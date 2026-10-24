import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';
import { blossomAuthTemplate, buildNote, checkSigned, dedupeKey, encodeAuthHeader, imetaTag, normalizeUrl } from '../src/nostr/event';
import { writeRelaysFrom } from '../src/nostr/relays';
import { parseRelayList } from '../src/settings';

describe('buildNote', () => {
  it('appends images, dedupes by hash, adds imeta and client tags', () => {
    const img = { url: 'https://b.example/aa.png', mime: 'image/png', sha256: 'aa', dim: '10x20', alt: 'a  cat\n' };
    const ev = buildNote({ text: ' hi ', images: [img, { ...img, url: 'https://other/aa.png' }], now: 100 });
    expect(ev).toEqual({
      kind: 1,
      created_at: 100,
      content: 'hi\n\nhttps://b.example/aa.png',
      tags: [['imeta', 'url https://b.example/aa.png', 'm image/png', 'x aa', 'dim 10x20', 'alt a cat'], ['client', 'XMRadar']],
    });
  });
  it('optionally appends the source link with an r tag', () => {
    const ev = buildNote({ text: 'hi', images: [], sourceUrl: 'https://twitter.com/a/status/1?s=20', appendSource: true, now: 1 });
    expect(ev.content).toBe('hi\n\nhttps://x.com/a/status/1');
    expect(ev.tags).toContainEqual(['r', 'https://x.com/a/status/1']);
    expect(buildNote({ text: 'hi', images: [], sourceUrl: 'https://x.com/a', now: 1 }).content).toBe('hi');
  });
  it('imeta only includes known fields', () => {
    expect(imetaTag({ url: 'u' })).toEqual(['imeta', 'url u']);
  });
});

describe('blossom auth', () => {
  it('builds a BUD-02 upload auth that expires in 5 minutes', () => {
    expect(blossomAuthTemplate('ff', 1000)).toEqual({
      kind: 24242,
      created_at: 1000,
      content: 'Upload image',
      tags: [['t', 'upload'], ['x', 'ff'], ['expiration', '1300']],
    });
  });
  it('encodes the header as base64 JSON', () => {
    const sk = generateSecretKey();
    const ev = finalizeEvent(blossomAuthTemplate('ff', 1), sk);
    const header = encodeAuthHeader(ev);
    expect(header.startsWith('Nostr ')).toBe(true);
    expect(JSON.parse(atob(header.slice(6)))).toEqual(JSON.parse(JSON.stringify(ev)));
  });
});

describe('checkSigned', () => {
  const sk = generateSecretKey();
  const pk = getPublicKey(sk);
  const template = buildNote({ text: 'x', images: [], now: 5 });
  it('accepts a faithful signature', () => {
    expect(() => checkSigned(template, finalizeEvent(template, sk), pk)).not.toThrow();
  });
  it('rejects tampered, foreign or invalid events', () => {
    expect(() => checkSigned(template, finalizeEvent({ ...template, content: 'evil' }, sk), pk)).toThrow(/modified/);
    expect(() => checkSigned(template, finalizeEvent(template, generateSecretKey()), pk)).toThrow(/different pubkey/);
    expect(() => checkSigned(template, { ...finalizeEvent(template, sk), sig: '00'.repeat(64) }, pk)).toThrow(/signature/);
  });
});

describe('dedupe', () => {
  it('normalizes tracking params, hosts and fragments', () => {
    expect(normalizeUrl('https://twitter.com/a/status/1?s=20&t=abc#x')).toBe('https://x.com/a/status/1');
    expect(normalizeUrl('https://www.blog.example/p?id=3&utm_source=t&fbclid=1')).toBe('https://blog.example/p?id=3');
  });
  it('produces the same key for equivalent URLs', async () => {
    expect(await dedupeKey('https://x.com/a/status/1?s=20', 'hi ')).toBe(await dedupeKey('https://twitter.com/a/status/1', 'hi'));
    expect(await dedupeKey('https://x.com/a/status/1', 'hi')).not.toBe(await dedupeKey('https://x.com/a/status/1', 'edited'));
  });
});

describe('relays', () => {
  it('reads write relays from NIP-65', () => {
    const list = { tags: [['r', 'wss://a/'], ['r', 'wss://b', 'read'], ['r', 'wss://c', 'write'], ['p', 'x']] } as never;
    expect(writeRelaysFrom(list)).toEqual(['wss://a', 'wss://c']);
    expect(writeRelaysFrom(null)).toEqual([]);
  });
  it('parses relay textarea input', () => {
    expect(parseRelayList('wss://a.com/\n  wss://a.com, https://no\nwss://b.io')).toEqual(['wss://a.com', 'wss://b.io']);
    expect(parseRelayList('ws://evil.example ws://localhost:7777')).toEqual(['ws://localhost:7777']);
    expect(parseRelayList('wss://relay.example/nostr/')).toEqual(['wss://relay.example/nostr']);
  });
});
