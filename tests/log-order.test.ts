import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { describe, expect, it } from 'vitest';
import { letterUrlFor, matchOrderPage, orderIdFor } from '../src/log/order';
import { readFeed, templateUrl, type SiteEntry } from '../src/sites/feed';

const fx = JSON.parse(readFileSync(join(process.cwd(), 'tests/fixtures/log/letters.json'), 'utf8')) as { keys: Record<string, { fingerprint: string; key: string }> };
const sk = ed25519.utils.randomSecretKey();
const KEYS = new Set([bytesToHex(ed25519.getPublicKey(sk))]);
const NOW = 1_793_261_226;
const ONION = 'bitaniazto32g3fuifykktkvay3tofkrrdgtvpvspdmca5r2lwrxp2id.onion';
const MISTEX_KEY = 'j/1x9v9Sv7n0BlSIbrW0IbsoAphfRrkF0pn9ObTRr7k=';

const feedOf = (sites: Record<string, unknown>[]) => {
  const text = JSON.stringify({ v: 1, issuer: 'xmr.club', issued_at: NOW, expires_at: NOW + 172800, sites });
  return readFeed({ payload: text, signature: bytesToHex(ed25519.sign(new TextEncoder().encode(text), sk)), public_key: bytesToHex(ed25519.getPublicKey(sk)), alg: 'ed25519' }, NOW, 0, KEYS);
};
const listing = (id: string, hosts: string[], over: Record<string, unknown>) => ({ id, name: id, category: 'exchanges', grade: 'B', incident: false, url: `https://xmr.club/exchanges/${id}`, hosts, ...over });

// the live shapes, 2026-10-29
const LIVE = [
  listing('bitania', ['bitania.com', ONION], {
    order_url: 'https://bitania.com/swap/{order}',
    log: { format: 'pgp', where: 'download', key_source: 'operator', url: 'https://bitania.com/swap/{order}/guarantee.txt', pgp_fingerprint: fx.keys.bitania!.fingerprint, pgp_public_key: fx.keys.bitania!.key, key_url: 'https://bitania.com/pgp.txt' },
  }),
  listing('pablo-cash', ['pablo.cash'], {
    order_url: 'https://pablo.cash/en/swap/{order}',
    log: { format: 'pgp', where: 'download', key_source: 'operator', url: 'https://pablo.cash/en/swap/{order}?pgp=download', pgp_fingerprint: '3EC2 8B27 CD30 3B2B B2BD  18E7 9429 7C45 C682 A409' },
  }),
  listing('mistex', ['mistex.io'], {
    order_url: 'https://mistex.io/order/{order}',
    log: { format: 'mistproof', where: 'download', key_source: 'operator', url: 'https://mistex.io/api/v1/orders/{order}/receipt', ed25519_key: MISTEX_KEY, key_url: 'https://mistex.io/verify' },
  }),
  listing('kyc-rip-aggregator', ['kyc.rip'], { order_url: 'https://kyc.rip/track/{order}', log: { format: 'nkip01', where: 'order_page', key_source: 'operator', key_url: 'https://kyc.rip/.well-known/nkip01.json' } }),
  listing('kyc-rip-ghost', ['kyc.rip'], { order_url: 'https://kyc.rip/track/{order}', log: { format: 'nkip01', where: 'order_page', key_source: 'operator' } }),
  listing('query-shop', ['query.example'], { order_url: 'https://query.example/order-details?query_code={order}', log: { format: 'nkip01' } }),
  listing('no-log', ['nolog.example'], { order_url: 'https://nolog.example/track/{order}' }),
];

describe('reading order_url and log from the feed', () => {
  const sites = feedOf(LIVE).sites;
  const by = (id: string) => sites.find((s) => s.id === id)!;

  it('keeps the live shapes, with the key from the signed feed', () => {
    expect(by('bitania')).toMatchObject({ orderUrl: 'https://bitania.com/swap/{order}', log: { format: 'pgp', url: 'https://bitania.com/swap/{order}/guarantee.txt', fingerprint: fx.keys.bitania!.fingerprint, publicKey: fx.keys.bitania!.key } });
    expect(by('pablo-cash').log).toEqual({ format: 'pgp', url: 'https://pablo.cash/en/swap/{order}?pgp=download', fingerprint: '3EC28B27CD303B2BB2BD18E794297C45C682A409', publicKey: null });
    expect(by('mistex').log).toEqual({ format: 'mistproof', url: 'https://mistex.io/api/v1/orders/{order}/receipt', ed25519Key: MISTEX_KEY });
    expect(by('kyc-rip-aggregator').log).toEqual({ format: 'nkip01' });
    expect(by('no-log')).toMatchObject({ orderUrl: 'https://nolog.example/track/{order}' });
    expect(by('no-log').log).toBeUndefined();
  });

  it('drops a malformed log whole, never in part, and keeps the listing', () => {
    const bad = (log: Record<string, unknown>) => feedOf([listing('x', ['x.example'], { order_url: 'https://x.example/o/{order}', log })]).sites[0]!;
    const pgp = { format: 'pgp', url: 'https://x.example/o/{order}/letter', pgp_fingerprint: fx.keys.bitania!.fingerprint };
    expect(bad(pgp).log).toMatchObject({ format: 'pgp' });
    expect(bad({ ...pgp, pgp_fingerprint: 'ABCD' }).log).toBeUndefined();
    expect(bad({ ...pgp, pgp_public_key: '<html>not a key</html>' }).log).toBeUndefined();
    expect(bad({ ...pgp, pgp_public_key: `-----BEGIN PGP PUBLIC KEY BLOCK-----${'A'.repeat(70_000)}` }).log).toBeUndefined();
    expect(bad({ ...pgp, url: 'https://evil.example/o/{order}' }).log).toBeUndefined();
    expect(bad({ ...pgp, url: 'http://x.example/o/{order}' }).log).toBeUndefined();
    expect(bad({ format: 'mistproof', ed25519_key: 'short' }).log).toBeUndefined();
    expect(bad({ format: 'something-else' }).log).toBeUndefined();
    expect(bad({ format: 'pgp', pgp_fingerprint: fx.keys.bitania!.fingerprint }).log).toEqual({ format: 'pgp', url: null, fingerprint: fx.keys.bitania!.fingerprint, publicKey: null });
    expect(bad(pgp).id).toBe('x');
  });

  it('templateUrl: https, a listing host, {order} exactly once as a whole segment or query value', () => {
    const h = ['x.example', 'www2.x.example'];
    expect(templateUrl('https://x.example/track/{order}', h)).toBeTruthy();
    expect(templateUrl('https://x.example/exchange/?id={order}', h)).toBeTruthy();
    expect(templateUrl('https://x.example/swap/{order}?pgp=download', h)).toBeTruthy();
    expect(templateUrl('https://www.x.example/track/{order}', h)).toBeTruthy(); // www. is the same host
    expect(templateUrl('https://x.example/track/', h)).toBeNull();
    expect(templateUrl('https://x.example/{order}/{order}', h)).toBeNull();
    expect(templateUrl('https://x.example/track-{order}', h)).toBeNull();
    expect(templateUrl('https://x.example/t?id=a{order}', h)).toBeNull();
    expect(templateUrl('https://x.example/t#{order}', h)).toBeNull();
    expect(templateUrl('https://x.example:8443/t/{order}', h)).toBeNull();
    expect(templateUrl('https://user@x.example/t/{order}', h)).toBeNull();
    expect(templateUrl('https://x.example.evil.com/t/{order}', h)).toBeNull();
    expect(templateUrl('javascript:alert(1)//{order}', h)).toBeNull();
    expect(templateUrl(`https://x.example/${'a'.repeat(300)}/{order}`, h)).toBeNull();
  });
});

describe('matching an order page (§2)', () => {
  const sites = feedOf(LIVE).sites;

  it('finds the order id in a path segment, with or without a trailing slash', () => {
    expect(matchOrderPage(sites, 'https://bitania.com/swap/jbstqmqrr6')).toMatchObject([{ site: { id: 'bitania' }, orderId: 'jbstqmqrr6', letterUrl: 'https://bitania.com/swap/jbstqmqrr6/guarantee.txt' }]);
    expect(matchOrderPage(sites, 'https://www.bitania.com/swap/jbstqmqrr6/')).toMatchObject([{ orderId: 'jbstqmqrr6', letterUrl: 'https://www.bitania.com/swap/jbstqmqrr6/guarantee.txt' }]);
    expect(matchOrderPage(sites, 'https://mistex.io/order/DX-36N87L?utm=x#top')).toMatchObject([{ site: { id: 'mistex' }, orderId: 'DX-36N87L', letterUrl: 'https://mistex.io/api/v1/orders/DX-36N87L/receipt' }]);
    expect(matchOrderPage(sites, 'https://pablo.cash/en/swap/AB12CD34')).toMatchObject([{ letterUrl: 'https://pablo.cash/en/swap/AB12CD34?pgp=download' }]);
  });

  it('finds it in a query value, and needs the other template parts', () => {
    expect(matchOrderPage(sites, 'https://query.example/order-details?query_code=Q1234&lang=en')).toMatchObject([{ orderId: 'Q1234', letterUrl: null }]);
    expect(matchOrderPage(sites, 'https://query.example/order-details')).toEqual([]);
    expect(matchOrderPage(sites, 'https://query.example/order-details?code=Q1234')).toEqual([]);
    expect(matchOrderPage(sites, 'https://query.example/order-details?query_code=Q1234&query_code=EVIL99')).toEqual([]);
  });

  it('keeps an onion mirror on its own origin, http allowed only there', () => {
    expect(matchOrderPage(sites, `http://${ONION}/swap/jbstqmqrr6`)).toMatchObject([{ letterUrl: `http://${ONION}/swap/jbstqmqrr6/guarantee.txt` }]);
    expect(matchOrderPage(sites, 'http://bitania.com/swap/jbstqmqrr6')).toEqual([]);
  });

  it('returns every listing on a shared host, never one picked', () => {
    expect(matchOrderPage(sites, 'https://kyc.rip/track/abc123').map((m) => m.site.id)).toEqual(['kyc-rip-aggregator', 'kyc-rip-ghost']);
  });

  it('does not match other paths, hosts, lookalikes or odd ids', () => {
    for (const url of [
      'https://bitania.com/',
      'https://bitania.com/swap/',
      'https://bitania.com/swap/jbstqmqrr6/guarantee.txt',
      'https://bitania.com/en/swap/jbstqmqrr6',
      'https://bitania.com/SWAP/jbstqmqrr6',
      'https://bitania.com/swap/abc', // too short
      'https://bitania.com/swap/%3Cscript%3E',
      'https://bitania.com.evil.com/swap/jbstqmqrr6',
      'https://evil.com/swap/jbstqmqrr6',
      'https://app.bitania.com/swap/jbstqmqrr6',
      'https://user:pw@bitania.com/swap/jbstqmqrr6',
      'https://nolog.example/track/abcd1234', // an order page, but no letter to check
      'https://bitania.com:8443/swap/jbstqmqrr6',
      `http://${ONION}:8080/swap/jbstqmqrr6`,
      'not a url',
    ]) expect(matchOrderPage(sites, url), url).toEqual([]);
  });

  it('orderIdFor and letterUrlFor on their own', () => {
    expect(orderIdFor('https://a.example/exchange/?id={order}', new URL('https://a.example/exchange?id=XYZ_99'))).toBe('XYZ_99');
    expect(orderIdFor('https://a.example/t/{order}', new URL('https://a.example/t/' + 'a'.repeat(81)))).toBeNull();
    expect(letterUrlFor({ format: 'nkip01' }, 'abcd', new URL('https://a.example/'))).toBeNull();
    expect(letterUrlFor({ format: 'mistproof', url: null, ed25519Key: MISTEX_KEY }, 'abcd', new URL('https://a.example/'))).toBeNull();
  });

  it('never matches on a platform host, even if a listing names one', () => {
    const gh = feedOf([listing('gh-swap', ['github.com'], { order_url: 'https://github.com/o/{order}', log: { format: 'nkip01' } })]).sites;
    expect(gh[0]!.log).toBeTruthy();
    expect(matchOrderPage(gh, 'https://github.com/o/abcd1234')).toEqual([]);
  });

  it('ignores a site whose log is missing even if its template matches', () => {
    const s: SiteEntry = { ...sites.find((x) => x.id === 'bitania')!, log: undefined };
    expect(matchOrderPage([s], 'https://bitania.com/swap/jbstqmqrr6')).toEqual([]);
  });
});

describe('what leaves the background', () => {
  it('publicSite drops the order template and letter keys', async () => {
    const { publicSite } = await import('../src/sites/feed');
    const s = feedOf(LIVE).sites.find((x) => x.id === 'bitania')!;
    expect(s.log).toBeTruthy();
    const p = publicSite(s);
    expect(p).not.toHaveProperty('log');
    expect(p).not.toHaveProperty('orderUrl');
    expect(p).toMatchObject({ id: 'bitania', hosts: s.hosts, grade: 'B' });
  });
});
