import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { renderXap } from '../src/entrypoints/content/xap-popup';
import type { BadgeEntry } from '../src/identity/resolve';

const send = vi.hoisted(() => vi.fn());
vi.mock('../src/messaging', async (orig) => ({ ...(await orig<typeof import('../src/messaging')>()), sendToBackground: send }));

const ADDR = '44AFFq5kSiGBoZ4NMDwYtN18obc8AemS33DBLWs3H7otXft3XjrpDtQGv7SqSsaBYBb98uNbr2VBBEt7f2wfn3RVGQBEP3A';
const ADDR2 = '888tNkZrPN6JsEgekjMnABU4TBzc2Dt29EPAvkRxbANsAnjyPbb3iQ1YBRk1UXcdRsiKc9dhwMVgN5S9cQUiyoogDavup3H';
const PK = 'c'.repeat(64);
const entry = { source: 'nostr', address: ADDR, check: { ok: true, type: 'standard' }, verified: true, method: 'nip39:client', pubkey: PK } as BadgeEntry & { pubkey: string };
const totals = (address: string | null) => ({ verified: '0', verifiedTippers: 0, verifying: '0', claimed: '0', claimedTippers: 0, address, mine: [], at: 0 });

const mount = (receipts = true) => {
  const el = renderXap({ handle: 'xbtoshi', entry, receipts, isClosed: () => false });
  document.body.append(el);
  return el;
};
const wallet = (el: HTMLElement) => el.querySelector<HTMLAnchorElement>('a.button')!;
const button = (el: HTMLElement, text: string) => [...el.querySelectorAll('button')].find((b) => b.textContent === text)!;
const typeAmount = (el: HTMLElement, v: string) => {
  const input = el.querySelector('input')!;
  input.value = v;
  input.dispatchEvent(new Event('input'));
};

describe('Xap popup', () => {
  // block bodies: a function returned from a hook runs as its cleanup
  beforeEach(() => {
    fakeBrowser.reset();
    send.mockReset().mockImplementation(async (m: { type: string }) =>
      m.type === 'xap-totals' ? { totals: [[PK, totals(ADDR)]], pending: [] } : m.type === 'xmr-price' ? { usd: 500 } : null,
    );
  });
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('asks for fresh totals on open, and needs an amount; the link carries the unique amount', async () => {
    const el = mount();
    await vi.waitFor(() => expect(el.textContent).toContain('No Xaps yet'));
    expect(send).toHaveBeenCalledWith({ type: 'xap-totals', recipients: [PK], fresh: true });
    expect(wallet(el).getAttribute('aria-disabled')).toBe('true');
    typeAmount(el, '0.01');
    expect(wallet(el).href).toMatch(new RegExp(`^monero:${ADDR}\\?tx_amount=0\\.010000\\d{0,5}[1-9]$`));
    expect(wallet(el).href).not.toMatch(/tx_amount=0\.01$/);
  });

  it('a changed address shuts the payment path off', async () => {
    send.mockImplementation(async (m: { type: string }) => (m.type === 'xap-totals' ? { totals: [[PK, totals(ADDR2)]], pending: [] } : { usd: 500 }));
    const el = mount();
    typeAmount(el, '0.01');
    await vi.waitFor(() => expect(el.textContent).toContain('now lists a different address'));
    expect(wallet(el).hasAttribute('href')).toBe(false);
    expect(el.querySelector('.qr')).toBeNull();
    expect(button(el, 'I sent it').disabled).toBe(true);
    expect(button(el, 'Copy address').disabled).toBe(true);
    expect(el.querySelector('input')!.disabled).toBe(true);
    expect(el.querySelector('.fiat')!.classList.contains('stale')).toBe(true);
    expect(el.textContent).not.toContain("You'll send");
  });

  it('with receipts off: a plain tip, amount optional, no "I sent it"', async () => {
    const el = mount(false);
    expect(wallet(el).href).toBe(`monero:${ADDR}`);
    expect(button(el, 'I sent it')).toBeUndefined();
  });

  it('"I sent it" asks first and publishes only on a trusted click, with the same amount', async () => {
    const el = mount();
    typeAmount(el, '0.01');
    // locked only once the kept mark is loaded, so it can't miss one already paid
    expect(button(el, 'I sent it').disabled).toBe(true);
    await vi.waitFor(() => expect(button(el, 'I sent it').disabled).toBe(false));
    const unique = /tx_amount=([\d.]+)/.exec(wallet(el).href)![1]!;
    button(el, 'I sent it').click();
    expect(el.querySelector('.xap-confirm')!.textContent).toContain(`${unique} XMR`);
    expect(el.querySelector('input')!.readOnly).toBe(true);
    button(el, 'Publish receipt').click();
    expect(send.mock.calls.some(([m]) => m.type === 'xap-publish')).toBe(false);
  });

  it('dollar shortcuts fill the amount in XMR, and the line shows the dollar value', async () => {
    const el = mount();
    await vi.waitFor(() => expect(button(el, '$5')).toBeDefined());
    button(el, '$5').click();
    expect(el.querySelector('input')!.value).toBe('0.01');
    expect(wallet(el).href).toMatch(/tx_amount=0\.010000\d{0,5}[1-9]$/);
    expect(el.textContent).toContain('(≈ $5.00)');
    expect(el.textContent).toContain('1 XMR ≈ $500.00');
  });

  it.each([['an error', null], ['Infinity', Infinity], ['an out-of-range price', 0.5], ['no number', '615']])('%s for a price: no shortcuts, the popup still works', async (_, usd) => {
    send.mockImplementation(async (m: { type: string }) => {
      if (m.type === 'xmr-price') {
        if (usd === null) throw new Error('Price unavailable');
        return { usd };
      }
      return { totals: [[PK, totals(ADDR)]], pending: [] };
    });
    const el = mount();
    await vi.waitFor(() => expect(el.textContent).toContain('No Xaps yet'));
    expect(el.querySelector('.fiat')!.classList.contains('hidden')).toBe(true);
    typeAmount(el, '0.01');
    expect(wallet(el).href).toMatch(/tx_amount=/);
  });

  it('after "I sent it" the shortcuts no longer change the amount', async () => {
    const el = mount();
    typeAmount(el, '0.01');
    await vi.waitFor(() => expect(button(el, '$20')).toBeDefined());
    await vi.waitFor(() => expect(button(el, 'I sent it').disabled).toBe(false));
    button(el, 'I sent it').click();
    button(el, '$20').click();
    expect(el.querySelector('input')!.value).toBe('0.01');
  });

  it('a popup reopened for the same recipient gives the same amount, so a paid Xap can still get its receipt', async () => {
    const first = mount();
    typeAmount(first, '0.01');
    const sent = /tx_amount=([\d.]+)/.exec(wallet(first).href)![1];
    await vi.waitFor(async () => expect((await fakeBrowser.storage.local.get('xapMarks')).xapMarks).toHaveLength(1));
    first.remove();
    const again = mount();
    typeAmount(again, '0.01');
    await vi.waitFor(() => expect(/tx_amount=([\d.]+)/.exec(wallet(again).href)![1]).toBe(sent));
  });

  it('receipts off: no mark is kept', async () => {
    const el = mount(false);
    typeAmount(el, '0.01');
    await new Promise((r) => setTimeout(r, 20));
    expect((await fakeBrowser.storage.local.get('xapMarks')).xapMarks).toBeUndefined();
    expect(el.textContent).not.toContain('I sent it');
  });
});
