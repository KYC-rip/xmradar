import { describe, expect, it } from 'vitest';
import { retryable } from '../src/nostr/retry';

const r = (ok: boolean, message: string) => ({ relay: 'wss://r', ok, message });

describe('which failed relays a retry tries again', () => {
  it('connection failures and timeouts, yes', () => {
    for (const m of ['connection failure: connection failed', 'publish timed out', 'error: database busy', 'rate-limited: slow down'])
      expect(retryable(r(false, m)), m).toBe(true);
  });
  it('refusals that will repeat, and successes, no', () => {
    for (const m of ['blocked: you do not have a Nostr Plebs NIP-05.', 'restricted: paid relay', 'invalid: bad sig', 'pow: difficulty 20', 'auth-required: login', ' Blocked: x'])
      expect(retryable(r(false, m)), m).toBe(false);
    expect(retryable(r(true, 'ok'))).toBe(false);
  });
});
