import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { amount, mountReceiptCard } from '../src/entrypoints/content/receipt-card';
import { startReceipts } from '../src/entrypoints/content/receipt';
import { missingReceiptText } from '../src/receipts/issuers';
import { recordText } from '../src/ui/receipts-panel';
import { LOOKUP_MIN_AGE_MS } from '../src/receipts/witness';
import type { SavedReceipt } from '../src/receipts/store';

const send = vi.hoisted(() => vi.fn());
vi.mock('../src/messaging', async (orig) => ({ ...(await orig<typeof import('../src/messaging')>()), sendToBackground: send }));

const v2 = JSON.parse(readFileSync(join(process.cwd(), 'tests/fixtures/nkip01/v2.json'), 'utf8'));
const receipt = { ...v2.cases[0].receipt, deposit_address: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4' };

describe('the receipt card', () => {
  afterEach(() => (document.documentElement.querySelectorAll('xmradar-receipt').forEach((e) => e.remove())));
  it('shows amounts in coins, and base units for other assets', () => {
    expect(amount('820000', 'BTC', '')).toBe('0.0082 BTC');
    expect(amount('1500000000000', 'xmr', '')).toBe('1.5 XMR');
    expect(amount('5', 'DOGE', '')).toBe('5 base units of DOGE (the network sets the decimals)');
  });
  it('USDT and USDC in coins when the signed address tells the network; never a guess for 0x', () => {
    expect(amount('10000000000', 'USDT', 'TDRbGEu5EFRTaFJJmoU3qKwH1RvyXQvvWp')).toBe('10000 USDT on TRON');
    expect(amount('2500000', 'usdc', '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM')).toBe('2.5 USDC on Solana');
    // 6 decimals on Ethereum, 18 on BNB Chain: the address can't tell them apart
    expect(amount('10000000000', 'USDT', `0x${'ab'.repeat(20)}`)).toMatch(/^10000000000 base units of USDT/);
    // a T… address with a bad checksum isn't TRON
    expect(amount('10000000000', 'USDT', 'TDRbGEu5EFRTaFJJmoU3qKwH1RvyXQvvWq')).toMatch(/base units/);
  });
  it('mounts once, in a closed shadow root at the end of the page', () => {
    const card = mountReceiptCard(document);
    card.render([{ receipt, lines: [{ level: 'ok', text: 'Signed by example.swap' }], saved: true }], []);
    const host = document.querySelector('xmradar-receipt')!;
    expect(host).not.toBeNull();
    expect(host.shadowRoot).toBeNull(); // closed
  });
  // the card's shadow root is closed; tests open it to look inside
  const openShadow = () => {
    const attach = Element.prototype.attachShadow;
    const roots: ShadowRoot[] = [];
    Element.prototype.attachShadow = function (init) {
      const r = attach.call(this, { ...init, mode: 'open' });
      roots.push(r);
      return r;
    };
    return { roots, restore: () => (Element.prototype.attachShadow = attach) };
  };
  const ok = [{ receipt, lines: [{ level: 'ok' as const, text: 'Signed by kyc.rip' }, { level: 'off' as const, text: 'No event id shown' }], saved: true }];
  it('a toast that says the site speaks NKIP-0001, then a chip with the status', async () => {
    const shadow = openShadow();
    try {
      const card = mountReceiptCard(document, { toastMs: 10 });
      card.render(ok, []);
      const root = shadow.roots[0]!;
      expect(root.querySelector('.msg')!.textContent).toBe('example.swap supports NKIP-0001 · Receipt checked and saved ✓');
      await vi.waitFor(() => expect(root.querySelector('.box')!.classList.contains('chip')).toBe(true));
      // a ○ line never outranks a ✓
      expect(root.querySelector('.label')!.textContent).toBe('Receipt ✓');
      (root.querySelector('.label') as HTMLButtonElement).click();
      expect(root.querySelector('dl')).not.toBeNull();
      card.remove();
    } finally {
      shadow.restore();
    }
  });
  it('a warning stays open with no Hide; × hides it until a different warning appears', async () => {
    const shadow = openShadow();
    try {
      const card = mountReceiptCard(document, { toastMs: 10 });
      const warn = [{ receipt, lines: [{ level: 'warn' as const, text: 'Bad signature' }], saved: true }];
      card.render(warn, []);
      const root = shadow.roots[0]!;
      const host = document.querySelector('xmradar-receipt') as HTMLElement;
      await new Promise((r) => setTimeout(r, 30));
      expect(root.querySelector('.box')!.classList.contains('chip')).toBe(false);
      expect([...root.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['×', 'Copy', 'Copy']);
      (root.querySelector('.x') as HTMLButtonElement).click();
      expect(host.hidden).toBe(true);
      card.render(warn, []);
      expect(host.hidden).toBe(true);
      card.render(warn, [{ level: 'warn', text: 'You copied an address the exchange didn\'t sign' }]);
      expect(host.hidden).toBe(false);
      card.remove();
    } finally {
      shadow.restore();
    }
  });
});

describe('order pages (content script)', () => {
  let invalidate: (() => void)[] = [];
  const ctx = {
    addEventListener: (t: EventTarget, e: string, h: EventListener) => t.addEventListener(e, h),
    onInvalidated: (cb: () => void) => invalidate.push(cb),
  };
  beforeEach(() => {
    fakeBrowser.reset();
    send.mockReset().mockImplementation(async (m: { type: string }) => (m.type === 'log-page' ? [] : { receipt, commitment: v2.cases[0].commitment, lines: [{ level: 'ok', text: 'Signed by example.swap' }], saved: true }));
  });
  afterEach(() => {
    for (const cb of invalidate) cb();
    invalidate = [];
    document.body.innerHTML = '';
  });

  it('a page with a receipt is sent once to the background, with the event id it shows', async () => {
    const id = 'cd'.repeat(32);
    document.body.innerHTML = `<script type="application/nkip01+json">${JSON.stringify(receipt)}</script><p>Deposit: ${receipt.deposit_address}</p><p>Attestation event ${id}</p>`;
    startReceipts(ctx as never);
    await vi.waitFor(() => expect(send.mock.calls.filter(([m]) => m.type === 'receipt-found')).toHaveLength(1));
    expect(send).toHaveBeenCalledWith({ type: 'receipt-found', text: JSON.stringify(receipt), eventId: id });
    await vi.waitFor(() => expect(document.querySelector('xmradar-receipt')).not.toBeNull());
    // the toolbar icon gets the state for this tab
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith({ type: 'receipt-badge', level: 'ok' }));
  });
  it('the card goes when the page takes its receipt away, and the toolbar badge clears', async () => {
    document.body.innerHTML = `<script type="application/nkip01+json">${JSON.stringify(receipt)}</script><p>Deposit: ${receipt.deposit_address}</p>`;
    startReceipts(ctx as never);
    await vi.waitFor(() => expect(document.querySelector('xmradar-receipt')).not.toBeNull());
    document.querySelector('script[type="application/nkip01+json"]')!.remove();
    await vi.waitFor(() => expect(document.querySelector('xmradar-receipt')).toBeNull(), { timeout: 4000 });
    expect(send).toHaveBeenLastCalledWith({ type: 'receipt-badge', level: 'none' });
  });
  it('kyc.rip’s unsigned witness pointer is not a receipt: its event id goes with the real one', async () => {
    const id = 'ef'.repeat(32);
    const pointer = { v: receipt.v, issuer: receipt.issuer, order_id: receipt.order_id, event_id: id, commitment: 'ab'.repeat(32), deposit_address: receipt.deposit_address };
    document.body.innerHTML = `<script type="application/nkip01+json">${JSON.stringify(receipt)}</script><script type="application/nkip01+json">${JSON.stringify(pointer)}</script><p>Deposit: ${receipt.deposit_address}</p>`;
    startReceipts(ctx as never);
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith({ type: 'receipt-found', text: JSON.stringify(receipt), eventId: id }));
    expect(send.mock.calls.filter(([m]) => m.type === 'receipt-found')).toHaveLength(1);
  });
  it('a page without one sends nothing and shows nothing', async () => {
    document.body.innerHTML = `<p>Deposit: ${receipt.deposit_address}</p>`;
    startReceipts(ctx as never);
    await new Promise((r) => setTimeout(r, 30));
    // only the question whether this is a listed order page (no URL in it)
    expect(send.mock.calls.map(([m]) => m)).toEqual([{ type: 'log-page' }]);
    expect(document.querySelector('xmradar-receipt')).toBeNull();
  });
  it('letters follow the site-info switch while the page is open', async () => {
    const page = { siteId: 'mistex', name: 'Mistex', format: 'mistproof', orderId: 'DX-36N87L', letterUrl: null };
    send.mockImplementation(async (m: { type: string }) => (m.type === 'log-page' ? [page] : null));
    document.body.innerHTML = '<p>Order</p>';
    startReceipts(ctx as never);
    await vi.waitFor(() => expect(document.querySelector('xmradar-receipt')).not.toBeNull());
    const xmr = { badgesX: true, badgesNostr: true, nostrDiscovery: false, tipReceipts: true, badgeIcon: 'mono', badgeLabel: true };
    await fakeBrowser.storage.sync.set({ xmrSettings: { ...xmr, siteInfo: false } });
    await vi.waitFor(() => expect(document.querySelector('xmradar-receipt')).toBeNull());
    send.mockClear();
    await fakeBrowser.storage.sync.set({ xmrSettings: { ...xmr, siteInfo: true } });
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith({ type: 'log-page' }));
    await vi.waitFor(() => expect(document.querySelector('xmradar-receipt')).not.toBeNull());
  });
  it('switched off in Options: nothing runs', async () => {
    await fakeBrowser.storage.sync.set({ settings: { relays: [], blossomServer: '', appendSourceLink: false, debug: false, receiptsCheck: false } });
    document.body.innerHTML = `<script type="application/nkip01+json">${JSON.stringify(receipt)}</script>`;
    startReceipts(ctx as never);
    await new Promise((r) => setTimeout(r, 30));
    expect(send).not.toHaveBeenCalled();
  });
});

describe('the missing-receipt warning (§1.4, PLAN-LOG §6)', () => {
  let invalidate: (() => void)[] = [];
  const ctx = {
    addEventListener: (t: EventTarget, e: string, h: EventListener) => t.addEventListener(e, h),
    onInvalidated: (cb: () => void) => invalidate.push(cb),
  };
  const nkip = { siteId: 'kyc-rip-aggregator', name: 'kyc.rip', format: 'nkip01', orderId: 'ABCD1234', letterUrl: null };
  afterEach(() => {
    for (const cb of invalidate) cb();
    invalidate = [];
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('an order page xmr.club lists with receipts, showing a deposit address but no receipt for 15 s: a caution', async () => {
    fakeBrowser.reset();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    send.mockReset().mockImplementation(async (m: { type: string }) => (m.type === 'log-page' ? [nkip] : null));
    document.body.innerHTML = `<p>Deposit address: ${receipt.deposit_address}</p>`;
    startReceipts(ctx as never);
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith({ type: 'log-page' }));
    await vi.advanceTimersByTimeAsync(15_500);
    expect(document.querySelector('xmradar-receipt')).not.toBeNull();
    expect(send).toHaveBeenCalledWith({ type: 'receipt-badge', level: 'caution' });
    expect(missingReceiptText(['kyc.rip'])).toContain('keep a dated screenshot');
  });

  it('goes with site info, and the 15 s start over when it comes back', async () => {
    fakeBrowser.reset();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    send.mockReset().mockImplementation(async (m: { type: string }) => (m.type === 'log-page' ? [nkip] : null));
    document.body.innerHTML = `<p>Deposit address: ${receipt.deposit_address}</p>`;
    startReceipts(ctx as never);
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith({ type: 'log-page' }));
    await vi.advanceTimersByTimeAsync(15_500);
    await vi.waitFor(() => expect(document.querySelector('xmradar-receipt')).not.toBeNull());
    const xmr = { badgesX: true, badgesNostr: true, nostrDiscovery: false, tipReceipts: true, badgeIcon: 'mono', badgeLabel: true };
    await fakeBrowser.storage.sync.set({ xmrSettings: { ...xmr, siteInfo: false } });
    await vi.waitFor(() => expect(document.querySelector('xmradar-receipt')).toBeNull());
    send.mockClear();
    await fakeBrowser.storage.sync.set({ xmrSettings: { ...xmr, siteInfo: true } });
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith({ type: 'log-page' }));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(document.querySelector('xmradar-receipt')).toBeNull();
    await vi.advanceTimersByTimeAsync(11_000);
    await vi.waitFor(() => expect(document.querySelector('xmradar-receipt')).not.toBeNull());
  });

  it('not on a page the feed doesn’t list with receipts', async () => {
    fakeBrowser.reset();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    send.mockReset().mockImplementation(async (m: { type: string }) => (m.type === 'log-page' ? [] : null));
    document.body.innerHTML = `<p>Deposit address: ${receipt.deposit_address}</p>`;
    startReceipts(ctx as never);
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith({ type: 'log-page' }));
    await vi.advanceTimersByTimeAsync(16_000);
    expect(document.querySelector('xmradar-receipt')).toBeNull();
  });
});

describe('Options → Swap receipts', () => {
  const s = (over: Partial<SavedReceipt> = {}): SavedReceipt => ({ commitment: 'c'.repeat(64), receipt, page: 'https://example.swap/o', savedAt: 0, ...over });
  it('says when the public record may be checked, and what it found', () => {
    expect(recordText(s(), LOOKUP_MIN_AGE_MS - 60_000)).toContain('can be checked in 1 min');
    expect(recordText(s(), LOOKUP_MIN_AGE_MS)).toBe('Public record: not checked.');
    expect(recordText(s({ publicRecord: { checkedAt: 0, seen: ['wss://a'], asked: ['wss://a', 'wss://b'], saltBoxMissing: true } }), 0)).toMatch(/Seen on 1 of 2 relays.*salt box/);
    expect(recordText(s({ publicRecord: { checkedAt: 0, seen: [], asked: ['wss://a'] } }), 0)).toMatch(/Not found on 1 relays/);
  });
});
