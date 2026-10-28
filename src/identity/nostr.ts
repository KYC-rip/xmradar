import { npubEncode } from 'nostr-tools/nip19';
import { SimplePool } from 'nostr-tools/pool';
import { verifyEvent, type Event } from 'nostr-tools/pure';
import { validateMoneroAddress, type AddressCheck } from '../xmr/address';
import { isXHost } from '../sender';
import { HANDLE_RE, normalizeHandle } from './envelope';

export const KIND_IDENTITIES = 10011; // NIP-39
export const KIND_PAYTO = 10133; // NIP-A3

export type QueryFn = (relays: string[], filter: { kinds: number[]; authors?: string[]; '#i'?: string[] }) => Promise<Event[]>;

export const poolQuery: QueryFn = async (relays, filter) => {
  const pool = new SimplePool();
  try {
    return await pool.querySync(relays, filter, { maxWait: 4000 });
  } finally {
    pool.close(relays);
  }
};

export interface TwitterClaim {
  pubkey: string;
  /** normalized (lowercase) handle */
  handle: string;
  tweetId: string;
  /** created_at of the claiming kind-10011 (or kind 0) event */
  createdAt: number;
}

const TWEET_URL = /^https?:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/status\/(\d{1,20})(?:[/?#].*)?$/;

/** NIP-39 proof value: a bare tweet ID or a tweet URL (whose author must be the claimed handle). */
export function parseTweetProof(proof: string | undefined, handle: string): string | null {
  if (!proof) return null;
  if (/^\d{1,20}$/.test(proof)) return proof;
  const m = TWEET_URL.exec(proof);
  return m && normalizeHandle(m[1]!) === handle ? m[2]! : null;
}

/** `twitter:` claims in one kind-10011 event, limited to the given (normalized) handles. */
export function twitterClaims(event: Event, wanted: ReadonlySet<string>): TwitterClaim[] {
  if (event.kind !== KIND_IDENTITIES && event.kind !== 0) return [];
  const out: TwitterClaim[] = [];
  for (const t of event.tags) {
    if (t[0] !== 'i' || !t[1]?.toLowerCase().startsWith('twitter:')) continue;
    const handle = normalizeHandle(t[1].slice('twitter:'.length));
    if (!HANDLE_RE.test(handle) || !wanted.has(handle)) continue;
    const tweetId = parseTweetProof(t[2], handle);
    if (tweetId) out.push({ pubkey: event.pubkey, handle, tweetId, createdAt: event.created_at });
  }
  return out;
}

/** verifyEvent caches its verdict on the object (and spreads copy it), so check a fresh plain copy. */
export const validEvent = (e: Event) =>
  verifyEvent({ id: e.id, pubkey: e.pubkey, created_at: e.created_at, kind: e.kind, tags: e.tags, content: e.content, sig: e.sig });

/** Newest valid event per pubkey. */
function newestPerPubkey(events: Event[], kind: number): Map<string, Event> {
  const out = new Map<string, Event>();
  for (const e of events) {
    if (e.kind !== kind || !validEvent(e)) continue;
    const prev = out.get(e.pubkey);
    if (!prev || e.created_at > prev.created_at || (e.created_at === prev.created_at && e.id < prev.id)) out.set(e.pubkey, e);
  }
  return out;
}

/**
 * Every pubkey whose newest identity list claims one of the handles: kind 10011 (current NIP-39), or
 * kind 0 `i` tags (older NIP-39 clients, the minimum NKIP-0002 R14 names) when it has no kind 10011.
 */
export async function findClaims(handles: string[], relays: string[], query: QueryFn = poolQuery): Promise<TwitterClaim[]> {
  const wanted = new Set(handles.map(normalizeHandle).filter((h) => HANDLE_RE.test(h)));
  if (!wanted.size) return [];
  // `#i` matches exactly and claims keep the handle's case, so ask for both spellings
  const values = [...new Set(handles.flatMap((h) => [`twitter:${h.replace(/^@/, '')}`, `twitter:${normalizeHandle(h)}`]))];
  const events = await query(relays, { kinds: [KIND_IDENTITIES, 0], '#i': values });
  const lists = newestPerPubkey(events, KIND_IDENTITIES);
  const meta = [...newestPerPubkey(events, 0).values()].filter((e) => !lists.has(e.pubkey));
  // any kind 10011 supersedes a key's kind 0, also one that no longer names the handle (and so wasn't
  // returned above): ask for those keys' lists before taking a kind 0 claim
  const superseded = meta.length ? new Set((await query(relays, { kinds: [KIND_IDENTITIES], authors: meta.map((e) => e.pubkey) })).filter((e) => e.kind === KIND_IDENTITIES && validEvent(e)).map((e) => e.pubkey)) : new Set<string>();
  return [...lists.values(), ...meta.filter((e) => !superseded.has(e.pubkey))].flatMap((e) => twitterClaims(e, wanted));
}

export interface Payto {
  address: string;
  check: AddressCheck;
  createdAt: number;
}

/** The first valid `monero` payto in a kind-10133 event (or the first one, if none is valid). */
export function moneroPayto(event: Event): Payto | null {
  const addrs = event.tags.filter((t) => t[0] === 'payto' && t[1]?.toLowerCase() === 'monero' && t[2]).map((t) => t[2]!.trim());
  if (!addrs.length) return null;
  const checked = addrs.map((address) => ({ address, check: validateMoneroAddress(address), createdAt: event.created_at }));
  return checked.find((p) => p.check.ok) ?? checked[0]!;
}

export async function fetchPayto(pubkeys: string[], relays: string[], query: QueryFn = poolQuery): Promise<Map<string, Payto>> {
  const out = new Map<string, Payto>();
  if (!pubkeys.length) return out;
  const events = await query(relays, { kinds: [KIND_PAYTO], authors: pubkeys });
  for (const [pk, e] of newestPerPubkey(events, KIND_PAYTO)) {
    const p = moneroPayto(e);
    if (p) out.set(pk, p);
  }
  return out;
}

// ---- proof tweets ----

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…' };

/**
 * Text of the tweet's own `<p>` in oEmbed html: no quoted, card or byline content.
 * Only the part before any nested blockquote counts, so a quote-only tweet yields null.
 */
export function oembedText(html: string): string | null {
  const outer = /<blockquote\b[^>]*>/i.exec(html);
  const body = outer ? html.slice(outer.index + outer[0].length) : html;
  const nested = body.search(/<blockquote\b/i);
  const m = /<p\b[^>]*>([\s\S]*?)<\/p>/i.exec(nested < 0 ? body : body.slice(0, nested));
  if (!m) return null;
  return m[1]!
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, ent: string) => {
      if (ent[0] === '#') {
        const code = ent[1] === 'x' || ent[1] === 'X' ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
        return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : all;
      }
      return Object.hasOwn(ENTITIES, ent.toLowerCase()) ? ENTITIES[ent.toLowerCase()]! : all;
    });
}

/** The npub as a whole word (quotes or punctuation around it are fine, extra bech32 characters are not). */
export function containsNpub(text: string, npub: string): boolean {
  return new RegExp(`(?<![A-Za-z0-9])${npub}(?![A-Za-z0-9])`).test(text);
}

/** Token for cdn.syndication.twimg.com (reverse-engineered from X's embed widget). */
export const syndicationToken = (id: string) => ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, '');

export type ProofResult = { status: 'verified'; via: 'oembed' | 'syndication' } | { status: 'failed'; reason: string } | { status: 'error'; reason: string };

const pathHandle = (url: unknown) => {
  try {
    if (typeof url !== 'string') return '';
    const u = new URL(url);
    return u.protocol === 'https:' && isXHost(u.hostname) ? normalizeHandle(u.pathname.split('/')[1] ?? '') : '';
  } catch {
    return '';
  }
};

/**
 * Does tweet `tweetId` belong to `handle` and contain the claimer's npub?
 * oEmbed (X's official embed API) first, syndication as best effort. "error" means
 * neither endpoint could answer, which is reported as "could not verify", never as verified.
 */
export async function verifyTwitterProof(handle: string, tweetId: string, pubkey: string, fetchFn: typeof fetch = fetch): Promise<ProofResult> {
  const h = normalizeHandle(handle);
  if (!HANDLE_RE.test(h) || !/^\d{1,20}$/.test(tweetId)) return { status: 'failed', reason: 'malformed claim' };
  const npub = npubEncode(pubkey);
  const init: RequestInit = { credentials: 'omit', signal: AbortSignal.timeout(8000) };
  const failures: string[] = [];
  let answered = false;

  try {
    const res = await fetchFn(`https://publish.twitter.com/oembed?url=${encodeURIComponent(`https://twitter.com/${h}/status/${tweetId}`)}&omit_script=1&dnt=true`, init);
    if (res.status === 404) {
      answered = true;
      failures.push('tweet not found');
    } else if (res.ok) {
      answered = true;
      const data = (await res.json()) as { author_url?: unknown; html?: unknown };
      const text = typeof data.html === 'string' ? oembedText(data.html) : null;
      // oEmbed is X's official API: a definite answer from it is final, syndication is only for when it can't answer
      if (pathHandle(data.author_url) !== h) return { status: 'failed', reason: 'tweet is by another account' };
      if (!text || !containsNpub(text, npub)) return { status: 'failed', reason: 'tweet does not contain the npub' };
      return { status: 'verified', via: 'oembed' };
    }
  } catch {
    // network error: fall through to syndication
  }

  try {
    const res = await fetchFn(`https://cdn.syndication.twimg.com/tweet-result?id=${tweetId}&token=${syndicationToken(tweetId)}&lang=en`, init);
    if (res.ok) {
      const data = (await res.json()) as { text?: unknown; user?: { screen_name?: unknown } };
      if (typeof data.text === 'string' && typeof data.user?.screen_name === 'string') {
        answered = true;
        // `text` is the tweet's own text; a quoted tweet comes separately as `quoted_tweet`
        if (normalizeHandle(data.user.screen_name) !== h) failures.push('tweet is by another account');
        else if (!containsNpub(data.text, npub)) failures.push('tweet does not contain the npub');
        else return { status: 'verified', via: 'syndication' };
      }
    }
  } catch {
    // ignore: reported below
  }

  return answered ? { status: 'failed', reason: failures[0] ?? 'proof not found' } : { status: 'error', reason: 'X did not answer' };
}
