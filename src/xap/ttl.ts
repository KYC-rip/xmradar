import type { XapTotals } from '../messaging';
import { parseXmr } from './amount';
/** Totals cache lifetime: an empty result can be a relay hiccup, so it's kept briefly. */
export const XAP_TTL_MS = 10 * 60_000;
export const XAP_EMPTY_TTL_MS = 2 * 60_000;
export const xapTtl = (t: XapTotals) => (parseXmr(t.verified) || parseXmr(t.verifying) || parseXmr(t.claimed) ? XAP_TTL_MS : XAP_EMPTY_TTL_MS);
