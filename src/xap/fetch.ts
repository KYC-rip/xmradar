import type { Filter } from 'nostr-tools/filter';
import { SimplePool } from 'nostr-tools/pool';
import type { Event } from 'nostr-tools/pure';
import { KIND_PAYTO, validEvent } from '../identity/nostr';
import { allRelaysFrom } from '../nostr/relays';
import { validateMoneroAddress } from '../xmr/address';
import { KIND_CONFIRMATION, KIND_DELETION, KIND_RECEIPT } from './events';

export type XapQuery = (relays: string[], filter: Filter) => Promise<Event[]>;

export const xapPoolQuery: XapQuery = async (relays, filter) => {
  const pool = new SimplePool();
  try {
    return await pool.querySync(relays, filter, { maxWait: 4000 });
  } finally {
    pool.close(relays);
  }
};

/** NKIP-0002 fetch bounds */
export const MAX_RECEIPTS = 500;
export const MAX_CONFIRMATIONS = 500;
const MAX_MISSING = 100;
const MAX_INBOX = 4;

const newest = (events: Event[], kind: number, pubkey: string) =>
  events
    .filter((e) => e.kind === kind && e.pubkey === pubkey && validEvent(e))
    .sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? -1 : 1))[0] ?? null;

const usable = (a: unknown): a is string => {
  if (typeof a !== 'string') return false;
  const c = validateMoneroAddress(a.trim());
  return c.ok && c.type !== 'integrated';
};

/**
 * The recipient's current tip address: the first valid `payto monero|xmr` of the newest kind 10133;
 * a kind 0 `monero`, `xmr` or `monero_address` field only when there's no NIP-A3 one.
 */
export function currentAddress(events: Event[], pubkey: string): string | null {
  const payto = newest(events, KIND_PAYTO, pubkey);
  const fromPayto = payto?.tags.find((t) => t[0] === 'payto' && /^(monero|xmr)$/i.test(t[1] ?? '') && usable(t[2]))?.[2]?.trim();
  if (fromPayto) return fromPayto;
  const meta = newest(events, 0, pubkey);
  if (!meta) return null;
  try {
    const o = JSON.parse(meta.content) as Record<string, unknown>;
    const v = [o.monero, o.xmr, o.monero_address].find(usable);
    return v ? v.trim() : null;
  } catch {
    return null;
  }
}

export interface Profiles {
  /** pubkey → current address */
  addresses: Map<string, string | null>;
  /** pubkey → NIP-65 relays (read and write), at most 4 */
  relays: Map<string, string[]>;
}

/** Kind 0, 10002 and 10133 for many recipients in one REQ. */
export async function fetchProfiles(pubkeys: string[], relays: string[], query: XapQuery = xapPoolQuery): Promise<Profiles> {
  const events = pubkeys.length ? await query(relays, { kinds: [0, 10002, KIND_PAYTO], authors: pubkeys }) : [];
  const out: Profiles = { addresses: new Map(), relays: new Map() };
  for (const pk of pubkeys) {
    out.addresses.set(pk, currentAddress(events, pk));
    out.relays.set(pk, allRelaysFrom(newest(events, 10002, pk)).filter((r) => r.startsWith('wss://')).slice(0, MAX_INBOX));
  }
  return out;
}

/** Profile-tip receipts, their confirmations by the recipient, and the recipient's deletions of those. */
export async function fetchXapEvents(recipient: string, relays: string[], query: XapQuery = xapPoolQuery): Promise<Event[]> {
  const receipts = (await query(relays, { kinds: [KIND_RECEIPT], '#p': [recipient], limit: MAX_RECEIPTS }))
    .sort((a, b) => b.created_at - a.created_at)
    .slice(0, MAX_RECEIPTS);
  if (!receipts.length) return [];
  const ids = new Set(receipts.map((r) => r.id));
  // the recipient's newest confirmations, not only those for the receipts above, so older confirmed receipts are found too
  const confirmations = (await query(relays, { kinds: [KIND_CONFIRMATION], authors: [recipient], limit: MAX_CONFIRMATIONS }))
    .sort((a, b) => b.created_at - a.created_at)
    .slice(0, MAX_CONFIRMATIONS);
  // a confirmation of a receipt beyond the cap: fetch that receipt by id
  const missing = [...new Set(confirmations.flatMap((c) => c.tags.filter((t) => t[0] === 'e' && t[1] && !ids.has(t[1])).map((t) => t[1]!)))].slice(0, MAX_MISSING);
  const [extra, deletions] = await Promise.all([
    missing.length ? query(relays, { ids: missing, kinds: [KIND_RECEIPT] }) : Promise.resolve([]),
    confirmations.length ? query(relays, { kinds: [KIND_DELETION], authors: [recipient], '#e': confirmations.map((c) => c.id) }) : Promise.resolve([]),
  ]);
  return [...receipts, ...extra, ...confirmations, ...deletions];
}
