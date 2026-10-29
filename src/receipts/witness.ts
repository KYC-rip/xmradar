import type { Event } from 'nostr-tools/pure';
import { safeRelay } from './guards';
import type { PublicRecord, SavedReceipt } from './store';
import { checkAttestationEvent, KIND_ATTESTATION } from './verify';

/**
 * The public-record check (PLAN-NKIP01 §12, §12.1): only when the user asks, from Options, and only
 * for receipts at least an hour old, since relays see the IP asking about the commitment. The event
 * id the page showed is tried first; then the commitment. Never run from the order page.
 */

export const LOOKUP_MIN_AGE_MS = 60 * 60_000;
const MAX_RELAYS = 6;

export type RelayQuery = (relay: string, filter: { kinds: number[]; ids?: string[]; '#c'?: string[]; limit?: number }) => Promise<Event[]>;

/** ms until the check may run, or 0. */
export const lookupWaitMs = (s: SavedReceipt, now: number) => Math.max(0, s.savedAt + LOOKUP_MIN_AGE_MS - now);

/** The issuer's relays that pass the guard, then the user's, at most 6. */
export function lookupRelays(s: SavedReceipt, mine: string[]): string[] {
  return [...new Set([...(s.manifest?.relays ?? []), ...mine])].filter(safeRelay).slice(0, MAX_RELAYS);
}

export async function checkPublicRecord(s: SavedReceipt, mine: string[], query: RelayQuery, now: number): Promise<PublicRecord> {
  if (lookupWaitMs(s, now) > 0) throw new Error('Too early: relays would see your IP asking about this order');
  if (!s.manifest) throw new Error('The issuer’s manifest wasn’t read for this receipt, so a record can’t be checked');
  const asked = lookupRelays(s, mine);
  const seen: string[] = [];
  let saltBoxMissing: boolean | undefined;
  await Promise.all(
    asked.map(async (relay) => {
      const valid = async (filter: Parameters<RelayQuery>[1]) =>
        (await query(relay, filter).catch(() => [] as Event[])).map((e) => checkAttestationEvent(e, s.receipt, s.manifest!)).find((r) => r.ok);
      // the id the page showed first; a page may show a wrong one, so the commitment is the fallback
      const byId = s.eventId ? await valid({ kinds: [KIND_ATTESTATION], ids: [s.eventId] }) : undefined;
      const found = byId ?? (await valid({ kinds: [KIND_ATTESTATION], '#c': [s.commitment], limit: 20 }));
      if (found?.ok) {
        seen.push(relay);
        saltBoxMissing ||= found.saltBoxMissing;
      }
    }),
  );
  return { checkedAt: now, seen: asked.filter((r) => seen.includes(r)), asked, ...(saltBoxMissing ? { saltBoxMissing } : {}) };
}
