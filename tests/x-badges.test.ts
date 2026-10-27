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

const tweet = `<article data-testid="tweet"><div data-testid="User-Name"><a href="/XBToshi">CyberSatoshi</a><a href="/XBToshi/status/42"><time>1h</time></a></div></article>`;
const badge = { handle: 'xbtoshi', primary: { source: 'nostr', address: 'a' }, entries: [], differ: false } as unknown as Badge;
const badges = () => document.querySelectorAll('xmradar-badge').length;

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
    send.mockReset().mockResolvedValue({ badges: [['xbtoshi', badge]], pending: [] });
    await xmrSettingsItem.setValue({ badgesX: true, badgesNostr: true, nostrDiscovery: true, tipReceipts: true, badgeIcon: 'mono', badgeLabel: true });
  });

  it('shows your own badge too', async () => {
    await myHandleItem.setValue({ handle: 'xbtoshi', proven: true });
    document.body.innerHTML = tweet;
    startBadges(ctx as never);
    await vi.waitFor(() => expect(badges()).toBe(1), { timeout: 3000 });
  });

  it('redraws badges when the look changes, without a new lookup', async () => {
    document.body.innerHTML = tweet;
    startBadges(ctx as never);
    await vi.waitFor(() => expect(badges()).toBe(1), { timeout: 3000 });
    const first = document.querySelector('xmradar-badge');
    await xmrSettingsItem.setValue({ ...(await xmrSettingsItem.getValue()), badgeIcon: 'none' });
    await vi.waitFor(() => expect(document.querySelector('xmradar-badge')).not.toBe(first));
    expect(badges()).toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('clicking the badge opens the tip without following the tweet link', async () => {
    document.body.innerHTML = tweet;
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
});
