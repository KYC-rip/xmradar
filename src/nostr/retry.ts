import type { RelayResult } from '../messaging';

/**
 * A failure worth trying again: the connection or the time ran out. A relay that refused the event
 * (NIP-01 `blocked:`, `restricted:`, `invalid:`, `pow:`, `auth-required:`) will refuse it again.
 */
export const retryable = (r: RelayResult) => !r.ok && !/^(blocked|restricted|invalid|pow|auth-required):/i.test(r.message.trim());

/**
 * A publish that needs nothing more from the user (PLAN-DEADRELAYS): accepted somewhere, and either no
 * failure worth retrying or at least 2 relays have it. The pill closes itself and the dock lets it go.
 */
export function settled(results: RelayResult[]): boolean {
  const ok = results.filter((r) => r.ok).length;
  return ok >= 1 && (ok >= 2 || !results.some(retryable));
}
