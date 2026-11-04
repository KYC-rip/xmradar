import { callbackHost, canonicalMessage, parseChallenge, timely } from './challenge';
import { sameSite } from './site';
import { verifySpendSignature } from './signature';

/**
 * The background half of the Sign-In with Monero helper (PLAN-SIWM): challenges waiting in a consent
 * window, and the callback once the user's own wallet has signed. Only the link and the opening page's
 * host are kept, in session storage, until the window closes or 20 minutes pass.
 */

export interface SiwmEntry {
  uri: string;
  /** host of the page whose link was clicked; null when the link was pasted */
  pageHost: string | null;
  at: number;
  windowId?: number;
}
export type SiwmStore = Record<string, SiwmEntry>;

export interface SiwmDeps {
  store: { getValue(): Promise<SiwmStore>; setValue(v: SiwmStore): Promise<void> };
  now(): number;
  randomId(): string;
  openWindow(id: string): Promise<number | undefined>;
  /** POST JSON; the status and at most a few KB of the answer */
  post(url: string, body: string): Promise<{ status: number; text: string }>;
}

export type SubmitResult = { ok: true } | { ok: false; error: string };

/** What the consent window shows; the same-site answers are worked out here, where the suffix list is. */
export interface SiwmView {
  uri: string;
  pageHost: string | null;
  /** the page that opened the link is on another site than the one it signs in to */
  crossSite: boolean;
  /** the callback is on the sign-in site's own registrable domain */
  callbackOwnSite: boolean;
}

export const ENTRY_TTL_MS = 20 * 60_000;
export const MAX_ANSWER = 4096;

/** At most `max` bytes of a response, decoded; the rest is never read. */
export async function cappedText(res: Response, max = MAX_ANSWER): Promise<string> {
  if (!res.body) return (await res.text()).slice(0, max);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < max) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value.subarray(0, max - size));
    size += Math.min(value.length, max - size);
  }
  await reader.cancel().catch(() => {});
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.length;
  }
  return new TextDecoder().decode(all);
}
const MAX_ENTRIES = 20;
const MAX_URI = 4096;

/** The page sent the link from a site other than the one it signs in to (NKIP-0003 wallet rule 6). */
export const crossSite = (e: Pick<SiwmEntry, 'pageHost'>, origin: string) => e.pageHost !== null && !sameSite(e.pageHost, origin);

/** What the verifier said, as one short line of text. */
export function verifierAnswer(status: number, text: string): SubmitResult {
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {}
  const b = typeof body === 'object' && body ? (body as { ok?: unknown; error?: unknown }) : {};
  if (status >= 200 && status < 300 && b.ok === true) return { ok: true };
  const said = typeof b.error === 'string' ? b.error.replace(/\s+/g, ' ').trim().slice(0, 200) : '';
  return { ok: false, error: said ? `The site said: ${said}` : `The site refused the sign-in (HTTP ${status}).` };
}

export function siwmService(d: SiwmDeps) {
  let chain: Promise<unknown> = Promise.resolve();
  const queued = <T>(f: () => Promise<T>): Promise<T> => {
    const run = chain.then(f);
    chain = run.then(
      () => {},
      () => {},
    );
    return run;
  };
  const fresh = (s: SiwmStore): SiwmStore => Object.fromEntries(Object.entries(s).filter(([, e]) => d.now() - e.at < ENTRY_TTL_MS));
  const sending = new Set<string>();

  const get = (id: string) =>
    queued(async () => {
      const e = fresh(await d.store.getValue())[id];
      if (!e) return null;
      const p = parseChallenge(e.uri);
      const view: SiwmView = {
        uri: e.uri,
        pageHost: e.pageHost,
        crossSite: p.ok && crossSite(e, p.c.origin),
        callbackOwnSite: p.ok && sameSite(callbackHost(p.c), p.c.origin),
      };
      return view;
    });

  const drop = (id: string) =>
    queued(async () => {
      const s = fresh(await d.store.getValue());
      delete s[id];
      await d.store.setValue(s);
    });

  return {
    /** Keeps the link and opens the consent window (unless it's already open); even a bad link opens it, to say why it's refused. */
    open: async (uri: string, pageHost: string | null, withWindow = true): Promise<{ id: string }> => {
      if (typeof uri !== 'string' || !uri || uri.length > MAX_URI) throw new Error('Not a sign-in link');
      const id = d.randomId();
      await queued(async () => {
        const s = fresh(await d.store.getValue());
        const kept = Object.entries(s)
          .sort(([, a], [, b]) => b.at - a.at)
          .slice(0, MAX_ENTRIES - 1);
        await d.store.setValue({ ...Object.fromEntries(kept), [id]: { uri, pageHost, at: d.now() } });
      });
      if (!withWindow) return { id };
      let windowId: number | undefined;
      try {
        windowId = await d.openWindow(id);
      } catch (e) {
        // no window to show it in: forget it at once, and say so to the caller
        await drop(id);
        throw e;
      }
      if (windowId !== undefined)
        await queued(async () => {
          const s = await d.store.getValue();
          if (s[id]) await d.store.setValue({ ...s, [id]: { ...s[id], windowId } });
        });
      return { id };
    },

    get,
    close: drop,

    /** A consent window was closed: forget what it showed. */
    windowClosed: (windowId: number) =>
      queued(async () => {
        const s = fresh(await d.store.getValue());
        await d.store.setValue(Object.fromEntries(Object.entries(s).filter(([, e]) => e.windowId !== windowId)));
      }),

    /** Checks everything again from the stored link, then posts the signature to the verifier. */
    submit: async (id: string, signature: unknown): Promise<SubmitResult> => {
      const e = await get(id);
      if (!e) return { ok: false, error: 'This sign-in is no longer open. Start it again on the site.' };
      const p = parseChallenge(e.uri);
      if (!p.ok) return { ok: false, error: `This sign-in link is refused: ${p.reason}.` };
      const c = p.c;
      if (crossSite(e, c.origin)) return { ok: false, error: 'This link came from another site. XMRadar won’t help sign it.' };
      const when = timely(c, d.now());
      if (when !== 'ok') return { ok: false, error: when === 'expired' ? 'This sign-in has expired. Start it again on the site.' : 'This sign-in claims to be issued in the future. Check your computer’s clock.' };
      const sig = typeof signature === 'string' ? signature.trim() : '';
      if (!verifySpendSignature(canonicalMessage(c), c.address, sig)) {
        return { ok: false, error: 'This isn’t a signature of this message by this address’s spend key. Sign the exact message with the wallet that holds the address (not a view-only wallet).' };
      }
      if (sending.has(id)) return { ok: false, error: 'Already sending.' };
      sending.add(id);
      try {
        let answer: SubmitResult;
        try {
          const r = await d.post(c.return_url, JSON.stringify({ session: c.session, address: c.address, signature: sig }));
          answer = verifierAnswer(r.status, r.text);
        } catch {
          answer = { ok: false, error: `Couldn’t reach ${new URL(c.return_url).host}. Try again.` };
        }
        // a failed callback doesn't use the challenge up (NKIP-0003); a successful one does
        if (answer.ok) await drop(id).catch(() => {});
        return answer;
      } finally {
        sending.delete(id);
      }
    },
  };
}
