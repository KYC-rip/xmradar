import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { storage } from 'wxt/utils/storage';
import { burnerInboxItem } from '../src/burner/service';
import { badgeSummary, statusFor } from '../src/identity/status';
import { doneCount, identitySteps } from '../src/identity/steps';
import type { SetupStatus } from '../src/messaging';
import { patchSettings, settingsItem, xmrSettingsItem } from '../src/settings';
import { validateMoneroAddress } from '../src/xmr/address';
import { mountBurnerPanel } from '../src/ui/burner-panel';
import { splitLine } from '../src/ui/identity-status';
import { mountBlossomField, mountRelayEditor } from '../src/ui/posting-fields';
import { mountSections } from '../src/ui/sections';
import { mountXmrToggles } from '../src/ui/xmr-toggles';

const send = vi.hoisted(() => vi.fn());
vi.mock('../src/messaging', async (orig) => ({ ...(await orig<typeof import('../src/messaging')>()), sendToBackground: send }));

const ADDR = '82xJWoLaM57aawFTuB2FbCAGrYQUgmfc6R9Rew7pYsouewT4aC3PUg1HMoniCVDRHANsJR7hkrBj6cfxaf3AFECtPsKZcjk';
const BIO = '89fM69NVioz94JQrJFLGPDa8PMpjea7TV8JQktbLBLpX9gKMfrt3dge7KMdqg86coZjCxCm3fn1WKdM8WBMJhEdaUimo8Q3';
const verified = { status: 'verified', via: 'oembed' } as const;
const status = (over: Partial<SetupStatus> = {}): SetupStatus => ({ pubkey: 'pk', relays: ['wss://a'], unreadable: [], address: null, link: null, xmrbio: null, ...over });
const withAddress = (a = ADDR) => ({ address: { address: a, check: validateMoneroAddress(a) } });
const linked = { link: { handle: 'xbtoshi', tweetUrl: 'https://x.com/xbtoshi/status/1', proof: verified } };
const page = (name: string) => readFileSync(join(__dirname, `../src/entrypoints/${name}/index.html`), 'utf8').replace(/^[\s\S]*<body>|<\/body>[\s\S]*$/g, '').replace(/<script[\s\S]*?<\/script>/g, '');

beforeEach(() => {
  fakeBrowser.reset();
  send.mockReset();
  document.body.innerHTML = '';
  location.hash = '';
});

describe('xmrSettings v2 migration', () => {
  it('splits the old badges switch into X and Nostr and turns tip receipts on', async () => {
    await storage.setItem('sync:xmrSettings', { badges: false, nostrDiscovery: true });
    await xmrSettingsItem.migrate();
    expect(await xmrSettingsItem.getValue()).toEqual({ badgesX: false, badgesNostr: false, nostrDiscovery: true, tipReceipts: true });
  });
  it('a fresh install gets the fallback', async () => {
    expect(await xmrSettingsItem.getValue()).toEqual({ badgesX: true, badgesNostr: true, nostrDiscovery: false, tipReceipts: true });
  });
});

describe('identitySteps', () => {
  const states = (i: Parameters<typeof identitySteps>[0]) => identitySteps(i).map((s) => `${s.key}:${s.state}${s.unchecked ? '?' : ''}${s.warning ? '!' : ''}`);

  it('nothing set up: signer is next', () => {
    expect(states({ npub: null, handle: null, status: null })).toEqual(['signer:current', 'handle:todo', 'address:todo?', 'link:todo?']);
  });
  it('no status check yet: steps 3 and 4 are unchecked, not guessed', () => {
    expect(states({ npub: 'npub1x', handle: 'xbtoshi', status: null })).toEqual(['signer:done', 'handle:done', 'address:current?', 'link:todo?']);
  });
  it('address published, X not linked (the owner a day ago): 3/4', () => {
    const steps = identitySteps({ npub: 'npub1xyz', handle: 'xbtoshi', status: status(withAddress()) });
    expect(steps.map((s) => s.state)).toEqual(['done', 'done', 'done', 'current']);
    expect(steps[2]!.value).toBe(`${ADDR.slice(0, 10)}…${ADDR.slice(-8)}`);
    expect(doneCount(steps)).toBe(3);
  });
  it('all four done', () => {
    const steps = identitySteps({ npub: 'npub1xyz', handle: 'xbtoshi', status: status({ ...withAddress(), ...linked }) });
    expect(steps.map((s) => s.state)).toEqual(['done', 'done', 'done', 'done']);
    expect(steps[3]!.value).toBe('@xbtoshi');
  });
  it('an invalid published address and a failing proof are current, with the reason', () => {
    const bad = { address: { address: 'nope', check: validateMoneroAddress('nope') } };
    const failing = { link: { handle: 'xbtoshi', tweetUrl: 'u', proof: { status: 'failed', reason: 'tweet not found' } as const } };
    const steps = identitySteps({ npub: 'n', handle: 'h', status: status({ ...bad, ...failing }) });
    expect(steps.map((s) => s.state)).toEqual(['done', 'done', 'current', 'todo']);
    expect(steps[2]!.warning).toMatch(/invalid/);
    expect(steps[3]!.warning).toBe('The proof tweet fails (tweet not found).');
  });
  it('unreadable relays alone change nothing', () => {
    const a = states({ npub: 'n', handle: 'h', status: status(withAddress()) });
    expect(states({ npub: 'n', handle: 'h', status: status({ ...withAddress(), unreadable: ['wss://x'] }) })).toEqual(a);
  });
});

describe('badgeSummary and statusFor', () => {
  const bio = { xmrbio: { found: true, address: BIO, check: validateMoneroAddress(BIO), linked: true } as const };
  it('the owner: Nostr live and xmr.bio verified', () => {
    expect(badgeSummary(status({ ...withAddress(), ...linked, ...bio }))).toBe('Live on Nostr · xmr.bio verified');
  });
  it('address only, nothing, not checked', () => {
    expect(badgeSummary(status(withAddress()))).toBe('Address on Nostr · X needs the proof tweet');
    expect(badgeSummary(status())).toBe('Not set up yet');
    expect(badgeSummary(null)).toBe('Not checked yet');
  });
  it('a check made with another signer key is ignored', () => {
    const stored = { at: 1, status: status() };
    expect(statusFor(stored, 'pk')).toBe(stored);
    expect(statusFor(stored, 'other')).toBeNull();
    expect(statusFor(stored, null)).toBeNull();
  });
});

describe('relay editor', () => {
  const mount = async () => {
    document.body.innerHTML = `<div id="r"><div data-relays="chips"></div><input data-relays="input"/><span data-relays="error"></span><span data-relays="saved"></span></div>`;
    const ed = mountRelayEditor(document.getElementById('r')!);
    await ed.ready;
    return ed;
  };
  const input = () => document.querySelector<HTMLInputElement>('[data-relays="input"]')!;
  const chips = () => [...document.querySelectorAll('.chip')].map((c) => c.firstChild!.textContent);
  const enter = () => input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));

  it('adds on Enter and on blur, ignores duplicates, removes with ×', async () => {
    await mount();
    input().value = 'wss://nos.lol';
    enter();
    await vi.waitFor(async () => expect((await settingsItem.getValue()).relays).toEqual(['wss://nos.lol']));
    expect(input().value).toBe('');
    input().value = 'wss://relay.damus.io/';
    input().dispatchEvent(new Event('blur'));
    await vi.waitFor(async () => expect((await settingsItem.getValue()).relays).toEqual(['wss://nos.lol', 'wss://relay.damus.io']));
    input().value = 'wss://nos.lol';
    enter();
    await vi.waitFor(() => expect(input().value).toBe(''));
    expect(chips()).toEqual(['wss://nos.lol', 'wss://relay.damus.io']);
    document.querySelector<HTMLButtonElement>('[aria-label="Remove wss://nos.lol"]')!.click();
    await vi.waitFor(async () => expect((await settingsItem.getValue()).relays).toEqual(['wss://relay.damus.io']));
  });

  it('invalid input stays in the field with an error and saves nothing', async () => {
    await mount();
    for (const bad of ['https://nos.lol', 'ws://relay.example', 'wss://a wss://b']) {
      input().value = bad;
      enter();
      await vi.waitFor(() => expect(document.querySelector('[data-relays="error"]')!.textContent).toMatch(/wss:\/\//));
      expect(input().value).toBe(bad);
      expect(input().getAttribute('aria-invalid')).toBe('true');
    }
    expect((await settingsItem.getValue()).relays).toEqual([]);
    input().dispatchEvent(new Event('input'));
    expect(document.querySelector('[data-relays="error"]')!.textContent).toBe('');
  });

  it('replace (NIP-65) swaps the list and saves', async () => {
    const ed = await mount();
    await ed.replace(['wss://a.example', 'wss://b.example']);
    expect((await settingsItem.getValue()).relays).toEqual(['wss://a.example', 'wss://b.example']);
    expect(chips()).toEqual(['wss://a.example', 'wss://b.example']);
  });

  it('replace clears a rejected entry left in the input', async () => {
    const ed = await mount();
    input().value = 'https://nos.lol';
    enter();
    await vi.waitFor(() => expect(input().getAttribute('aria-invalid')).toBe('true'));
    await ed.replace(['wss://a.example']);
    expect(input().value).toBe('');
    expect(input().hasAttribute('aria-invalid')).toBe(false);
  });

  it('a failed remove puts the chip back and shows the error', async () => {
    const ed = await mount();
    await ed.replace(['wss://a.example']);
    const spy = vi.spyOn(settingsItem, 'setValue').mockRejectedValueOnce(new Error('quota'));
    document.querySelector<HTMLButtonElement>('[aria-label="Remove wss://a.example"]')!.click();
    await vi.waitFor(() => expect(document.querySelector('[data-relays="error"]')!.textContent).toMatch(/quota/));
    expect(chips()).toEqual(['wss://a.example']);
    expect((await settingsItem.getValue()).relays).toEqual(['wss://a.example']);
    spy.mockRestore();
  });
});

describe('Blossom field', () => {
  it('saves a valid https URL on blur and keeps the old value for an invalid one', async () => {
    document.body.innerHTML = `<div id="f"><input data-blossom="input"/><span data-blossom="error"></span><span data-blossom="saved"></span></div>`;
    await mountBlossomField(document.getElementById('f')!);
    const el = document.querySelector<HTMLInputElement>('[data-blossom="input"]')!;
    expect(el.value).toBe('https://blossom.primal.net');
    el.value = 'https://cdn.example/';
    el.dispatchEvent(new Event('blur'));
    await vi.waitFor(async () => expect((await settingsItem.getValue()).blossomServer).toBe('https://cdn.example'));
    el.value = 'http://cdn.example';
    el.dispatchEvent(new Event('blur'));
    await vi.waitFor(() => expect(document.querySelector('[data-blossom="error"]')!.textContent).toMatch(/https/));
    expect((await settingsItem.getValue()).blossomServer).toBe('https://cdn.example');
  });
});

describe('options sections', () => {
  const setup = () => {
    document.body.innerHTML = `
      <a data-nav="posting" href="#posting"></a><a data-nav="identity" href="#identity"></a><a data-nav="burner" href="#burner"></a>
      <section data-section="posting"></section><section data-section="identity"></section><section data-section="burner"></section>`;
  };
  const visible = () => [...document.querySelectorAll<HTMLElement>('[data-section]')].filter((s) => !s.hidden).map((s) => s.dataset.section);

  it('the hash picks the section and the nav item; unknown → posting', () => {
    setup();
    location.hash = '#identity';
    expect(mountSections(document)).toBe('identity');
    expect(visible()).toEqual(['identity']);
    expect(document.querySelector('[data-nav="identity"]')!.getAttribute('aria-current')).toBe('page');
    expect(document.querySelector('[data-nav="posting"]')!.hasAttribute('aria-current')).toBe(false);
    setup();
    location.hash = '#nope';
    expect(mountSections(document)).toBe('posting');
  });
});

describe('page markup', () => {
  it('the popup burner card mounts, free and imported (Burn, Forget inside the panel root)', async () => {
    document.body.innerHTML = page('popup');
    await burnerInboxItem.setValue({ email: 'a@ros.rip', expiresAt: Date.now() + 3_600_000, tier: 'FREE', source: 'free', lastSeenIds: [], watchUntil: 0 });
    const panel = mountBurnerPanel(document.getElementById('burner')!);
    await panel.ready;
    const q = (n: string) => document.querySelector<HTMLElement>(`#burner [data-burner="${n}"]`)!;
    expect([q('burn').classList.contains('hidden'), q('forget').classList.contains('hidden')]).toEqual([false, true]);
    await burnerInboxItem.setValue({ email: 'b@vigilbox.xyz', expiresAt: Date.now() + 3_600_000, tier: 'PRO', source: 'imported', lastSeenIds: [], watchUntil: 0 });
    await vi.waitFor(() => expect(q('forget').classList.contains('hidden')).toBe(false));
    expect(q('burn').classList.contains('hidden')).toBe(true);
    expect(q('meta').textContent).toMatch(/^Imported, PRO/);
    panel.stop();
  });

  it('the options burner section mounts with its import card', async () => {
    document.body.innerHTML = page('options');
    const panel = mountBurnerPanel(document.getElementById('burner')!);
    await panel.ready;
    panel.stop();
  });

  it('the inline logo has no script, link or external reference', () => {
    for (const name of ['popup', 'options']) {
      const svg = /<svg[\s\S]*?<\/svg>/.exec(page(name))![0];
      expect(svg).not.toMatch(/<script|href|foreignObject|http/i);
    }
  });
});

describe('theme', () => {
  const css = (dir: string): string[] =>
    readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      return statSync(p).isDirectory() ? css(p) : f.endsWith('.css') && !p.includes('/content/') ? [p] : [];
    });

  it('colours live only in the token blocks of base.css', () => {
    for (const file of css(join(__dirname, '../src'))) {
      let text = readFileSync(file, 'utf8');
      if (file.endsWith('ui/base.css')) text = text.replace(/:root\s*\{[^}]*\}/g, '');
      expect(text.match(/#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?)\(/gi) ?? [], file).toEqual([]);
    }
  });
  it('no font is fetched from the network', () => {
    for (const file of css(join(__dirname, '../src'))) expect(readFileSync(file, 'utf8'), file).not.toMatch(/fonts\.googleapis|https?:\/\//);
  });
});

describe('status rows', () => {
  it('splits label and value', () => {
    expect(splitLine('xmr.bio: @x verified')).toEqual(['xmr.bio', '@x verified']);
    expect(splitLine('Read 4 relays.')).toEqual(['Relays', 'Read 4 relays.']);
    expect(splitLine('Your xmr.bio and Nostr addresses differ.')).toEqual(['Note', 'Your xmr.bio and Nostr addresses differ.']);
  });
});

describe('patchSettings', () => {
  it('keeps both of two autosaves made at once', async () => {
    await Promise.all([patchSettings({ debug: true }), patchSettings({ relays: ['wss://a.example'] }), patchSettings({ appendSourceLink: true })]);
    expect(await settingsItem.getValue()).toMatchObject({ debug: true, relays: ['wss://a.example'], appendSourceLink: true });
  });
});

describe('popup switches', () => {
  it('two quick changes both stick', async () => {
    document.body.innerHTML = '<div id="t"><input type="checkbox" data-xmr="badges"/><input type="checkbox" data-xmr="discovery"/></div>';
    await mountXmrToggles(document.getElementById('t')!);
    document.querySelector<HTMLInputElement>('[data-xmr="badges"]')!.click();
    document.querySelector<HTMLInputElement>('[data-xmr="discovery"]')!.click();
    await vi.waitFor(async () => expect(await xmrSettingsItem.getValue()).toMatchObject({ badgesX: false, nostrDiscovery: true }));
  });
});
