import type { AddressCheck } from '../xmr/address';
import { HANDLE_RE, normalizeHandle } from './envelope';
import { fetchPayto, findClaims, type ProofResult, type QueryFn } from './nostr';

export interface BadgeEntry {
  source: 'xmrbio' | 'nostr';
  address: string;
  check: AddressCheck;
  verified: boolean;
  /** how the handle link was checked, e.g. `nip39:client` */
  method: string;
  pubkey?: string;
  tweetId?: string;
  /** created_at (seconds) of the claim event */
  createdAt?: number;
  /** why an entry is unverified */
  note?: string;
}

export interface Badge {
  /** normalized handle */
  handle: string;
  /** the address for the QR code and link; null means no badge */
  primary: BadgeEntry | null;
  entries: BadgeEntry[];
  /** more than one distinct usable address */
  differ: boolean;
}

/** Tweet IDs are snowflakes, so a longer or larger ID is newer. */
const newerTweet = (a = '', b = '') => (a.length !== b.length ? a.length - b.length : a < b ? -1 : a > b ? 1 : 0);

/**
 * Merge rules (PLAN-PHASE2 §1, NIP39-2): xmr.bio is primary when present; otherwise the
 * verified Nostr claim with the newest claim event, then the newest proof tweet.
 * Every entry is kept so the popup can show all sources and differing addresses.
 */
export function mergeBadge(handle: string, entries: BadgeEntry[]): Badge {
  const usable = entries.filter((e) => e.verified && e.check.ok);
  const fromXmrbio = usable.find((e) => e.source === 'xmrbio');
  const fromNostr = usable
    .filter((e) => e.source === 'nostr')
    .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0) || newerTweet(b.tweetId, a.tweetId));
  return {
    handle: normalizeHandle(handle),
    primary: fromXmrbio ?? fromNostr[0] ?? null,
    entries,
    differ: new Set(usable.map((e) => e.address)).size > 1,
  };
}

/**
 * The Nostr entry a Xap goes to (PLAN-XAP): the newest verified claim with a pubkey and a standard
 * address or subaddress. xmr.bio may still be the badge's primary; receipts need a Nostr key.
 */
export function xapEntry(b: Badge): BadgeEntry | null {
  const ok = b.entries.filter((e) => e.source === 'nostr' && e.pubkey && e.verified && e.check.ok && e.check.type !== 'integrated');
  return ok.sort((a, c) => (c.createdAt ?? 0) - (a.createdAt ?? 0) || newerTweet(c.tweetId, a.tweetId))[0] ?? null;
}

/** The badge as it would be without Nostr sources (discovery turned off). */
export const withoutNostr = (b: Badge): Badge =>
  b.entries.some((e) => e.source === 'nostr') ? mergeBadge(b.handle, b.entries.filter((e) => e.source !== 'nostr')) : b;

export interface ResolveDeps {
  /** opt-in relay lookups (source B, client-side) */
  discovery: boolean;
  relays: string[];
  query?: QueryFn;
  /** proof-tweet check, cached by the caller */
  verify: (handle: string, tweetId: string, pubkey: string) => Promise<ProofResult>;
  /** passive source A (the signed directory, Phase 2d); absent until then */
  directory?: (handle: string) => BadgeEntry[];
}

// each proof check can cost two requests to X, so a big batch must not fan out all at once
const PROOF_CONCURRENCY = 4;

async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]!);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/** Source B for a batch of handles: claims → payto → proof check, only for claims that have a payto. */
export async function discoverNostr(handles: string[], deps: ResolveDeps): Promise<Map<string, BadgeEntry[]>> {
  const out = new Map<string, BadgeEntry[]>();
  const claims = await findClaims(handles, deps.relays, deps.query);
  if (!claims.length) return out;
  const payto = await fetchPayto([...new Set(claims.map((c) => c.pubkey))], deps.relays, deps.query);
  await mapLimit(
    claims,
    PROOF_CONCURRENCY,
    async (c) => {
      const p = payto.get(c.pubkey);
      if (!p) return;
      const entry: BadgeEntry = { source: 'nostr', address: p.address, check: p.check, verified: false, method: 'nip39:client', pubkey: c.pubkey, tweetId: c.tweetId, createdAt: c.createdAt };
      if (p.check.ok) {
        // no X traffic for claims that couldn't give a badge anyway
        const proof = await deps.verify(c.handle, c.tweetId, c.pubkey);
        entry.verified = proof.status === 'verified';
        if (proof.status !== 'verified') entry.note = proof.status === 'error' ? `could not verify: ${proof.reason}` : proof.reason;
      } else {
        entry.note = `invalid address (${p.check.reason})`;
      }
      out.set(c.handle, [...(out.get(c.handle) ?? []), entry]);
    },
  );
  return out;
}

/**
 * Badges for a batch of handles from the passive sources only. It never calls xmr.bio's
 * per-handle /resolve: that only happens when the user clicks in the popup.
 */
export async function resolveHandles(handles: string[], deps: ResolveDeps): Promise<Map<string, Badge>> {
  const valid = [...new Set(handles.map((h) => h.replace(/^@/, '')).filter((h) => HANDLE_RE.test(h)))];
  const nostr = deps.discovery && valid.length ? await discoverNostr(valid, deps) : new Map<string, BadgeEntry[]>();
  const out = new Map<string, Badge>();
  for (const h of valid) {
    const key = normalizeHandle(h);
    if (!out.has(key)) out.set(key, mergeBadge(key, [...(deps.directory?.(key) ?? []), ...(nostr.get(key) ?? [])]));
  }
  return out;
}
