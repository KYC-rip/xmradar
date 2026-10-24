import { finalizeEvent, generateSecretKey, getPublicKey, type Event } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';
import { buildMerged, isTarget, newestOwn, tagDiff } from '../src/identity/setup';
import { checkSigned } from '../src/nostr/event';
import { readEach, type RelayReader } from '../src/nostr/relays';

const SUB = '89fM69NVioz94JQrJFLGPDa8PMpjea7TV8JQktbLBLpX9gKMfrt3dge7KMdqg86coZjCxCm3fn1WKdM8WBMJhEdaUimo8Q3';
const STD = '44AFFq5kSiGBoZ4NMDwYtN18obc8AemS33DBLWs3H7otXft3XjrpDtQGv7SqSsaBYBb98uNbr2VBBEt7f2wfn3RVGQBEP3A';

const sk = generateSecretKey();
const pk = getPublicKey(sk);
const ev = (kind: number, tags: string[][], created_at: number, content = '', key = sk): Event => finalizeEvent({ kind, tags, content, created_at }, key);

describe('isTarget', () => {
  it('matches the monero payto in any case, and nothing else in 10133', () => {
    expect(isTarget(10133, ['payto', 'Monero', 'x'])).toBe(true);
    expect(isTarget(10133, ['payto', 'bitcoin', 'x'])).toBe(false);
    expect(isTarget(10133, ['alt', 'Payment targets'])).toBe(false);
  });
  it('matches only the twitter tag for this handle in 10011, normalizing case and @', () => {
    expect(isTarget(10011, ['i', 'twitter:@Alice', '1'], 'alice')).toBe(true);
    expect(isTarget(10011, ['i', 'Twitter:alice', '1'], '@ALICE')).toBe(true);
    expect(isTarget(10011, ['i', 'twitter:bob', '1'], 'alice')).toBe(false);
    expect(isTarget(10011, ['i', 'github:alice', 'x'], 'alice')).toBe(false);
    expect(isTarget(10011, ['i', 'twitter:alice', '1'])).toBe(false);
  });
});

describe('buildMerged', () => {
  const current = ev(10133, [['payto', 'bitcoin', 'bc1q'], ['payto', 'monero', STD], ['alt', 'Payment targets'], ['client', 'Ditto']], 1000, 'keep me');

  it('replaces the monero payto and keeps every other tag in order, plus the content', () => {
    const t = buildMerged(current, { type: 'add-address', address: SUB }, 2000);
    expect(t).toEqual({
      kind: 10133,
      content: 'keep me',
      created_at: 2000,
      tags: [['payto', 'bitcoin', 'bc1q'], ['alt', 'Payment targets'], ['client', 'Ditto'], ['payto', 'monero', SUB]],
    });
  });

  it('goes strictly after the current event when the clock is behind', () => {
    expect(buildMerged(current, { type: 'remove-address' }, 500).created_at).toBe(1001);
  });

  it('removes the address', () => {
    expect(buildMerged(current, { type: 'remove-address' }, 2000).tags).toEqual([['payto', 'bitcoin', 'bc1q'], ['alt', 'Payment targets'], ['client', 'Ditto']]);
  });

  it('links X with a tweet URL and keeps claims for other handles and services', () => {
    const ids = ev(10011, [['i', 'github:me', 'gist'], ['i', 'twitter:Alice', '1'], ['i', 'twitter:oldalt', '2']], 1000);
    const t = buildMerged(ids, { type: 'link-x', handle: '@Alice', tweetId: '42' }, 2000);
    expect(t.tags).toEqual([['i', 'github:me', 'gist'], ['i', 'twitter:oldalt', '2'], ['i', 'twitter:alice', 'https://x.com/alice/status/42']]);
    expect(buildMerged(ids, { type: 'unlink-x', handle: 'alice' }, 2000).tags).toEqual([['i', 'github:me', 'gist'], ['i', 'twitter:oldalt', '2']]);
  });

  it('starts a new list when there is none', () => {
    expect(buildMerged(null, { type: 'add-address', address: SUB }, 2000)).toEqual({ kind: 10133, content: '', created_at: 2000, tags: [['payto', 'monero', SUB]] });
  });

  it('rejects a bad handle, address or tweet ID', () => {
    expect(() => buildMerged(null, { type: 'link-x', handle: 'no spaces', tweetId: '1' })).toThrow(/handle/);
    expect(() => buildMerged(null, { type: 'link-x', handle: 'alice', tweetId: '1/../2' })).toThrow(/tweet/);
    expect(() => buildMerged(null, { type: 'add-address', address: 'bc1q' })).toThrow(/Monero/);
  });
});

describe('newestOwn', () => {
  it('takes the newest validly signed event by this pubkey only', () => {
    const other = generateSecretKey();
    const old = ev(10133, [['payto', 'monero', STD]], 100);
    const fresh = ev(10133, [['payto', 'monero', SUB]], 200);
    const foreign = ev(10133, [], 300, '', other);
    const forged = { ...ev(10133, [], 400), sig: 'ab'.repeat(64) };
    expect(newestOwn([old, foreign, fresh, forged], 10133, pk)?.id).toBe(fresh.id);
    expect(newestOwn([foreign], 10133, pk)).toBeNull();
  });
});

describe('readEach (MERGE-2)', () => {
  it('drops a relay that is down, even if it holds a newer event, and reports it', async () => {
    const onUp = ev(10133, [['payto', 'monero', STD], ['alt', 'x']], 100);
    const reader: RelayReader = async (url) => {
      if (url === 'wss://down') throw new Error('no EOSE');
      return [onUp];
    };
    const read = await readEach(['wss://a', 'wss://down', 'wss://b'], { kinds: [10133], authors: [pk] }, 100, reader);
    expect(read.readable).toEqual(['wss://a', 'wss://b']);
    expect(read.unreadable).toEqual(['wss://down']);
    // the merge only builds on what could be read; the publish set is `readable`
    expect(buildMerged(newestOwn(read.events, 10133, pk), { type: 'add-address', address: SUB }, 50).created_at).toBe(101);
  });

  it('reports every relay unreadable when all fail', async () => {
    const read = await readEach(['wss://a', 'wss://b'], { kinds: [1] }, 100, async () => Promise.reject(new Error('x')));
    expect(read.readable).toEqual([]);
  });
});

describe('tagDiff', () => {
  it('lists removed tags, then the new list marked added or kept', () => {
    expect(tagDiff([['a'], ['payto', 'monero', STD]], [['a'], ['payto', 'monero', SUB]])).toEqual([
      { op: '-', tag: ['payto', 'monero', STD] },
      { op: ' ', tag: ['a'] },
      { op: '+', tag: ['payto', 'monero', SUB] },
    ]);
    expect(tagDiff(null, [['x']])).toEqual([{ op: '+', tag: ['x'] }]);
  });

  it('counts duplicate tags separately', () => {
    expect(tagDiff([['a'], ['a']], [['a']])).toEqual([{ op: '-', tag: ['a'] }, { op: ' ', tag: ['a'] }]);
    expect(tagDiff([['a']], [['a'], ['a']])).toEqual([{ op: ' ', tag: ['a'] }, { op: '+', tag: ['a'] }]);
  });
});

describe('one-shot signing check', () => {
  const template = buildMerged(null, { type: 'add-address', address: SUB }, 2000);
  it('accepts exactly the template signed by the expected key', () => {
    expect(() => checkSigned(template, finalizeEvent({ ...template, tags: template.tags.map((t) => [...t]) }, sk), pk)).not.toThrow();
  });
  it('rejects changed tags, another key or a bad signature', () => {
    const changed = finalizeEvent({ ...template, tags: [['payto', 'monero', STD]] }, sk);
    expect(() => checkSigned(template, changed, pk)).toThrow(/modified/);
    const otherKey = finalizeEvent({ ...template }, generateSecretKey());
    expect(() => checkSigned(template, otherKey, pk)).toThrow(/different pubkey/);
    const good = finalizeEvent({ ...template }, sk);
    expect(() => checkSigned(template, { ...good, sig: '00'.repeat(64) }, pk)).toThrow(/signature/);
    expect(() => checkSigned(template, { ...good, created_at: 1 }, pk)).toThrow(/modified/);
  });
});
