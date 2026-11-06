import { describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';

const send = vi.hoisted(() => vi.fn());
vi.mock('../src/messaging', async (orig) => ({ ...(await orig<typeof import('../src/messaging')>()), sendToBackground: send }));
vi.mock('../src/entrypoints/content/receipt-card', async (orig) => ({
  ...(await orig<typeof import('../src/entrypoints/content/receipt-card')>()),
  mountReceiptCard: () => ({ render: () => {}, remove: () => {} }),
}));
import { startReceipts } from '../src/entrypoints/content/receipt';
import { dataLinkLetters, decodeDataUrl, MAX_HREF, MAX_LINKS } from '../src/log/data-links';
import { MISTPROOF_MARK, PGP_BEGIN } from '../src/log/fetch';

// PLAN-LOGLINK: DEX.fo's "Download Signed Message" link
const LETTER = `${PGP_BEGIN}\nHash: SHA256\n\nOrder 6aed79c2 · send to bc1q…\n-----BEGIN PGP SIGNATURE-----\n\nwsBc\n-----END PGP SIGNATURE-----\n`;
const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));
const page = (...hrefs: string[]) => {
  document.body.innerHTML = hrefs.map((h, i) => `<a id="l${i}" download="receipt.asc" href="${h.replace(/"/g, '&quot;')}">Download Signed Message</a>`).join('');
  return document;
};

describe('a letter behind a data: link', () => {
  it('found percent-encoded (as DEX.fo writes it) and in base64, any case', () => {
    expect(dataLinkLetters(page(`data:application/pgp-keys,${encodeURIComponent(LETTER)}`))).toEqual([LETTER]);
    expect(dataLinkLetters(page(`data:text/plain;charset=utf-8;base64,${b64(LETTER)}`))).toEqual([LETTER]);
    expect(dataLinkLetters(page(`DATA:Application/PGP-Signature;BASE64,${b64(LETTER)}`))).toEqual([LETTER]);
    expect(dataLinkLetters(page(`data:,${encodeURIComponent(LETTER)}`))).toEqual([LETTER]);
  });
  it('a MistProof in a JSON link', () => {
    const proof = JSON.stringify({ format: MISTPROOF_MARK, order: 'x' });
    expect(dataLinkLetters(page(`data:application/json,${encodeURIComponent(proof)}`))).toEqual([proof]);
  });
  it('nothing for DEX.fo’s empty link today, an image, a non-letter, a bad encoding', () => {
    expect(dataLinkLetters(page('data:application/pgp-keys,'))).toEqual([]);
    expect(dataLinkLetters(page(`data:image/svg+xml,${encodeURIComponent(LETTER)}`))).toEqual([]);
    expect(dataLinkLetters(page(`data:text/plain,${encodeURIComponent('hello')}`))).toEqual([]);
    expect(dataLinkLetters(page('data:text/plain;base64,@@@'))).toEqual([]);
    expect(dataLinkLetters(page('data:text/plain,%E0%A4%A'))).toEqual([]);
    expect(dataLinkLetters(page(`https://example.com/receipt.asc`))).toEqual([]);
    expect(decodeDataUrl('blob:https://dex.fo/abc')).toBeNull();
  });
  it('at most 5 links, each at most 64 KB', () => {
    const filler = Array.from({ length: MAX_LINKS }, () => 'data:text/plain,x');
    expect(dataLinkLetters(page(...filler, `data:text/plain,${encodeURIComponent(LETTER)}`))).toEqual([]);
    const big = `data:text/plain,${encodeURIComponent(LETTER)}${'x'.repeat(MAX_HREF)}`;
    expect(dataLinkLetters(page(big))).toEqual([]);
  });
  it('each link is decoded once while it stays; a link filled in later is read then', () => {
    const doc = page('data:application/pgp-keys,');
    const spy = vi.spyOn(globalThis, 'decodeURIComponent');
    dataLinkLetters(doc);
    dataLinkLetters(doc);
    expect(spy).toHaveBeenCalledTimes(1);
    doc.getElementById('l0')!.setAttribute('href', `data:application/pgp-keys,${encodeURIComponent(LETTER)}`);
    expect(dataLinkLetters(doc)).toEqual([LETTER]);
    expect(dataLinkLetters(doc)).toEqual([LETTER]);
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });
});

describe('on an order page (the receipt watcher)', () => {
  it('a link filled in after load is read: the href change alone wakes the rescan', async () => {
    fakeBrowser.reset();
    send.mockImplementation(async (m: { type: string }) =>
      m.type === 'log-page'
        ? [{ siteId: 'dex-fo', name: 'DEX.fo', format: 'pgp', orderId: '6aed79c2', letterUrl: null }]
        : m.type === 'log-found'
          ? { verified: false, lines: [], addresses: [], signedText: '', saved: false }
          : { lines: [], saved: false },
    );
    document.body.innerHTML = `<p>Order 6aed79c2</p><a id="dl" download="receipt.asc" href="data:application/pgp-keys,">Download Signed Message</a>`;
    const off: (() => void)[] = [];
    startReceipts({ addEventListener: (t: EventTarget, e: string, h: EventListener) => t.addEventListener(e, h), onInvalidated: (cb: () => void) => off.push(cb) } as never);
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith({ type: 'log-page' }));
    await new Promise((r) => setTimeout(r, 50));
    expect(send.mock.calls.some(([m]) => m.type === 'log-found')).toBe(false);
    document.getElementById('dl')!.setAttribute('href', `data:application/pgp-keys,${encodeURIComponent(LETTER)}`);
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith({ type: 'log-found', siteId: 'dex-fo', text: LETTER.trim() }), { timeout: 4000 });
    for (const cb of off) cb();
  }, 8000);
});
