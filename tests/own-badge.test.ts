import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { startBadges } from '../src/entrypoints/content/x-badges';
import type { Badge } from '../src/identity/resolve';
import { hideOwnBadge, sessionHandle } from '../src/identity/x-handle';
import { myHandleItem, xmrSettingsItem } from '../src/settings';
import { makeDoc } from './helpers';

const send = vi.hoisted(() => vi.fn());
vi.mock('../src/messaging', async (orig) => ({ ...(await orig<typeof import('../src/messaging')>()), sendToBackground: send }));

const nav = (href: string) => `<nav><a href="${href}" data-testid="AppTabBar_Profile_Link" aria-label="Profile" role="link">Profile</a></nav>`;
const tweet = `<article data-testid="tweet"><div data-testid="User-Name"><a href="/XBToshi">CyberSatoshi</a><a href="/XBToshi/status/42"><time>1h</time></a></div></article>`;
const badge = { handle: 'xbtoshi', primary: { source: 'nostr', address: 'a' }, entries: [], differ: false } as unknown as Badge;
const badges = () => document.querySelectorAll('xmradar-badge').length;

describe('sessionHandle', () => {
  const at = (body: string) => sessionHandle(makeDoc('https://x.com/XBToshi', body));
  it('reads the logged-in account from the nav profile link', () => {
    expect(at(nav('/mnr_network'))).toBe('mnr_network');
    expect(at(nav('/XBToshi/'))).toBe('xbtoshi');
    expect(at(nav('https://x.com/XBToshi?s=1#top'))).toBe('xbtoshi');
    expect(at(nav('/XBToshi') + nav('/xbtoshi'))).toBe('xbtoshi');
  });
  it('is null when logged out or unclear', () => {
    expect(at('')).toBeNull();
    expect(at(nav('/home'))).toBeNull();
    expect(at(nav('/i/flow/login'))).toBeNull();
    expect(at(nav('/XBToshi/status/1'))).toBeNull();
    expect(at(nav('/way_too_long_handle_x'))).toBeNull();
    expect(at(nav('https://evil.example/XBToshi'))).toBeNull();
    expect(at(nav('/XBToshi') + nav('/mnr_network'))).toBeNull();
  });
});

describe('hideOwnBadge', () => {
  it('hides only your proven handle, and only while X is logged in as it', () => {
    expect(hideOwnBadge('XBToshi', 'xbtoshi', 'xbtoshi')).toBe(true);
    expect(hideOwnBadge('XBToshi', 'xbtoshi', 'mnr_network')).toBe(false);
    expect(hideOwnBadge('XBToshi', 'xbtoshi', null)).toBe(false);
    expect(hideOwnBadge('XBToshi', null, 'xbtoshi')).toBe(false);
    expect(hideOwnBadge('alice', 'xbtoshi', 'xbtoshi')).toBe(false);
    expect(hideOwnBadge('xbtoshi', 'XBToshi', '@xbtoshi')).toBe(true);
  });
});

describe('own badge in the page', () => {
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
    send.mockReset().mockResolvedValue({ badges: [['xbtoshi', badge]], pending: [] });
    await xmrSettingsItem.setValue({ badgesX: true, badgesNostr: true, nostrDiscovery: true, tipReceipts: true });
  });

  it('follows account switches, including ones that change only the profile link', async () => {
    await myHandleItem.setValue({ handle: 'xbtoshi', proven: true });
    document.body.innerHTML = nav('/mnr_network') + tweet;
    startBadges(ctx as never);
    await vi.waitFor(() => expect(badges()).toBe(1), { timeout: 3000 });
    const link = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]')!;
    link.setAttribute('href', '/XBToshi');
    await vi.waitFor(() => expect(badges()).toBe(0));
    link.setAttribute('href', '/mnr_network');
    await vi.waitFor(() => expect(badges()).toBe(1));
    // redrawn from the content-side results, no second lookup
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('shows the badge again when the confirmed handle changes or stops being proven', async () => {
    await myHandleItem.setValue({ handle: 'xbtoshi', proven: true });
    document.body.innerHTML = nav('/XBToshi') + tweet;
    startBadges(ctx as never);
    // your own handle isn't even looked up while it's hidden
    await new Promise((r) => setTimeout(r, 1000));
    expect(send).not.toHaveBeenCalled();
    expect(badges()).toBe(0);
    await myHandleItem.setValue({ handle: 'xbtoshi', proven: false });
    await vi.waitFor(() => expect(badges()).toBe(1), { timeout: 3000 });
    await myHandleItem.setValue({ handle: 'xbtoshi', proven: true });
    await vi.waitFor(() => expect(badges()).toBe(0));
    await myHandleItem.setValue({ handle: 'someone_else', proven: true });
    await vi.waitFor(() => expect(badges()).toBe(1));
  });

  it('does not look up a queued handle once the session becomes yours', async () => {
    await myHandleItem.setValue({ handle: 'xbtoshi', proven: true });
    document.body.innerHTML = nav('/mnr_network') + tweet;
    startBadges(ctx as never);
    // queued under @mnr_network; switch before the 750 ms batch
    await new Promise((r) => setTimeout(r, 100));
    document.querySelector('a[data-testid="AppTabBar_Profile_Link"]')!.setAttribute('href', '/XBToshi');
    await new Promise((r) => setTimeout(r, 1200));
    expect(send).not.toHaveBeenCalled();
    expect(badges()).toBe(0);
  });

  it('keeps the session while the profile link is briefly missing', async () => {
    await myHandleItem.setValue({ handle: 'xbtoshi', proven: true });
    document.body.innerHTML = nav('/XBToshi') + tweet;
    startBadges(ctx as never);
    await new Promise((r) => setTimeout(r, 1000));
    document.querySelector('nav')!.remove();
    await new Promise((r) => setTimeout(r, 1200));
    expect(badges()).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });
});
