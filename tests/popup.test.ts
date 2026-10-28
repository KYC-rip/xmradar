import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { burnerInboxItem } from '../src/burner/service';
import { CREATING_STALE_MS, isCreating, LAST_ERROR_MS, PING_MS, shownError, trackCreate } from '../src/burner/tracked';
import { statusLines, xmrbioLinked } from '../src/identity/status';
import type { SetupStatus } from '../src/messaging';
import { xmrSettingsItem } from '../src/settings';
import { validateMoneroAddress } from '../src/xmr/address';
import { BURN_CONFIRM_MS, mountBurnerPanel } from '../src/ui/burner-panel';
import { mountTabs } from '../src/ui/tabs';
import { mountXmrToggles } from '../src/ui/xmr-toggles';

const send = vi.hoisted(() => vi.fn());
vi.mock('../src/messaging', async (orig) => ({ ...(await orig<typeof import('../src/messaging')>()), sendToBackground: send }));

const NOSTR = '82xJWoLaM57aawFTuB2FbCAGrYQUgmfc6R9Rew7pYsouewT4aC3PUg1HMoniCVDRHANsJR7hkrBj6cfxaf3AFECtPsKZcjk';
const BIO = '89fM69NVioz94JQrJFLGPDa8PMpjea7TV8JQktbLBLpX9gKMfrt3dge7KMdqg86coZjCxCm3fn1WKdM8WBMJhEdaUimo8Q3';
const ok = validateMoneroAddress(NOSTR);

const status = (over: Partial<SetupStatus> = {}): SetupStatus => ({
  pubkey: 'pk',
  relays: ['wss://a', 'wss://b'],
  unreadable: [],
  address: null,
  link: null,
  xmrbio: null,
  ...over,
});

beforeEach(() => {
  fakeBrowser.reset();
  send.mockReset();
  document.body.innerHTML = '';
});
afterEach(() => vi.useRealTimers());

describe('statusLines', () => {
  const texts = (s: SetupStatus, h: string | null = 'xbtoshi') => statusLines(s, h).map((l) => `${l.kind}|${l.text}`);

  it('shows both sources, the address mismatch and the xmr.bio badge (the reported case)', () => {
    const lines = texts(
      status({
        address: { address: NOSTR, check: ok },
        xmrbio: { found: true, address: BIO, check: ok, linked: true },
        unreadable: ['wss://nos.lol'],
      }),
    );
    expect(lines[0]).toMatch(/^ok\|Nostr address: 82xJWoLaM5…/);
    expect(lines[1]).toBe('|Nostr X link: @xbtoshi is not linked');
    expect(lines[2]).toMatch(/^ok\|xmr\.bio: @xbtoshi verified, 89fM69NVio….*linked to this key$/);
    expect(lines[3]).toMatch(/^warn\|Your xmr\.bio and Nostr addresses differ/);
    expect(lines[4]).toMatch(/^ok\|Badge: from xmr\.bio/);
    expect(lines.at(-1)).toBe("warn|Read 2 relays; couldn't read wss://nos.lol.");
  });

  it('a Nostr-only identity is live for discovery users', () => {
    const lines = texts(
      status({
        address: { address: NOSTR, check: ok },
        link: { handle: 'xbtoshi', tweetUrl: 'u', proof: { status: 'verified', via: 'oembed' } },
        xmrbio: { found: false },
      }),
    );
    expect(lines).toContain('ok|Nostr X link: @xbtoshi');
    expect(lines).toContain("|xmr.bio: @xbtoshi isn't verified there");
    expect(lines).toContain('ok|Badge: live for XMRadar users with Nostr discovery on.');
    expect(lines.some((l) => l.includes('differ'))).toBe(false);
  });

  it('no handle, no address: nothing claims a badge', () => {
    const lines = texts(status(), null);
    expect(lines).toContain('|Nostr X link: confirm your handle first');
    expect(lines.some((l) => l.includes('xmr.bio:'))).toBe(false);
    expect(lines).toContain('|Badge: not yet. Publish an address and link your X account here, or verify on xmr.bio.');
    expect(lines.at(-1)).toBe('|Read 2 relays.');
  });

  it('an xmr.bio error is a warning, not a missing profile', () => {
    expect(texts(status({ xmrbio: { found: 'error', reason: 'xmr.bio lookup failed (502)' } }))).toContain("warn|xmr.bio: couldn't check (xmr.bio lookup failed (502))");
  });
});

describe('trackCreate', () => {
  const slot = <T>() => {
    const values: (T | null)[] = [];
    return { values, setValue: async (v: T | null) => void values.push(v) };
  };

  it('pings at once and every 10 s, and marks creating until done', async () => {
    vi.useFakeTimers();
    const creating = slot<{ startedAt: number }>();
    const lastError = slot<{ message: string; at: number }>();
    const ping = vi.fn();
    let finish!: (v: string) => void;
    const p = trackCreate(() => new Promise<string>((r) => (finish = r)), { creating, lastError, ping, now: () => 5 });
    expect(ping).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(PING_MS * 3);
    expect(ping).toHaveBeenCalledTimes(4);
    expect(creating.values).toEqual([{ startedAt: 5 }]);
    finish('ok');
    await expect(p).resolves.toBe('ok');
    expect(creating.values.at(-1)).toBeNull();
    expect(lastError.values).toEqual([null]);
    await vi.advanceTimersByTimeAsync(PING_MS * 3);
    expect(ping).toHaveBeenCalledTimes(4);
  });

  it('stores a failure and stops pinging', async () => {
    vi.useFakeTimers();
    const creating = slot<{ startedAt: number }>();
    const lastError = slot<{ message: string; at: number }>();
    const ping = vi.fn(() => Promise.reject(new Error('gone')));
    await expect(trackCreate(() => Promise.reject(new Error('limited')), { creating, lastError, ping, now: () => 9 })).rejects.toThrow('limited');
    expect(lastError.values.at(-1)).toEqual({ message: 'limited', at: 9 });
    expect(creating.values.at(-1)).toBeNull();
    await vi.advanceTimersByTimeAsync(PING_MS * 2);
    expect(ping).toHaveBeenCalledTimes(1);
  });

  it('refuses a second create without touching the stored state', async () => {
    const creating = slot<{ startedAt: number }>();
    const lastError = slot<{ message: string; at: number }>();
    let finish!: () => void;
    const first = trackCreate(() => new Promise<void>((r) => (finish = r)), { creating, lastError, ping: () => {} });
    await Promise.resolve();
    const before = [creating.values.length, lastError.values.length];
    await expect(trackCreate(async () => {}, { creating, lastError, ping: () => {} })).rejects.toThrow(/Busy/);
    expect([creating.values.length, lastError.values.length]).toEqual(before);
    finish();
    await first;
  });

  it('stale marks and old errors stop showing', () => {
    expect(isCreating({ startedAt: 0 }, CREATING_STALE_MS - 1)).toBe(true);
    expect(isCreating({ startedAt: 0 }, CREATING_STALE_MS)).toBe(false);
    expect(shownError({ message: 'x', at: 0 }, LAST_ERROR_MS - 1)).toBe('x');
    expect(shownError({ message: 'x', at: 0 }, LAST_ERROR_MS)).toBeNull();
  });
});

const BURNER_HTML = (withImport: boolean) => `
  <div id="b">
    <code data-burner="email"></code><button data-burner="copy"></button><div data-burner="meta"></div>
    <button data-burner="create"></button><button data-burner="burn">Burn now</button><button data-burner="forget"></button>
    ${withImport ? '<details data-burner="import-box"><input data-burner="import-email"/><input data-burner="import-token"/><button data-burner="import"></button></details>' : ''}
    <span data-burner="status"></span>
  </div>`;

describe('burner panel', () => {
  const mount = async (withImport: boolean) => {
    document.body.innerHTML = BURNER_HTML(withImport);
    const panel = mountBurnerPanel(document.getElementById('b')!);
    await panel.ready;
    return panel;
  };
  const q = (name: string) => document.querySelector<HTMLElement>(`[data-burner="${name}"]`)!;

  it('mounts without the import form (popup) and with it (options)', async () => {
    (await mount(false)).stop();
    expect(q('email').textContent).toBe('none');
    (await mount(true)).stop();
    expect(q('import-box').classList.contains('hidden')).toBe(false);
  });

  it('a missing required element is named', () => {
    document.body.innerHTML = '<div id="b"><code data-burner="email"></code></div>';
    expect(() => mountBurnerPanel(document.getElementById('b')!)).toThrow('[data-burner="copy"]');
  });

  it('burns only on the second click, and the first click wears off', async () => {
    vi.useFakeTimers();
    await burnerInboxItem.setValue({ email: 'a@ros.rip', expiresAt: Date.now() + 3_600_000, tier: 'FREE', source: 'free', lastSeenIds: [], watchUntil: 0 });
    const panel = await mount(false);
    send.mockResolvedValue({ burned: true });
    q('burn').click();
    expect(send).not.toHaveBeenCalled();
    expect(q('burn').textContent).toBe('Confirm burn');
    await vi.advanceTimersByTimeAsync(BURN_CONFIRM_MS);
    expect(q('burn').textContent).toBe('Burn now');
    q('burn').click();
    q('burn').click();
    await vi.advanceTimersByTimeAsync(0);
    expect(send).toHaveBeenCalledWith({ type: 'burner-burn' });
    expect(q('status').textContent).toBe('Burned');
    panel.stop();
  });

  it('shows a create that a closed popup started, and its failure', async () => {
    const { burnerCreatingItem, burnerLastErrorItem } = await import('../src/burner/service');
    await burnerCreatingItem.setValue({ startedAt: Date.now() });
    const panel = await mount(false);
    expect(q('status').textContent).toBe('Getting an address…');
    expect((q('create') as HTMLButtonElement).disabled).toBe(true);
    await burnerCreatingItem.setValue(null);
    await burnerLastErrorItem.setValue({ message: 'Your network already has a free address', at: Date.now() });
    await vi.waitFor(() => expect(q('status').textContent).toBe('Last attempt failed: Your network already has a free address'));
    expect((q('create') as HTMLButtonElement).disabled).toBe(false);
    panel.stop();
  });
});

describe('xmr toggles', () => {
  it('saves on change and follows storage', async () => {
    document.body.innerHTML = '<div id="t"><input type="checkbox" data-xmr="badges"/><input type="checkbox" data-xmr="discovery"/><input type="checkbox" data-xmr="receipts"/></div>';
    await mountXmrToggles(document.getElementById('t')!);
    const badges = document.querySelector<HTMLInputElement>('[data-xmr="badges"]')!;
    const discovery = document.querySelector<HTMLInputElement>('[data-xmr="discovery"]')!;
    expect([badges.checked, discovery.checked]).toEqual([true, false]);
    discovery.click();
    await vi.waitFor(async () => expect(await xmrSettingsItem.getValue()).toEqual({ badgesX: true, badgesNostr: true, nostrDiscovery: true, tipReceipts: true, badgeIcon: 'mono', badgeLabel: true }));
    await xmrSettingsItem.setValue({ badgesX: false, badgesNostr: true, nostrDiscovery: true, tipReceipts: true, badgeIcon: 'mono', badgeLabel: true });
    await vi.waitFor(() => expect(badges.checked).toBe(false));
    const receipts = document.querySelector<HTMLInputElement>('[data-xmr="receipts"]')!;
    expect(receipts.checked).toBe(true);
    receipts.click();
    await vi.waitFor(async () => expect((await xmrSettingsItem.getValue()).tipReceipts).toBe(false));
  });
});

describe('tabs', () => {
  const setup = (initial: string | null) => {
    document.body.innerHTML = `
      <div role="tablist" id="l">
        <button role="tab" data-tab="monero" aria-controls="p1"></button>
        <button role="tab" data-tab="burner" aria-controls="p2"></button>
      </div><div id="p1"></div><div id="p2"></div>`;
    const shown: string[] = [];
    mountTabs(document.getElementById('l')!, initial, (n) => shown.push(n));
    return shown;
  };
  const selected = () => document.querySelector('[aria-selected="true"]')!.getAttribute('data-tab');
  const key = (k: string) => document.getElementById('l')!.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));

  it('restores the saved tab and falls back to the first for an unknown one', () => {
    expect(setup('burner')).toEqual(['burner']);
    expect(document.getElementById('p1')!.hidden).toBe(true);
    expect(document.getElementById('p2')!.hidden).toBe(false);
    expect(setup('swap')).toEqual(['monero']);
  });

  it('arrow keys, Home and End move selection, focus and tabindex', () => {
    const shown = setup(null);
    key('ArrowRight');
    expect(selected()).toBe('burner');
    expect(document.activeElement?.getAttribute('data-tab')).toBe('burner');
    expect(document.querySelector<HTMLElement>('[data-tab="monero"]')!.tabIndex).toBe(-1);
    key('ArrowRight');
    expect(selected()).toBe('monero');
    key('End');
    expect(selected()).toBe('burner');
    key('Home');
    expect(selected()).toBe('monero');
    key('ArrowLeft');
    expect(selected()).toBe('burner');
    expect(shown).toEqual(['monero', 'burner', 'monero', 'burner', 'monero', 'burner']);
  });
});

describe('xmrbioLinked', () => {
  const PK = '7dc18ff0eec577704b3b8bdf8c85e30e3c9573939d2eafe0c331dc18b378181e';
  const NPUB = 'npub10hqclu8wc4mhqjem300cep0rpc7f2uunn5h2lcxrx8wp3vmcrq0quj4fln';
  const proof = (type: string, identifier: string) => [{ type, identifier, verifiedAt: '2026-07-08 17:03:45' }];

  it('matches this key as an npub or as hex', () => {
    expect(xmrbioLinked(proof('nostr', NPUB), PK)).toBe(true);
    expect(xmrbioLinked(proof('nostr', PK.toUpperCase()), PK)).toBe(true);
  });

  it('another key, another proof type or garbage is not linked', () => {
    expect(xmrbioLinked(proof('nostr', NPUB), 'f'.repeat(64))).toBe(false);
    expect(xmrbioLinked(proof('github', NPUB), PK)).toBe(false);
    expect(xmrbioLinked(proof('nostr', 'npub1nope'), PK)).toBe(false);
    expect(xmrbioLinked([], PK)).toBe(false);
  });
});
