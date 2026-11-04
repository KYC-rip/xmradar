import type { Event } from 'nostr-tools/pure';
import { KIND_IDENTITIES, KIND_PAYTO, moneroPayto, newestPerPubkey, twitterClaims, validEvent, type ProofResult } from '../identity/nostr';

/**
 * Whether an xo's sender is a Monero person (PLAN-MONEROLIKE): their key publishes a valid Monero address
 * (NIP-A3, kind 10133) and an X account (NIP-39) whose proof tweet carries their npub. Starts from the key,
 * not from a handle, since an xo carries only the key. Known answers are kept a day; a proof that couldn't
 * be fetched isn't an answer and is asked again next time.
 */

export type Liker = { ok: true; handle: string } | { ok: false };
export interface KnownLiker {
  liker: Liker;
  at: number;
}
export type LikerCache = Record<string, KnownLiker>;

export const LIKER_TTL_MS = 24 * 3600_000;
export const MAX_LIKER_CACHE = 1000;

export interface VerifyDeps {
  query(relays: string[], filter: { kinds: number[]; authors: string[] }): Promise<Event[]>;
  relays: string[];
  /** `verifyTwitterProof`: the tweet must carry this key's npub */
  proof(handle: string, tweetId: string, pubkey: string): Promise<ProofResult>;
}

/** The answer, or null when it couldn't be had (no relay data, or the proof check errored). */
export async function verifyLiker(pubkey: string, deps: VerifyDeps): Promise<Liker | null> {
  const events = (await deps.query(deps.relays, { kinds: [KIND_IDENTITIES, 0, KIND_PAYTO], authors: [pubkey] })).filter((e) => e.pubkey === pubkey && validEvent(e));
  if (!events.length) return null;
  const payto = newestPerPubkey(events, KIND_PAYTO).get(pubkey);
  const address = payto ? moneroPayto(payto) : null;
  if (!address?.check.ok) return { ok: false };
  // NIP-39: a kind 10011 list supersedes kind 0 `i` tags
  const list = newestPerPubkey(events, KIND_IDENTITIES).get(pubkey) ?? newestPerPubkey(events, 0).get(pubkey);
  const claims = list ? twitterClaims(list, null) : [];
  if (!claims.length) return { ok: false };
  let errored = false;
  for (const c of claims.slice(0, 3)) {
    const r = await deps.proof(c.handle, c.tweetId, pubkey).catch((): ProofResult => ({ status: 'error', reason: 'proof' }));
    if (r.status === 'verified') return { ok: true, handle: c.handle };
    if (r.status === 'error') errored = true;
  }
  return errored ? null : { ok: false };
}

export const knownLiker = (cache: LikerCache, pubkey: string, now: number): Liker | null => {
  const k = cache[pubkey];
  return k && now - k.at < LIKER_TTL_MS ? k.liker : null;
};

/** The cache with this answer; expired and then the oldest entries go past the cap. */
export function rememberLiker(cache: LikerCache, pubkey: string, liker: Liker, now: number): LikerCache {
  const next: LikerCache = Object.fromEntries(Object.entries(cache).filter(([, k]) => now - k.at < LIKER_TTL_MS));
  next[pubkey] = { liker, at: now };
  const keys = Object.keys(next);
  if (keys.length > MAX_LIKER_CACHE) for (const k of keys.sort((a, b) => next[a]!.at - next[b]!.at).slice(0, keys.length - MAX_LIKER_CACHE)) delete next[k];
  return next;
}
