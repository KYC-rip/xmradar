import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { decode, npubEncode } from 'nostr-tools/nip19';
import { finalizeEvent, generateSecretKey, getPublicKey, type Event } from 'nostr-tools/pure';
import { describe, expect, it, vi } from 'vitest';
import { badgePanel, renderBadge } from '../src/entrypoints/content/tip';
import { PendingQueue, TokenBucket } from '../src/identity/bucket';
import { EntryCache } from '../src/identity/cache';
import {
  containsNpub,
  fetchPayto,
  findClaims,
  moneroPayto,
  oembedText,
  parseTweetProof,
  syndicationToken,
  twitterClaims,
  verifyTwitterProof,
  type QueryFn,
} from '../src/identity/nostr';
import { discoverNostr, mergeBadge, resolveHandles, withoutNostr, type BadgeEntry } from '../src/identity/resolve';
import { profileSlot, tweetSlot } from '../src/identity/x-handle';
import { makeDoc } from './helpers';

const fixture = (name: string) => JSON.parse(readFileSync(join(process.cwd(), 'tests/fixtures', name), 'utf8'));
// a real NIP-39 proof tweet by @abengisme, recorded from oEmbed and syndication
const OEMBED = fixture('oembed-nip39-abengisme.json');
const SYND = fixture('syndication-nip39-abengisme.json');
const ABENG_NPUB = 'npub1q7g8dyxw8lkrp7eq38445cwpga2gcfzt4ptqtecn67v3e48qzhmqwgk6wr';
const ABENG_PK = decode(ABENG_NPUB).data as string;
const ABENG_TWEET = '1777680685995528555';

const SUB = '89fM69NVioz94JQrJFLGPDa8PMpjea7TV8JQktbLBLpX9gKMfrt3dge7KMdqg86coZjCxCm3fn1WKdM8WBMJhEdaUimo8Q3';
const STD = '44AFFq5kSiGBoZ4NMDwYtN18obc8AemS33DBLWs3H7otXft3XjrpDtQGv7SqSsaBYBb98uNbr2VBBEt7f2wfn3RVGQBEP3A';

function signed(sk: Uint8Array, kind: number, tags: string[][], created_at = 1_700_000_000): Event {
  return finalizeEvent({ kind, tags, content: '', created_at }, sk);
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

/** fetch mock routed by host */
function routes(oembed: () => Response | Promise<Response>, synd: () => Response | Promise<Response>) {
  return vi.fn(async (url: string) => (String(url).startsWith('https://publish.twitter.com/') ? oembed() : synd())) as unknown as typeof fetch;
}

describe('parseTweetProof', () => {
  it('accepts a bare ID or a tweet URL by the claimed handle', () => {
    expect(parseTweetProof('123', 'jack')).toBe('123');
    expect(parseTweetProof('https://x.com/Jack/status/123', 'jack')).toBe('123');
    expect(parseTweetProof('https://twitter.com/jack/status/123?s=20', 'jack')).toBe('123');
  });
  it('rejects URLs by another account and junk', () => {
    expect(parseTweetProof('https://x.com/other/status/123', 'jack')).toBeNull();
    expect(parseTweetProof('https://evil.com/jack/status/123', 'jack')).toBeNull();
    expect(parseTweetProof('12a', 'jack')).toBeNull();
    expect(parseTweetProof(undefined, 'jack')).toBeNull();
  });
});

describe('twitterClaims / findClaims', () => {
  const sk = generateSecretKey();
  it('normalizes handle case and ignores other identities', () => {
    const e = signed(sk, 10011, [['i', 'twitter:VorticeDistopic', '2112311305038131559'], ['i', 'github:jack', 'abc'], ['i', 'twitter:someoneelse', '1']]);
    expect(twitterClaims(e, new Set(['vorticedistopic']))).toEqual([{ pubkey: e.pubkey, handle: 'vorticedistopic', tweetId: '2112311305038131559', createdAt: e.created_at }]);
  });

  it('queries both spellings, keeps the newest valid event per pubkey and every claimer', async () => {
    const other = generateSecretKey();
    const old = signed(sk, 10011, [['i', 'twitter:Alice', '1']], 100);
    const fresh = signed(sk, 10011, [['i', 'twitter:alice', '2']], 200);
    const rival = signed(other, 10011, [['i', 'twitter:alice', '3']], 150);
    const forged = { ...signed(other, 10011, [['i', 'twitter:alice', '4']], 999), sig: '00'.repeat(64) };
    const query = vi.fn<QueryFn>(async () => [old, fresh, rival, forged]);
    const claims = await findClaims(['Alice'], ['wss://r'], query);
    expect(query.mock.calls[0]![1]['#i']).toEqual(['twitter:Alice', 'twitter:alice']);
    expect(claims.map((c) => c.tweetId).sort()).toEqual(['2', '3']);
  });
});

describe('payto', () => {
  const sk = generateSecretKey();
  it('takes the first valid monero payto, or reports the invalid one', () => {
    const e = signed(sk, 10133, [['payto', 'bitcoin', 'bc1q'], ['payto', 'Monero', 'bad'], ['payto', 'monero', SUB]]);
    expect(moneroPayto(e)).toMatchObject({ address: SUB, check: { ok: true } });
    expect(moneroPayto(signed(sk, 10133, [['payto', 'monero', 'bad']]))).toMatchObject({ address: 'bad', check: { ok: false } });
    expect(moneroPayto(signed(sk, 10133, [['payto', 'bitcoin', 'bc1q']]))).toBeNull();
  });
  it('uses the newest event per pubkey', async () => {
    const events = [signed(sk, 10133, [['payto', 'monero', STD]], 100), signed(sk, 10133, [['payto', 'monero', SUB]], 200)];
    const map = await fetchPayto([getPublicKey(sk)], ['wss://r'], async () => events);
    expect(map.get(getPublicKey(sk))?.address).toBe(SUB);
  });
});

describe('proof tweets', () => {
  it('extracts the real oEmbed text with entities decoded', () => {
    const text = oembedText(OEMBED.html)!;
    expect(text).toContain(`My Public Key: "${ABENG_NPUB}"`);
    expect(text).not.toContain('&quot;');
    expect(text).not.toContain('Abeng (@abengisme)');
  });

  it('only reads the first <p> (the tweet itself, not quoted or byline content)', () => {
    const html = `<blockquote><p>gm</p>&mdash; x <blockquote><p>${ABENG_NPUB}</p></blockquote></blockquote>`;
    expect(oembedText(html)).toBe('gm');
  });

  it('yields nothing for a quote-only tweet', () => {
    expect(oembedText(`<blockquote class="twitter-tweet"><blockquote><p>${ABENG_NPUB}</p></blockquote>&mdash; x</blockquote>`)).toBeNull();
  });

  it('matches the npub as a whole word only', () => {
    expect(containsNpub(`key: "${ABENG_NPUB}".`, ABENG_NPUB)).toBe(true);
    expect(containsNpub(`${ABENG_NPUB}q`, ABENG_NPUB)).toBe(false);
    expect(containsNpub(`x${ABENG_NPUB}`, ABENG_NPUB)).toBe(false);
    expect(containsNpub(`X${ABENG_NPUB}`, ABENG_NPUB)).toBe(false);
    expect(containsNpub(`${ABENG_NPUB}Q`, ABENG_NPUB)).toBe(false);
  });

  it('computes the syndication token', () => {
    expect(syndicationToken('20')).toBe('6dq1a2xwd93');
  });
});

describe('verifyTwitterProof', () => {
  const down = () => Promise.reject(new TypeError('network'));

  it('verifies the real proof via oEmbed', async () => {
    const f = routes(() => json(OEMBED), down);
    expect(await verifyTwitterProof('AbengIsMe', ABENG_TWEET, ABENG_PK, f)).toEqual({ status: 'verified', via: 'oembed' });
  });

  it('falls back to syndication when oEmbed is unreachable', async () => {
    const f = routes(down, () => json(SYND));
    expect(await verifyTwitterProof('abengisme', ABENG_TWEET, ABENG_PK, f)).toEqual({ status: 'verified', via: 'syndication' });
  });

  it('fails for another author, a missing npub, or an npub only in a quoted tweet', async () => {
    const otherPk = getPublicKey(generateSecretKey());
    const notFound = () => json({}, 404);
    expect(await verifyTwitterProof('impostor', ABENG_TWEET, ABENG_PK, routes(() => json(OEMBED), notFound))).toEqual({ status: 'failed', reason: 'tweet is by another account' });
    expect(await verifyTwitterProof('abengisme', ABENG_TWEET, otherPk, routes(() => json(OEMBED), notFound))).toEqual({ status: 'failed', reason: 'tweet does not contain the npub' });
    const quoted = { ...OEMBED, html: `<blockquote><p>look at this</p><blockquote><p>${npubEncode(otherPk)}</p></blockquote></blockquote>` };
    const quotedSynd = { ...SYND, text: 'look at this', quoted_tweet: { text: npubEncode(otherPk) } };
    expect((await verifyTwitterProof('abengisme', ABENG_TWEET, otherPk, routes(() => json(quoted), () => json(quotedSynd)))).status).toBe('failed');
  });

  it('treats a definite oEmbed failure as final, even if syndication would pass', async () => {
    const otherPk = getPublicKey(generateSecretKey());
    const lying = { ...SYND, text: npubEncode(otherPk) };
    const f = routes(() => json(OEMBED), () => json(lying));
    expect(await verifyTwitterProof('abengisme', ABENG_TWEET, otherPk, f)).toEqual({ status: 'failed', reason: 'tweet does not contain the npub' });
  });

  it('rejects an author_url that is not on X', async () => {
    const f = routes(() => json({ ...OEMBED, author_url: 'https://evil.com/abengisme' }), () => json({}, 404));
    expect(await verifyTwitterProof('abengisme', ABENG_TWEET, ABENG_PK, f)).toEqual({ status: 'failed', reason: 'tweet is by another account' });
  });

  it('reports "error", never verified, when X does not answer', async () => {
    expect(await verifyTwitterProof('abengisme', ABENG_TWEET, ABENG_PK, routes(down, down))).toEqual({ status: 'error', reason: 'X did not answer' });
    expect((await verifyTwitterProof('abengisme', ABENG_TWEET, ABENG_PK, routes(() => json({}, 500), () => json({}, 429)))).status).toBe('error');
  });

  it('rejects malformed claims without any network call', async () => {
    const f = routes(down, down);
    expect((await verifyTwitterProof('bad handle!', '1', ABENG_PK, f)).status).toBe('failed');
    expect(f).not.toHaveBeenCalled();
  });
});

const entry = (over: Partial<BadgeEntry>): BadgeEntry => ({ source: 'nostr', address: SUB, check: { ok: true, type: 'subaddress' }, verified: true, method: 'nip39:client', ...over });

describe('mergeBadge', () => {
  it('prefers xmr.bio over Nostr', () => {
    const b = mergeBadge('Jack', [entry({ address: SUB }), entry({ source: 'xmrbio', address: STD, method: 'x-post' })]);
    expect(b).toMatchObject({ handle: 'jack', primary: { source: 'xmrbio', address: STD }, differ: true });
  });

  it('picks the newest claim event, then the newest proof tweet', () => {
    const b = mergeBadge('a', [entry({ pubkey: 'old', createdAt: 100 }), entry({ pubkey: 'new', createdAt: 200 }), entry({ pubkey: 'unverified', createdAt: 300, verified: false })]);
    expect(b.primary?.pubkey).toBe('new');
    const t = mergeBadge('a', [entry({ pubkey: 'a', createdAt: 1, tweetId: '999' }), entry({ pubkey: 'b', createdAt: 1, tweetId: '1000' })]);
    expect(t.primary?.pubkey).toBe('b');
  });

  it('gives no badge without a verified, valid entry', () => {
    expect(mergeBadge('a', [entry({ verified: false }), entry({ check: { ok: false, reason: 'bad checksum' } })]).primary).toBeNull();
    expect(mergeBadge('a', []).primary).toBeNull();
  });
});

describe('resolveHandles / discoverNostr', () => {
  it('makes no relay, X or xmr.bio requests when discovery is off', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const query = vi.fn<QueryFn>(async () => []);
    const verify = vi.fn();
    const res = await resolveHandles(['jack', 'Alice'], { discovery: false, relays: ['wss://r'], query, verify });
    expect([...res.keys()]).toEqual(['jack', 'alice']);
    expect([...res.values()].every((b) => b.primary === null)).toBe(true);
    expect(query).not.toHaveBeenCalled();
    expect(verify).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('only checks proof tweets for claims with a valid payto', async () => {
    const [k1, k2, k3] = [generateSecretKey(), generateSecretKey(), generateSecretKey()];
    const query: QueryFn = async (_r, f) =>
      f.kinds[0] === 10011
        ? [signed(k1, 10011, [['i', 'twitter:alice', '1']]), signed(k2, 10011, [['i', 'twitter:alice', '2']]), signed(k3, 10011, [['i', 'twitter:alice', '3']])]
        : [signed(k1, 10133, [['payto', 'monero', SUB]]), signed(k2, 10133, [['payto', 'monero', 'bad']])];
    const verify = vi.fn(async () => ({ status: 'verified' as const, via: 'oembed' as const }));
    const found = await discoverNostr(['alice'], { discovery: true, relays: ['wss://r'], query, verify });
    expect(verify).toHaveBeenCalledTimes(1);
    expect(verify).toHaveBeenCalledWith('alice', '1', getPublicKey(k1));
    const entries = found.get('alice')!;
    expect(entries).toHaveLength(2);
    expect(entries.find((e) => e.pubkey === getPublicKey(k2))).toMatchObject({ verified: false, note: expect.stringMatching(/invalid address/) });
  });

  it('runs at most 4 proof checks at once', async () => {
    const keys = Array.from({ length: 12 }, () => generateSecretKey());
    const query: QueryFn = async (_r, f) =>
      f.kinds[0] === 10011 ? keys.map((k, i) => signed(k, 10011, [['i', 'twitter:alice', String(i + 1)]])) : keys.map((k) => signed(k, 10133, [['payto', 'monero', SUB]]));
    let active = 0;
    let peak = 0;
    const verify = vi.fn(async () => {
      peak = Math.max(peak, ++active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return { status: 'verified' as const, via: 'oembed' as const };
    });
    const found = await discoverNostr(['alice'], { discovery: true, relays: ['wss://r'], query, verify });
    expect(verify).toHaveBeenCalledTimes(12);
    expect(peak).toBeLessThanOrEqual(4);
    expect(found.get('alice')).toHaveLength(12);
  });

  it('drops Nostr sources from a cached badge once discovery is off', () => {
    const cached = mergeBadge('alice', [entry({ pubkey: 'p' }), entry({ source: 'xmrbio', address: STD, method: 'x-post', verified: false })]);
    expect(cached.primary?.source).toBe('nostr');
    const off = withoutNostr(cached);
    expect(off.primary).toBeNull();
    expect(off.entries.every((e) => e.source !== 'nostr')).toBe(true);
  });

  it('labels proof errors as "could not verify"', async () => {
    const k = generateSecretKey();
    const query: QueryFn = async (_r, f) => (f.kinds[0] === 10011 ? [signed(k, 10011, [['i', 'twitter:alice', '1']])] : [signed(k, 10133, [['payto', 'monero', SUB]])]);
    const res = await resolveHandles(['alice'], { discovery: true, relays: ['wss://r'], query, verify: async () => ({ status: 'error', reason: 'X did not answer' }) });
    const b = res.get('alice')!;
    expect(b.primary).toBeNull();
    expect(b.entries[0]!.note).toBe('could not verify: X did not answer');
  });
});

describe('rate limiting', () => {
  it('a fast scroll past 200 handles loses none and spreads lookups out', () => {
    const bucket = new TokenBucket(50, 2, 0);
    const queue = new PendingQueue(500);
    const resolved = new Set<string>();
    queue.add(Array.from({ length: 200 }, (_, i) => `user${i}`));
    let now = 0;
    const grants: number[] = [];
    while (queue.size && now < 600_000) {
      const batch = queue.take(200);
      const granted = bucket.take(batch.length, now);
      grants.push(granted);
      batch.slice(0, granted).forEach((h) => resolved.add(h));
      queue.add(batch.slice(granted));
      now += 1500;
    }
    expect(resolved.size).toBe(200);
    expect(grants[0]).toBe(50);
    expect(Math.max(...grants.slice(1))).toBeLessThanOrEqual(3);
  });

  it('the pending queue dedupes and drops the oldest past its cap', () => {
    const q = new PendingQueue(3);
    q.add(['a', 'b', 'a', 'c', 'd']);
    expect(q.take(10)).toEqual(['b', 'a', 'c', 'd'].slice(-3));
  });
});

describe('EntryCache', () => {
  it('expires by a value-dependent TTL and caps size', () => {
    const c = new EntryCache<{ ok: boolean }>([], 2);
    c.set('a', { ok: true }, 0);
    c.set('b', { ok: false }, 0);
    const ttl = (v: { ok: boolean }) => (v.ok ? 100 : 10);
    expect(c.get('b', 20, ttl)).toBeUndefined();
    expect(c.get('a', 20, ttl)).toEqual({ ok: true });
    c.set('c', { ok: true }, 30);
    c.set('d', { ok: true }, 30);
    expect(c.entries().map(([k]) => k)).toEqual(['c', 'd']);
  });

  it('treats prototype names as plain keys and survives a storage round-trip', () => {
    const c = new EntryCache<number>();
    expect(c.get('constructor', 0, 10)).toBeUndefined();
    c.set('__proto__', 1, 0);
    const back = new EntryCache<number>(JSON.parse(JSON.stringify(c.entries())));
    expect(back.get('__proto__', 1, 10)).toBe(1);
    expect(new EntryCache<number>({} as never).entries()).toEqual([]);
  });
});

describe('badge slots', () => {
  const html = `<article data-testid="tweet"><div data-testid="User-Name"><a href="/Alice">Alice</a><a href="/Alice">@Alice</a><a href="/Alice/status/42"><time>1h</time></a></div></article>
    <div data-testid="UserName"><span>Bob</span></div>`;
  const doc = makeDoc('https://x.com/bob', html);
  it('keys tweets by tweet ID and handle', () => {
    const slot = tweetSlot(doc.querySelector('article')!)!;
    expect(slot).toMatchObject({ handle: 'Alice', key: '42:alice' });
    expect(slot.anchor.getAttribute('data-testid')).toBe('User-Name');
  });
  it('finds the profile header on profile pages only', () => {
    expect(profileSlot(doc, { hostname: 'x.com', pathname: '/bob' })).toMatchObject({ handle: 'bob', key: 'profile:bob' });
    expect(profileSlot(doc, { hostname: 'x.com', pathname: '/home' })).toBeNull();
  });
});

describe('badge popup', () => {
  const pk = getPublicKey(generateSecretKey());
  it('warns when addresses differ, marks the primary and links the proof tweet', () => {
    const primary = entry({ pubkey: pk, tweetId: '42', createdAt: 200 });
    const badge = mergeBadge('alice', [primary, entry({ pubkey: getPublicKey(generateSecretKey()), address: STD, tweetId: '7', createdAt: 100 })]);
    // as after messaging: a copy, not the same objects
    const el = renderBadge(structuredClone(badge));
    expect(el.textContent).toContain('more than one address');
    expect(el.textContent).toContain('(shown above)');
    const hrefs = [...el.querySelectorAll('a[href]')].map((a) => a.getAttribute('href'));
    expect(hrefs).toContain('https://x.com/alice/status/42');
    expect(hrefs).toContain(`https://njump.me/${npubEncode(pk)}`);
  });

  it('renders hostile notes as text and skips links for bad values', () => {
    const el = badgePanel(mergeBadge('alice', [entry({ pubkey: 'zz', verified: false, note: '<img src=x onerror=alert(1)>', tweetId: 'javascript:1' })]));
    expect(el.querySelector('img')).toBeNull();
    expect(el.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(el.querySelectorAll('a[href]')).toHaveLength(0);
  });
});
