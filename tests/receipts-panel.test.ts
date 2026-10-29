import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { LETTER_EXPORT_WARNING } from '../src/log/export';
import type { SavedLetter } from '../src/log/store';
import type { SavedReceipt } from '../src/receipts/store';
import { settingsItem } from '../src/settings';
import { mountReceiptsPanel } from '../src/ui/receipts-panel';

const send = vi.hoisted(() => vi.fn());
vi.mock('../src/messaging', async (orig) => ({ ...(await orig<typeof import('../src/messaging')>()), sendToBackground: send }));

const HTML = ['check', 'log-fetch', 'site-info', 'site-warnings'].map((n) => `<input data-receipts="${n}" type="checkbox" />`).join('') +
  '<button data-receipts="export-all"></button><div data-receipts="list"></div><span data-receipts="status"></span>';

const receipt = { commitment: 'c'.repeat(64), receipt: { order_id: 'EX-1', issuer: 'kyc.rip', deposit_asset: 'BTC', payout_asset: 'XMR', expires_at: 2_000_000_000, created_at: 1_793_000_000 }, page: 'https://kyc.rip/o', savedAt: 1000 } as unknown as SavedReceipt;
const letter: SavedLetter = { id: 'a'.repeat(64), siteId: 'stereoswap', siteName: 'StereoSwap', format: 'pgp', orderId: 'STRRSXUE', page: 'https://stereoswap.app/swap/STRRSXUE', text: 't', key: 'k', feedIssuedAt: 1, savedAt: 2000 };
const XMR = { badgesX: true, badgesNostr: true, nostrDiscovery: false, tipReceipts: true, badgeIcon: 'mono', badgeLabel: true };

async function mount() {
  const root = document.createElement('div');
  root.innerHTML = HTML;
  document.body.replaceChildren(root);
  await mountReceiptsPanel(root);
  const q = <T extends HTMLElement>(n: string) => root.querySelector<T>(`[data-receipts="${n}"]`)!;
  const button = (card: Element, text: string) => [...card.querySelectorAll('button')].find((b) => b.textContent === text)!;
  return { root, q, button };
}

describe('Options → Swaps and sites: letters', () => {
  beforeEach(() => {
    fakeBrowser.reset();
    send.mockReset().mockImplementation(async (m: { type: string }) => {
      if (m.type === 'receipts-list') return [receipt];
      if (m.type === 'letters-list') return [letter];
      if (m.type === 'letter-export' || m.type === 'receipt-export') return { format: m.type };
      return null;
    });
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} }));
  });

  it('lists letters with receipts, newest first, tagged "Letter"', async () => {
    const { q } = await mount();
    const cards = [...q('list').querySelectorAll('.card')];
    expect(cards.map((c) => c.querySelector('h2')!.textContent)).toEqual(['STRRSXUE · StereoSwap Letter', 'EX-1 · kyc.rip']);
    expect(cards[0]!.querySelector('.tag')!.textContent).toBe('Letter');
  });

  it('exports one letter with its warning, and deletes it in two steps', async () => {
    const { q, button } = await mount();
    const card = q('list').querySelector('.card')!;
    button(card, 'Export').click();
    await vi.waitFor(() => expect(q('status').textContent).toBe(LETTER_EXPORT_WARNING));
    expect(send).toHaveBeenCalledWith({ type: 'letter-export', id: letter.id });
    button(card, 'Delete').click();
    expect(send).not.toHaveBeenCalledWith({ type: 'letter-delete', id: letter.id });
    button(card, 'Confirm delete').click();
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith({ type: 'letter-delete', id: letter.id }));
  });

  it('Export all takes the letters too', async () => {
    const { q } = await mount();
    q('export-all').click();
    await vi.waitFor(() => expect(q('status').textContent).toContain(LETTER_EXPORT_WARNING));
    expect(send).toHaveBeenCalledWith({ type: 'letter-export', id: letter.id });
    expect(send).toHaveBeenCalledWith({ type: 'receipt-export', commitment: receipt.commitment });
  });

  it('the letter-fetch switch: on by default, saved when changed, unavailable without site info', async () => {
    const { q } = await mount();
    const fetchSwitch = q<HTMLInputElement>('log-fetch');
    expect(fetchSwitch.checked).toBe(true);
    expect(fetchSwitch.disabled).toBe(false);
    fetchSwitch.checked = false;
    fetchSwitch.dispatchEvent(new Event('change'));
    await vi.waitFor(async () => expect((await settingsItem.getValue()).logFetch).toBe(false));
    await fakeBrowser.storage.sync.set({ xmrSettings: { ...XMR, siteInfo: false } });
    await vi.waitFor(() => expect(fetchSwitch.disabled).toBe(true));
  });
});
