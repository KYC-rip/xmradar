import { decode as nip19Decode } from 'nostr-tools/nip19';
import { validateMoneroAddress } from '../xmr/address';
import { HANDLE_RE, normalizeHandle } from './envelope';
import type { BadgeEntry } from './resolve';

/**
 * X self-claims (PLAN-XCLAIMS, Phase 2g): a Monero address, an npub or an xmr.bio link that an account
 * shows in its own bio, Website field or pinned post. Read from the page you're on, kept on this
 * device, and never sent anywhere: a weaker, labelled tier below xmr.bio and verified NIP-39.
 */

export type ClaimPlace = 'bio' | 'url' | 'pinned';
export const CLAIM_PLACES: readonly ClaimPlace[] = ['bio', 'url', 'pinned'];

/** What one place says: at most one value of each type (X4). */
export interface ClaimValues {
  /** mainnet standard address or subaddress */
  address?: string;
  /** lowercase hex, from an npub or nprofile */
  pubkey?: string;
  /** an xmr.bio name, lowercase */
  xmrbio?: string;
}

export interface StoredClaim extends ClaimValues {
  /** when these exact values were first seen (ms) */
  seenAt: number;
  /** the last time they were seen again (ms) */
  confirmedAt: number;
  /** the pinned post */
  tweetId?: string;
}

export interface XClaimEntry {
  /** normalized handle */
  handle: string;
  bio?: StoredClaim;
  url?: StoredClaim;
  pinned?: StoredClaim;
}

export interface XClaimStore {
  v: 1;
  entries: XClaimEntry[];
}

export const MAX_CLAIM_HANDLES = 1000;
export const CLAIM_TTL_MS = 30 * 86_400_000;
/** a field's text, as much as X shows of a bio or a post */
export const MAX_CLAIM_TEXT = 4000;
const REFRESH_MS = 86_400_000;

const B58 = '1-9A-HJ-NP-Za-km-z';
const B58_RUN = new RegExp(`(?<![${B58}])[${B58}]{95,}(?![${B58}])`, 'g');
const NOSTR = /(?<![a-z0-9])(npub1|nprofile1)[02-9ac-hj-np-z]{20,500}(?![a-z0-9])/g;
// visible link text; the href is a t.co link. A name X cut short ends in "…" and is refused.
// exactly `xmr.bio/<name>` and an optional `/`, then the end of the link: a space, closing punctuation, or a
// full stop that ends the sentence; `xmr.bio/foo-bar`, `/foo.bar`, `/foo/bar` and `/foo?x` name no one
const XMRBIO = /(?<![A-Za-z0-9_.\/-])(?:https?:\/\/)?(?:www\.)?xmr\.bio\/([A-Za-z0-9_]{1,15})\/?(?=$|[\s)\]},;:!"'’”|<>]|[.,](?:\s|$))/gi;
const CUT_XMRBIO = /xmr\.bio\/\S*…/i;
// a lone address can be a warning about it (X1); English only, matched anywhere in the field
const WARNING = /scam|fake|impersonat|don['’]t send|do not send|never send|not my|not mine|stolen|hacked/i;

const one = (values: Set<string>) => (values.size === 1 ? [...values][0] : undefined);

/**
 * The claim in one field's text. `url` is the Website field, where only an xmr.bio link counts (§10).
 * Two different values of a type, or any integrated address, leave that type out; a warning cue leaves
 * the whole field out.
 */
export function parseClaim(text: string, place: ClaimPlace): ClaimValues {
  if (typeof text !== 'string' || !text || WARNING.test(text)) return {};
  text = text.slice(0, MAX_CLAIM_TEXT);
  const out: ClaimValues = {};
  const names = new Set<string>();
  for (const m of text.matchAll(XMRBIO)) names.add(m[1]!.toLowerCase());
  // a cut-short link next to a whole one makes the field ambiguous
  if (CUT_XMRBIO.test(text)) names.add('…');
  const name = one(names);
  if (name && name !== '…' && HANDLE_RE.test(name)) out.xmrbio = name;
  if (place === 'url') return out;

  const addresses = new Set<string>();
  let integrated = false;
  for (const [run] of text.matchAll(B58_RUN)) {
    const check = validateMoneroAddress(run);
    if (!check.ok) continue;
    if (check.type === 'integrated') integrated = true;
    else addresses.add(run);
  }
  const address = integrated ? undefined : one(addresses);
  if (address) out.address = address;

  const keys = new Set<string>();
  for (const [word] of text.matchAll(NOSTR)) {
    try {
      const d = nip19Decode(word);
      if (d.type === 'npub') keys.add(d.data);
      else if (d.type === 'nprofile') keys.add(d.data.pubkey);
    } catch {
      // not bech32, or a bad checksum: not a key
    }
  }
  const pubkey = one(keys);
  if (pubkey && /^[0-9a-f]{64}$/.test(pubkey)) out.pubkey = pubkey;
  return out;
}

export const emptyClaim = (c: ClaimValues | null | undefined) => !c || (!c.address && !c.pubkey && !c.xmrbio);

/** A claim as it arrives in a message: every value checked again, unknown fields dropped. */
export function cleanClaim(raw: unknown, place: ClaimPlace): ClaimValues | null {
  if (raw == null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Bad claim');
  const r = raw as Record<string, unknown>;
  const out: ClaimValues = {};
  if (r.xmrbio !== undefined) {
    if (typeof r.xmrbio !== 'string' || !HANDLE_RE.test(r.xmrbio)) throw new Error('Bad xmr.bio name');
    out.xmrbio = r.xmrbio.toLowerCase();
  }
  if (place !== 'url' && r.address !== undefined) {
    const check = typeof r.address === 'string' ? validateMoneroAddress(r.address) : null;
    if (!check?.ok || check.type === 'integrated') throw new Error('Bad address');
    out.address = r.address as string;
  }
  if (place !== 'url' && r.pubkey !== undefined) {
    if (typeof r.pubkey !== 'string' || !/^[0-9a-f]{64}$/.test(r.pubkey)) throw new Error('Bad pubkey');
    out.pubkey = r.pubkey;
  }
  return emptyClaim(out) ? null : out;
}

const sameValues = (a: ClaimValues, b: ClaimValues) => a.address === b.address && a.pubkey === b.pubkey && a.xmrbio === b.xmrbio;
const lastConfirmed = (e: XClaimEntry) => Math.max(0, ...CLAIM_PLACES.map((p) => e[p]?.confirmedAt ?? 0));

/** Expiry per place, then the cap by the oldest last sighting (X6). */
export function pruneClaims(store: XClaimStore | null | undefined, now: number): XClaimStore {
  const entries: XClaimEntry[] = [];
  for (const e of Array.isArray(store?.entries) ? store.entries : []) {
    if (!e || typeof e.handle !== 'string') continue;
    const kept: XClaimEntry = { handle: e.handle };
    for (const p of CLAIM_PLACES) {
      const c = e[p];
      if (c && typeof c.confirmedAt === 'number' && now - c.confirmedAt < CLAIM_TTL_MS) kept[p] = c;
    }
    if (CLAIM_PLACES.some((p) => kept[p])) entries.push(kept);
  }
  entries.sort((a, b) => lastConfirmed(b) - lastConfirmed(a));
  return { v: 1, entries: entries.slice(0, MAX_CLAIM_HANDLES) };
}

/**
 * One place seen on a profile: a claim (new, changed or seen again) or none (removed). `changed` says
 * whether the handle's badge may differ now, so cached badges for it must go.
 */
export function applySeen(store: XClaimStore | null | undefined, handle: string, place: ClaimPlace, claim: ClaimValues | null, now: number, tweetId?: string): { store: XClaimStore; changed: boolean } {
  const key = normalizeHandle(handle);
  const pruned = pruneClaims(store, now);
  const entries = pruned.entries.filter((e) => e.handle !== key);
  const prev = pruned.entries.find((e) => e.handle === key) ?? { handle: key };
  const next: XClaimEntry = { ...prev };
  const old = prev[place];
  let changed: boolean;
  if (emptyClaim(claim)) {
    delete next[place];
    changed = !!old;
  } else {
    const values: ClaimValues = { ...(claim!.address ? { address: claim!.address } : {}), ...(claim!.pubkey ? { pubkey: claim!.pubkey } : {}), ...(claim!.xmrbio ? { xmrbio: claim!.xmrbio } : {}) };
    const same = !!old && sameValues(old, values);
    const tweet = place === 'pinned' && tweetId ? { tweetId } : {};
    // a new pinned post with the same values keeps its first sighting (X6)
    next[place] = { ...values, seenAt: same ? old!.seenAt : now, confirmedAt: now, ...tweet };
    // a sighting a day or more after the last one changes the popup's "last seen" line
    changed = !same || (place === 'pinned' && old?.tweetId !== tweetId) || now - old!.confirmedAt >= REFRESH_MS;
  }
  if (CLAIM_PLACES.some((p) => next[p])) entries.unshift(next);
  return { store: pruneClaims({ v: 1, entries }, now), changed };
}

const METHOD_RANK = ['x-bio', 'x-bio-xmrbio', 'x-bio-npub', 'x-url-xmrbio', 'x-pinned', 'x-pinned-xmrbio', 'x-pinned-npub'];
/** Bio before Website before pinned; within a place, a direct address before a link before an npub. */
export const selfRank = (e: BadgeEntry) => {
  const i = METHOD_RANK.indexOf(e.method);
  return i < 0 ? METHOD_RANK.length : i;
};

/**
 * Badge entries from a handle's claims. An xmr.bio link takes its address from the downloaded directory
 * (no request); a link to the handle's own xmr.bio name adds nothing, as the directory already gives it.
 * An npub gives an entry only through `payto`, which the caller fills only with relay discovery on.
 */
export function selfEntries(e: XClaimEntry | undefined, directory: (handle: string) => BadgeEntry[], payto?: (pubkey: string) => string | undefined): BadgeEntry[] {
  if (!e) return [];
  const out: BadgeEntry[] = [];
  for (const place of CLAIM_PLACES) {
    const c = e[place];
    if (!c) continue;
    const base = { source: 'xself' as const, verified: true, seenAt: c.seenAt, confirmedAt: c.confirmedAt, ...(place === 'pinned' && c.tweetId ? { tweetId: c.tweetId } : {}) };
    if (c.address) out.push({ ...base, address: c.address, check: validateMoneroAddress(c.address), method: `x-${place}` });
    if (c.xmrbio && c.xmrbio !== e.handle) {
      const hit = directory(c.xmrbio).find((d) => d.source === 'xmrbio');
      if (hit) out.push({ ...base, address: hit.address, check: hit.check, method: `x-${place}-xmrbio`, xmrbio: c.xmrbio });
    }
    const addr = c.pubkey ? payto?.(c.pubkey) : undefined;
    if (addr) out.push({ ...base, address: addr, check: validateMoneroAddress(addr), method: `x-${place}-npub`, pubkey: c.pubkey });
  }
  return out;
}

interface Item<T> {
  getValue(): Promise<T>;
  setValue(v: T): Promise<void>;
  removeValue(): Promise<void>;
}

export interface ClaimKeeperDeps {
  store: Item<XClaimStore | null>;
  /** tells x.com tabs which handle to look up again */
  changedItem: { setValue(v: { handle: string; at: number }): Promise<void> };
  /** claims are read and kept (X badges and the switch on) */
  enabled(): Promise<boolean>;
  /** a handle's cached badge, or all of them, are out of date */
  dropBadge(handle: string): Promise<void> | void;
  dropAllBadges(): Promise<void> | void;
  now?: () => number;
}

/**
 * The background's side (A3): every sighting is checked again and written one at a time, so two tabs
 * can't overwrite each other; a change drops the handle's cached badge in the background and on x.com.
 */
export function claimKeeper(deps: ClaimKeeperDeps) {
  const now = deps.now ?? Date.now;
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = queue.then(fn);
    queue = run.catch(() => {});
    return run;
  };

  async function lookup(): Promise<(handle: string) => XClaimEntry | undefined> {
    if (!(await deps.enabled())) return () => undefined;
    const map = new Map(pruneClaims(await deps.store.getValue(), now()).entries.map((e) => [e.handle, e]));
    return (handle) => map.get(normalizeHandle(handle));
  }

  /** an `x-claims-seen` message from an x.com tab (the caller checks the sender) */
  function seen(msg: { handle?: unknown; place?: unknown; claim?: unknown; tweetId?: unknown }): Promise<{ changed: boolean }> {
    if (typeof msg.handle !== 'string' || !HANDLE_RE.test(msg.handle)) return Promise.reject(new Error('Bad handle'));
    if (!CLAIM_PLACES.includes(msg.place as ClaimPlace)) return Promise.reject(new Error('Bad place'));
    const place = msg.place as ClaimPlace;
    let claim: ClaimValues | null;
    try {
      claim = cleanClaim(msg.claim, place);
    } catch (e) {
      return Promise.reject(e);
    }
    if (msg.tweetId !== undefined && (typeof msg.tweetId !== 'string' || !/^[1-9]\d{0,19}$/.test(msg.tweetId))) return Promise.reject(new Error('Bad tweet id'));
    const handle = normalizeHandle(msg.handle);
    const tweetId = place === 'pinned' ? (msg.tweetId as string | undefined) : undefined;
    return serial(async () => {
      if (!(await deps.enabled())) return { changed: false };
      const { store, changed } = applySeen(await deps.store.getValue(), handle, place, claim, now(), tweetId);
      await deps.store.setValue(store);
      if (changed) {
        await deps.dropBadge(handle);
        await deps.changedItem.setValue({ handle, at: now() });
      }
      return { changed };
    });
  }

  /** switched off: nothing kept, and badges merged from claims go */
  const clear = () =>
    serial(async () => {
      const had = (await deps.store.getValue())?.entries?.length;
      await deps.store.removeValue();
      if (had) await deps.dropAllBadges();
    });

  return { lookup, seen, clear };
}
