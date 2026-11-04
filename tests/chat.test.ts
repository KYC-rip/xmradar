import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { openChat } from '../src/chat/open';
import { CHAT_SANDBOX, chatPanel } from '../src/chat/panel';
import { chatUrl, roomFor, roomSlug, type Room } from '../src/chat/rooms';
import type { SiteEntry, SiteFeed } from '../src/sites/feed';

const site = (id: string, name: string, hosts: string[]): SiteEntry =>
  ({ id, name, category: 'exchanges', grade: '', incident: false, url: `https://xmr.club/${id}`, hosts }) as SiteEntry;
const feed = (...sites: SiteEntry[]): SiteFeed => ({ issuedAt: 0, expiresAt: Infinity, sites });

describe('chatUrl', () => {
  it('always chat.xmr.club, the embed layout and a valid room', () => {
    expect(chatUrl('lobby')).toBe('https://chat.xmr.club/?embed=1&room=lobby');
    expect(chatUrl('x')).toBe('https://chat.xmr.club/?embed=1&room=x');
    expect(chatUrl('trocador', false)).toBe('https://chat.xmr.club/?room=trocador');
    for (const bad of ['', '../a', 'A', 'a'.repeat(21), 'a b', 'a&embed=0']) expect(chatUrl(bad)).toBe('https://chat.xmr.club/?embed=1&room=lobby');
  });
});

describe('roomSlug', () => {
  it('keeps an id that already is a room name', () => {
    expect(roomSlug('trocador')).toBe('trocador');
    expect(roomSlug('b-ai')).toBe('b-ai');
    expect(roomSlug('a'.repeat(20))).toBe('a'.repeat(20));
  });
  it('makes one for long, reserved or odd ids, always with _ so it never equals a kept id', () => {
    for (const id of ['cypher-stack-research', 'should-have-used-monero', 'lobby', 'x', 'my_site', 'Big.Site']) {
      const s = roomSlug(id);
      expect(s).toMatch(/^[a-z0-9-]{1,13}_[0-9a-f]{6}$/);
      expect(s).not.toBe(id);
    }
    expect(roomSlug('cypher-stack-research')).toBe(roomSlug('cypher-stack-research'));
    expect(roomSlug('cypher-stack-research').startsWith('cypher-stack-_')).toBe(true);
  });
  it('two long ids sharing 13 characters get different rooms', () => {
    expect(roomSlug('instantshippinglabels')).not.toBe(roomSlug('instantshippingforms'));
  });
});

describe('roomFor', () => {
  const f = feed(site('trocador', 'Trocador', ['trocador.app']), site('zz', 'Zed', ['shared.example']), site('aa', 'Ay', ['shared.example']));
  it('X and its other names', () => {
    for (const u of ['https://x.com/home', 'https://twitter.com/a', 'https://mobile.x.com/', 'https://www.x.com/']) expect(roomFor(u, null)).toEqual({ slug: 'x', label: 'X' });
  });
  it('a listed host, exactly (www. ignored)', () => {
    expect(roomFor('https://trocador.app/en', f)).toEqual({ slug: 'trocador', label: 'Trocador' });
    expect(roomFor('https://www.trocador.app/', f)).toEqual({ slug: 'trocador', label: 'Trocador' });
    expect(roomFor('https://app.trocador.app/', f)).toBeNull();
  });
  it('several listings on one host → the smallest id', () => {
    expect(roomFor('https://shared.example/', f)).toEqual({ slug: 'aa', label: 'Ay' });
  });
  it('nothing for unlisted, non-web or unreadable addresses', () => {
    for (const u of ['https://example.org/', 'chrome://extensions', 'about:blank', 'file:///a', '', undefined]) expect(roomFor(u, f)).toBeNull();
    expect(roomFor('https://trocador.app/', null)).toBeNull();
  });
});

describe('openChat', () => {
  const base = () => ({ openTab: vi.fn(async () => {}), close: vi.fn() });
  it('Chrome: the side panel for this window, called at once', async () => {
    const a = { ...base(), sidePanelOpen: vi.fn(async () => {}), windowId: 7 };
    const p = openChat(a);
    expect(a.sidePanelOpen).toHaveBeenCalledWith({ windowId: 7 });
    await p;
    expect(a.close).toHaveBeenCalled();
    expect(a.openTab).not.toHaveBeenCalled();
  });
  it('Firefox: the sidebar, called at once', async () => {
    const a = { ...base(), sidebarOpen: vi.fn(async () => {}) };
    const p = openChat(a);
    expect(a.sidebarOpen).toHaveBeenCalled();
    await p;
    expect(a.openTab).not.toHaveBeenCalled();
  });
  it('a refusal, a throw, no window or no API → a tab', async () => {
    const cases = [
      { sidePanelOpen: vi.fn(() => Promise.reject(new Error('gesture'))), windowId: 1 },
      {
        sidePanelOpen: vi.fn(() => {
          throw new Error('sync');
        }),
        windowId: 1,
      },
      { sidePanelOpen: vi.fn(async () => {}) },
      {},
    ];
    for (const c of cases) {
      const a = { ...base(), ...c };
      await openChat(a);
      expect(a.openTab).toHaveBeenCalledTimes(1);
      expect(a.close).toHaveBeenCalled();
    }
  });
});

describe('chatPanel', () => {
  function setup(stored: unknown, url: string | undefined, f: SiteFeed | null = feed(site('trocador', 'Trocador', ['trocador.app']))) {
    document.body.innerHTML = '<span id="t"></span><button id="l"></button><button id="s"></button><a id="n"></a>';
    const state = { url, feed: f, saved: [] as Room[] };
    // a stand-in: the test DOM doesn't load frames, and only src and attributes matter here
    const frame = document.createElement('div') as unknown as HTMLIFrameElement;
    const addListener = vi.spyOn(window, 'addEventListener');
    const panel = chatPanel({
      frame,
      title: document.getElementById('t')!,
      lobby: document.getElementById('l') as HTMLButtonElement,
      site: document.getElementById('s') as HTMLButtonElement,
      newTab: document.getElementById('n') as HTMLAnchorElement,
      room: { get: async () => stored, set: async (r) => void state.saved.push(r) },
      activeUrl: async () => state.url,
      feed: async () => state.feed,
    });
    return { panel, state, frame, site: document.getElementById('s') as HTMLButtonElement, addListener };
  }

  it('starts in the stored room, lobby when none or bad; sandboxed', async () => {
    let t = setup({ slug: 'x', label: 'X' }, undefined);
    await t.panel.ready;
    expect(t.frame.src).toBe('https://chat.xmr.club/?embed=1&room=x');
    expect(t.frame.getAttribute('sandbox')).toBe('allow-scripts allow-same-origin allow-forms allow-popups');
    expect(t.frame.referrerPolicy).toBe('no-referrer');
    t = setup({ slug: '../evil', label: 'E' }, undefined);
    await t.panel.ready;
    expect(t.frame.src).toBe('https://chat.xmr.club/?embed=1&room=lobby');
  });

  it("offers this site's room without loading it; loads it only on a click", async () => {
    const t = setup(null, 'https://x.com/home');
    await t.panel.ready;
    expect(t.site.hidden).toBe(false);
    expect(t.site.textContent).toBe('X room');
    expect(t.frame.src).toContain('room=lobby');
    t.state.url = 'https://trocador.app/';
    await t.panel.refresh();
    expect(t.site.textContent).toBe('Trocador room');
    expect(t.frame.src).toContain('room=lobby');
    t.site.click();
    expect(t.frame.src).toBe('https://chat.xmr.club/?embed=1&room=trocador');
    expect(t.state.saved).toEqual([{ slug: 'trocador', label: 'Trocador' }]);
    expect(t.site.hidden).toBe(true);
    // leaving the site keeps the room; only the button goes
    t.state.url = 'https://example.org/';
    await t.panel.refresh();
    expect(t.frame.src).toContain('room=trocador');
    expect(t.site.hidden).toBe(true);
  });

  it('a feed arriving later shows the button', async () => {
    const t = setup(null, 'https://trocador.app/', null);
    await t.panel.ready;
    expect(t.site.hidden).toBe(true);
    t.state.feed = feed(site('trocador', 'Trocador', ['trocador.app']));
    await t.panel.refresh();
    expect(t.site.hidden).toBe(false);
  });

  it('never listens to the chat', async () => {
    const t = setup(null, undefined);
    await t.panel.ready;
    expect(t.addListener.mock.calls.some(([type]) => type === 'message')).toBe(false);
    const src = readFileSync(join(process.cwd(), 'src/chat/panel.ts'), 'utf8') + readFileSync(join(process.cwd(), 'src/entrypoints/sidepanel/main.ts'), 'utf8');
    expect(src).not.toMatch(/postMessage|addEventListener\(\s*['"]message/);
    expect(CHAT_SANDBOX).not.toMatch(/escape-sandbox|top-navigation|modals/);
  });
});

describe('built manifests', () => {
  const read = (b: string) => JSON.parse(readFileSync(join(process.cwd(), `output/${b}/manifest.json`), 'utf8'));
  it.skipIf(!existsSync(join(process.cwd(), 'output/chrome-mv3/manifest.json')))('Chrome has the side panel', () => {
    const m = read('chrome-mv3');
    expect(m.side_panel).toEqual({ default_path: 'sidepanel.html' });
    expect(m.permissions).toContain('sidePanel');
    expect(m.host_permissions).toEqual(['<all_urls>']);
  });
  it.skipIf(!existsSync(join(process.cwd(), 'output/firefox-mv3/manifest.json')))('Firefox has the sidebar', () => {
    const m = read('firefox-mv3');
    expect(m.sidebar_action).toMatchObject({ default_panel: 'sidepanel.html', default_title: 'XMRadar chat', open_at_install: false });
    expect(m.host_permissions).toEqual(['<all_urls>']);
  });
});
