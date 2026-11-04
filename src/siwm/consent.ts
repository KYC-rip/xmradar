import { callbackHost, canonicalMessage, expiresAt, parseChallenge, timely, type Challenge } from './challenge';
import { GUIDE_FOOTNOTE, walletGuides, type GuideFor } from './guide';
import type { SiwmView, SubmitResult } from './service';
import { validateMoneroAddress } from '../xmr/address';

/**
 * The consent window (PLAN-SIWM): what the user would sign, shown in full from the link itself (NKIP-0003
 * R6), then the signature their wallet made. Text only; nothing from the link is ever HTML.
 */

export interface ConsentDeps {
  /** the stored link's id, from the window's address; '' when the window was opened to paste one */
  id: string;
  get(id: string): Promise<SiwmView | null>;
  open(uri: string): Promise<{ id: string } | null>;
  submit(id: string, signature: string): Promise<SubmitResult>;
  copy(text: string): Promise<void>;
  /** saves `text` as a file the user picks up from their downloads */
  save(name: string, text: string): void;
  setId(id: string): void;
  close(): void;
  now(): number;
}

const fmtLeft = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `in ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/** One `<details>` per wallet, built with textContent only. */
export function renderGuide(doc: Document, into: HTMLElement, g: GuideFor) {
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) => {
    const e = doc.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };
  into.replaceChildren(
    ...walletGuides(g).map((w, i) => {
      const box = el('details', 'card');
      box.dataset.wallet = w.id;
      box.open = i === 0;
      box.append(el('summary', undefined, w.name));
      if (w.warn) box.append(el('p', 'warn-line', w.warn));
      const ol = el('ol');
      for (const step of w.steps) {
        const li = el('li');
        li.append(...step.map((p) => (typeof p === 'string' ? doc.createTextNode(p) : el('code', undefined, p.code))));
        ol.append(li);
      }
      box.append(ol);
      return box;
    }),
  );
}

export function mountConsent(doc: Document, d: ConsentDeps) {
  const $ = <T extends HTMLElement>(id: string) => doc.getElementById(id) as T;
  const fields = (name: string) => doc.querySelectorAll<HTMLElement>(`[data-f="${name}"]`);
  const fill = (name: string, text: string) => fields(name).forEach((el) => (el.textContent = text));
  const show = (which: 'paste' | 'refused' | 'consent' | 'done') => {
    for (const s of ['paste', 'refused', 'consent', 'done']) $(s).hidden = s !== which;
  };
  const refuse = (why: string) => {
    $('refused-why').textContent = why;
    show('refused');
  };
  let timer: ReturnType<typeof setInterval> | undefined;

  function render(id: string, e: SiwmView) {
    const p = parseChallenge(e.uri);
    if (!p.ok) return refuse(`This sign-in link is invalid: ${p.reason}.`);
    const c: Challenge = p.c;
    // NKIP-0003 wallet rule 6: the page that opened the link must be the site it signs in to
    if (e.crossSite) return refuse(`This link came from ${e.pageHost}, not ${c.origin}. Someone may be trying to sign in to your account from their own device.`);
    const when = timely(c, d.now());
    if (when === 'expired') return refuse('This sign-in has expired. Start it again on the site.');
    if (when === 'future') return refuse('This sign-in claims to be issued in the future. Check your computer’s clock.');

    const cb = callbackHost(c);
    const own = e.callbackOwnSite;
    fill('origin', c.origin);
    fill('handle', `@${c.handle}`);
    fill('address', c.address);
    fill('callback', cb);
    const tag = fields('callback-site')[0]!;
    tag.textContent = own ? 'the site’s own' : 'a different site';
    tag.classList.toggle('other', !own);
    fill('page', e.pageHost ?? 'a pasted link: XMRadar can’t tell which page it came from');
    const message = canonicalMessage(c);
    fill('message', message);
    const addr = validateMoneroAddress(c.address);
    renderGuide(doc, $('guide'), { subaddress: addr.ok && addr.type === 'subaddress', equalsSign: message.includes('=') });
    $('guide-note').textContent = GUIDE_FOOTNOTE;
    const query = e.uri.replace(/^monero-signin:\??/i, '');
    ($('ripley') as HTMLAnchorElement).href = `ripley://sign?${query}`;
    ($('wallet-app') as HTMLAnchorElement).href = e.uri;

    const send = $<HTMLButtonElement>('send');
    const tick = () => {
      const left = expiresAt(c) - d.now();
      fill('expires', left > 0 ? fmtLeft(left) : 'expired');
      if (left <= 0) {
        send.disabled = true;
        clearInterval(timer);
      }
    };
    tick();
    timer = setInterval(tick, 1000);

    $('copy').addEventListener('click', () => {
      void d.copy(message).then(
        () => ($('status').textContent = 'Message copied.'),
        () => ($('status').textContent = 'Couldn’t copy; select the message and copy it.'),
      );
    });
    $('copy-address').addEventListener('click', () => {
      void d.copy(c.address).then(
        () => ($('status').textContent = 'Address copied.'),
        () => ($('status').textContent = 'Couldn’t copy; select the address and copy it.'),
      );
    });
    $('save-file').addEventListener('click', () => {
      try {
        d.save('xmr-signin.txt', message);
        $('status').textContent = 'Downloading xmr-signin.txt; find it in your downloads folder.';
      } catch {
        $('status').textContent = 'Couldn’t save the file; copy the message instead.';
      }
    });
    send.addEventListener('click', async () => {
      const sig = $<HTMLTextAreaElement>('signature').value.trim();
      if (!sig) return void ($('status').textContent = 'Paste the signature first.');
      send.disabled = true;
      $('status').textContent = 'Checking and sending…';
      const r = await d.submit(id, sig).catch((err: Error) => ({ ok: false as const, error: err.message }));
      if (r.ok) {
        clearInterval(timer);
        show('done');
        setTimeout(d.close, 2500);
        return;
      }
      $('status').textContent = r.error;
      send.disabled = expiresAt(c) <= d.now();
    });
    show('consent');
  }

  const load = async (id: string) => {
    const e = await d.get(id).catch(() => null);
    if (!e) return refuse('This sign-in is no longer open. Start it again on the site.');
    render(id, e);
  };

  if (d.id) return load(d.id);
  show('paste');
  $('paste-check').addEventListener('click', async () => {
    const uri = $<HTMLTextAreaElement>('paste-uri').value.trim();
    if (!uri) return;
    const r = await d.open(uri).catch(() => null);
    if (!r) return refuse('That isn’t a sign-in link.');
    d.setId(r.id);
    await load(r.id);
  });
  return Promise.resolve();
}
