import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { describe, expect, it, vi } from 'vitest';
import { canonicalMessage, parseChallenge, timely, type Challenge } from '../src/siwm/challenge';
import { sameSite } from '../src/siwm/site';
import { addressKeys, verifySpendSignature } from '../src/siwm/signature';
import { mountConsent } from '../src/siwm/consent';
import { cappedText, siwmService, verifierAnswer, type SiwmStore } from '../src/siwm/service';
import { signinLinkOf, startSigninLinks } from '../src/siwm/link-click';

// NKIP-0003's own vectors (CC0); the addresses belong to a throwaway offline test wallet
const V = JSON.parse(readFileSync(join(process.cwd(), 'tests/fixtures/nkip0003-v1.json'), 'utf8')) as {
  valid: { name: string; uri: string; message: string; message_sha256: string; callback_same_site: boolean; signatures: string[] }[];
  invalid: { name: string; uri: string; reason: string }[];
  bad_signatures: { name: string; message: string; address: string; signature: string }[];
  test_wallet: { primary_address: string; subaddress_0_1: string };
};

const ok = (uri: string): Challenge => {
  const r = parseChallenge(uri);
  if (!r.ok) throw new Error(r.reason);
  return r.c;
};

describe('parseChallenge + canonicalMessage (R1, R2)', () => {
  it.each(V.valid.map((v) => [v.name, v] as const))('valid: %s', (_n, v) => {
    const c = ok(v.uri);
    const msg = canonicalMessage(c);
    expect(msg).toBe(v.message);
    expect(bytesToHex(sha256(new TextEncoder().encode(msg)))).toBe(v.message_sha256);
    expect(msg.endsWith('\n')).toBe(false);
  });

  it.each(V.invalid.map((v) => [v.name, v] as const))('invalid: %s', (_n, v) => {
    expect(parseChallenge(v.uri).ok).toBe(false);
  });

  it('scheme forms: with and without ?, any case; never //', () => {
    const query = V.valid[0]!.uri.slice('monero-signin:?'.length);
    expect(parseChallenge(`monero-signin:${query}`).ok).toBe(true);
    expect(parseChallenge(`MONERO-SIGNIN:?${query}`).ok).toBe(true);
    expect(parseChallenge(`monero-signin://?${query}`).ok).toBe(false);
    expect(parseChallenge(`ripley://sign?${query}`).ok).toBe(false);
    expect(parseChallenge('monero-signin:?').ok).toBe(false);
  });

  it('purpose: absent → login; present but empty → refused', () => {
    const base = V.valid[0]!.uri;
    expect(ok(base.replace('&purpose=login', '')).purpose).toBe('login');
    expect(parseChallenge(base.replace('purpose=login', 'purpose=')).ok).toBe(false);
  });

  it('every Default_Ignorable and blank character in a handle is refused, other scripts are fine', () => {
    const base = V.valid[0]!.uri;
    for (const cp of [0xad, 0x34f, 0x61c, 0x115f, 0x17b4, 0x180e, 0x200b, 0x200d, 0x202e, 0x2066, 0x3164, 0xfe0f, 0xfeff, 0xffa0, 0xfff0, 0x1bca0, 0x1d173, 0xe0041, 0xe0100, 0x2800]) {
      expect(parseChallenge(base.replace('handle=alice', `handle=al${encodeURIComponent(String.fromCodePoint(cp))}ice`)).ok, cp.toString(16)).toBe(false);
    }
    expect(ok(base.replace('handle=alice', `handle=${encodeURIComponent('ありす')}`)).handle).toBe('ありす');
    expect(parseChallenge(base.replace('handle=alice', `handle=${'a'.repeat(65)}`)).ok).toBe(false);
  });

  it('origin ports must be numbers in range; impossible dates and long windows refused', () => {
    const base = V.valid[0]!.uri;
    expect(ok(base.replace('origin=example.org', 'origin=example.org%3A8443')).origin).toBe('example.org:8443');
    expect(parseChallenge(base.replace('origin=example.org', 'origin=example.org%3A99999')).ok).toBe(false);
    expect(parseChallenge(base.replace('origin=example.org', 'origin=example.org%3A')).ok).toBe(false);
    expect(parseChallenge(base.replace('2026-10-27T12%3A00', '2026-02-30T12%3A00').replace('2026-10-27T12%3A03', '2026-02-30T12%3A03')).ok).toBe(false);
    expect(parseChallenge(base.replace('12%3A03%3A00', '12%3A16%3A00')).ok).toBe(false);
  });

  it('return_url: https anywhere, http only to this computer, no user info or fragment', () => {
    const base = V.valid[0]!.uri;
    const cb = (u: string) => parseChallenge(base.replace('https%3A%2F%2Fauth.example.net%2Fsignin%2Fcallback', encodeURIComponent(u))).ok;
    expect(cb('https://auth.example.net:8443/cb')).toBe(true);
    expect(cb('http://localhost:8787/cb')).toBe(true);
    expect(cb('http://127.0.0.1/cb')).toBe(true);
    expect(cb('http://[::1]/cb')).toBe(true);
    expect(cb('http://auth.example.net/cb')).toBe(false);
    expect(cb('https://u:p@auth.example.net/cb')).toBe(false);
    expect(cb('https://u@auth.example.net/cb')).toBe(false);
    expect(cb('https://auth.example.net/cb#x')).toBe(false);
    expect(cb('javascript:alert(1)')).toBe(false);
  });
});

describe('timely', () => {
  const c = ok(V.valid[0]!.uri);
  it('expired, too far ahead, or fine', () => {
    expect(timely(c, Date.parse('2026-10-27T12:01:00Z'))).toBe('ok');
    expect(timely(c, Date.parse('2026-10-27T12:03:00Z'))).toBe('expired');
    expect(timely(c, Date.parse('2026-10-27T11:54:00Z'))).toBe('future');
  });
});

describe('sameSite (Public Suffix List)', () => {
  it('registrable domain, private suffixes, ports, IPs and localhost', () => {
    expect(sameSite('xmr.bio', 'api.xmr.bio')).toBe(true);
    expect(sameSite('xmr.bio:443', 'xmr.bio')).toBe(true);
    expect(sameSite('example.org', 'auth.example.net')).toBe(false);
    expect(sameSite('a.github.io', 'b.github.io')).toBe(false);
    expect(sameSite('localhost:3000', 'localhost')).toBe(true);
    expect(sameSite('127.0.0.1', '127.0.0.2')).toBe(false);
    expect(sameSite('[::1]:8787', '::1')).toBe(true);
  });
  it('agrees with the vectors', () => {
    for (const v of V.valid) {
      const c = ok(v.uri);
      expect(sameSite(c.origin, new URL(c.return_url).host)).toBe(v.callback_same_site);
    }
  });
});

describe('verifySpendSignature (R3)', () => {
  it("the vectors' SigV1 and SigV2 from monero-wallet-rpc verify, primary and subaddress", () => {
    let n = 0;
    for (const v of V.valid) {
      const c = ok(v.uri);
      for (const s of v.signatures) {
        expect(verifySpendSignature(v.message, c.address, s), `${v.name} ${s.slice(0, 5)}`).toBe(true);
        n++;
      }
    }
    expect(n).toBeGreaterThanOrEqual(3);
  });
  it.each(V.bad_signatures.map((b) => [b.name, b] as const))('refused: %s', (_n, b) => {
    expect(verifySpendSignature(b.message, b.address, b.signature)).toBe(false);
  });
  it('a changed message, a flipped byte, garbage or another address fail', () => {
    const v = V.valid[0]!;
    const c = ok(v.uri);
    const s = v.signatures[0]!;
    expect(verifySpendSignature(v.message + ' ', c.address, s)).toBe(false);
    const flip = s.slice(0, 20) + (s[20] === 'A' ? 'B' : 'A') + s.slice(21);
    expect(verifySpendSignature(v.message, c.address, flip)).toBe(false);
    for (const g of ['', 'SigV2', 'SigV3' + s.slice(5), 'SigV2!!!', s.slice(0, -3)]) expect(verifySpendSignature(v.message, c.address, g)).toBe(false);
    expect(verifySpendSignature(v.message, V.test_wallet.subaddress_0_1, s)).toBe(false);
  });
});

describe('addressKeys', () => {
  it('mainnet standard and subaddress; checksum and prefix enforced', () => {
    expect(addressKeys(V.test_wallet.primary_address)?.spend).toHaveLength(32);
    expect(addressKeys(V.test_wallet.subaddress_0_1)?.view).toHaveLength(32);
    const a = V.test_wallet.primary_address;
    expect(addressKeys(a.slice(0, 50) + (a[50] === 'z' ? 'y' : 'z') + a.slice(51))).toBeNull();
    expect(addressKeys('not an address')).toBeNull();
  });
});

// ---- the helper around the checks ----

const AT = Date.parse('2026-10-27T12:01:00Z');
const VALID = V.valid[0]!;
const SIG = VALID.signatures[0]!;

function service(post = vi.fn(async (_u: string, _b: string) => ({ status: 200, text: '{"ok":true}' }))) {
  let store: SiwmStore = {};
  let n = 0;
  const openWindow = vi.fn(async () => 42);
  const svc = siwmService({
    store: { getValue: async () => store, setValue: async (v) => void (store = v) },
    now: () => AT,
    randomId: () => `id${++n}`,
    openWindow,
    post,
  });
  return { svc, post, openWindow, store: () => store };
}

describe('siwmService', () => {
  it('keeps the link and the page host only; opens one window; forgets it when the window closes', async () => {
    const t = service();
    const { id } = await t.svc.open(VALID.uri, 'example.org');
    expect(t.openWindow).toHaveBeenCalledWith(id);
    expect(t.store()[id]).toEqual({ uri: VALID.uri, pageHost: 'example.org', at: AT, windowId: 42 });
    await t.svc.windowClosed(42);
    expect(await t.svc.get(id)).toBeNull();
  });

  it('a pasted link opens no second window', async () => {
    const t = service();
    await t.svc.open(VALID.uri, null, false);
    expect(t.openWindow).not.toHaveBeenCalled();
  });

  it('posts session, address and the signature after checking it; success uses the challenge up', async () => {
    const t = service();
    const { id } = await t.svc.open(VALID.uri, 'example.org');
    expect(await t.svc.submit(id, `  ${SIG}\n`)).toEqual({ ok: true });
    const c = ok(VALID.uri);
    expect(t.post).toHaveBeenCalledWith(c.return_url, JSON.stringify({ session: c.session, address: c.address, signature: SIG }));
    expect(await t.svc.get(id)).toBeNull();
  });

  it('a refused callback keeps the challenge for another try, with the site’s words', async () => {
    const t = service(vi.fn(async () => ({ status: 400, text: '{"ok":false,"error":"bad\\n signature"}' })));
    const { id } = await t.svc.open(VALID.uri, 'example.org');
    expect(await t.svc.submit(id, SIG)).toEqual({ ok: false, error: 'The site said: bad signature' });
    expect(await t.svc.get(id)).not.toBeNull();
  });

  it('never posts: a bad or view-key signature, a link from another site, an expired or invalid link', async () => {
    const t = service();
    const a = await t.svc.open(VALID.uri, 'example.org');
    expect((await t.svc.submit(a.id, V.bad_signatures[0]!.signature)).ok).toBe(false);
    expect((await t.svc.submit(a.id, 'SigV2nope')).ok).toBe(false);
    const b = await t.svc.open(VALID.uri, 'evil.example');
    expect(await t.svc.submit(b.id, SIG)).toMatchObject({ ok: false, error: expect.stringContaining('another site') });
    const c = await t.svc.open(V.invalid[0]!.uri, 'example.org');
    expect((await t.svc.submit(c.id, SIG)).ok).toBe(false);
    expect((await t.svc.submit('nope', SIG)).ok).toBe(false);
    expect(t.post).not.toHaveBeenCalled();
  });

  it('an unreachable verifier is said plainly', async () => {
    const t = service(vi.fn(async () => Promise.reject(new Error('net'))));
    const { id } = await t.svc.open(VALID.uri, null);
    expect(await t.svc.submit(id, SIG)).toEqual({ ok: false, error: 'Couldn’t reach auth.example.net. Try again.' });
  });

  it('verifierAnswer: only a 2xx with ok:true is success; anything else one short line', () => {
    expect(verifierAnswer(200, '{"ok":true}')).toEqual({ ok: true });
    expect(verifierAnswer(200, '{"ok":"yes"}').ok).toBe(false);
    expect(verifierAnswer(500, '<html>')).toEqual({ ok: false, error: 'The site refused the sign-in (HTTP 500).' });
    expect((verifierAnswer(400, JSON.stringify({ error: 'x'.repeat(500) })) as { error: string }).error.length).toBeLessThan(230);
  });
});

describe('mountConsent', () => {
  const html = readFileSync(join(process.cwd(), 'src/entrypoints/siwm/index.html'), 'utf8').replace(/<script[\s\S]*?<\/script>/g, '');
  function setup(entry: { uri: string; pageHost: string | null; crossSite?: boolean; callbackOwnSite?: boolean } | null, submit = vi.fn(async () => ({ ok: true as const }))) {
    document.documentElement.innerHTML = html.replace(/^[\s\S]*?<html[^>]*>/, '').replace(/<\/html>\s*$/, '');
    const d = { id: 'id1', get: vi.fn(async () => (entry ? { crossSite: false, callbackOwnSite: false, ...entry } : null)), open: vi.fn(async () => ({ id: 'id2' })), submit, copy: vi.fn(async (_t: string) => {}), save: vi.fn((_n: string, _t: string) => {}), setId: vi.fn(), close: vi.fn(), now: () => AT };
    return { d, done: mountConsent(document, d) };
  }
  const visible = () => ['paste', 'refused', 'consent', 'done'].filter((s) => !document.getElementById(s)!.hidden);

  it('shows every R6 fact, the full message and the warning, as text', async () => {
    const t = setup({ uri: VALID.uri, pageHost: 'example.org' });
    await t.done;
    expect(visible()).toEqual(['consent']);
    const text = document.getElementById('consent')!.textContent!;
    for (const s of ['example.org', '@alice', ok(VALID.uri).address, 'auth.example.net', 'a different site', 'in 2:00', 'Approve only a sign-in you started yourself']) expect(text).toContain(s);
    expect(document.querySelector('[data-f="message"]')!.textContent).toBe(VALID.message);
    expect((document.getElementById('ripley') as HTMLAnchorElement).getAttribute('href')).toBe(`ripley://sign?${VALID.uri.slice('monero-signin:?'.length)}`);
  });

  it('a link from another site shows only the refusal: nothing to copy or sign', async () => {
    const t = setup({ uri: VALID.uri, pageHost: 'evil.example', crossSite: true });
    await t.done;
    expect(visible()).toEqual(['refused']);
    expect(document.getElementById('refused-why')!.textContent).toContain('evil.example');
    expect(document.querySelector('[data-f="message"]')!.textContent).toBe('');
  });

  it('invalid, expired or gone links are refused', async () => {
    await setup({ uri: V.invalid[0]!.uri, pageHost: null }).done;
    expect(visible()).toEqual(['refused']);
    await setup({ uri: VALID.uri.replace('12%3A03', '12%3A01'), pageHost: null }).done;
    expect(document.getElementById('refused-why')!.textContent).toContain('expired');
    await setup(null).done;
    expect(visible()).toEqual(['refused']);
  });

  it('sends the pasted signature; success says so and closes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval'] });
    const t = setup({ uri: VALID.uri, pageHost: null });
    await t.done;
    expect(document.querySelector('[data-f="page"]')!.textContent).toContain('pasted');
    (document.getElementById('signature') as HTMLTextAreaElement).value = ` ${SIG} `;
    document.getElementById('send')!.click();
    await vi.waitFor(() => expect(visible()).toEqual(['done']));
    expect(t.d.submit).toHaveBeenCalledWith('id1', SIG);
    vi.advanceTimersByTime(3000);
    expect(t.d.close).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('a failure keeps the window open with the reason', async () => {
    const t = setup({ uri: VALID.uri, pageHost: null }, vi.fn(async () => ({ ok: false as const, error: 'nope' })) as never);
    await t.done;
    (document.getElementById('signature') as HTMLTextAreaElement).value = SIG;
    document.getElementById('send')!.click();
    await vi.waitFor(() => expect(document.getElementById('status')!.textContent).toBe('nope'));
    expect(visible()).toEqual(['consent']);
    expect((document.getElementById('send') as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('signing guide (PLAN-SIWM-GUIDE)', () => {
  const html = readFileSync(join(process.cwd(), 'src/entrypoints/siwm/index.html'), 'utf8').replace(/<script[\s\S]*?<\/script>/g, '');
  async function mount(uri: string) {
    document.documentElement.innerHTML = html.replace(/^[\s\S]*?<html[^>]*>/, '').replace(/<\/html>\s*$/, '');
    const d = { id: 'id1', get: vi.fn(async () => ({ uri, pageHost: null, crossSite: false, callbackOwnSite: true })), open: vi.fn(), submit: vi.fn(), copy: vi.fn(async (_t: string) => {}), save: vi.fn((_n: string, _t: string) => {}), setId: vi.fn(), close: vi.fn(), now: () => AT };
    await mountConsent(document, d as never);
    return d;
  }
  const wallet = (id: string) => document.querySelector<HTMLDetailsElement>(`#guide details[data-wallet="${id}"]`)!;

  it('one section per wallet, Feather open; a main address gets no GUI warning', async () => {
    await mount(VALID.uri);
    expect([...document.querySelectorAll<HTMLElement>('#guide details')].map((e) => e.dataset.wallet)).toEqual(['feather', 'gui', 'cake', 'cli', 'rpc']);
    expect(wallet('feather').open).toBe(true);
    expect(wallet('gui').open).toBe(false);
    expect(wallet('gui').querySelector('.warn-line')).toBeNull();
    expect(wallet('cli').textContent).toContain('sign /path/to/xmr-signin.txt');
    expect(document.getElementById('guide-note')!.textContent).toContain('View-only');
  });

  it('a subaddress: the GUI says it can’t, Feather says to replace Address, the CLI asks for the index', async () => {
    await mount(V.valid[1]!.uri);
    expect(wallet('gui').querySelector('.warn-line')!.textContent).toContain('main address');
    expect(wallet('feather').textContent).toContain('paste it over Address');
    expect(wallet('cli').textContent).toContain('address all');
    expect(wallet('cli').textContent).toContain('sign <account>,<index>');
  });

  it('a message with “=” warns off Cake Wallet’s paste button', async () => {
    await mount(VALID.uri);
    expect(wallet('cake').querySelector('.warn-line')).toBeNull();
    await mount(VALID.uri.replace('handle=alice', 'handle=al%3Dice'));
    expect(wallet('cake').querySelector('.warn-line')!.textContent).toContain('=');
  });

  it('Save message as file gets the exact message; Copy address copies the address', async () => {
    const d = await mount(VALID.uri);
    document.getElementById('save-file')!.click();
    expect(d.save).toHaveBeenCalledWith('xmr-signin.txt', VALID.message);
    document.getElementById('copy-address')!.click();
    expect(d.copy).toHaveBeenCalledWith(ok(VALID.uri).address);
  });

  it('nothing from the link becomes markup', async () => {
    await mount(VALID.uri.replace('handle=alice', `handle=${encodeURIComponent('<b>x</b>')}`));
    expect(document.getElementById('consent')!.hidden).toBe(false);
    expect(document.querySelector('#consent b')).toBeNull();
    expect(document.querySelector('[data-f="handle"]')!.textContent).toBe('@<b>x</b>');
  });
});

describe('sign-in link clicks', () => {
  const click = (init: MouseEventInit = {}) => {
    const e = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...init });
    Object.defineProperty(e, 'isTrusted', { value: true });
    return e;
  };
  it('a plain left click on a monero-signin: link is taken over; others are left alone', () => {
    document.body.innerHTML = `<a id="s" href=" ${VALID.uri}"><span id="in">Open in wallet</span></a><a id="r" href="ripley://sign?x">R</a><a id="h" href="https://xmr.bio/">H</a>`;
    const open = vi.fn();
    let on = true;
    const stop = startSigninLinks(document, () => on, open);
    const e = click();
    document.getElementById('in')!.dispatchEvent(e);
    expect(open).toHaveBeenCalledWith(VALID.uri);
    expect(e.defaultPrevented).toBe(true);
    for (const id of ['r', 'h']) document.getElementById(id)!.dispatchEvent(click());
    document.getElementById('s')!.dispatchEvent(click({ ctrlKey: true }));
    document.getElementById('s')!.dispatchEvent(click({ button: 1 }));
    on = false;
    document.getElementById('s')!.dispatchEvent(click());
    expect(open).toHaveBeenCalledTimes(1);
    stop();
  });
  it('a click made by the page itself is ignored', () => {
    document.body.innerHTML = `<a id="s" href="${VALID.uri}">S</a>`;
    const a = document.getElementById('s')!;
    const e = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    a.addEventListener('click', (ev) => ev.preventDefault());
    a.dispatchEvent(e);
    expect(signinLinkOf(e)).toBeNull();
  });
});

describe('siwmService.get', () => {
  it('works out the same-site answers for the window', async () => {
    const t = service();
    const a = await t.svc.open(VALID.uri, 'www.example.org');
    expect(await t.svc.get(a.id)).toEqual({ uri: VALID.uri, pageHost: 'www.example.org', crossSite: false, callbackOwnSite: false });
    const b = await t.svc.open(V.valid[1]!.uri, 'evil.example');
    expect(await t.svc.get(b.id)).toMatchObject({ crossSite: true, callbackOwnSite: true });
  });
});

describe('consent window styles', () => {
  it('hidden sections stay hidden although sections are flex boxes', () => {
    const css = readFileSync(join(process.cwd(), 'src/entrypoints/siwm/style.css'), 'utf8');
    expect(css).toMatch(/\[hidden\]\s*\{\s*display:\s*none\s*!important;?\s*\}/);
  });
});

describe('review fixes', () => {
  it('a well-shaped address with a bad checksum is refused at parse time', () => {
    const a = V.test_wallet.primary_address;
    const bad = a.slice(0, 60) + (a[60] === 'z' ? 'y' : 'z') + a.slice(61);
    expect(parseChallenge(VALID.uri.replace(a, bad))).toMatchObject({ ok: false, reason: expect.stringContaining('address') });
  });
  it('the verifier’s answer is read only up to the cap', async () => {
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        pulled++;
        c.enqueue(new Uint8Array(3000).fill(0x61));
        if (pulled > 100) c.close();
      },
    });
    const text = await cappedText(new Response(body), 4096);
    expect(text).toHaveLength(4096);
    expect(pulled).toBeLessThan(5);
  });
  it('no window → the link is forgotten and the caller told', async () => {
    let store: SiwmStore = {};
    const svc = siwmService({
      store: { getValue: async () => store, setValue: async (v) => void (store = v) },
      now: () => AT,
      randomId: () => 'x',
      openWindow: async () => Promise.reject(new Error('no window')),
      post: async () => ({ status: 200, text: '' }),
    });
    await expect(svc.open(VALID.uri, 'example.org')).rejects.toThrow('no window');
    expect(store).toEqual({});
  });
});
