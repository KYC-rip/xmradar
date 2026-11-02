import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { parseLogoPack, readFeed, type SiteEntry, type SiteFeed } from '../src/sites/feed';
import { logoFor, logoHosts, logoKeeper, readLogos, webpSize, type LogoPack } from '../src/sites/logos';
import { siteLogo } from '../src/ui/site-logo';

const sha = (b: Uint8Array) => crypto.subtle.digest('SHA-256', b as Uint8Array<ArrayBuffer>).then((d) => bytesToHex(new Uint8Array(d)));
const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));

/** A VP8X WebP header of the given size (enough for webpSize; never decoded). */
function webp(width: number, height: number, pad = 0): Uint8Array {
  const b = new Uint8Array(30 + pad);
  const put = (at: number, s: string) => [...s].forEach((c, i) => (b[at + i] = c.charCodeAt(0)));
  put(0, 'RIFF');
  new DataView(b.buffer).setUint32(4, b.length - 8, true);
  put(8, 'WEBP');
  put(12, 'VP8X');
  new DataView(b.buffer).setUint32(16, 10, true);
  const w = width - 1;
  const h = height - 1;
  b.set([w & 0xff, (w >> 8) & 0xff, (w >> 16) & 0xff, h & 0xff, (h >> 8) & 0xff, (h >> 16) & 0xff], 24);
  return b;
}
const uri = (b: Uint8Array) => `data:image/webp;base64,${b64(b)}`;
const LOGO = uri(webp(32, 32));
const OTHER = uri(webp(32, 32, 2));

const site = (id: string, hosts: string[], issues = true): SiteEntry => ({
  id,
  name: id,
  category: 'exchanges',
  grade: 'B',
  incident: false,
  url: `https://xmr.club/exchanges/${id}`,
  hosts,
  ...(issues ? { nkip01: { level: 2 as const, logOnly: false, checkedAt: null, lastOkAt: null, l3VerifiedAt: null } } : {}),
});
const feedOf = (sites: SiteEntry[], ref?: SiteFeed['logoPack']): SiteFeed => ({ issuedAt: 1, expiresAt: 2, sites, ...(ref ? { logoPack: ref } : {}) });

describe('logo_pack in the signed list', () => {
  const ok = { url: 'https://xmr.club/feed/logos-77c05d749ebb.json', sha256: 'a'.repeat(64), bytes: 238740, count: 328, size_px: 32, format: 'webp' };
  it('takes the live shape', () => {
    expect(parseLogoPack(ok)).toEqual({ url: ok.url, sha256: ok.sha256, bytes: 238740, sizePx: 32 });
  });
  it.each([
    ['http', { url: 'http://xmr.club/feed/a.json' }],
    ['another host', { url: 'https://evil.club/feed/a.json' }],
    ['a lookalike host', { url: 'https://xmr.club.evil/feed/a.json' }],
    ['userinfo', { url: 'https://u:p@xmr.club/feed/a.json' }],
    ['a port', { url: 'https://xmr.club:8443/feed/a.json' }],
    ['a query', { url: 'https://xmr.club/feed/a.json?x=1' }],
    ['a fragment', { url: 'https://xmr.club/feed/a.json#x' }],
    ['dot segments', { url: 'https://xmr.club/feed/../api/a.json' }],
    ['encoded dots', { url: 'https://xmr.club/feed/%2e%2e/a.json' }],
    ['another path', { url: 'https://xmr.club/a.json' }],
    ['not json', { url: 'https://xmr.club/feed/a.js' }],
    ['a short hash', { sha256: 'abc' }],
    ['an upper-case hash', { sha256: 'A'.repeat(64) }],
    ['a huge file', { bytes: 2 * 1024 * 1024 }],
    ['zero bytes', { bytes: 0 }],
    ['another format', { format: 'png' }],
    ['a big size_px', { size_px: 512 }],
  ])('drops %s', (_, over) => expect(parseLogoPack({ ...ok, ...over })).toBeNull());

  it('a bad logo_pack leaves the rest of the list as it is', () => {
    const sk = ed25519.utils.randomSecretKey();
    const now = 1_793_261_226;
    const payload = JSON.stringify({ v: 1, issuer: 'xmr.club', issued_at: now, expires_at: now + 9999, sites: [{ ...site('mistex', ['mistex.io']) }], logo_pack: { ...ok, url: 'https://evil.club/feed/a.json' } });
    const env = { payload, signature: bytesToHex(ed25519.sign(new TextEncoder().encode(payload), sk)), public_key: bytesToHex(ed25519.getPublicKey(sk)), alg: 'ed25519' };
    const feed = readFeed(env, now, 0, new Set([bytesToHex(ed25519.getPublicKey(sk))]));
    expect(feed.sites).toHaveLength(1);
    expect(feed.logoPack).toBeUndefined();
  });
});

describe('the logos in the pack', () => {
  const feed = feedOf([site('mistex', ['mistex.io']), site('trocador', ['trocador.app'])]);
  it('reads WebP sizes from VP8X, VP8L and VP8 headers', () => {
    expect(webpSize(webp(32, 32))).toEqual({ width: 32, height: 32 });
    const lossless = webp(1, 1);
    lossless.set([..."VP8L"].map((c) => c.charCodeAt(0)), 12);
    lossless[20] = 0x2f;
    new DataView(lossless.buffer).setUint32(21, (31 & 0x3fff) | ((31 & 0x3fff) << 14), true);
    expect(webpSize(lossless)).toEqual({ width: 32, height: 32 });
    const lossy = webp(1, 1);
    lossy.set([..."VP8 "].map((c) => c.charCodeAt(0)), 12);
    lossy.set([0x9d, 0x01, 0x2a, 32, 0, 32, 0], 23);
    expect(webpSize(lossy)).toEqual({ width: 32, height: 32 });
    expect(webpSize(new TextEncoder().encode('RIFF....WEBPVP8Xjunkjunkjunkjunk'))).toBeNull();
  });

  it('keeps small WebPs of listed sites and drops the rest one by one', () => {
    // parsed, as the pack is, so __proto__ is an own key rather than the literal's prototype
    const json = JSON.parse(JSON.stringify({ mistex: LOGO, trocador: uri(webp(10000, 10000)), unlisted: LOGO, constructor: LOGO }).replace('{', `{"__proto__":${JSON.stringify(LOGO)},`));
    expect(Object.hasOwn(json, '__proto__')).toBe(true);
    const logos = readLogos(json, feed, 32);
    expect(Object.keys(logos)).toEqual(['mistex']);
    expect(Object.getPrototypeOf(logos)).toBeNull();
    for (const bad of ['data:image/png;base64,iVBORw0KGgo=', 'javascript:alert(1)', `data:image/webp;base64,${b64(webp(32, 32, 5000))}`, uri(new TextEncoder().encode('not a webp at all, not at all!!'))]) {
      expect(readLogos({ mistex: bad }, feed, 32)).toEqual({});
    }
    // size_px 32 allows up to 64; never more than 64
    expect(Object.keys(readLogos({ mistex: uri(webp(64, 64)) }, feed, 32))).toEqual(['mistex']);
    expect(readLogos({ mistex: uri(webp(65, 65)) }, feed, 64)).toEqual({});
    expect(() => readLogos(['x'], feed, 32)).toThrow();
  });

  it('maps a host to a site only when every record-issuing listing on it shows the same logo', () => {
    // kyc.rip as listed: cards and CLI share the host (the CLI with another logo) but issue no records
    const f = feedOf([site('kyc-rip-cards', ['kyc.rip'], false), site('kyc-rip-aggregator', ['kyc.rip']), site('kyc-rip-ghost', ['kyc.rip', 'kyc.rip']), site('kyc-rip-cli', ['kyc.rip'], false), site('a', ['www.shared.io']), site('b', ['shared.io']), site('c', ['half.io']), site('d', ['half.io']), site('e', ['solo.io', 'solo2.io'])]);
    const hosts = logoHosts(f, Object.assign(Object.create(null), { 'kyc-rip-cards': LOGO, 'kyc-rip-aggregator': LOGO, 'kyc-rip-ghost': LOGO, 'kyc-rip-cli': OTHER, a: LOGO, b: OTHER, c: LOGO, e: LOGO }));
    expect({ ...hosts }).toEqual({ 'kyc.rip': 'kyc-rip-aggregator', 'solo.io': 'e', 'solo2.io': 'e' });
    const pack: LogoPack = { sha256: 'x', logos: Object.assign(Object.create(null), { e: LOGO, 'kyc-rip-aggregator': LOGO }), hosts };
    expect(logoFor(pack, { host: 'WWW.Solo.io.' })).toBe(LOGO);
    expect(logoFor(pack, { host: 'shared.io' })).toBeUndefined();
    expect(logoFor(pack, { host: '__proto__' })).toBeUndefined();
    expect(logoFor(pack, { siteId: 'constructor' })).toBeUndefined();
  });
});

describe('logoKeeper', () => {
  async function setup(opts: { held?: LogoPack | null; on?: boolean } = {}) {
    const body = new TextEncoder().encode(JSON.stringify({ mistex: LOGO, trocador: LOGO }));
    const hash = await sha(body);
    const ref = { url: 'https://xmr.club/feed/logos-1.json', sha256: hash, bytes: body.length, sizePx: 32 };
    let held: LogoPack | null = opts.held ?? null;
    let feed: SiteFeed | null = feedOf([site('mistex', ['mistex.io']), site('trocador', ['trocador.app'])], ref);
    let on = opts.on ?? true;
    const deps = {
      held: { getValue: async () => held, setValue: async (v: LogoPack | null) => void (held = v), removeValue: async () => void (held = null) },
      feed: async () => feed,
      fetch: vi.fn(async () => new Response(body, { headers: { 'content-type': 'application/json' } })),
      readBody: async (res: Response, max: number) => {
        const b = new Uint8Array(await res.arrayBuffer());
        if (b.length > max) throw new Error('Response too large');
        return b;
      },
      sha256Hex: sha,
      enabled: async () => on,
    };
    return { k: logoKeeper(deps as never), deps, ref, body, held: () => held, setFeed: (f: SiteFeed | null) => (feed = f), setOn: (v: boolean) => (on = v), feed: () => feed! };
  }

  it('a new hash: one request, without cookies or referrer, then kept with its hosts', async () => {
    const t = await setup();
    await t.k.sync(t.feed());
    expect(t.deps.fetch).toHaveBeenCalledTimes(1);
    expect(t.deps.fetch).toHaveBeenCalledWith(t.ref.url, expect.objectContaining({ credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error' }));
    expect(t.held()!.sha256).toBe(t.ref.sha256);
    expect({ ...t.held()!.hosts }).toEqual({ 'mistex.io': 'mistex', 'trocador.app': 'trocador' });
  });

  it('the same hash: no request, but hosts and ids follow the new list', async () => {
    const t = await setup();
    await t.k.sync(t.feed());
    t.setFeed(feedOf([site('mistex', ['mistex.io', 'mistex.app'])], t.ref));
    await t.k.sync(t.feed());
    expect(t.deps.fetch).toHaveBeenCalledTimes(1);
    expect(Object.keys(t.held()!.logos)).toEqual(['mistex']);
    expect({ ...t.held()!.hosts }).toEqual({ 'mistex.io': 'mistex', 'mistex.app': 'mistex' });
  });

  it.each([
    ['a hash mismatch', (t: Awaited<ReturnType<typeof setup>>) => t.deps.fetch.mockResolvedValueOnce(new Response('{"mistex":"x"}', { headers: { 'content-type': 'application/json' } }))],
    ['HTTP 404', (t: Awaited<ReturnType<typeof setup>>) => t.deps.fetch.mockResolvedValueOnce(new Response('', { status: 404 }))],
    ['not JSON', (t: Awaited<ReturnType<typeof setup>>) => t.deps.fetch.mockResolvedValueOnce(new Response(t.body, { headers: { 'content-type': 'text/html' } }))],
    ['too big', (t: Awaited<ReturnType<typeof setup>>) => t.deps.fetch.mockResolvedValueOnce(new Response(new Uint8Array(t.body.length + 1), { headers: { 'content-type': 'application/json' } }))],
  ])('%s: the kept pack stays, its hosts follow the new list', async (_, fail) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const t = await setup({ held: { sha256: 'old', logos: Object.assign(Object.create(null), { mistex: LOGO }), hosts: Object.create(null) } });
    fail(t);
    await t.k.sync(t.feed());
    expect(t.held()!.sha256).toBe('old');
    expect({ ...t.held()!.hosts }).toEqual({ 'mistex.io': 'mistex' });
  });

  it('no pack in the list, or site info off: removed', async () => {
    const t = await setup({ held: { sha256: 'old', logos: Object.create(null), hosts: Object.create(null) } });
    await t.k.sync(feedOf([site('mistex', ['mistex.io'])]));
    expect(t.held()).toBeNull();
    const u = await setup({ on: false, held: { sha256: 'old', logos: Object.create(null), hosts: Object.create(null) } });
    await u.k.sync(u.feed());
    expect(u.held()).toBeNull();
    expect(u.deps.fetch).not.toHaveBeenCalled();
  });

  it('switched off while downloading: dropped', async () => {
    const t = await setup();
    let release!: (r: Response) => void;
    t.deps.fetch.mockImplementationOnce(() => new Promise((r) => (release = r)));
    const run = t.k.sync(t.feed());
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    t.setOn(false);
    release(new Response(t.body, { headers: { 'content-type': 'application/json' } }));
    await run;
    expect(t.held()).toBeNull();
  });

  it('a newer list with another hash mid-download: the old pack is dropped, the new one kept', async () => {
    const t = await setup();
    let release!: (r: Response) => void;
    t.deps.fetch.mockImplementationOnce(() => new Promise((r) => (release = r)));
    const first = t.k.sync(t.feed());
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    const body2 = new TextEncoder().encode(JSON.stringify({ mistex: OTHER }));
    const ref2 = { ...t.ref, url: 'https://xmr.club/feed/logos-2.json', sha256: await sha(body2), bytes: body2.length };
    t.setFeed(feedOf([site('mistex', ['mistex.io'])], ref2));
    t.deps.fetch.mockResolvedValueOnce(new Response(body2, { headers: { 'content-type': 'application/json' } }));
    const second = t.k.sync(t.feed());
    await second;
    release(new Response(t.body, { headers: { 'content-type': 'application/json' } }));
    await first;
    expect(t.held()!.sha256).toBe(ref2.sha256);
    expect(t.held()!.logos.mistex).toBe(OTHER);
  });

});

describe('the record cards', () => {
  beforeEach(() => fakeBrowser.reset());
  const pack: LogoPack = { sha256: 'x', logos: Object.assign(Object.create(null), { mistex: LOGO }), hosts: Object.assign(Object.create(null), { 'kyc.rip': 'mistex' }) };

  it('a letter by site id and a receipt by issuer host get the logo; without one, the initial', () => {
    const a = siteLogo(pack, { siteId: 'mistex' }, 'Mistex');
    expect(a.tagName).toBe('IMG');
    expect((a as HTMLImageElement).src).toBe(LOGO);
    expect((siteLogo(pack, { host: 'www.kyc.rip' }, 'kyc.rip') as HTMLImageElement).src).toBe(LOGO);
    const none = siteLogo(pack, { siteId: 'trocador' }, 'trocador');
    expect(none.tagName).toBe('SPAN');
    expect(none.textContent).toBe('T');
    expect(siteLogo(null, { siteId: 'mistex' }, '67.tax').textContent).toBe('6');
  });

  it('the panel follows the pack: a logo when it arrives, the initial when it goes', async () => {
    const send = vi.fn(async (m: { type: string }) => (m.type === 'letters-list' ? [{ id: 'l1', orderId: 'DX-1', siteId: 'mistex', siteName: 'Mistex', format: 'mistproof', savedAt: 1, page: 'https://mistex.io/order/DX-1' }] : []));
    vi.doMock('../src/messaging', async (orig) => ({ ...(await orig<typeof import('../src/messaging')>()), sendToBackground: send }));
    vi.resetModules();
    const { mountReceiptsPanel } = await import('../src/ui/receipts-panel');
    const { logoPackItem: item } = await import('../src/settings');
    const html = readFileSync(join(process.cwd(), 'src/entrypoints/options/index.html'), 'utf8');
    document.body.innerHTML = new DOMParser().parseFromString(html, 'text/html').querySelector('#receipts')!.outerHTML;
    await mountReceiptsPanel(document.querySelector('#receipts')!);
    const logo = () => document.querySelector('.rec-head .site-logo')!;
    expect(logo().tagName).toBe('SPAN');
    await item.setValue(pack);
    await vi.waitFor(() => expect(logo().tagName).toBe('IMG'));
    expect((logo() as HTMLImageElement).src).toBe(LOGO);
    expect([...document.querySelectorAll('img')].every((i) => i.src.startsWith('data:image/webp;base64,'))).toBe(true);
    await item.removeValue();
    await vi.waitFor(() => expect(logo().tagName).toBe('SPAN'));
    vi.doUnmock('../src/messaging');
  });
});

