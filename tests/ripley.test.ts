import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyState, storage } from '../src/ripley/storage';
import { timerAlarms } from '../src/ripley/service';
import { REQUEST_TYPES } from '../src/service/x-lookups';

// The built files, as Ripley gets them (ripley-os plans/x-app-xmradar.md R2/R9/R15)
const OUT = join(process.cwd(), 'output/ripley');
let xBundle = '';
let serviceBundle = '';
beforeAll(() => {
  if (!existsSync(join(OUT, 'xmradar-x.js')) || !existsSync(join(OUT, 'xmradar-service.js'))) execSync('pnpm build:ripley', { stdio: 'ignore' });
  xBundle = readFileSync(join(OUT, 'xmradar-x.js'), 'utf8');
  serviceBundle = readFileSync(join(OUT, 'xmradar-service.js'), 'utf8');
}, 120_000);

type W = Window & { __xmradarRipley?: boolean; __xmradarRipleyState?: unknown; __TAURI_INTERNALS__?: { invoke: ReturnType<typeof vi.fn> } };
const w = () => window as unknown as W;
const SETTINGS = { 'sync:xmrSettings': { badgesX: true, badgesNostr: true, nostrDiscovery: false, tipReceipts: false, badgeIcon: 'mono', badgeLabel: true, xClaims: false, xoButton: false } };

function ipc() {
  const sent: { type: string }[] = [];
  const invoke = vi.fn(async (cmd: string, args: { request: string }) => {
    expect(cmd).toBe('xapp_bridge');
    const req = JSON.parse(args.request) as { type: string };
    sent.push(req);
    return JSON.stringify({ ok: true, data: req.type === 'resolve-handles' ? { badges: [], pending: [] } : null });
  });
  return { invoke, sent };
}

const run = () => new Function(xBundle)();
const setUrl = (u: string) => (window as unknown as { happyDOM: { setURL(u: string): void } }).happyDOM.setURL(u);

describe('the Ripley X bundle (built file)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setUrl('https://x.com/home');
    delete w().__xmradarRipley;
    delete w().__TAURI_INTERNALS__;
    w().__xmradarRipleyState = SETTINGS;
  });
  afterEach(() => {
    vi.useRealTimers();
    document.body?.replaceChildren();
  });

  it('carries its banner: the commit it was built from and the licence note', () => {
    expect(xBundle.startsWith('/*! XMRadar ')).toBe(true);
    expect(xBundle).toMatch(/commit [0-9a-f]{40}(-dirty)?\./);
    expect(xBundle).toContain('see NOTICE in RipleyOS');
  });

  it('at document start with no body and no Ripley IPC it does nothing, then starts once both appear', async () => {
    const body = document.body;
    body.remove();
    run();
    await vi.advanceTimersByTimeAsync(500);
    const { invoke, sent } = ipc();
    w().__TAURI_INTERNALS__ = { invoke };
    await vi.advanceTimersByTimeAsync(500);
    expect(invoke).not.toHaveBeenCalled(); // still no body
    document.documentElement.appendChild(body);
    await vi.advanceTimersByTimeAsync(200);
    expect(sent.find((r) => r.type === 'status')).toMatchObject({ state: 'started' });
    // the seed was read and taken off the page
    expect(w().__xmradarRipleyState).toBeUndefined();
  });

  it('without Ripley’s IPC it gives up after 5 s and stays off', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    run();
    await vi.advanceTimersByTimeAsync(6000);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('stays off'));
    w().__TAURI_INTERNALS__ = ipc();
    await vi.advanceTimersByTimeAsync(1000);
    expect(w().__TAURI_INTERNALS__!.invoke).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('starts once per page, top frame of X only', async () => {
    const { invoke } = ipc();
    w().__TAURI_INTERNALS__ = { invoke };
    run();
    run();
    await vi.advanceTimersByTimeAsync(100);
    expect(invoke.mock.calls.filter(([, a]) => JSON.parse((a as { request: string }).request).type === 'status')).toHaveLength(1);
    delete w().__xmradarRipley;
    setUrl('https://example.org/');
    invoke.mockClear();
    run();
    await vi.advanceTimersByTimeAsync(100);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('on a page of posts it asks Ripley only allow-listed things', async () => {
    const { invoke, sent } = ipc();
    w().__TAURI_INTERNALS__ = { invoke };
    document.body.innerHTML = `<main><article data-testid="tweet"><div data-testid="User-Name"><a href="/alice" role="link"><span>Alice</span></a><a href="/alice" role="link"><span>@alice</span></a></div><div role="group"></div></article></main>`;
    run();
    await vi.advanceTimersByTimeAsync(3000);
    const allowed = new Set<string>([...REQUEST_TYPES, 'status']);
    // the post's author was looked up for a badge, through Ripley
    expect(sent.map((r) => r.type)).toContain('resolve-handles');
    for (const r of sent) expect(allowed.has(r.type)).toBe(true);
  });
});

describe('the Ripley service bundle (built file)', () => {
  it('opens no connection of its own: no WebSocket, no relay pool, no bare fetch call', () => {
    expect(serviceBundle).not.toMatch(/WebSocket/);
    expect(serviceBundle).not.toMatch(/fetch\(/);
    expect(serviceBundle).not.toMatch(/XMLHttpRequest|EventSource|sendBeacon/);
  });

  it('exports the lookups, the allow-list and its version', async () => {
    const mod = await import(/* @vite-ignore */ `data:text/javascript;base64,${Buffer.from(serviceBundle).toString('base64')}`);
    expect(typeof mod.xLookups).toBe('function');
    expect(mod.REQUEST_TYPES).toEqual([...REQUEST_TYPES]);
    expect(mod.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('exports what Ripley needs to sign xos and record copies itself (phase 3)', async () => {
    const mod = await import(/* @vite-ignore */ `data:text/javascript;base64,${Buffer.from(serviceBundle).toString('base64')}`);
    for (const f of ['xoTemplate', 'undoTemplate', 'xoRelayOrder', 'readRelaysFrom', 'rememberSent', 'xoKeeper', 'freshXoInbox', 'verifyLiker', 'knownLiker', 'rememberLiker', 'recordSynced', 'syncedLink', 'xoKey']) expect(typeof mod[f]).toBe('function');
    expect(mod.xoTemplate('123', 'a'.repeat(64), 1)).toMatchObject({ kind: 17, content: 'ɱ❤' });
    expect(mod.MAX_SENT).toBeGreaterThan(0);
    expect(mod.MAX_SYNCED).toBeGreaterThan(0);
  });
});

describe('Ripley shims', () => {
  it('storage: seeded and pushed values reach readers and watchers; fallbacks fill gaps', async () => {
    const item = storage.defineItem<{ on: boolean }>('local:shimTest', { fallback: { on: false } });
    expect(await item.getValue()).toEqual({ on: false });
    const seen: unknown[] = [];
    const stop = item.watch((v) => seen.push(v));
    applyState({ 'local:shimTest': { on: true } });
    expect(await item.getValue()).toEqual({ on: true });
    applyState({ 'local:shimTest': null });
    expect(await item.getValue()).toEqual({ on: false });
    expect(seen).toEqual([{ on: true }, { on: false }]);
    stop();
    applyState('</script><script>alert(1)</script>');
    applyState([1, 2]);
    expect(await item.getValue()).toEqual({ on: false });
  });

  it('alarms on timers: a period repeats, a delay fires once, stop clears everything', async () => {
    vi.useFakeTimers();
    const t = timerAlarms();
    const fired: string[] = [];
    t.listen((n) => fired.push(n));
    await t.alarms.create('every', { periodInMinutes: 60 });
    await t.alarms.create('once', { delayInMinutes: 1 });
    expect((await t.alarms.get('every'))?.periodInMinutes).toBe(60);
    await vi.advanceTimersByTimeAsync(121 * 60_000);
    expect(fired).toEqual(['once', 'every', 'every']);
    t.stop();
    await vi.advanceTimersByTimeAsync(120 * 60_000);
    expect(fired).toHaveLength(3);
    vi.useRealTimers();
  });
});
