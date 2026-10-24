import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { afterEach, describe, expect, it } from 'vitest';
import { callBridge, installBridge } from '../src/bridge';

const sk = generateSecretKey();
const w = window as unknown as { nostr?: unknown; __s2nBridge?: boolean };

// happy-dom's MessageEvent.source isn't the window itself, unlike real browsers
window.postMessage = ((data: unknown) =>
  setTimeout(() => window.dispatchEvent(new MessageEvent('message', { data, source: window as never })), 0)) as never;

describe('bridge', () => {
  installBridge();
  afterEach(() => delete w.nostr);

  it('proxies getPublicKey and signEvent to window.nostr', async () => {
    w.nostr = { getPublicKey: async () => getPublicKey(sk), signEvent: async (t: never) => finalizeEvent(t, sk) };
    expect(await callBridge('getPublicKey')).toBe(getPublicKey(sk));
    const signed = await callBridge<{ kind: number; content: string }>('signEvent', { kind: 1, content: 'hi', tags: [], created_at: 1 });
    expect(signed).toMatchObject({ kind: 1, content: 'hi', pubkey: getPublicKey(sk) });
  });

  it('refuses kinds outside the allowlist', async () => {
    w.nostr = { signEvent: async (t: never) => finalizeEvent(t, sk) };
    await expect(callBridge('signEvent', { kind: 0, content: '{}', tags: [], created_at: 1 })).rejects.toThrow(/rejected/);
  });

  it('waits for a late signer, then reports when none exists', async () => {
    setTimeout(() => (w.nostr = { getPublicKey: async () => 'late' }), 300);
    expect(await callBridge('getPublicKey')).toBe('late');
    delete w.nostr;
    await expect(callBridge('getPublicKey')).rejects.toThrow(/No NIP-07 signer/);
  }, 10_000);
});
