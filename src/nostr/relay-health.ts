import type { RelayResult } from '../messaging';
import type { PostRelaySource } from './post-relays';

/**
 * Relays that keep failing (PLAN-DEADRELAYS): one that failed on 3 posts in a row is skipped for a day,
 * then tried once again. Only XMRadar's own record; the user's relay list is never changed.
 */

export interface HealthEntry {
  fails: number;
  skipUntil?: number;
  /** when its last result was recorded */
  at: number;
}
export type Health = Record<string, HealthEntry>;

export const FAILS_TO_SKIP = 3;
export const SKIP_MS = 24 * 3600_000;
export const MAX_HEALTH = 200;

/** Each result counted: an accepted post clears the relay, a failure of any kind adds one. */
export function recordResults(health: Health, results: RelayResult[], now: number): Health {
  const next = { ...health };
  for (const r of results) {
    if (r.ok) {
      delete next[r.relay];
      continue;
    }
    const fails = (next[r.relay]?.fails ?? 0) + 1;
    next[r.relay] = { fails, at: now, ...(fails >= FAILS_TO_SKIP ? { skipUntil: now + SKIP_MS } : {}) };
  }
  // the newest 200; same time → by name, so the cut never depends on insertion order
  const kept = Object.entries(next)
    .sort(([a, x], [b, y]) => y.at - x.at || (a < b ? -1 : a > b ? 1 : 0))
    .slice(0, MAX_HEALTH);
  return Object.fromEntries(kept);
}

export interface Partition {
  use: string[];
  skipped: string[];
  /** every relay was being skipped, so all were used */
  overridden: boolean;
}

/** The relays to post to now. Never none: when all would be skipped, all are used. */
export function partition(health: Health, relays: string[], now: number): Partition {
  const skipped = relays.filter((r) => (health[r]?.skipUntil ?? 0) > now);
  if (relays.length && skipped.length === relays.length) return { use: [...relays], skipped: [], overridden: true };
  return { use: relays.filter((r) => !skipped.includes(r)), skipped, overridden: false };
}

/**
 * The stored record, read and written one call at a time: parallel copies can't lose each other's
 * failures, and a partition sees every result recorded before it was asked.
 */
export function healthStore(item: { getValue(): Promise<Health>; setValue(v: Health): Promise<void> }, now: () => number = Date.now) {
  let chain: Promise<unknown> = Promise.resolve();
  const queued = <T>(f: () => Promise<T>): Promise<T> => {
    const run = chain.then(f);
    chain = run.then(
      () => {},
      () => {},
    );
    return run;
  };
  return {
    record: (results: RelayResult[]) => queued(async () => item.setValue(recordResults(await item.getValue(), results, now()))),
    partition: (relays: string[]) => queued(async () => partition(await item.getValue(), relays, now())),
  };
}

const host = (url: string) => url.replace(/^wss?:\/\//, '').replace(/\/+$/, '');

/** The line under a publish's results about skipped relays; empty when there's nothing to say. */
export function relayNotice(skipped: string[], source: PostRelaySource, overridden: boolean): string {
  if (overridden) return 'Every relay has been failing lately, so XMRadar tried them all.';
  if (!skipped.length) return '';
  const n = skipped.length;
  const head = `Skipped ${n === 1 ? '1 relay that' : `${n} relays that`} failed on your last ${FAILS_TO_SKIP} posts: ${skipped.map(host).join(', ')}. XMRadar tries ${n === 1 ? 'it' : 'each'} again once a day.`;
  // the source of this publish's relays: one per publish (your list, your NIP-65 list or XMRadar's picks)
  const them = n === 1 ? 'it' : 'them';
  const fix =
    source === 'nip65'
      ? ` ${n === 1 ? "It's" : "They're"} in your NIP-65 relay list; remove ${them} in your Nostr client's relay settings.`
      : source === 'manual'
        ? ` Remove ${them} under Options → Posting → Relays.`
        : '';
  return head + fix;
}
