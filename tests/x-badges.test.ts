import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { startBadges } from '../src/entrypoints/content/x-badges';
import type { Badge } from '../src/identity/resolve';
import { myHandleItem, xmrSettingsItem } from '../src/settings';

const send = vi.hoisted(() => vi.fn());
const openTip = vi.hoisted(() => vi.fn());
const mounted = vi.hoisted(() => [] as HTMLElement[]);
vi.mock('../src/messaging', async (orig) => ({ ...(await orig<typeof import('../src/messaging')>()), sendToBackground: send }));
vi.mock('../src/entrypoints/content/tip', () => ({ openTip }));
// the badge sits in a closed shadow root; keep the element mountBadge hands back
vi.mock('../src/identity/badge-look', async (orig) => {
  const m = await orig<typeof import('../src/identity/badge-look')>();
  return { ...m, mountBadge: (...a: Parameters<typeof m.mountBadge>) => (mounted.push(m.mountBadge(...a)), mounted.at(-1)!) };
});

const PK = 'c'.repeat(64);
const ADDR = '44AFFq5kSiGBoZ4NMDwYtN18obc8AemS33DBLWs3H7otXft3XjrpDtQGv7SqSsaBYBb98uNbr2VBBEt7f2wfn3RVGQBEP3A';
const entry = { source: 'nostr', address: ADDR, check: { ok: true, type: 'standard' }, verified: true, method: 'nip39:client', pubkey: PK, createdAt: 1 };
const badge = { handle: 'xbtoshi', primary: entry, entries: [entry], differ: false } as unknown as Badge;
const fixture = readFileSync(join(process.cwd(), 'tests/fixtures/x-share-menu.html'), 'utf8');
const card = `<div data-testid="HoverCard"><a href="/XBToshi" role="link"><div id="row"><span>CyberSatoshi</span></div></a></div>`;
const badges = () => document.querySelectorAll('xmradar-badge').length;
const xaps = () => document.querySelectorAll('[data-xmradar="xap"]');
const totals = { verified: '0.004', verifiedTippers: 1, verifying: '0', claimed: '0.5', claimedTippers: 1, address: ADDR, mine: [], at: 0 };

describe('badges on X', () => {
  let invalidate: (() => void)[] = [];
  const ctx = {
    addEventListener: (t: EventTarget, e: string, h: EventListener, o?: AddEventListenerOptions) => t.addEventListener(e, h, o),
    onInvalidated: (cb: () => void) => invalidate.push(cb),
  };
  afterEach(() => {
    for (const cb of invalidate) cb();
    invalidate = [];
    document.body.innerHTML = '';
  });
  beforeEach(async () => {
    fakeBrowser.reset();
    openTip.mockReset();
    mounted.length = 0;
    send.mockReset().mockImplementation(async (m: { type: string }) => (m.type === 'xap-totals' ? { totals: [[PK, totals]], pending: [] } : { badges: [['xbtoshi', badge]], pending: [] }));
    await xmrSettingsItem.setValue({ badgesX: true, badgesNostr: true, nostrDiscovery: true, tipReceipts: true, badgeIcon: 'mono', badgeLabel: true });
  });
  const lookups = () => send.mock.calls.filter(([m]) => m.type === 'resolve-handles').length;

  it('tweets get a Xap button in the action bar, not a pill in the name row', async () => {
    await myHandleItem.setValue({ handle: 'xbtoshi', proven: true });
    document.body.innerHTML = fixture;
    startBadges(ctx as never);
    await vi.waitFor(() => expect(xaps().length).toBe(1), { timeout: 3000 });
    expect(badges()).toBe(0);
    expect(document.querySelector('[data-testid="User-Name"] xmradar-badge')).toBeNull();
    // with discovery on, the verified total comes in batches
    await vi.waitFor(() => expect(document.querySelector('[data-xmradar="xap-count"]')!.textContent).toBe('0.004'), { timeout: 3000 });
  });

  it('the Xap button opens the popup in Xap mode, with the cached totals', async () => {
    document.body.innerHTML = fixture;
    startBadges(ctx as never);
    await vi.waitFor(() => expect(document.querySelector('[data-xmradar="xap-count"]')?.textContent).toBe('0.004'), { timeout: 3000 });
    xaps()[0]!.querySelector('button')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(openTip).toHaveBeenCalledWith(ctx, 'XBToshi', badge, { xap: true, totals });
  });

  it('no button for an author without a badge, and a recycled tweet loses its old one', async () => {
    send.mockImplementation(async () => ({ badges: [['xbtoshi', { ...badge, primary: null, entries: [] }]], pending: [] }));
    document.body.innerHTML = fixture;
    startBadges(ctx as never);
    await vi.waitFor(() => expect(lookups()).toBe(1), { timeout: 3000 });
    await new Promise((r) => setTimeout(r, 50));
    expect(xaps().length).toBe(0);
  });

  it('removes Xap buttons when badges or discovery go off', async () => {
    for (const patch of [{ badgesX: false }, { nostrDiscovery: false }]) {
      document.body.innerHTML = fixture;
      const stop = invalidate.length;
      startBadges(ctx as never);
      await vi.waitFor(() => expect(xaps().length).toBe(1), { timeout: 3000 });
      await xmrSettingsItem.setValue({ ...(await xmrSettingsItem.getValue()), ...patch });
      await vi.waitFor(() => expect(xaps().length, JSON.stringify(patch)).toBe(0));
      for (const cb of invalidate.splice(stop)) cb();
      await xmrSettingsItem.setValue({ badgesX: true, badgesNostr: true, nostrDiscovery: true, tipReceipts: true, badgeIcon: 'mono', badgeLabel: true });
    }
  });

  it('a recycled tweet node with another id gets a fresh button', async () => {
    document.body.innerHTML = fixture;
    startBadges(ctx as never);
    await vi.waitFor(() => expect(xaps().length).toBe(1), { timeout: 3000 });
    const first = xaps()[0];
    for (const a of document.querySelectorAll('article a[href*="/status/"]')) a.setAttribute('href', a.getAttribute('href')!.replace('2113662765525282909', '42'));
    window.dispatchEvent(new Event('wxt:locationchange'));
    await vi.waitFor(() => expect(xaps()[0]).not.toBe(first));
    expect(xaps().length).toBe(1);
    expect((xaps()[0] as HTMLElement).dataset.key).toBe('42:xbtoshi');
  });

  it('the hover card gets the pill after the name, redrawn on a look change without a new lookup', async () => {
    document.body.innerHTML = card;
    startBadges(ctx as never);
    await vi.waitFor(() => expect(badges()).toBe(1), { timeout: 3000 });
    expect(document.querySelector('#row > xmradar-badge')).not.toBeNull();
    const first = document.querySelector('xmradar-badge');
    await xmrSettingsItem.setValue({ ...(await xmrSettingsItem.getValue()), badgeIcon: 'none' });
    await vi.waitFor(() => expect(document.querySelector('xmradar-badge')).not.toBe(first));
    expect(badges()).toBe(1);
    expect(lookups()).toBe(1);
  });

  it('clicking the pill opens the tip without following the card link', async () => {
    document.body.innerHTML = card;
    startBadges(ctx as never);
    await vi.waitFor(() => expect(mounted.length).toBe(1), { timeout: 3000 });
    const btn = mounted[0]!;
    expect(btn.localName).toBe('button');
    expect(btn.getAttribute('aria-label')).toBe('Accepts Monero — tip @XBToshi');
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true });
    btn.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(openTip).toHaveBeenCalledWith(ctx, 'XBToshi', badge);
  });

  it("the pill's tooltip carries the Xap totals, verified and claimed apart", async () => {
    document.body.innerHTML = card;
    startBadges(ctx as never);
    await vi.waitFor(() => expect(mounted[0]?.title).toContain('Xaps:'), { timeout: 3000 });
    expect(mounted[0]!.title).toBe('Accepts Monero — tip @XBToshi\nXaps: ɱ 0.004 verified (1 tipper) · ~ɱ 0.5 claimed (1 tipper, not confirmed by @XBToshi)');
  });
});
