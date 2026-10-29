import { orderPathMatches } from './guards';

/**
 * Exchanges whose order pages XMRadar has checked live to carry signed receipts (PLAN-NKIP01 §1.4).
 * Only these get the missing-receipt warning (R12), and only from `receipts_live_at` on. An entry is
 * added in the release after its live check passes: the list starts empty, so the warning is off.
 */
export interface Adopter {
  host: string;
  /** unix seconds: when XMRadar confirmed this issuer's order pages carry receipts */
  receipts_live_at: number;
  order_paths: string[];
}

export const ADOPTERS: readonly Adopter[] = [];

/** The adopter whose order page this is, if the warning applies now. */
export function adopterFor(url: URL, nowSecs: number, adopters: readonly Adopter[] = ADOPTERS): Adopter | null {
  if (url.protocol !== 'https:') return null;
  const host = url.hostname.toLowerCase();
  return adopters.find((a) => (host === a.host || host === `www.${a.host}`) && nowSecs >= a.receipts_live_at && a.order_paths.some((p) => orderPathMatches(p, url.pathname))) ?? null;
}

export const missingReceiptText = (a: Adopter) =>
  `${a.host} has published signed receipts since ${new Date(a.receipts_live_at * 1000).toLocaleDateString()}, but this order page has none. If you deposit, keep a dated screenshot of this page.`;
