import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { startBadges } from '../src/entrypoints/content/x-badges';
import type { Badge } from '../src/identity/resolve';
import { directoryStatusItem, myHandleItem, xClaimsChangedItem, xmrSettingsItem } from '../src/settings';

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
// the fixture tweet's own figure: different from the profile total, so a mix-up shows
const postTotals = { ...totals, verified: '0', verifiedTippers: 0, claimed: '0.0016', claimedTippers: 1 };
const STATUS = '2113662765525282909';

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
    send.mockReset().mockImplementation(async (m: { type: string; posts?: { id: string; pubkey: string }[] }) =>
      m.type === 'xap-totals'
        ? { totals: [[PK, totals]], pending: [] }
        : m.type === 'xap-post-totals'
          ? { totals: m.posts!.map((p) => [`${p.pubkey}:${p.id}`, postTotals]), pending: [] }
          : { badges: [['xbtoshi', badge]], pending: [] },
    );
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
    // with discovery on, the tweet's own figure comes in batches: never the profile total
    await vi.waitFor(() => expect(document.querySelector('[data-xmradar="xap-count"]')!.textContent).toBe('~0.0016'), { timeout: 3000 });
    expect(xaps()[0]!.querySelector('button')!.getAttribute('aria-label')).toBe('Xap this post by @XBToshi (Monero tip), ~ɱ 0.0016 claimed by 1 tipper on this post, not confirmed');
    expect(send).toHaveBeenCalledWith({ type: 'xap-post-totals', posts: [{ pubkey: PK, id: STATUS }] });
  });

  it('the Xap button opens a post Xap, with the cached post figure', async () => {
    document.body.innerHTML = fixture;
    startBadges(ctx as never);
    await vi.waitFor(() => expect(document.querySelector('[data-xmradar="xap-count"]')?.textContent).toBe('~0.0016'), { timeout: 3000 });
    xaps()[0]!.querySelector('button')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(openTip).toHaveBeenCalledWith(ctx, 'XBToshi', badge, { xap: true, post: STATUS, totals: postTotals, onTotals: expect.any(Function), onProfileTotals: expect.any(Function), onPublished: expect.any(Function) });
  });

  it('a tweet without a status link gets a profile Xap and the profile total', async () => {
    document.body.innerHTML = fixture.replaceAll(`/status/${STATUS}`, '');
    startBadges(ctx as never);
    await vi.waitFor(() => expect(document.querySelector('[data-xmradar="xap-count"]')?.textContent).toBe('0.004'), { timeout: 3000 });
    expect((xaps()[0] as HTMLElement).dataset.post).toBeUndefined();
    expect(send.mock.calls.some(([m]) => m.type === 'xap-post-totals')).toBe(false);
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

  it('a new xmr.bio directory makes badges on screen look up again; a status-only change doesn’t', async () => {
    document.body.innerHTML = card;
    startBadges(ctx as never);
    await vi.waitFor(() => expect(badges()).toBe(1), { timeout: 3000 });
    expect(lookups()).toBe(1);
    await directoryStatusItem.setValue({ state: 'not-live', at: 1 });
    await new Promise((r) => setTimeout(r, 1200));
    expect(lookups()).toBe(1);
    await directoryStatusItem.setValue({ state: 'ok', at: 2, count: 1, generatedAt: 5 });
    await vi.waitFor(() => expect(lookups()).toBe(2), { timeout: 3000 });
    await vi.waitFor(() => expect(badges()).toBe(1), { timeout: 3000 });
  });

  describe('X self-claims on a profile page', () => {
    const SUB = '89fM69NVioz94JQrJFLGPDa8PMpjea7TV8JQktbLBLpX9gKMfrt3dge7KMdqg86coZjCxCm3fn1WKdM8WBMJhEdaUimo8Q3';
    const PIN = '<svg><path d="M13 21l-1 2-1-2v-5H4.5v-2.287"></path></svg>';
    const profile = (bio: string) => `<div data-testid="primaryColumn">
      <div data-testid="UserName"><span>Foo</span><span>@foo</span></div>
      <div data-testid="UserDescription">${bio}</div>
      <div data-testid="UserProfileHeader_Items"><a data-testid="UserUrl">xmr.bio/foo_tips</a></div>
      <article data-testid="tweet"><div><div>${PIN}</div><span data-testid="socialContext">Pinned</span></div>
        <div data-testid="User-Name"><a href="/foo">Foo</a><a href="/foo/status/77"><time></time></a></div>
        <div data-testid="tweetText">pay ${SUB}</div></article></div>`;
    const sent = () => send.mock.calls.map(([m]) => m).filter((m) => m.type === 'x-claims-seen');
    beforeEach(() => (window as unknown as { happyDOM: { setURL(u: string): void } }).happyDOM.setURL('https://x.com/foo'));
    afterEach(() => (window as unknown as { happyDOM: { setURL(u: string): void } }).happyDOM.setURL('http://localhost:3000/'));

    it('reads bio and Website once settled, the pinned post once it stayed; only changes are sent again', async () => {
      send.mockImplementation(async (m: { type: string }) => (m.type === 'x-claims-seen' ? { changed: true } : { badges: [], pending: [] }));
      document.body.innerHTML = profile(`Monero: ${ADDR}`);
      startBadges(ctx as never);
      await vi.waitFor(() => expect(sent().length).toBe(2), { timeout: 3000 });
      expect(sent()).toEqual([
        { type: 'x-claims-seen', handle: 'foo', place: 'bio', claim: { address: ADDR } },
        { type: 'x-claims-seen', handle: 'foo', place: 'url', claim: { xmrbio: 'foo_tips' } },
      ]);
      await vi.waitFor(() => expect(sent().length).toBe(3), { timeout: 4000 });
      expect(sent()[2]).toEqual({ type: 'x-claims-seen', handle: 'foo', place: 'pinned', claim: { address: SUB }, tweetId: '77' });
      // the bio changes: only the bio goes again, now without a claim
      document.querySelector('[data-testid="UserDescription"]')!.textContent = 'just a bio';
      await vi.waitFor(() => expect(sent().length).toBe(4), { timeout: 3000 });
      expect(sent()[3]).toEqual({ type: 'x-claims-seen', handle: 'foo', place: 'bio', claim: null });
    }, 10_000);

    it('a complete profile with no posts says it has no pinned post, after a wait', async () => {
      send.mockImplementation(async (m: { type: string }) => (m.type === 'x-claims-seen' ? { changed: false } : { badges: [], pending: [] }));
      document.body.innerHTML = profile('just a bio').replace(/<article[\s\S]*<\/article>/, '');
      startBadges(ctx as never);
      await vi.waitFor(() => expect(sent().length).toBe(2), { timeout: 3000 });
      await new Promise((r) => setTimeout(r, 3000));
      // not yet: the timeline may still be loading
      expect(sent().some((m) => m.place === 'pinned')).toBe(false);
      await vi.waitFor(() => expect(sent().find((m) => m.place === 'pinned')).toEqual({ type: 'x-claims-seen', handle: 'foo', place: 'pinned', claim: null }), { timeout: 5000 });
    }, 12_000);

    it('nothing is read with the switch off', async () => {
      await xmrSettingsItem.setValue({ ...(await xmrSettingsItem.getValue()), xClaims: false });
      document.body.innerHTML = profile(`Monero: ${ADDR}`);
      startBadges(ctx as never);
      await new Promise((r) => setTimeout(r, 1500));
      expect(sent()).toEqual([]);
    });

    it('a changed claim makes that handle look up again, and only that one', async () => {
      document.body.innerHTML = card;
      startBadges(ctx as never);
      await vi.waitFor(() => expect(badges()).toBe(1), { timeout: 3000 });
      await xClaimsChangedItem.setValue({ handle: 'someone_else', at: 1 });
      await new Promise((r) => setTimeout(r, 1200));
      expect(lookups()).toBe(1);
      await xClaimsChangedItem.setValue({ handle: 'xbtoshi', at: 2 });
      await vi.waitFor(() => expect(lookups()).toBe(2), { timeout: 3000 });
      await vi.waitFor(() => expect(badges()).toBe(1), { timeout: 3000 });
    });
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

  it('people lists get the pill after the name, never for a mention in the bio', async () => {
    document.body.innerHTML = `<div data-testid="UserCell">
      <a href="/XBToshi" role="link" tabindex="-1"><img></a>
      <a href="/XBToshi" role="link"><div id="cellrow"><span>CyberSatoshi</span></div></a>
      <a href="/XBToshi" role="link" tabindex="-1"><div>@XBToshi</div></a>
      <div><a href="/kyc_rip" role="link"><div id="mention">@kyc_rip</div></a></div>
    </div>`;
    startBadges(ctx as never);
    await vi.waitFor(() => expect(badges()).toBe(1), { timeout: 3000 });
    expect(document.querySelector('#cellrow > xmradar-badge')).not.toBeNull();
    expect(document.querySelector('#mention xmradar-badge')).toBeNull();
  });
});

