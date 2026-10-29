import type { RelayResult } from '../messaging';

/**
 * A failure worth trying again: the connection or the time ran out. A relay that refused the event
 * (NIP-01 `blocked:`, `restricted:`, `invalid:`, `pow:`, `auth-required:`) will refuse it again.
 */
export const retryable = (r: RelayResult) => !r.ok && !/^(blocked|restricted|invalid|pow|auth-required):/i.test(r.message.trim());
