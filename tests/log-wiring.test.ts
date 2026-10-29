import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { letterWatch } from '../src/entrypoints/content/letter';
import { buildLetterExport, LETTER_EXPORT_WARNING } from '../src/log/export';
import { fetchLetter, letterFromHtml, letterInText, MAX_FETCH_BYTES } from '../src/log/fetch';
import { verifyLetter } from '../src/log/pgp';
import { checkFoundLetter, letterRequests, logPages, type LetterReply, type LogPage } from '../src/log/service';
import { MAX_LETTERS, memoryLetterStore, saveLetter, type SavedLetter } from '../src/log/store';
import { verifyMistProof } from '../src/log/mistproof';
import { readFeed } from '../src/sites/feed';

const send = vi.hoisted(() => vi.fn());
vi.mock('../src/messaging', async (orig) => ({ ...(await orig<typeof import('../src/messaging')>()), sendToBackground: send }));

const fx = JSON.parse(readFileSync(join(process.cwd(), 'tests/fixtures/log/letters.json'), 'utf8')) as { keys: Record<string, { fingerprint: string; key: string }>; letters: Record<string, string> };
const sk = ed25519.utils.randomSecretKey();
const KEYS = new Set([bytesToHex(ed25519.getPublicKey(sk))]);
const NOW = 1_793_261_226;
const MISTEX_KEY = 'j/1x9v9Sv7n0BlSIbrW0IbsoAphfRrkF0pn9ObTRr7k=';
const STEREO = fx.letters['stereoswap-STRRSXUE.asc']!;
const MISTPROOF = fx.letters['mistex-DX-4W850L.json']!;
// the signed block alone, as letterInText cuts it from what's around it
const STEREO_BLOCK = STEREO.match(/-----BEGIN PGP SIGNED MESSAGE-----[\s\S]*?-----END PGP SIGNATURE-----/)![0];

const listing = (id: string, hosts: string[], over: Record<string, unknown>) => ({ id, name: id, category: 'exchanges', grade: 'B', incident: false, url: `https://xmr.club/exchanges/${id}`, hosts, ...over });
const feed = (() => {
  const sites = [
    listing('stereoswap', ['stereoswap.app'], {
      order_url: 'https://stereoswap.app/swap/{order}',
      log: { format: 'pgp', url: 'https://stereoswap.app/swap/{order}/letter.asc', pgp_fingerprint: fx.keys.stereoswap!.fingerprint, pgp_public_key: fx.keys.stereoswap!.key },
    }),
    listing('mistex', ['mistex.io'], { order_url: 'https://mistex.io/order/{order}', log: { format: 'mistproof', url: 'https://mistex.io/api/v1/orders/{order}/receipt', ed25519_key: MISTEX_KEY } }),
    listing('kyc-rip', ['kyc.rip'], { order_url: 'https://kyc.rip/track/{order}', log: { format: 'nkip01' } }),
  ];
  const text = JSON.stringify({ v: 1, issuer: 'xmr.club', issued_at: NOW, expires_at: NOW + 172800, sites });
  return readFeed({ payload: text, signature: bytesToHex(ed25519.sign(new TextEncoder().encode(text), sk)), public_key: bytesToHex(ed25519.getPublicKey(sk)), alg: 'ed25519' }, NOW, 0, KEYS);
})();
const STEREO_PAGE = 'https://stereoswap.app/swap/STRRSXUE?ref=abc#top';
const at = Date.UTC(2026, 9, 29, 12);

describe('logPages: what a page learns about its order', () => {
  it('a projection: never the feed’s log, order template or any key', () => {
    const pages = logPages(feed, STEREO_PAGE);
    expect(pages).toEqual([{ siteId: 'stereoswap', name: 'stereoswap', format: 'pgp', orderId: 'STRRSXUE', letterUrl: 'https://stereoswap.app/swap/STRRSXUE/letter.asc' }]);
    const wire = JSON.stringify(pages);
    for (const leak of ['BEGIN PGP', fx.keys.stereoswap!.fingerprint, 'orderUrl', '"log"', 'publicKey']) expect(wire).not.toContain(leak);
    expect(JSON.stringify(logPages(feed, 'https://mistex.io/order/DX-4W850L'))).not.toContain(MISTEX_KEY);
  });
  it('nothing without a feed or off an order page', () => {
    expect(logPages(null, STEREO_PAGE)).toEqual([]);
    expect(logPages(feed, 'https://stereoswap.app/about')).toEqual([]);
  });
});

describe('checkFoundLetter: verified letters are saved, once', () => {
  const deps = () => ({ verifyLetter, store: memoryLetterStore(), now: () => at });

  it('verifies a real letter for this page and saves it with the feed’s key, without the query', async () => {
    const d = deps();
    const r = await checkFoundLetter(feed, STEREO_PAGE, 'stereoswap', STEREO, d);
    expect(r).toMatchObject({ verified: true, saved: true });
    expect(r.addresses.find((a) => a.role === 'deposit')?.address).toBe('bc1qmumua59vdrukll6segkjm2zh0zgp5fphrtgtx9');
    // the reply carries no key
    expect(JSON.stringify(r)).not.toContain('BEGIN PGP PUBLIC KEY');
    const [saved] = [...d.store.letters.values()];
    expect(saved).toMatchObject({ siteId: 'stereoswap', orderId: 'STRRSXUE', page: 'https://stereoswap.app/swap/STRRSXUE', text: STEREO, fingerprint: fx.keys.stereoswap!.fingerprint, key: fx.keys.stereoswap!.key, feedIssuedAt: NOW, savedAt: at });
    expect(saved!.id).toMatch(/^[0-9a-f]{64}$/);
    // again: nothing new
    await checkFoundLetter(feed, STEREO_PAGE, 'stereoswap', STEREO, d);
    expect(d.store.letters.size).toBe(1);
  });

  it('a letter that fails is not saved', async () => {
    const d = deps();
    const r = await checkFoundLetter(feed, STEREO_PAGE, 'stereoswap', STEREO.replace('STRRSXUE', 'STRRSXUF'), d);
    expect(r).toMatchObject({ verified: false, saved: false });
    expect(r.lines[0]!.level).toBe('warn');
    expect(d.store.letters.size).toBe(0);
  });

  it('a letter for another order (the page is the tab’s, not the message’s) is not saved', async () => {
    const d = deps();
    const r = await checkFoundLetter(feed, 'https://stereoswap.app/swap/OTHER123', 'stereoswap', STEREO, d);
    expect(r.verified).toBe(false);
    expect(d.store.letters.size).toBe(0);
  });

  it('refuses a listing the page doesn’t match, and NKIP-0001 listings', async () => {
    await expect(checkFoundLetter(feed, STEREO_PAGE, 'mistex', MISTPROOF, deps())).rejects.toThrow();
    await expect(checkFoundLetter(feed, 'https://kyc.rip/track/ABCD1234', 'kyc-rip', '{}', deps())).rejects.toThrow();
    await expect(checkFoundLetter(null, STEREO_PAGE, 'stereoswap', STEREO, deps())).rejects.toThrow();
  });

  it('MistProof: saved with the Ed25519 key', async () => {
    const d = deps();
    const r = await checkFoundLetter(feed, 'https://mistex.io/order/DX-4W850L', 'mistex', MISTPROOF, d);
    expect(r).toMatchObject({ verified: true, saved: true });
    expect([...d.store.letters.values()][0]).toMatchObject({ format: 'mistproof', key: MISTEX_KEY });
  });

  it('a store error leaves the check verified, not saved, and says so', async () => {
    const d = deps();
    d.store.put = async () => {
      throw new Error('quota');
    };
    expect(await checkFoundLetter(feed, STEREO_PAGE, 'stereoswap', STEREO, d)).toMatchObject({ verified: true, saved: false, saveError: 'Not saved: quota' });
  });
});

describe('the background’s log-page and log-found handlers', () => {
  const tab = { id: 7, url: STEREO_PAGE };
  const me = { id: 'xmradar', frameId: 0, tab };
  const setup = (over: { on?: () => Promise<boolean>; budget?: () => boolean } = {}) => {
    const store = memoryLetterStore();
    const r = letterRequests({ runtimeId: 'xmradar', checksOn: over.on ?? (async () => true), feed: async () => feed, budget: over.budget ?? (() => true), verifyLetter, store, now: () => at });
    return { r, store };
  };

  it('only the top frame of a tab in this extension, with the tab’s own URL', async () => {
    const { r } = setup();
    expect(await r.logPage(me)).toEqual([{ siteId: 'stereoswap', name: 'stereoswap', format: 'pgp', orderId: 'STRRSXUE', letterUrl: 'https://stereoswap.app/swap/STRRSXUE/letter.asc' }]);
    for (const bad of [{ ...me, id: 'other' }, { ...me, frameId: 1 }, { ...me, tab: undefined }, { ...me, tab: { id: 7 } }]) {
      await expect(r.logPage(bad)).rejects.toThrow('Not allowed');
      await expect(r.logFound({ siteId: 'stereoswap', text: STEREO }, bad)).rejects.toThrow('Not allowed');
    }
  });

  it('checks off: no order, no letter', async () => {
    const { r, store } = setup({ on: async () => false });
    expect(await r.logPage(me)).toEqual([]);
    await expect(r.logFound({ siteId: 'stereoswap', text: STEREO }, me)).rejects.toThrow('off');
    expect(store.letters.size).toBe(0);
  });

  it('a malformed message, or a tab out of budget, is refused', async () => {
    await expect(setup().r.logFound({ siteId: 1, text: STEREO }, me)).rejects.toThrow('Bad letter');
    await expect(setup().r.logFound({ siteId: 'stereoswap' }, me)).rejects.toThrow('Bad letter');
    await expect(setup({ budget: () => false }).r.logFound({ siteId: 'stereoswap', text: STEREO }, me)).rejects.toThrow('Too many');
  });

  it('verifies and saves; switched off while it verified: checked, but nothing saved', async () => {
    const { r, store } = setup();
    expect(await r.logFound({ siteId: 'stereoswap', text: STEREO }, me)).toMatchObject({ verified: true, saved: true });
    expect(store.letters.size).toBe(1);
    // on for the first ask, off by the time the letter would be saved
    let asks = 0;
    const late = setup({ on: async () => asks++ === 0 });
    expect(await late.r.logFound({ siteId: 'stereoswap', text: STEREO }, me)).toMatchObject({ verified: true, saved: false, saveError: expect.stringContaining('switched off') });
    expect(late.store.letters.size).toBe(0);
  });
});

describe('the letter store', () => {
  const letter = (i: number): SavedLetter => ({ id: `id${i}`, siteId: 's', siteName: 's', format: 'pgp', orderId: `O${i}`, page: 'https://s/x', text: 't', key: 'k', feedIssuedAt: NOW, savedAt: i });
  it(`keeps at most ${MAX_LETTERS}, dropping the oldest`, async () => {
    const store = memoryLetterStore();
    for (let i = 0; i < MAX_LETTERS; i++) await store.put(letter(i));
    expect(await saveLetter(store, letter(10_000))).toEqual({ pruned: 1 });
    expect(store.letters.has('id0')).toBe(false);
    expect(store.letters.size).toBe(MAX_LETTERS);
    // a letter saved before costs nothing
    expect(await saveLetter(store, letter(10_000))).toEqual({ pruned: 0 });
  });
});

describe('export', () => {
  it('PGP: the exact text and the feed’s key, which verify again offline', async () => {
    const store = memoryLetterStore();
    await checkFoundLetter(feed, STEREO_PAGE, 'stereoswap', STEREO, { verifyLetter, store, now: () => at });
    const x = buildLetterExport([...store.letters.values()][0]!, at);
    expect(x).toMatchObject({ format: 'xmradar-letter/1', orderId: 'STRRSXUE', letter: { format: 'pgp', text: STEREO }, key: { fingerprint: fx.keys.stereoswap!.fingerprint } });
    expect(x.key.source).toContain(new Date(NOW * 1000).toISOString());
    expect((await verifyLetter(x.letter.text, x.key.armored!, x.key.fingerprint!, new Date(at))).ok).toBe(true);
    expect(LETTER_EXPORT_WARNING).toMatch(/order id and swap addresses/);
  });
  it('MistProof: the JSON and the Ed25519 key', async () => {
    const store = memoryLetterStore();
    await checkFoundLetter(feed, 'https://mistex.io/order/DX-4W850L', 'mistex', MISTPROOF, { verifyLetter, store, now: () => at });
    const x = buildLetterExport([...store.letters.values()][0]!, at);
    expect(x.key.ed25519).toBe(MISTEX_KEY);
    expect(verifyMistProof(x.letter.text, x.key.ed25519!).ok).toBe(true);
  });
});

describe('fetchLetter: one same-origin request', () => {
  const ORIGIN = 'https://stereoswap.app';
  const URL_ = `${ORIGIN}/swap/STRRSXUE/letter.asc`;
  const respond = (body: string, init: ResponseInit & { url?: string } = {}) => {
    const r = new Response(body, init);
    Object.defineProperty(r, 'url', { value: init.url ?? URL_ });
    return r;
  };

  it('asks with the page’s cookies and refuses redirects', async () => {
    const f = vi.fn(async () => respond(STEREO, { headers: { 'content-type': 'text/plain' } }));
    expect(await fetchLetter(URL_, ORIGIN, f as unknown as typeof fetch)).toEqual({ ok: true, text: STEREO });
    expect(f).toHaveBeenCalledWith(URL_, expect.objectContaining({ credentials: 'include', redirect: 'error' }));
  });
  it('never asks another origin', async () => {
    const f = vi.fn();
    expect(await fetchLetter('https://evil.example/letter.asc', ORIGIN, f as unknown as typeof fetch)).toMatchObject({ ok: false });
    expect(f).not.toHaveBeenCalled();
  });
  it('a redirect (refused by the browser) or a final URL elsewhere is no letter', async () => {
    const redirected = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    expect(await fetchLetter(URL_, ORIGIN, redirected as unknown as typeof fetch)).toEqual({ ok: false, why: 'no answer' });
    const moved = vi.fn(async () => respond(STEREO, { url: 'https://evil.example/x' }));
    expect(await fetchLetter(URL_, ORIGIN, moved as unknown as typeof fetch)).toEqual({ ok: false, why: 'moved to another site' });
  });
  it('an error status or a body that is too large is no letter', async () => {
    expect(await fetchLetter(URL_, ORIGIN, (async () => respond('nope', { status: 404 })) as unknown as typeof fetch)).toEqual({ ok: false, why: 'HTTP 404' });
    expect(await fetchLetter(URL_, ORIGIN, (async () => respond('x'.repeat(MAX_FETCH_BYTES + 1))) as unknown as typeof fetch)).toEqual({ ok: false, why: 'too large' });
  });
  it('an HTML page (SageSwap): the text of the <pre> that holds the letter, entities decoded', async () => {
    const html = `<html><body><pre>other</pre><pre>${STEREO.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre></body></html>`;
    expect(letterFromHtml(html)).toBe(STEREO);
    expect(await fetchLetter(URL_, ORIGIN, (async () => respond(html, { headers: { 'content-type': 'text/html; charset=utf-8' } })) as unknown as typeof fetch)).toEqual({ ok: true, text: STEREO });
    expect(await fetchLetter(URL_, ORIGIN, (async () => respond('<p>Log in</p>', { headers: { 'content-type': 'text/html' } })) as unknown as typeof fetch)).toEqual({ ok: false, why: 'no letter in the page' });
  });
});

describe('letterInText: a letter the page shows or the user copies', () => {
  it('clear-signed blocks, without what is around them', () => {
    expect(letterInText(`Your letter:\n${STEREO}\nThanks`)).toBe(STEREO_BLOCK);
    expect(letterInText('no letter here')).toBeNull();
  });
  it('MistProof JSON inside other text, nearest object first', () => {
    const shown = `MistProof {"note":"x"} ${MISTPROOF} Copy`;
    expect(JSON.parse(letterInText(shown)!)).toEqual(JSON.parse(MISTPROOF));
    expect(letterInText('"format":"mistex-receipt/1" but no object')).toBeNull();
  });
});

describe('letterWatch: the content side', () => {
  const page: LogPage = { siteId: 'stereoswap', name: 'StereoSwap', format: 'pgp', orderId: 'STRRSXUE', letterUrl: `${location.origin}/swap/STRRSXUE/letter.asc` };
  const verified: LetterReply = { verified: true, lines: [{ level: 'ok', text: 'signed' }], addresses: [{ address: 'bc1qmumua59vdrukll6segkjm2zh0zgp5fphrtgtx9', role: 'deposit' }], signedText: 'x', saved: true };
  let fetchSpy: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fakeBrowser.reset();
    send.mockReset().mockImplementation(async (m: { type: string }) => (m.type === 'log-page' ? [page] : verified));
    fetchSpy = vi.fn(async () => {
      const r = new Response(STEREO, { headers: { 'content-type': 'text/plain' } });
      Object.defineProperty(r, 'url', { value: page.letterUrl });
      return r;
    });
    vi.stubGlobal('fetch', fetchSpy);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('fetches the letter once and sends it to the background', async () => {
    const w = letterWatch({ onChange: () => {}, fetchOn: async () => true });
    await w.start();
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith({ type: 'log-found', siteId: 'stereoswap', text: STEREO }));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(w.entries(document)[0]!.reply).toEqual(verified);
    // a copy of the same letter, or any letter once verified, is not sent again
    w.capture(STEREO);
    expect(send.mock.calls.filter(([m]) => m.type === 'log-found')).toHaveLength(1);
  });

  it('logFetch off: no request; a copied letter is still checked', async () => {
    const w = letterWatch({ onChange: () => {}, fetchOn: async () => false });
    await w.start();
    await vi.waitFor(() => expect(w.entries(document)[0]!.lines[0]!.text).toMatch(/copy the letter/));
    expect(fetchSpy).not.toHaveBeenCalled();
    w.capture(`copied:\n${STEREO}`);
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith({ type: 'log-found', siteId: 'stereoswap', text: STEREO_BLOCK }));
  });

  it('site info off: not even asked whether this is an order page', async () => {
    await fakeBrowser.storage.sync.set({ xmrSettings: { badgesX: true, badgesNostr: true, nostrDiscovery: false, tipReceipts: true, badgeIcon: 'mono', badgeLabel: true, siteInfo: false } });
    const w = letterWatch({ onChange: () => {}, fetchOn: async () => true });
    await w.start();
    expect(send).not.toHaveBeenCalled();
  });

  it('a failed fetch is "not available yet", never a failed check', async () => {
    fetchSpy.mockImplementation(async () => new Response('', { status: 401 }));
    const w = letterWatch({ onChange: () => {}, fetchOn: async () => true });
    await w.start();
    await vi.waitFor(() => expect(w.entries(document)[0]!.lines).toMatchObject([{ level: 'off', text: expect.stringContaining('not available yet (HTTP 401)') }]));
  });

  it('NKIP-0001 listings are left to the receipt', async () => {
    send.mockImplementation(async (m: { type: string }) => (m.type === 'log-page' ? [{ ...page, format: 'nkip01', letterUrl: null }] : verified));
    const w = letterWatch({ onChange: () => {}, fetchOn: async () => true });
    await w.start();
    expect(w.entries(document)).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('several orders on one page: a captured letter goes to the order it names, and copies are checked against all verified letters', async () => {
    // an order id that is a prefix of this letter's (STRRSXUE) gets nothing
    const other: LogPage = { ...page, siteId: 'stereo-mirror', orderId: 'STRRSX', letterUrl: null };
    send.mockImplementation(async (m: { type: string }) => (m.type === 'log-page' ? [{ ...page, letterUrl: null }, other] : verified));
    const w = letterWatch({ onChange: () => {}, fetchOn: async () => true });
    await w.start();
    w.capture(STEREO);
    await vi.waitFor(() => expect(send.mock.calls.filter(([m]) => m.type === 'log-found')).toHaveLength(1));
    expect(send).toHaveBeenCalledWith({ type: 'log-found', siteId: 'stereoswap', text: STEREO_BLOCK });
    await vi.waitFor(() => expect(w.entries(document)[0]!.reply?.verified).toBe(true));
    expect(w.copyWarning('bc1qmumua59vdrukll6segkjm2zh0zgp5fphrtgtx9')).toBeNull();
    // the other order's id, shortened on the page, is not a stray address for this one
    document.body.innerHTML = '<p>Also open: 3ZZZ...9999</p><p>Deposit to <code>bc1qmumua59vdrukll6segkjm2zh0zgp5fphrtgtx9</code></p>';
    const otherId = { ...other, orderId: '3ZZZ-0000-9999' };
    send.mockImplementation(async (m: { type: string }) => (m.type === 'log-page' ? [{ ...page, letterUrl: null }, otherId] : verified));
    const w2 = letterWatch({ onChange: () => {}, fetchOn: async () => true });
    await w2.start();
    w2.capture(STEREO);
    await vi.waitFor(() => expect(w2.entries(document)[0]!.reply?.verified).toBe(true));
    expect(w2.entries(document)[0]!.lines.map((l) => l.level)).not.toContain('caution');
    document.body.innerHTML = '';
  });

  it('stop() cancels a letter request still in flight', async () => {
    let signal: AbortSignal | undefined;
    fetchSpy.mockImplementation((_u: string, init: RequestInit) => {
      signal = init.signal ?? undefined;
      return new Promise((_, reject) => signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
    });
    const w = letterWatch({ onChange: () => {}, fetchOn: async () => true });
    await w.start();
    await vi.waitFor(() => expect(signal).toBeDefined());
    w.stop();
    expect(signal!.aborted).toBe(true);
    expect(send.mock.calls.filter(([m]) => m.type === 'log-found')).toHaveLength(0);
  });

  it('copy check against the verified letter', async () => {
    const w = letterWatch({ onChange: () => {}, fetchOn: async () => true });
    await w.start();
    await vi.waitFor(() => expect(w.entries(document)[0]!.reply?.verified).toBe(true));
    expect(w.copyWarning('bc1qmumua59vdrukll6segkjm2zh0zgp5fphrtgtx9')).toBeNull();
    expect(w.copyWarning('bc1q9a6k7z7wvzcvsy9tlrefl0kz67ma593spst9kv')).toContain("doesn't name");
  });
});

describe('the build: openpgp.js in the background only', () => {
  // runs after `pnpm build`, which CI does first (XMRADAR_REQUIRE_BUILD: a missing build fails there);
  // locally it skips without one. The source boundary is tested in log.test.ts either way.
  const required = !!process.env.XMRADAR_REQUIRE_BUILD;
  for (const target of ['chrome-mv3', 'firefox-mv3']) {
    const dir = join(process.cwd(), 'output', target);
    it.skipIf(!required && !existsSync(join(dir, 'background.js')))(target, () => {
      const read = (f: string) => readFileSync(join(dir, f), 'utf8');
      const has = (f: string) => read(f).includes('readCleartextMessage');
      expect(has('background.js')).toBe(true);
      expect(has('content-scripts/content.js')).toBe(false);
      for (const f of readdirSync(join(dir, 'chunks'))) expect(has(`chunks/${f}`)).toBe(false);
      // size budgets (PLAN-LOG Round 3): openpgp.js is about 240 KB, so a leak into the page script shows here
      expect(read('content-scripts/content.js').length).toBeLessThan(250_000);
      expect(read('background.js').length).toBeLessThan(700_000);
    });
  }
});
