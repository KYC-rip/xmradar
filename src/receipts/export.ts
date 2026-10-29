import type { SavedReceipt } from './store';

/**
 * A saved receipt as a file the user keeps for a dispute (NKIP-0001 order and dispute flow): the signed
 * receipt (with its salt, which a verifier needs to recompute the commitment), the manifest it was
 * checked against, the policy bytes as served, and what the public-record check found.
 */
export interface ReceiptExport {
  format: 'xmradar-nkip01-receipt/1';
  exportedAt: string;
  receipt: SavedReceipt['receipt'];
  commitment: string;
  page: string;
  savedAt: string;
  eventId?: string;
  manifest?: SavedReceipt['manifest'];
  /** base64 of the policy bytes exactly as served */
  policy?: { hash: string; base64: string };
  publicRecord?: SavedReceipt['publicRecord'];
}

const base64 = (b: Uint8Array) => btoa(Array.from(b, (c) => String.fromCharCode(c)).join(''));

export function buildExport(s: SavedReceipt, policy: Uint8Array | null, now: number): ReceiptExport {
  return {
    format: 'xmradar-nkip01-receipt/1',
    exportedAt: new Date(now).toISOString(),
    receipt: s.receipt,
    commitment: s.commitment,
    page: s.page,
    savedAt: new Date(s.savedAt).toISOString(),
    ...(s.eventId ? { eventId: s.eventId } : {}),
    ...(s.manifest ? { manifest: s.manifest } : {}),
    ...(policy ? { policy: { hash: s.receipt.policy_hash, base64: base64(policy) } } : {}),
    ...(s.publicRecord ? { publicRecord: s.publicRecord } : {}),
  };
}

export const EXPORT_WARNING = 'Contains your swap’s addresses and salt: anyone with this file can link your deposit to your payout.';
