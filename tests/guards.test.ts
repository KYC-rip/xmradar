import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';
import { blossomAuthTemplate, checkBlossomAuth, encodeAuthHeader } from '../src/nostr/event';
import { assertFetchableImageUrl } from '../src/nostr/url-guard';
import { checkSessionSender, isExtensionPageSender } from '../src/sender';

const RID = 'ext-id';
const BASE = 'chrome-extension://ext-id/';

describe('isExtensionPageSender', () => {
  it('accepts the options page even when it is opened in a tab', () => {
    expect(isExtensionPageSender({ id: RID, url: `${BASE}options.html`, tab: { id: 7 } }, RID, BASE)).toBe(true);
  });
  it('rejects content scripts and other extensions', () => {
    expect(isExtensionPageSender({ id: RID, url: 'https://x.com/home', tab: { id: 7 } }, RID, BASE)).toBe(false);
    expect(isExtensionPageSender({ id: 'other', url: `${BASE}options.html` }, RID, BASE)).toBe(false);
  });
});

describe('checkSessionSender', () => {
  const sessions = [{ id: 's1', tabId: 3, expires: 2000 }];
  it('accepts the matching tab within the TTL', () => {
    expect(() => checkSessionSender(sessions, 's1', { id: RID, tab: { id: 3 } }, RID, 1000)).not.toThrow();
  });
  it('rejects other tabs, unknown/expired sessions and foreign senders', () => {
    expect(() => checkSessionSender(sessions, 's1', { id: RID, tab: { id: 4 } }, RID, 1000)).toThrow(/another tab/);
    expect(() => checkSessionSender(sessions, 's1', { id: RID, tab: { id: 3 } }, RID, 3000)).toThrow(/expired/);
    expect(() => checkSessionSender(sessions, 'nope', { id: RID, tab: { id: 3 } }, RID, 1000)).toThrow(/expired/);
    expect(() => checkSessionSender(sessions, 's1', { id: 'x', tab: { id: 3 } }, RID, 1000)).toThrow(/Unknown sender/);
  });
});

describe('assertFetchableImageUrl', () => {
  it.each(['https://pbs.twimg.com/media/a.jpg', 'http://example.com/a.png', 'data:image/png;base64,AAAA'])('allows %s', (url) => {
    expect(() => assertFetchableImageUrl(url)).not.toThrow();
  });
  it.each([
    'file:///etc/passwd',
    'http://127.0.0.1/a.png',
    'http://localhost:8080/a.png',
    'http://192.168.1.1/a.png',
    'http://10.0.0.5/a.png',
    'http://172.16.0.1/a.png',
    'http://[::1]/a.png',
    'http://printer.local/a.png',
    'data:text/html,hi',
    'blob:https://x.com/123',
    'http://[::ffff:127.0.0.1]/a.png',
    'http://[::ffff:169.254.169.254]/a.png',
    'http://localhost./a.png',
    'http://[fec0::1]/a.png',
  ])('blocks %s', (url) => {
    expect(() => assertFetchableImageUrl(url)).toThrow();
  });
});

describe('checkBlossomAuth', () => {
  const sk = generateSecretKey();
  it('accepts a valid, unexpired auth for the same blob', () => {
    expect(() => checkBlossomAuth(encodeAuthHeader(finalizeEvent(blossomAuthTemplate('aa', 1000), sk)), 'aa', 1100)).not.toThrow();
  });
  it('rejects wrong hash, expired, wrong kind and bad signature', () => {
    const ev = finalizeEvent(blossomAuthTemplate('aa', 1000), sk);
    expect(() => checkBlossomAuth(encodeAuthHeader(ev), 'bb', 1100)).toThrow(/does not match/);
    expect(() => checkBlossomAuth(encodeAuthHeader(ev), 'aa', 1400)).toThrow(/does not match/);
    expect(() => checkBlossomAuth(encodeAuthHeader(finalizeEvent({ ...blossomAuthTemplate('aa', 1000), kind: 1 }, sk)), 'aa', 1100)).toThrow();
    expect(() => checkBlossomAuth(encodeAuthHeader({ ...ev, content: 'x' }), 'aa', 1100)).toThrow(/signature/);
    expect(() => checkBlossomAuth('Nostr !!!', 'aa')).toThrow(/Malformed/);
    const noExp = finalizeEvent({ ...blossomAuthTemplate('aa', 1000), tags: [['t', 'upload'], ['x', 'aa']] }, sk);
    expect(() => checkBlossomAuth(encodeAuthHeader(noExp), 'aa', 1100)).toThrow(/does not match/);
    const badTags = btoa(JSON.stringify({ ...ev, tags: 'nope' }));
    expect(() => checkBlossomAuth(`Nostr ${badTags}`, 'aa', 1100)).toThrow(/Malformed/);
  });
});
