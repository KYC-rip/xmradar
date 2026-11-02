import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { isNewer, readLatest, releaseUrl, UPDATE_ALARM, UPDATE_URL, updateFor, updateKeeper, type UpdateState } from '../src/update/check';
import { settingsItem, updateStateItem } from '../src/settings';
import { heldUpdate, mountPopupUpdate, mountUpdatePanel } from '../src/ui/update-notice';

const DAY = 24 * 3600_000;
const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { headers: { 'content-type': 'application/json' }, ...init });
const v = (version: string) => json({ version, tag: `v${version}`, build: `${version}.9` });

describe('readLatest', () => {
  it('takes a version whose tag matches', () => {
    expect(readLatest({ version: '0.6.1', tag: 'v0.6.1', build: '0.6.1.7', extra: 1 })).toBe('0.6.1');
  });
  it.each([
    ['tag mismatch', { version: '0.6.1', tag: 'v0.6.2' }],
    ['no tag', { version: '0.6.1' }],
    ['number', { version: 61, tag: 'v61' }],
    ['four parts', { version: '0.6.1.7', tag: 'v0.6.1.7' }],
    ['five digits', { version: '0.6.10000', tag: 'v0.6.10000' }],
    ['a path', { version: '0.6.1/../x', tag: 'v0.6.1/../x' }],
    ['array', ['0.6.1']],
    ['null', null],
    ['string', '0.6.1'],
  ])('refuses %s', (_, body) => expect(readLatest(body)).toBeNull());
});

describe('isNewer', () => {
  it('compares the first three parts, numerically', () => {
    expect(isNewer('0.6.1', '0.6.0.6')).toBe(true);
    expect(isNewer('0.6.0', '0.6.0.9')).toBe(false);
    expect(isNewer('0.10.0', '0.9.9')).toBe(true);
    expect(isNewer('1.0.0', '0.99.99')).toBe(true);
    expect(isNewer('0.6.0', '0.6.0')).toBe(false);
    expect(isNewer('0.5.9', '0.6.0')).toBe(false);
    expect(isNewer(null, '0.6.0')).toBe(false);
  });
  it('builds release links from a checked version only', () => {
    expect(releaseUrl('0.6.1')).toBe('https://github.com/KYC-rip/xmradar/releases/tag/v0.6.1');
    expect(releaseUrl('0.6.1/../../evil')).toBeNull();
    expect(releaseUrl(null)).toBeNull();
    expect(updateFor({ attemptAt: 0, latest: '0.6.1', notified: null }, '0.6.0.6')).toBe('0.6.1');
    expect(updateFor({ attemptAt: 0, latest: '0.6.1', notified: null }, '0.6.1.7')).toBeNull();
  });
});

function setup(opts: { on?: boolean; current?: string; held?: UpdateState | null; now?: number } = {}) {
  let held: UpdateState | null = opts.held ?? null;
  let on = opts.on ?? true;
  let current = opts.current ?? '0.6.0.6';
  let now = opts.now ?? 10 * DAY;
  const deps = {
    held: {
      getValue: async () => held,
      setValue: async (x: UpdateState | null) => void (held = x),
      removeValue: async () => void (held = null),
    },
    fetch: vi.fn(async (_url: string, _init?: RequestInit) => v('0.6.1')),
    readBody: async (res: Response, max: number) => {
      const b = new Uint8Array(await res.arrayBuffer());
      if (b.length > max) throw new Error('Response too large');
      return b;
    },
    alarms: { create: vi.fn(async () => {}), clear: vi.fn(async () => {}) },
    enabled: async () => on,
    current: () => current,
    notify: vi.fn(async (_v: string) => {}),
    clearNotice: vi.fn(async () => {}),
    now: () => now,
  };
  const k = updateKeeper(deps as never);
  return {
    k,
    deps,
    held: () => held,
    set: { on: (x: boolean) => (on = x), current: (x: string) => (current = x), now: (x: number) => (now = x) },
  };
}

describe('updateKeeper', () => {
  it('off: no request, alarm and answer cleared, notification taken away', async () => {
    const t = setup({ on: false, held: { attemptAt: 0, latest: '0.6.1', notified: '0.6.1' } });
    await t.k.apply(false);
    expect(t.deps.fetch).not.toHaveBeenCalled();
    expect(t.deps.alarms.clear).toHaveBeenCalledWith(UPDATE_ALARM);
    expect(t.held()).toBeNull();
    expect(t.deps.clearNotice).toHaveBeenCalled();
    await t.k.onAlarm(UPDATE_ALARM);
    expect(t.deps.fetch).not.toHaveBeenCalled();
  });

  it('on: a daily alarm, and one request with no cookies, referrer or redirects', async () => {
    const t = setup();
    await t.k.apply(true);
    expect(t.deps.alarms.create).toHaveBeenCalledWith(UPDATE_ALARM, { periodInMinutes: 1440 });
    expect(t.deps.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = t.deps.fetch.mock.calls[0]!;
    expect(url).toBe(UPDATE_URL);
    expect(init).toMatchObject({ credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error', cache: 'no-store' });
    expect(init!.headers).toBeUndefined();
    expect(t.held()).toEqual({ attemptAt: 10 * DAY, latest: '0.6.1', notified: '0.6.1' });
    expect(t.deps.notify).toHaveBeenCalledWith('0.6.1');
  });

  it('asked less than a day ago: no request at start', async () => {
    const t = setup({ held: { attemptAt: 10 * DAY - 1000, latest: null, notified: null } });
    await t.k.apply(true);
    expect(t.deps.fetch).not.toHaveBeenCalled();
  });

  it('two checks at once make one request', async () => {
    const t = setup();
    await Promise.all([t.k.check(), t.k.check()]);
    expect(t.deps.fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['HTTP 503', () => json('down', { status: 503 })],
    ['not JSON', () => new Response('{"version":"0.6.1","tag":"v0.6.1"}', { headers: { 'content-type': 'text/html' } })],
    ['oversize', () => json({ version: '0.6.1', tag: 'v0.6.1', pad: 'x'.repeat(5000) })],
    ['bad JSON', () => json('{nope')],
    ['invalid fields', () => json({ version: '0.6.1', tag: 'v0.6.9' })],
    ['network error', () => Promise.reject(new TypeError('Failed to fetch'))],
  ])('a failure (%s) keeps the version seen, notifies nothing, and waits a day', async (_, res) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const t = setup({ held: { attemptAt: 0, latest: '0.6.0', notified: null } });
    t.deps.fetch.mockImplementation(res as never);
    await t.k.apply(true);
    expect(t.held()).toEqual({ attemptAt: 10 * DAY, latest: '0.6.0', notified: null });
    expect(t.deps.notify).not.toHaveBeenCalled();
    // the worker starts again an hour later: no new request
    t.set.now(10 * DAY + 3600_000);
    await t.k.apply(true);
    expect(t.deps.fetch).toHaveBeenCalledTimes(1);
  });

  it('notifies once per version: not again for the same one, nor after a rollback, but for a higher one', async () => {
    const t = setup();
    await t.k.check();
    await t.k.check();
    expect(t.deps.notify).toHaveBeenCalledTimes(1);
    t.deps.fetch.mockImplementation(async () => v('0.6.0'));
    await t.k.check();
    expect(t.held()!.latest).toBe('0.6.0');
    t.deps.fetch.mockImplementation(async () => v('0.6.1'));
    await t.k.check();
    expect(t.deps.notify).toHaveBeenCalledTimes(1);
    t.deps.fetch.mockImplementation(async () => v('0.7.0'));
    await t.k.check();
    expect(t.deps.notify).toHaveBeenCalledTimes(2);
    expect(t.deps.notify).toHaveBeenLastCalledWith('0.7.0');
    expect(t.held()!.notified).toBe('0.7.0');
  });

  it('a forged high version recovers with the next real answer, without another notification', async () => {
    const t = setup();
    t.deps.fetch.mockImplementation(async () => v('99.0.0'));
    await t.k.check();
    expect(updateFor(t.held(), '0.6.0.6')).toBe('99.0.0');
    t.deps.fetch.mockImplementation(async () => v('0.6.1'));
    await t.k.check();
    expect(t.held()).toMatchObject({ latest: '0.6.1', notified: '99.0.0' });
    expect(updateFor(t.held(), '0.6.0.6')).toBe('0.6.1');
    expect(t.deps.notify).toHaveBeenCalledTimes(1);
  });

  it('a notification that could not be shown is tried again next time', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const t = setup();
    t.deps.notify.mockRejectedValueOnce(new Error('denied'));
    await t.k.check();
    expect(t.held()).toMatchObject({ latest: '0.6.1', notified: null });
    await t.k.check();
    expect(t.deps.notify).toHaveBeenCalledTimes(2);
    expect(t.held()!.notified).toBe('0.6.1');
  });

  it('nothing for this version or an older one', async () => {
    const t = setup({ current: '0.6.1.7' });
    await t.k.check();
    expect(t.deps.notify).not.toHaveBeenCalled();
  });

  it('switched off while asking: the answer is dropped', async () => {
    let release!: (r: Response) => void;
    const t = setup();
    t.deps.fetch.mockImplementation(() => new Promise((r) => (release = r)));
    const pending = t.k.check();
    await vi.waitFor(() => expect(t.deps.fetch).toHaveBeenCalled());
    t.set.on(false);
    await t.k.apply(false);
    release(v('0.6.1'));
    await pending;
    expect(t.held()).toBeNull();
    expect(t.deps.notify).not.toHaveBeenCalled();
  });

  it('off and on again while asking: a new request starts and its answer is kept', async () => {
    const releases: ((r: Response) => void)[] = [];
    const t = setup();
    t.deps.fetch.mockImplementation(() => new Promise((r) => releases.push(r)));
    const first = t.k.check();
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    await t.k.apply(false);
    const second = t.k.apply(true);
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    releases[0]!(v('0.9.0'));
    releases[1]!(v('0.6.1'));
    await Promise.all([first, second]);
    expect(t.held()).toMatchObject({ latest: '0.6.1' });
  });

  it('updated since: a notification still showing is cleared at start', async () => {
    const t = setup({ current: '0.6.1.7', held: { attemptAt: 10 * DAY, latest: '0.6.1', notified: '0.6.1' } });
    await t.k.apply(true);
    expect(t.deps.clearNotice).toHaveBeenCalled();
    const u = setup({ held: { attemptAt: 10 * DAY, latest: '0.6.1', notified: '0.6.1' } });
    await u.k.apply(true);
    expect(u.deps.clearNotice).not.toHaveBeenCalled();
  });

  it('switched off after the answer arrived but before it was kept: nothing stored, nothing shown', async () => {
    const t = setup();
    let release!: (v: UpdateState | null) => void;
    const real = t.deps.held.getValue;
    t.deps.held.getValue = () => new Promise((r) => (release = r));
    const pending = t.k.check();
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    t.set.on(false);
    t.deps.held.getValue = real;
    await t.k.apply(false);
    release(null);
    await pending;
    expect(t.held()).toBeNull();
    expect(t.deps.notify).not.toHaveBeenCalled();
  });

  it('switched off while the notification was being shown: it is taken away', async () => {
    const t = setup();
    t.deps.notify.mockImplementation(async () => {
      t.set.on(false);
    });
    await t.k.check();
    expect(t.deps.notify).toHaveBeenCalledTimes(1);
    expect(t.deps.clearNotice).toHaveBeenCalled();
    expect(t.held()!.notified).toBeNull();
  });

  it('a forged high version followed by the real one: its notification is taken away', async () => {
    const t = setup();
    t.deps.fetch.mockImplementation(async () => v('99.0.0'));
    await t.k.check();
    expect(t.deps.clearNotice).not.toHaveBeenCalled();
    t.deps.fetch.mockImplementation(async () => v('0.6.1'));
    await t.k.check();
    expect(t.deps.clearNotice).toHaveBeenCalledTimes(1);
  });

  it('a notification that failed is tried again at the next start, without a new request', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const t = setup();
    t.deps.notify.mockRejectedValueOnce(new Error('denied'));
    await t.k.apply(true);
    expect(t.held()!.notified).toBeNull();
    t.set.now(10 * DAY + 3600_000);
    await t.k.apply(true);
    expect(t.deps.fetch).toHaveBeenCalledTimes(1);
    expect(t.deps.notify).toHaveBeenCalledTimes(2);
    expect(t.held()!.notified).toBe('0.6.1');
    // and not a third time
    await t.k.apply(true);
    expect(t.deps.notify).toHaveBeenCalledTimes(2);
  });

  it('other alarms are not ours', async () => {
    const t = setup();
    expect(t.k.onAlarm('site-feed')).toBeUndefined();
    expect(t.deps.fetch).not.toHaveBeenCalled();
  });
});

describe('the notice in the popup and Options', () => {
  beforeEach(() => {
    fakeBrowser.reset();
    document.body.innerHTML = '';
    vi.spyOn(fakeBrowser.runtime, 'getManifest').mockReturnValue({ manifest_version: 3, name: 'XMRadar', version: '0.6.0.6' });
  });
  const current = () => '0.6.0.6';

  it('shows only a version newer than this copy, while the check is on', async () => {
    await updateStateItem.setValue({ attemptAt: 1, latest: '999.0.0', notified: null });
    expect(await heldUpdate(current())).toBe('999.0.0');
    await settingsItem.setValue({ ...(await settingsItem.getValue()), updateCheck: false });
    expect(await heldUpdate(current())).toBeNull();
    await settingsItem.setValue({ ...(await settingsItem.getValue()), updateCheck: true });
    await updateStateItem.setValue({ attemptAt: 1, latest: '0.0.1', notified: null });
    expect(await heldUpdate(current())).toBeNull();
  });

  it('popup: a button that opens the release page, hidden without an update', async () => {
    document.body.innerHTML = '<button id="update" class="hidden"><span class="row-title"></span></button>';
    const btn = document.querySelector<HTMLButtonElement>('#update')!;
    const open = vi.fn();
    mountPopupUpdate(btn, open);
    await vi.waitFor(() => expect(btn.classList.contains('hidden')).toBe(true));
    await updateStateItem.setValue({ attemptAt: 1, latest: '999.0.0', notified: null });
    await vi.waitFor(() => expect(btn.classList.contains('hidden')).toBe(false));
    expect(btn.textContent).toBe('XMRadar 999.0.0 is out');
    btn.click();
    expect(open).toHaveBeenCalledWith('https://github.com/KYC-rip/xmradar/releases/tag/v999.0.0');
  });

  it('Options: the switch saves, and the links follow the answer', async () => {
    const html = readFileSync(join(process.cwd(), 'src/entrypoints/options/index.html'), 'utf8');
    document.body.innerHTML = new DOMParser().parseFromString(html, 'text/html').body.innerHTML;
    await mountUpdatePanel(document);
    const sw = document.querySelector<HTMLInputElement>('#update-check')!;
    const links = [...document.querySelectorAll<HTMLAnchorElement>('[data-update-link]')];
    expect(links).toHaveLength(2);
    expect(sw.checked).toBe(true);
    await updateStateItem.setValue({ attemptAt: 1, latest: '999.0.0', notified: null });
    await vi.waitFor(() => expect(links.every((a) => !a.classList.contains('hidden'))).toBe(true));
    expect(links[0]!.href).toBe('https://github.com/KYC-rip/xmradar/releases/tag/v999.0.0');
    expect(document.querySelector('#nav-update')!.textContent).toBe('new');
    sw.checked = false;
    sw.dispatchEvent(new Event('change'));
    await vi.waitFor(async () => expect((await settingsItem.getValue()).updateCheck).toBe(false));
    await vi.waitFor(() => expect(links.every((a) => a.classList.contains('hidden'))).toBe(true));
    expect(links[0]!.hasAttribute('href')).toBe(false);
  });
});

describe('xmradar.app/latest.json (site/build.py)', () => {
  const run = (tag: string, version: string) =>
    execFileSync(
      'python3',
      [
        '-I',
        '-c',
        "import importlib.util,sys\nspec=importlib.util.spec_from_file_location('b',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)\nsys.stdout.write(m.latest_json(sys.argv[2],sys.argv[3]))",
        join(process.cwd(), 'site/build.py'),
        tag,
        version,
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );

  it('names the version and tag the extension checks, and no URL', () => {
    const out = run('v0.6.1', '0.6.1.7');
    expect(JSON.parse(out)).toEqual({ version: '0.6.1', tag: 'v0.6.1', build: '0.6.1.7' });
    expect(readLatest(JSON.parse(out))).toBe('0.6.1');
  });
  it('refuses a tag that is not the zip version', () => {
    expect(() => run('v0.6.2', '0.6.1.7')).toThrow();
  });
  it('is written next to the page, with the headers left as they were', () => {
    const build = readFileSync(join(process.cwd(), 'site/build.py'), 'utf8');
    expect(build).toContain("(out / 'latest.json').write_text(latest)");
    expect(build.slice(build.indexOf('HEADERS = '), build.indexOf('"""\n', build.indexOf('HEADERS = ') + 14))).not.toContain('latest');
  });
});
