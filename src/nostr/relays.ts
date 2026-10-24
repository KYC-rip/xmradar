import { SimplePool } from 'nostr-tools/pool';
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
