import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { findTweet, hoverTint, shareButtonOf, shareMenu } from '../src/entrypoints/content/x-share';
import { ownStatusId } from '../src/extractors/x';
import { shareMenuOn } from '../src/settings';
import { checkShareMenuSender, shareMenuRateLimit, withoutTab } from '../src/sender';
import { makeDoc } from './helpers';

const raw = readFileSync(join(process.cwd(), 'tests/fixtures/x-share-menu.html'), 'utf8');
const ID = '2113662765525282909';

/** The fixture page with the menu taken out; `openMenu` puts it back the way X does. */
function setup() {
  const doc = makeDoc('https://x.com/XBToshi', raw);
  const menu = doc.querySelector('#layers > div')!;
  menu.remove();
  const share = doc.querySelector<HTMLButtonElement>('article button[aria-haspopup="menu"]:not([data-testid])')!;
  const openMenu = (expand = true) => {
    if (expand) share.setAttribute('aria-expanded', 'true');
    doc.getElementById('layers')!.append(menu.cloneNode(true));
  };
  return { doc, share, openMenu };
}

const click = (el: Element) => {
  const e = new MouseEvent('click', { bubbles: true, cancelable: true });
  Object.defineProperty(e, 'target', { value: el });
  return e;
};
/** happy-dom can't make trusted events; the real listener passes e.isTrusted */
const trusted = (e: Event) => {
  Object.defineProperty(e, 'isTrusted', { value: true });
  return e;
};
const item = (doc: Document) => doc.querySelectorAll('[data-xmradar="copy-to-nostr"]');
const settle = () => new Promise((r) => setTimeout(r, 0));

let stops: (() => void)[] = [];
afterEach(() => {
  for (const s of stops) s();
  stops = [];
});
function menuFor(doc: Document, request = vi.fn(async () => null), now?: () => number) {
  const m = shareMenu(doc, request, now);
  stops.push(m.stop);
  return { m, request };
}

describe('share button and tweet identity', () => {
  it('finds only the share button: the last, untagged, menu-type button of the action bar', () => {
    const { doc, share } = setup();
    expect(shareButtonOf(share.querySelector('svg'))).toBe(share);
    for (const id of ['reply', 'retweet', 'unlike', 'bookmark']) expect(shareButtonOf(doc.querySelector(`[data-testid="${id}"]`))).toBeNull();
    // the caret (…) sits above the tweet, outside the action bar
    const caret = doc.createElement('button');
    caret.setAttribute('data-testid', 'caret');
    caret.setAttribute('aria-haspopup', 'menu');
    doc.querySelector('article')!.prepend(caret);
    expect(shareButtonOf(caret)).toBeNull();
    expect(shareButtonOf(doc.querySelector('a[href$="/analytics"]'))).toBeNull();
  });
  it('identifies tweets by their own status link', () => {
    const { doc } = setup();
    expect(ownStatusId(doc.querySelector('article')!)).toBe(ID);
    expect(findTweet(doc, ID)).toBe(doc.querySelector('article'));
    expect(findTweet(doc, '1')).toBeNull();
  });
});

describe('share menu item', () => {
  it('appears once in the share menu after a trusted share click', async () => {
    const { doc, share, openMenu } = setup();
    const { m } = menuFor(doc);
    m.onClick(click(share), true);
    openMenu();
    await settle();
    expect(item(doc).length).toBe(1);
    const it = item(doc)[0]!;
    expect(it.textContent).toBe('Copy to Nostr');
    expect(it.getAttribute('tabindex')).toBe('0');
    expect(it.querySelector('svg path')!.getAttribute('d')).not.toBe('M0 0');
    expect(it.querySelector('[stroke="currentColor"]')).not.toBeNull();
    // hover like X's own items, which a copy doesn't inherit
    (it as HTMLElement).dispatchEvent(new Event('pointerenter'));
    expect((it as HTMLElement).style.backgroundColor).not.toBe('');
    (it as HTMLElement).dispatchEvent(new Event('pointerleave'));
    expect((it as HTMLElement).style.backgroundColor).toBe('');
    // X re-creates the menu on each open: one item per menu, never two
    m.onClick(click(share), true);
    doc.getElementById('layers')!.replaceChildren();
    openMenu();
    await settle();
    expect(item(doc).length).toBe(1);
  });

  it('appears when X marks the button expanded only after adding the menu', async () => {
    const { doc, share, openMenu } = setup();
    const { m } = menuFor(doc);
    m.onClick(click(share), true);
    openMenu(false);
    await settle();
    expect(item(doc).length).toBe(0);
    share.setAttribute('aria-expanded', 'true');
    await settle();
    expect(item(doc).length).toBe(1);
  });

  it('ignores untrusted share clicks, menus of other buttons, fakes and stale menus', async () => {
    const cases: [string, (s: ReturnType<typeof setup>, m: ReturnType<typeof shareMenu>, clock: { t: number }) => void][] = [
      ['untrusted click', ({ share, openMenu }, m) => (m.onClick(click(share), false), openMenu())],
      ['no share click at all', ({ openMenu }) => openMenu()],
      ['share button not expanded', ({ share, openMenu }, m) => (m.onClick(click(share), true), openMenu(false))],
      [
        'the repost menu is the one open',
        ({ doc, share, openMenu }, m) => {
          m.onClick(click(share), true);
          doc.querySelector('[data-testid="retweet"]')!.setAttribute('aria-expanded', 'true');
          openMenu();
        },
      ],
      ['menu after 2 s', ({ share, openMenu }, m, clock) => (m.onClick(click(share), true), (clock.t += 2500), openMenu())],
      [
        'a one-item fake menu',
        ({ doc, share }, m) => {
          m.onClick(click(share), true);
          share.setAttribute('aria-expanded', 'true');
          const fake = doc.createElement('div');
          fake.innerHTML = '<div role="menu"><div data-testid="Dropdown"><div role="menuitem"><svg></svg><span>x</span></div></div></div>';
          doc.getElementById('layers')!.append(fake);
        },
      ],
    ];
    for (const [name, run] of cases) {
      const s = setup();
      const clock = { t: 1000 };
      const { m } = menuFor(s.doc, undefined, () => clock.t);
      run(s, m, clock);
      await settle();
      expect(item(s.doc).length, name).toBe(0);
    }
  });

  it('goes into the newest menu when an old one is still in #layers', async () => {
    const { doc, share, openMenu } = setup();
    const { m } = menuFor(doc);
    m.onClick(click(share), true);
    openMenu();
    await settle();
    // X leaves the old menu (with our item) behind and opens a fresh one
    m.onClick(click(share), true);
    openMenu();
    await settle();
    const menus = doc.querySelectorAll('[data-testid="Dropdown"]');
    expect(menus.length).toBe(2);
    expect(menus[1]!.querySelectorAll('[data-xmradar]').length).toBe(1);
  });

  it('a second share click takes over from the first', async () => {
    const { doc, share, openMenu } = setup();
    const other = doc.querySelector('article')!.cloneNode(true) as Element;
    other.querySelector('a[href*="/status/"]')!.setAttribute('href', '/XBToshi/status/42');
    doc.body.prepend(other);
    const otherShare = shareButtonOf(other.querySelector('[role="group"] button:last-of-type'))!;
    const { m, request } = menuFor(doc);
    m.onClick(click(otherShare), true);
    m.onClick(click(share), true);
    openMenu();
    await settle();
    item(doc)[0]!.dispatchEvent(trusted(new MouseEvent('click', { bubbles: true, cancelable: true })));
    expect(request).toHaveBeenCalledTimes(1);
    expect(ownStatusId(m.takeTarget()!)).toBe(ID);
  });

  it('activation: trusted only, closes the menu through its button, then hands over the tweet once', async () => {
    const { doc, share, openMenu } = setup();
    const { m, request } = menuFor(doc);
    m.onClick(click(share), true);
    openMenu();
    await settle();
    const toggle = vi.spyOn(share, 'click');
    const el = item(doc)[0]!;
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(request).not.toHaveBeenCalled();
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    expect(request).not.toHaveBeenCalled();
    el.dispatchEvent(trusted(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true })));
    expect(request).toHaveBeenCalledTimes(1);
    expect(toggle).toHaveBeenCalledTimes(1);
    expect(m.takeTarget()).toBe(doc.querySelector('article'));
    expect(m.takeTarget()).toBeNull();
  });

  it('activation works however long the menu stayed open, but not after it closed and 10 s passed', async () => {
    for (const closed of [false, true]) {
      const { doc, share, openMenu } = setup();
      const clock = { t: 1000 };
      const { m, request } = menuFor(doc, undefined, () => clock.t);
      m.onClick(click(share), true);
      openMenu();
      await settle();
      clock.t += 60_000;
      if (closed) share.setAttribute('aria-expanded', 'false');
      item(doc)[0]!.dispatchEvent(trusted(new MouseEvent('click', { bubbles: true, cancelable: true })));
      expect(request.mock.calls.length, closed ? 'closed' : 'open').toBe(closed ? 0 : 1);
    }
  });

  it('a recycled tweet node or a stale request gives no target', async () => {
    for (const spoil of ['recycle', 'stale'] as const) {
      const { doc, share, openMenu } = setup();
      const clock = { t: 1000 };
      const { m } = menuFor(doc, undefined, () => clock.t);
      m.onClick(click(share), true);
      openMenu();
      await settle();
      item(doc)[0]!.dispatchEvent(trusted(new MouseEvent('click', { bubbles: true, cancelable: true })));
      if (spoil === 'recycle') doc.querySelector('article a[href*="/status/"]')!.setAttribute('href', '/someone/status/7');
      else clock.t += 11_000;
      expect(m.takeTarget(), spoil).toBeNull();
    }
  });
});

describe('share-menu background checks', () => {
  const RT = 'ourid';
  const ok = { id: RT, frameId: 0, url: 'https://x.com/XBToshi', tab: { id: 5, url: 'https://x.com/XBToshi' } };
  it('accepts our content script in the top frame of an X tab', () => {
    expect(checkShareMenuSender(ok, RT)).toBe(5);
  });
  it.each([
    ['another extension', { ...ok, id: 'other' }],
    ['no tab', { ...ok, tab: undefined }],
    ['a sub-frame', { ...ok, frameId: 1 }],
    ['an http page', { ...ok, url: 'http://x.com/a' }],
    ['another site', { ...ok, url: 'https://evil.example/', tab: { id: 5, url: 'https://evil.example/' } }],
    ['an extension page', { id: RT, frameId: 0, url: 'chrome-extension://ourid/options.html', tab: { id: 5, url: 'chrome-extension://ourid/options.html' } }],
    ['a frame URL that differs from the tab', { ...ok, tab: { id: 5, url: 'https://evil.example/' } }],
  ])('refuses %s', (_, sender) => {
    expect(() => checkShareMenuSender(sender, RT)).toThrow();
  });
  it('rate-limits each tab to one request per 2 s and forgets closed tabs', () => {
    expect(shareMenuRateLimit({}, 5, 0, 2000)).toEqual({ 5: 0 });
    const first = shareMenuRateLimit({}, 5, 10_000, 2000)!;
    expect(first).toEqual({ 5: 10_000 });
    expect(shareMenuRateLimit(first, 5, 11_000, 2000)).toBeNull();
    expect(shareMenuRateLimit(first, 6, 11_000, 2000)).toEqual({ 5: 10_000, 6: 11_000 });
    expect(shareMenuRateLimit(first, 5, 12_000, 2000)).toEqual({ 5: 12_000 });
    expect(withoutTab({ 5: 1, 6: 2 }, 5)).toEqual({ 6: 2 });
  });
  it('the setting is on unless explicitly off (older saved settings lack it)', () => {
    expect(shareMenuOn({ relays: [], blossomServer: '', appendSourceLink: false, debug: false })).toBe(true);
    expect(shareMenuOn(null)).toBe(true);
    expect(shareMenuOn({ shareMenuX: false })).toBe(false);
  });
});

describe('share menu hover tint', () => {
  it('dark on a light page, light on X’s dim and dark themes', () => {
    document.body.style.backgroundColor = 'rgb(255, 255, 255)';
    expect(hoverTint(document)).toBe('rgba(15, 20, 25, 0.03)');
    document.body.style.backgroundColor = 'rgb(21, 32, 43)';
    expect(hoverTint(document)).toBe('rgba(231, 233, 234, 0.03)');
    document.body.style.backgroundColor = '';
  });
});
