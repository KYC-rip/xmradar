import { SimplePool } from 'nostr-tools/pool';
import { Relay } from 'nostr-tools/relay';
import type { Filter } from 'nostr-tools/filter';
import type { Event } from 'nostr-tools/pure';
import type { RelayResult } from '../messaging';

export const PUBLISH_TIMEOUT_MS = 6000;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
}

/** Fresh pool per call: MV3 background may be suspended between calls, so keep no state. */
export async function publishToRelays(relays: string[], event: Event, timeoutMs = PUBLISH_TIMEOUT_MS): Promise<RelayResult[]> {
  const pool = new SimplePool();
  try {
    const settled = await Promise.allSettled(
      pool.publish(relays, event, { maxWait: timeoutMs }).map((p) => withTimeout(p, timeoutMs + 500)),
    );
    return settled.map((s, i) => ({
      relay: relays[i]!,
      ok: s.status === 'fulfilled',
      message: s.status === 'fulfilled' ? s.value || 'ok' : String((s.reason as Error)?.message ?? s.reason),
    }));
  } finally {
    pool.close(relays);
  }
}

/** Write relays from the newest kind-10002 list (NIP-65). Unmarked entries count as read+write. */
export function writeRelaysFrom(list: Event | null): string[] {
  if (!list) return [];
  const out = new Set<string>();
  for (const t of list.tags) {
    if (t[0] === 'r' && t[1] && (!t[2] || t[2] === 'write')) out.add(t[1].replace(/\/+$/, ''));
  }
  return [...out];
}

export async function fetchWriteRelays(pubkey: string, lookupRelays: string[]): Promise<string[]> {
  const pool = new SimplePool();
  try {
    const events = await pool.querySync(lookupRelays, { kinds: [10002], authors: [pubkey] }, { maxWait: 4000 });
    const newest = events.sort((a, b) => b.created_at - a.created_at)[0] ?? null;
    return writeRelaysFrom(newest);
  } finally {
    pool.close(lookupRelays);
  }
}

/** All relays in a kind-10002 list, read and write. */
export function allRelaysFrom(list: Event | null): string[] {
  if (!list) return [];
  return [...new Set(list.tags.filter((t) => t[0] === 'r' && t[1]).map((t) => t[1]!.replace(/\/+$/, '')))];
}

/** Events from one relay; throws unless the relay answered with EOSE in time. */
export type RelayReader = (url: string, filter: Filter, timeoutMs: number) => Promise<Event[]>;

export const readRelay: RelayReader = async (url, filter, timeoutMs) => {
  const connecting = Relay.connect(url);
  const relay = await Promise.race([
    connecting,
    new Promise<never>((_, rej) => setTimeout(() => rej(new Error('connect timeout')), timeoutMs)),
  ]).catch((e) => {
    // close the socket if it connects after we gave up
    connecting.then((r) => r.close(), () => {});
    throw e;
  });
  try {
    return await new Promise<Event[]>((resolve, reject) => {
      const events: Event[] = [];
      // our own timer: nostr-tools fires oneose on its eoseTimeout too, which would look like success
      // settle before closing: close() fires onclose synchronously
      let sub: { close(): void } | undefined;
      const timer = setTimeout(() => (reject(new Error('no EOSE')), sub?.close()), timeoutMs);
      sub = relay.subscribe([filter], {
        eoseTimeout: timeoutMs * 10,
        onevent: (e) => events.push(e),
        oneose: () => (clearTimeout(timer), resolve(events), sub?.close()),
        onclose: (reason) => (clearTimeout(timer), reject(new Error(reason || 'closed'))),
      });
    });
  } finally {
    relay.close();
  }
};

export interface ReadResult {
  events: Event[];
  /** relays that answered with EOSE */
  readable: string[];
  /** relays that errored or timed out */
  unreadable: string[];
}

/** Read every relay separately, so the caller knows exactly which ones it couldn't read (MERGE-2). */
export async function readEach(relays: string[], filter: Filter, timeoutMs = 5000, reader: RelayReader = readRelay): Promise<ReadResult> {
  const settled = await Promise.allSettled(relays.map((r) => reader(r, filter, timeoutMs)));
  const out: ReadResult = { events: [], readable: [], unreadable: [] };
  settled.forEach((s, i) => {
    if (s.status === 'fulfilled') {
      out.readable.push(relays[i]!);
      out.events.push(...s.value);
    } else {
      out.unreadable.push(relays[i]!);
    }
  });
  return out;
}
