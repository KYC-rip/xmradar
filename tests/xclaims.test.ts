import { keccak_256 } from '@noble/hashes/sha3.js';
import { npubEncode, nprofileEncode } from 'nostr-tools/nip19';
import { describe, expect, it, vi } from 'vitest';
import { mergeBadge, resolveHandles, withoutNostr, withoutSelf, type BadgeEntry } from '../src/identity/resolve';
import { pinnedPost, profileClaimScope } from '../src/identity/x-handle';
import { applySeen, CLAIM_TTL_MS, claimKeeper, MAX_CLAIM_HANDLES, parseClaim, pruneClaims, selfEntries, type XClaimStore } from '../src/identity/xclaims';
import { base58Decode, base58Encode } from '../src/xmr/address';

const A = '44AFFq5kSiGBoZ4NMDwYtN18obc8AemS33DBLWs3H7otXft3XjrpDtQGv7SqSsaBYBb98uNbr2VBBEt7f2wfn3RVGQBEP3A';
const SUB = '89fM69NVioz94JQrJFLGPDa8PMpjea7TV8JQktbLBLpX9gKMfrt3dge7KMdqg86coZjCxCm3fn1WKdM8WBMJhEdaUimo8Q3';
const B = '888tNkZrPN6JsEgekjMnABU4TBzc2Dt29EPAvkRxbANsAnjyPbb3iQ1YBRk1UXcdRsiKc9dhwMVgN5S9cQUiyoogDavup3H';

/** An address with another prefix (and payment id) over A's keys, with a good checksum. */
function withPrefix(prefix: number, paymentId?: Uint8Array) {
  const keys = base58Decode(A).subarray(1, 65);
  const body = new Uint8Array([prefix, ...keys, ...(paymentId ?? [])]);
  return base58Encode(new Uint8Array([...body, ...keccak_256(body).subarray(0, 4)]));
}
const INTEGRATED = withPrefix(19, new Uint8Array(8).fill(7));
const TESTNET = withPrefix(53);
const BAD_SUM = A.slice(0, -1) + (A.endsWith('A') ? 'B' : 'A');

const PK = 'a'.repeat(64);
const PK2 = 'b'.repeat(64);
const NPUB = npubEncode(PK);
const NOW = Date.parse('2026-11-01T12:00:00Z');
const DAY = 86_400_000;
const ok = { ok: true, type: 'standard' } as const;

describe('parseClaim (A2, X1, X4, §9, §10)', () => {
  it('one address in a bio', () => {
    expect(parseClaim(`Monero: ${A}`, 'bio')).toEqual({ address: A });
    expect(parseClaim(`tips ${SUB} 🙏`, 'bio')).toEqual({ address: SUB });
    // the same address twice is still one
    expect(parseClaim(`${A}\nagain: ${A}`, 'bio')).toEqual({ address: A });
  });

  it('two addresses, an integrated one, other networks and bad checksums give no address', () => {
    expect(parseClaim(`${A} or ${SUB}`, 'bio')).toEqual({});
    expect(parseClaim(`${A} ${INTEGRATED}`, 'bio')).toEqual({});
    expect(parseClaim(INTEGRATED, 'bio')).toEqual({});
    expect(parseClaim(TESTNET, 'bio')).toEqual({});
    expect(parseClaim(BAD_SUM, 'bio')).toEqual({});
  });

  it('an address glued to other base58 text is not half-read', () => {
    expect(parseClaim(`x${A}`, 'bio')).toEqual({});
    expect(parseClaim(`${A}z`, 'bio')).toEqual({});
    expect(parseClaim(`(${A}).`, 'bio')).toEqual({ address: A });
  });

  it('npub and nprofile give the pubkey; two keys give none; an address and a key are both kept', () => {
    expect(parseClaim(`nostr: ${NPUB}`, 'bio')).toEqual({ pubkey: PK });
    expect(parseClaim(nprofileEncode({ pubkey: PK, relays: ['wss://nos.lol'] }), 'bio')).toEqual({ pubkey: PK });
    // the same key as npub and nprofile is one key
    expect(parseClaim(`${NPUB} ${nprofileEncode({ pubkey: PK })}`, 'bio')).toEqual({ pubkey: PK });
    expect(parseClaim(`${NPUB} ${npubEncode(PK2)}`, 'bio')).toEqual({});
    expect(parseClaim(`${NPUB} ${npubEncode(PK2)} ${A}`, 'bio')).toEqual({ address: A });
    expect(parseClaim(`${A} | ${NPUB}`, 'pinned')).toEqual({ address: A, pubkey: PK });
    expect(parseClaim(`${NPUB.slice(0, -1)}q`, 'bio')).toEqual({});
  });

  it('a warning cue leaves the whole field out', () => {
    for (const t of [`SCAM address, don't pay: ${A}`, `Fake account. Do not send to ${A}`, `${A} is not mine`, `hacked! ${NPUB}`, `impersonators use ${A}`]) expect(parseClaim(t, 'bio'), t).toEqual({});
  });

  it('xmr.bio links: whole or split, with or without scheme; cut short or two names give none', () => {
    expect(parseClaim('Monero: xmr.bio/franz_fk19', 'bio')).toEqual({ xmrbio: 'franz_fk19' });
    expect(parseClaim('http://xmr.bio/Mr_XMR_', 'bio')).toEqual({ xmrbio: 'mr_xmr_' });
    expect(parseClaim('https://www.xmr.bio/foo/ tips', 'bio')).toEqual({ xmrbio: 'foo' });
    expect(parseClaim('xmr.bio/averyveryverylon…', 'bio')).toEqual({});
    expect(parseClaim('xmr.bio/foo/…', 'bio')).toEqual({});
    expect(parseClaim('xmr.bio/foo and xmr.bio/foo…', 'bio')).toEqual({});
    expect(parseClaim('xmr.bio/foo xmr.bio/bar', 'bio')).toEqual({});
    expect(parseClaim('notxmr.bio/foo', 'bio')).toEqual({});
    expect(parseClaim('xmr.bio/foo xmr.bio/FOO', 'bio')).toEqual({ xmrbio: 'foo' });
    // the name is exact: a longer path or another character after it names no one
    for (const t of ['xmr.bio/foo-bar', 'xmr.bio/foo.bar', 'xmr.bio/foo/bar', 'xmr.bio/foo?x=1', 'xmr.bio/foo#a', 'xmr.bio/foo%20', 'xmr.bio/foo-bar…', 'xmr.bio/foo.b…']) expect(parseClaim(t, 'bio'), t).toEqual({});
    // sentence punctuation ends the link
    expect(parseClaim('Tip me at xmr.bio/foo. Thanks', 'bio')).toEqual({ xmrbio: 'foo' });
    expect(parseClaim('(xmr.bio/foo), or', 'bio')).toEqual({ xmrbio: 'foo' });
    expect(parseClaim('xmr.bio/foo/', 'bio')).toEqual({ xmrbio: 'foo' });
  });

  it('the Website field only counts an xmr.bio link', () => {
    expect(parseClaim('xmr.bio/Mr_XMR_', 'url')).toEqual({ xmrbio: 'mr_xmr_' });
    expect(parseClaim('walls.rip', 'url')).toEqual({});
    expect(parseClaim(A, 'url')).toEqual({});
    expect(parseClaim(NPUB, 'url')).toEqual({});
  });
});

describe('the claim store (A3, X6)', () => {
  it('a new value starts seenAt; seeing it again only bumps confirmedAt; a change starts again', () => {
    let r = applySeen(null, '@Foo', 'bio', { address: A }, NOW);
    expect(r.changed).toBe(true);
    expect(r.store.entries).toEqual([{ handle: 'foo', bio: { address: A, seenAt: NOW, confirmedAt: NOW } }]);
    r = applySeen(r.store, 'foo', 'bio', { address: A }, NOW + 3600_000);
    expect(r.changed).toBe(false);
    expect(r.store.entries[0]!.bio).toEqual({ address: A, seenAt: NOW, confirmedAt: NOW + 3600_000 });
    // a day after the last sighting, the popup's "last seen" line is out of date: the cached badge goes
    r = applySeen(r.store, 'foo', 'bio', { address: A }, NOW + 3600_000 + DAY);
    expect(r.changed).toBe(true);
    expect(r.store.entries[0]!.bio).toEqual({ address: A, seenAt: NOW, confirmedAt: NOW + 3600_000 + DAY });
    r = applySeen(r.store, 'foo', 'bio', { address: SUB }, NOW + 2 * DAY);
    expect(r.changed).toBe(true);
    expect(r.store.entries[0]!.bio).toEqual({ address: SUB, seenAt: NOW + 2 * DAY, confirmedAt: NOW + 2 * DAY });
  });

  it('seen without a claim removes that place only; an entry with no place goes', () => {
    let r = applySeen(null, 'foo', 'bio', { address: A }, NOW);
    r = applySeen(r.store, 'foo', 'url', { xmrbio: 'foo_tips' }, NOW);
    r = applySeen(r.store, 'foo', 'bio', null, NOW + 1);
    expect(r.changed).toBe(true);
    expect(r.store.entries).toEqual([{ handle: 'foo', url: { xmrbio: 'foo_tips', seenAt: NOW, confirmedAt: NOW } }]);
    r = applySeen(r.store, 'foo', 'url', {}, NOW + 2);
    expect(r.store.entries).toEqual([]);
    // nothing to remove: no change
    expect(applySeen(r.store, 'foo', 'pinned', null, NOW + 3).changed).toBe(false);
  });

  it('a new pinned post with the same value keeps seenAt and takes the new id', () => {
    let r = applySeen(null, 'foo', 'pinned', { address: A }, NOW, '111');
    r = applySeen(r.store, 'foo', 'pinned', { address: A }, NOW + DAY, '222');
    expect(r.changed).toBe(true);
    expect(r.store.entries[0]!.pinned).toEqual({ address: A, seenAt: NOW, confirmedAt: NOW + DAY, tweetId: '222' });
  });

  it('30-day expiry per place, and a cap of 1000 handles by the oldest sighting', () => {
    let r = applySeen(null, 'old', 'bio', { address: A }, NOW);
    r = applySeen(r.store, 'old', 'url', { xmrbio: 'x' }, NOW + 20 * DAY);
    expect(pruneClaims(r.store, NOW + CLAIM_TTL_MS + 1).entries).toEqual([{ handle: 'old', url: { xmrbio: 'x', seenAt: NOW + 20 * DAY, confirmedAt: NOW + 20 * DAY } }]);
    const many: XClaimStore = { v: 1, entries: Array.from({ length: MAX_CLAIM_HANDLES + 5 }, (_, i) => ({ handle: `h${i}`, bio: { address: A, seenAt: NOW + i, confirmedAt: NOW + i } })) };
    const kept = pruneClaims(many, NOW + 10_000).entries;
    expect(kept.length).toBe(MAX_CLAIM_HANDLES);
    expect(kept.some((e) => e.handle === 'h0')).toBe(false);
    expect(kept[0]!.handle).toBe(`h${MAX_CLAIM_HANDLES + 4}`);
    // junk in storage is dropped, not thrown on
    expect(pruneClaims({ v: 1, entries: [null, { handle: 3 }, { handle: 'x' }] } as never, NOW).entries).toEqual([]);
  });
});

describe('claims become badge entries (A4, §9, §10)', () => {
  const dir = (h: string): BadgeEntry[] => (h === 'foo_tips' || h === 'foo' ? [{ source: 'xmrbio', address: B, check: ok, verified: true, method: 'xmrbio:directory' }] : []);
  const stored = (over: object) => ({ handle: 'foo', ...over });
  const seen = { seenAt: NOW, confirmedAt: NOW };

  it('an address, a link to another xmr.bio name, and a link to the handle itself', () => {
    expect(selfEntries(stored({ bio: { address: A, ...seen } }), dir)).toEqual([{ source: 'xself', verified: true, ...seen, address: A, check: ok, method: 'x-bio' }]);
    expect(selfEntries(stored({ url: { xmrbio: 'foo_tips', ...seen } }), dir)).toEqual([{ source: 'xself', verified: true, ...seen, address: B, check: ok, method: 'x-url-xmrbio', xmrbio: 'foo_tips' }]);
    // the handle's own name adds nothing: the directory already gives it
    expect(selfEntries(stored({ url: { xmrbio: 'foo', ...seen } }), dir)).toEqual([]);
    // not in the directory: no entry, and no request
    expect(selfEntries(stored({ bio: { xmrbio: 'nobody', ...seen } }), dir)).toEqual([]);
  });

  it('an npub only gives an entry through a payto (discovery on)', () => {
    const e = stored({ bio: { pubkey: PK, ...seen } });
    expect(selfEntries(e, dir)).toEqual([]);
    expect(selfEntries(e, dir, (pk) => (pk === PK ? SUB : undefined))).toEqual([{ source: 'xself', verified: true, ...seen, address: SUB, check: { ok: true, type: 'subaddress' }, method: 'x-bio-npub', pubkey: PK }]);
  });

  it('tier order: xmr.bio, then verified NIP-39, then bio, Website, pinned; differ shows', () => {
    const x = (method: string, address: string): BadgeEntry => ({ source: 'xself', address, check: ok, verified: true, method });
    const nostr: BadgeEntry = { source: 'nostr', address: SUB, check: ok, verified: true, method: 'nip39:client', pubkey: PK, createdAt: 5 };
    const xmrbio: BadgeEntry = { source: 'xmrbio', address: B, check: ok, verified: true, method: 'xmrbio:directory' };
    expect(mergeBadge('foo', [x('x-pinned', A), x('x-url-xmrbio', B), x('x-bio', SUB)]).primary!.method).toBe('x-bio');
    expect(mergeBadge('foo', [x('x-pinned', A), x('x-url-xmrbio', B)]).primary!.method).toBe('x-url-xmrbio');
    expect(mergeBadge('foo', [x('x-bio', A), nostr]).primary).toBe(nostr);
    const all = mergeBadge('foo', [x('x-bio', A), nostr, xmrbio]);
    expect(all.primary).toBe(xmrbio);
    expect(all.differ).toBe(true);
  });

  it('withoutSelf drops every self-claim (switch off), keeping the other sources', () => {
    const bio: BadgeEntry = { source: 'xself', address: A, check: ok, verified: true, method: 'x-bio' };
    const xmrbio: BadgeEntry = { source: 'xmrbio', address: B, check: ok, verified: true, method: 'xmrbio:directory' };
    expect(withoutSelf(mergeBadge('foo', [bio])).primary).toBeNull();
    const both = withoutSelf(mergeBadge('foo', [bio, xmrbio]));
    expect(both.entries).toEqual([xmrbio]);
    expect(both.differ).toBe(false);
  });

  it('withoutNostr keeps a bio address and drops a bio npub payto', () => {
    const bio: BadgeEntry = { source: 'xself', address: A, check: ok, verified: true, method: 'x-bio' };
    const npub: BadgeEntry = { source: 'xself', address: SUB, check: ok, verified: true, method: 'x-pinned-npub', pubkey: PK };
    const b = withoutNostr(mergeBadge('foo', [npub, bio]));
    expect(b.entries).toEqual([bio]);
    expect(b.primary).toBe(bio);
  });

  it('resolveHandles: an address-only bio makes no request; an npub is read from relays only with discovery', async () => {
    const query = vi.fn(async () => []);
    const verify = vi.fn();
    const selfClaims = (h: string) => (h === 'foo' ? stored({ bio: { address: A, ...seen }, pinned: { pubkey: PK, ...seen } }) : undefined);
    const off = await resolveHandles(['Foo'], { discovery: false, relays: ['wss://r'], query, verify, selfClaims });
    expect(off.get('foo')!.primary!.method).toBe('x-bio');
    expect(query).not.toHaveBeenCalled();
    await resolveHandles(['foo'], { discovery: true, relays: ['wss://r'], query, verify, selfClaims });
    expect(query).toHaveBeenCalledWith(['wss://r'], expect.objectContaining({ kinds: [10133], authors: [PK] }));
  });
});

describe('claimKeeper (A3, X3)', () => {
  const item = <T>(v: T) => {
    let value = v;
    return { getValue: vi.fn(async () => value), setValue: vi.fn(async (n: T) => void (value = n)), removeValue: vi.fn(async () => void (value = null as T)) };
  };
  const setup = (on = true) => {
    const store = item<XClaimStore | null>(null);
    const changedItem = { setValue: vi.fn(async () => {}) };
    const dropBadge = vi.fn();
    const dropAllBadges = vi.fn();
    const enabled = vi.fn(async () => on);
    return { store, changedItem, dropBadge, dropAllBadges, enabled, k: claimKeeper({ store, changedItem, enabled, dropBadge, dropAllBadges, now: () => NOW }) };
  };

  it('a change drops the cached badge and tells the tabs; seeing it again doesn’t', async () => {
    const s = setup();
    await expect(s.k.seen({ handle: 'Foo', place: 'bio', claim: { address: A } })).resolves.toEqual({ changed: true });
    expect(s.dropBadge).toHaveBeenCalledWith('foo');
    expect(s.changedItem.setValue).toHaveBeenCalledWith({ handle: 'foo', at: NOW });
    await expect(s.k.seen({ handle: 'foo', place: 'bio', claim: { address: A } })).resolves.toEqual({ changed: false });
    expect(s.dropBadge).toHaveBeenCalledTimes(1);
    expect((await s.k.lookup())('FOO')!.bio!.address).toBe(A);
  });

  it('every value is checked again; bad messages are refused and change nothing', async () => {
    const s = setup();
    for (const msg of [
      { handle: 'bad handle!', place: 'bio', claim: null },
      { handle: 'foo', place: 'header', claim: null },
      { handle: 'foo', place: 'bio', claim: { address: INTEGRATED } },
      { handle: 'foo', place: 'bio', claim: { address: BAD_SUM } },
      { handle: 'foo', place: 'bio', claim: { pubkey: 'XYZ' } },
      { handle: 'foo', place: 'bio', claim: { xmrbio: 'x'.repeat(16) } },
      { handle: 'foo', place: 'bio', claim: 'string' },
      { handle: 'foo', place: 'pinned', claim: { address: A }, tweetId: '0x1' },
    ])
      await expect(s.k.seen(msg), JSON.stringify(msg)).rejects.toThrow();
    expect(s.store.setValue).not.toHaveBeenCalled();
    // the Website field never keeps an address or key, even if a tab sends one
    await s.k.seen({ handle: 'foo', place: 'url', claim: { address: A, xmrbio: 'foo_tips' } });
    expect((await s.k.lookup())('foo')!.url).toEqual({ xmrbio: 'foo_tips', seenAt: NOW, confirmedAt: NOW });
  });

  it('switched off: nothing stored, nothing looked up; clear drops the store and cached badges', async () => {
    const off = setup(false);
    await expect(off.k.seen({ handle: 'foo', place: 'bio', claim: { address: A } })).resolves.toEqual({ changed: false });
    expect(off.store.setValue).not.toHaveBeenCalled();
    expect((await off.k.lookup())('foo')).toBeUndefined();
    const s = setup();
    await s.k.seen({ handle: 'foo', place: 'bio', claim: { address: A } });
    await s.k.clear();
    expect(await s.store.getValue()).toBeNull();
    expect(s.dropAllBadges).toHaveBeenCalledTimes(1);
  });

  it('sightings from two tabs are written one after the other', async () => {
    const s = setup();
    await Promise.all([s.k.seen({ handle: 'a', place: 'bio', claim: { address: A } }), s.k.seen({ handle: 'b', place: 'bio', claim: { address: SUB } })]);
    expect((await s.store.getValue())!.entries.map((e) => e.handle).sort()).toEqual(['a', 'b']);
  });
});

describe('reading a profile page (X2, X5, §8, §10)', () => {
  const loc = (pathname: string) => ({ hostname: 'x.com', pathname });
  const PIN = '<svg><g><path d="M13 21l-1 2-1-2v-5H4.5v-2.287l.152-.243"></path></g></svg>';
  const header = (handle: string, { bio = `Monero: ${A}` as string | null, url = 'xmr.bio/foo_tips' as string | null, items = true } = {}) => `
    <div data-testid="primaryColumn">
      <div data-testid="UserName"><span>Foo</span><span>@${handle}</span></div>
      ${bio == null ? '' : `<div data-testid="UserDescription"><span>${bio}</span></div>`}
      ${items ? `<div data-testid="UserProfileHeader_Items">${url == null ? '' : `<a data-testid="UserUrl" href="https://t.co/x"><span>${url}</span></a>`}<span data-testid="UserJoinDate">Joined</span></div>` : ''}
      <div id="timeline"></div>
    </div>`;
  const tweet = (author: string, text: string, { link = false, quote = '' } = {}) => `
    <article data-testid="tweet">
      <div><div><div>${PIN}</div><div>${link ? '<a href="/someone">' : ''}<span data-testid="socialContext">Pinned</span>${link ? '</a>' : ''}</div></div></div>
      <div data-testid="User-Name"><a href="/${author}"><span>${author}</span></a><a href="/${author}/status/123"><time></time></a></div>
      <div data-testid="tweetText">${text}</div>
      ${quote ? `<div role="link"><div data-testid="tweetText">${quote}</div></div>` : ''}
    </article>`;
  const page = (html: string, first = '') => {
    document.body.innerHTML = html;
    if (first) document.getElementById('timeline')!.innerHTML = first;
    return document;
  };

  it('reads bio and Website on the profile and its tabs, bound to the shown @handle', () => {
    for (const path of ['/Foo', '/foo/', '/foo/with_replies', '/foo/media']) {
      expect(profileClaimScope(page(header('foo')), loc(path)), path).toEqual({ handle: path.split('/')[1], bio: { text: `Monero: ${A}` }, url: { text: 'xmr.bio/foo_tips' } });
    }
  });

  it('refuses status pages, other hosts and a header still showing another profile', () => {
    expect(profileClaimScope(page(header('foo')), loc('/foo/status/1'))).toBeNull();
    expect(profileClaimScope(page(header('foo')), loc('/foo/followers'))).toBeNull();
    expect(profileClaimScope(page(header('bar')), loc('/foo'))).toBeNull();
    expect(profileClaimScope(page(header('foo')), { hostname: 'evil.com', pathname: '/foo' })).toBeNull();
    // a header outside the main column is not the page's
    expect(profileClaimScope(page(`<div data-testid="UserName">@foo</div><div data-testid="primaryColumn"></div>`), loc('/foo'))).toBeNull();
  });

  it('a missing bio or Website is only "gone" once the header items have rendered', () => {
    expect(profileClaimScope(page(header('foo', { bio: null, url: null })), loc('/foo'))).toEqual({ handle: 'foo', bio: { text: null }, url: { text: null } });
    expect(profileClaimScope(page(header('foo', { bio: null, items: false })), loc('/foo'))).toEqual({ handle: 'foo', bio: null, url: null });
  });

  it('the pinned post: marked by the pin icon, by the profile, without its quoted post', () => {
    const pin = pinnedPost(page(header('foo'), tweet('foo', `tips ${A}`, { quote: `scam ${SUB}` })), loc('/foo'), 'foo');
    expect(pin).toMatchObject({ text: `tips ${A}`, tweetId: '123' });
    expect(parseClaim(pin!.text!, 'pinned')).toEqual({ address: A });
  });

  it('not pinned: a repost (context is a link), another author, no pin icon, or a profile tab', () => {
    expect(pinnedPost(page(header('foo'), tweet('foo', A, { link: true })), loc('/foo'), 'foo')!.text).toBeNull();
    expect(pinnedPost(page(header('foo'), tweet('bar', A)), loc('/foo'), 'foo')!.text).toBeNull();
    expect(pinnedPost(page(header('foo'), tweet('foo', A).replace(PIN, '<svg><path d="M4.75 3.79l4.603"></path></svg>')), loc('/foo'), 'foo')!.text).toBeNull();
    expect(pinnedPost(page(header('foo'), tweet('foo', A)), loc('/foo/with_replies'), 'foo')).toBeNull();
    expect(pinnedPost(page(header('foo')), loc('/foo'), 'foo')).toBeNull();
  });
});
