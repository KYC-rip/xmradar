import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { LETTER_EXPORT_WARNING } from '../src/log/export';
import type { SavedLetter } from '../src/log/store';
import type { SavedReceipt } from '../src/receipts/store';
import { settingsItem, swapRecordDaysItem, swapRecordsCleanedItem, xmrSettingsItem } from '../src/settings';
import { mountReceiptsPanel } from '../src/ui/receipts-panel';

const send = vi.hoisted(() => vi.fn());
vi.mock('../src/messaging', async (orig) => ({ ...(await orig<typeof import('../src/messaging')>()), sendToBackground: send }));

const HTML = ['check', 'log-fetch', 'site-info', 'site-warnings', 'copy-reports'].map((n) => `<input data-receipts="${n}" type="checkbox" />`).join('') +
  '<select data-receipts="keep-days"><option value="0"></option><option value="1"></option><option value="7"></option><option value="30"></option><option value="90"></option></select><button data-receipts="export-all"></button><div data-receipts="list"></div><span data-receipts="status"></span>';

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

  it('the report switch: on by default, saved when changed, unavailable without warnings', async () => {
    const { q } = await mount();
    const reports = q<HTMLInputElement>('copy-reports');
    expect(reports.checked).toBe(true);
    expect(reports.disabled).toBe(false);
    reports.checked = false;
    reports.dispatchEvent(new Event('change'));
    await vi.waitFor(async () => expect((await xmrSettingsItem.getValue()).copyReports).toBe(false));
    await fakeBrowser.storage.sync.set({ xmrSettings: { ...XMR, siteWarnings: false } });
    await vi.waitFor(() => expect(reports.disabled).toBe(true));
  });

  it('automatic deletion: the choice is saved as a number; a clean-up reloads the open list', async () => {
    const { q } = await mount();
    const keep = q<HTMLSelectElement>('keep-days');
    // 90 days unless chosen
    expect(keep.value).toBe('90');
    keep.value = '7';
    keep.dispatchEvent(new Event('change'));
    await vi.waitFor(async () => expect(await swapRecordDaysItem.getValue()).toBe(7));
    send.mockImplementation(async (m: { type: string }) => (m.type === 'receipts-list' ? [] : m.type === 'letters-list' ? [] : null));
    await swapRecordsCleanedItem.setValue({ at: 1, receipts: 1, letters: 1 });
    await vi.waitFor(() => expect(q('list').querySelectorAll('.card')).toHaveLength(0));
    expect(q('status').textContent).toBe('Deleted 2 old letters and receipts.');
  });
});

describe('Options → swap records: Open order and View (PLAN-RECORDVIEW)', () => {
  const full = {
    ...receipt,
    receipt: { ...receipt.receipt, v: '2', deposit_amount: '12', deposit_address: 'addr1', payout_amount: '300000000000', payout_address: '<b>4x</b>', rate_type: 'fixed', policy_hash: 'ph', key_id: 'k1', sig: 'SIG', salt: 'SECRETSALT' },
  } as unknown as SavedReceipt;
  let links: unknown;
  beforeEach(() => {
    fakeBrowser.reset();
    links = { receipts: { [full.commitment]: 'https://kyc.rip/track/EX-1' }, letters: {} };
    send.mockReset().mockImplementation(async (m: { type: string }) => {
      if (m.type === 'receipts-list') return [full];
      if (m.type === 'letters-list') return [letter];
      if (m.type === 'record-links') return links;
      if (m.type === 'receipt-signature') return { level: 'ok', text: 'Signed by kyc.rip' };
      return null;
    });
  });
  const cardOf = (root: HTMLElement, title: string) => [...root.querySelectorAll('.card')].find((c) => c.querySelector('h2')!.textContent!.startsWith(title))!;

  it('Open order only where the background gives a link, opened without a referrer', async () => {
    const { q } = await mount();
    const a = cardOf(q('list'), 'EX-1').querySelector('a')!;
    expect(a.textContent).toBe('Open order');
    expect(a.getAttribute('href')).toBe('https://kyc.rip/track/EX-1');
    expect(a.rel).toBe('noopener noreferrer');
    expect(a.target).toBe('_blank');
    expect(cardOf(q('list'), 'STRRSXUE').querySelector('a')).toBeNull();
  });

  it('no links answer (old background) leaves the cards as they were', async () => {
    links = null;
    const { q } = await mount();
    expect(q('list').querySelector('a')).toBeNull();
    expect(q('list').querySelectorAll('.card').length).toBe(2);
  });

  it('View shows what was signed, as text, with the signature check; never the salt', async () => {
    const { q, button } = await mount();
    button(cardOf(q('list'), 'EX-1'), 'View').click();
    await vi.waitFor(() => expect(cardOf(q('list'), 'EX-1').querySelector('.sig-ok')?.textContent).toBe('Signed by kyc.rip'));
    const card = cardOf(q('list'), 'EX-1');
    const text = card.querySelector('.rec-view')!.textContent!;
    for (const s of ['0.00000012 BTC, to', 'addr1', '0.3 XMR, at', '<b>4x</b>', 'fixed', 'ph', 'k1', 'SIG', 'Kept, not shown']) expect(text).toContain(s);
    expect(text).not.toContain('SECRETSALT');
    expect(card.querySelector('.rec-view b')).toBeNull();
    expect(button(card, 'Hide').getAttribute('aria-expanded')).toBe('true');
    expect(send).toHaveBeenCalledWith({ type: 'receipt-signature', commitment: full.commitment });
  });

  it('a v1 receipt without a salt has no salt row; a letter shows its text', async () => {
    const noSalt = { ...full, receipt: { ...full.receipt, salt: undefined } } as unknown as SavedReceipt;
    send.mockImplementation(async (m: { type: string }) => (m.type === 'receipts-list' ? [noSalt] : m.type === 'letters-list' ? [{ ...letter, text: '-----BEGIN PGP SIGNED MESSAGE-----\nhi', fingerprint: 'FP' }] : m.type === 'record-links' ? links : { level: 'caution', text: 'Not checked when it was saved.' }));
    const { q, button } = await mount();
    button(cardOf(q('list'), 'EX-1'), 'View').click();
    await vi.waitFor(() => expect(cardOf(q('list'), 'EX-1').querySelector('.sig-caution')).not.toBeNull());
    expect(cardOf(q('list'), 'EX-1').textContent).not.toContain('Salt');
    button(cardOf(q('list'), 'STRRSXUE'), 'View').click();
    const pre = cardOf(q('list'), 'STRRSXUE').querySelector('pre')!;
    expect(pre.textContent).toBe('-----BEGIN PGP SIGNED MESSAGE-----\nhi');
    expect(cardOf(q('list'), 'STRRSXUE').textContent).toContain('FP');
  });

  it('a View stays open when the list is drawn again, and links follow the feed', async () => {
    const { q, button } = await mount();
    button(cardOf(q('list'), 'EX-1'), 'View').click();
    links = { receipts: {}, letters: {} };
    await fakeBrowser.storage.local.set({ siteFeed: { issuedAt: 2, expiresAt: 3, sites: [] } });
    await vi.waitFor(() => expect(cardOf(q('list'), 'EX-1').querySelector('a')).toBeNull());
    expect(cardOf(q('list'), 'EX-1').querySelector('.rec-view')).not.toBeNull();
  });
});

describe('letter View: MistProof laid out', () => {
  it('the signed payload is shown as indented JSON; anything else as it is', async () => {
    const { mistproofPayload } = await import('../src/ui/receipts-panel');
    const text = JSON.stringify({ alg: 'Ed25519', payload: JSON.stringify({ order: 'DX-1', send: { amount: '0.1', coin: 'XMR' } }), signature: 's' });
    expect(mistproofPayload(text)).toBe(JSON.stringify({ order: 'DX-1', send: { amount: '0.1', coin: 'XMR' } }, null, 2));
    expect(mistproofPayload('-----BEGIN PGP')).toBeNull();
    expect(mistproofPayload(JSON.stringify({ payload: 'not json' }))).toBeNull();
  });
});

describe('swap records: review fixes (PLAN-RECORDVIEW)', () => {
  beforeEach(() => fakeBrowser.reset());
  it('a malformed link is left out; the list still draws', async () => {
    send.mockReset().mockImplementation(async (m: { type: string }) => (m.type === 'receipts-list' ? [receipt] : m.type === 'letters-list' ? [] : m.type === 'record-links' ? { receipts: { [receipt.commitment]: 'not a url' }, letters: {} } : null));
    const { q } = await mount();
    expect(q('list').querySelectorAll('.card').length).toBe(1);
    expect(q('list').querySelector('a')).toBeNull();
  });
  it('an older links answer arriving last doesn’t replace a newer one', async () => {
    const answers: ((v: unknown) => void)[] = [];
    send.mockReset().mockImplementation((m: { type: string }) =>
      m.type === 'record-links' ? new Promise((r) => answers.push(r)) : Promise.resolve(m.type === 'receipts-list' ? [receipt] : m.type === 'letters-list' ? [] : null),
    );
    const root = document.createElement('div');
    root.innerHTML = HTML;
    document.body.replaceChildren(root);
    const mounted = mountReceiptsPanel(root);
    await vi.waitFor(() => expect(answers.length).toBe(1));
    await fakeBrowser.storage.local.set({ siteFeed: { issuedAt: 2, expiresAt: 3, sites: [] } });
    await vi.waitFor(() => expect(answers.length).toBe(2));
    answers[1]!({ receipts: { [receipt.commitment]: 'https://kyc.rip/track/NEW' }, letters: {} });
    answers[0]!({ receipts: { [receipt.commitment]: 'https://kyc.rip/track/OLD' }, letters: {} });
    await mounted;
    await vi.waitFor(() => expect(root.querySelector('a')?.getAttribute('href')).toBe('https://kyc.rip/track/NEW'));
  });
  it('Check public record makes an open View check the signature again', async () => {
    let n = 0;
    send.mockReset().mockImplementation(async (m: { type: string }) => {
      if (m.type === 'receipts-list') return [{ ...receipt, savedAt: 0, receipt: { ...receipt.receipt, deposit_amount: '1', deposit_address: 'a', payout_amount: '1', payout_address: 'b', rate_type: 'fixed', policy_hash: 'p', key_id: 'k', sig: 's' } }];
      if (m.type === 'letters-list') return [];
      if (m.type === 'receipt-signature') return { level: 'ok', text: `check ${++n}` };
      if (m.type === 'receipt-record') return { asked: [], seen: [], checkedAt: 1 };
      return null;
    });
    const { q, button } = await mount();
    const card = () => q('list').querySelector('.card')!;
    button(card(), 'View').click();
    await vi.waitFor(() => expect(card().querySelector('.sig-ok')?.textContent).toBe('check 1'));
    const check = button(card(), 'Check public record');
    check.disabled = false;
    check.click();
    await vi.waitFor(() => expect(card().querySelector('.sig-ok')?.textContent).toBe('check 2'));
  });
});
