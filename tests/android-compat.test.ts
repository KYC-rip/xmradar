import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { storage } from 'wxt/utils/storage';
import { browser } from 'wxt/browser';
import {
  closeCurrentPage,
  openExtensionPage,
  resolveActiveSiteTabId,
  safeAlarms,
  safeClearNotice,
  safeNotify,
  safeOnNotificationClicked,
  safePermissionsContains,
  safePermissionsRequest,
} from '../src/platform/compat';
import { createMemoryStorageArea, installStorageFallback, type StorageNamespaceLike } from '../src/platform/storage-compat';
import { isXTopFrameSender } from '../src/sender';
import { siwmService, type SiwmStore } from '../src/siwm/service';
import { setGlobalBadge, setTabBadge } from '../src/update/badge';
import { NoSignerError } from '../src/identity/signer-mode';
import {
  ANDROID_NATIVE_APP,
  BackgroundPermissionMissingError,
  nativeGetPublicKey,
  nativeSignEvent,
  probeAndroidSigner,
  resetAndroidSignerProbeCache,
} from '../src/nostr/native-signer';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';

describe('Android / GeckoView compatibility helpers', () => {
  it('openExtensionPage uses popup window on desktop and falls back to tab on Android', async () => {
    const winCreate = vi.fn(async () => ({ id: 77 }));
    const tabCreate = vi.fn(async () => ({ id: 99 }));
    expect(await openExtensionPage('moz-extension://x/siwm.html', { windows: { create: winCreate }, tabs: { create: tabCreate } })).toEqual({
      kind: 'window',
      id: 77,
    });
    expect(tabCreate).not.toHaveBeenCalled();

    // Android: windows undefined
    expect(await openExtensionPage('moz-extension://x/siwm.html', { tabs: { create: tabCreate } })).toEqual({
      kind: 'tab',
      id: 99,
    });

    // Partial windows stub that rejects popup creation
    const rejectingWin = vi.fn(async () => Promise.reject(new Error('unsupported')));
    expect(await openExtensionPage('moz-extension://x/siwm.html', { windows: { create: rejectingWin }, tabs: { create: tabCreate } })).toEqual({
      kind: 'tab',
      id: 99,
    });
  });

  it('closeCurrentPage removes own tab on Android and falls back to window.close() on desktop popups', async () => {
    const remove = vi.fn(async () => {});
    const closeWindow = vi.fn();
    await closeCurrentPage({ tabs: { getCurrent: async () => ({ id: 12 }), remove }, closeWindow });
    expect(remove).toHaveBeenCalledWith(12);
    expect(closeWindow).not.toHaveBeenCalled();

    await closeCurrentPage({ tabs: { getCurrent: async () => undefined, remove }, closeWindow });
    expect(closeWindow).toHaveBeenCalledTimes(1);
  });

  it('resolveActiveSiteTabId honors explicit ?tabId=, active site tab, or falls back from popup tab', async () => {
    expect(await resolveActiveSiteTabId(undefined, '?tabId=42', 'moz-extension://abc/')).toBe(42);
    expect(await resolveActiveSiteTabId(undefined, '?tabId=evil', 'moz-extension://abc/')).toBeNull();

    const desktopTabs = { query: vi.fn(async () => [{ id: 5, url: 'https://x.com/home', active: true }]) };
    expect(await resolveActiveSiteTabId(desktopTabs, '', 'moz-extension://abc/')).toBe(5);

    const androidTabs = {
      query: vi.fn(async (q: { active?: boolean; currentWindow?: boolean }) =>
        q.active
          ? [{ id: 10, url: 'moz-extension://abc/popup.html', active: true }]
          : [
              { id: 10, url: 'moz-extension://abc/popup.html', active: true },
              { id: 3, url: 'https://x.com/home', active: false },
              { id: 7, url: 'https://trocador.app/en', active: false },
            ],
      ),
    };
    expect(await resolveActiveSiteTabId(androidTabs, '', 'moz-extension://abc/')).toBe(3);
    expect(await resolveActiveSiteTabId(androidTabs, '?siteUrl=https%3A%2F%2Ftrocador.app%2Fen', 'moz-extension://abc/')).toBe(7);
    expect(await resolveActiveSiteTabId(androidTabs, '?siteUrl=https%3A%2F%2Ftrocador.app%2Fother', 'moz-extension://abc/')).toBe(7);
  });

  it('siwmService tracks and cleans up tab-backed consent pages on tabClosed', async () => {
    let store: SiwmStore = {};
    const svc = siwmService({
      store: { getValue: async () => store, setValue: async (v) => void (store = v) },
      now: () => 1_700_000_000_000,
      randomId: () => 'id-tab-1',
      openWindow: async () => ({ kind: 'tab', id: 88 }),
      post: async () => ({ status: 200, text: '{"ok":true}' }),
    });
    const { id } = await svc.open('monero-signin:bad', 'xmr.bio');
    expect(store[id]?.tabId).toBe(88);
    await svc.tabClosed(99);
    expect(store[id]).toBeDefined();
    await svc.tabClosed(88);
    expect(store[id]).toBeUndefined();
  });

  it('safeNotify, safeClearNotice, safeAlarms, safePermissions, and badges tolerate missing APIs', async () => {
    await expect(safeNotify(undefined, { title: 'x' })).resolves.toBeUndefined();
    await expect(safeNotify({ create: async () => Promise.reject(new Error('denied')) }, { title: 'x' })).resolves.toBeUndefined();
    await expect(safeClearNotice(undefined, 'a')).resolves.toBeUndefined();
    expect(() => safeOnNotificationClicked(undefined, () => {})).not.toThrow();

    const stubAlarms = safeAlarms(undefined);
    expect(() => stubAlarms.create('x', { periodInMinutes: 1 })).not.toThrow();
    expect(await stubAlarms.clear('x')).toBe(false);
    expect(await stubAlarms.get('x')).toBeUndefined();

    expect(await safePermissionsContains(undefined, { origins: ['<all_urls>'] })).toBe(false);
    expect(await safePermissionsRequest(undefined, { origins: ['<all_urls>'] })).toBe(false);

    await expect(setTabBadge(undefined, 1, { text: 'A', color: '#000' })).resolves.toBeUndefined();
    await expect(setGlobalBadge(undefined, { text: '↑', color: '#000', title: 'XMRadar' })).resolves.toBeUndefined();
    await expect(setTabBadge({}, 1, { text: 'A', color: '#000' })).resolves.toBeUndefined();
  });

  it('storage-compat works with real wxt/utils/storage when sync and session are missing', async () => {
    const realStorage = (browser as unknown as { storage?: StorageNamespaceLike }).storage;
    const localArea = createMemoryStorageArea();
    const fakeStorage: StorageNamespaceLike = { local: localArea };
    const { patchedSync, patchedSession } = installStorageFallback(fakeStorage);
    expect(patchedSync).toBe(true);
    expect(patchedSession).toBe(true);

    // Swap onto WXT's browser binding temporarily and exercise real storage.defineItem
    (browser as unknown as { storage?: StorageNamespaceLike }).storage = fakeStorage;
    try {
      const syncItem = storage.defineItem<{ n: number }>('sync:androidCompatTest', { fallback: { n: 0 } });
      const sessItem = storage.defineItem<string>('session:androidCompatSess', { fallback: '' });
      await syncItem.setValue({ n: 42 });
      expect(await syncItem.getValue()).toEqual({ n: 42 });
      // Sync fallback wrote under local with prefix (never collides with unprefixed local keys)
      const localDump = await localArea.get(null);
      expect(Object.keys(localDump).some((k) => k.startsWith('__xmradar_sync__:'))).toBe(true);

      // Session fallback stays strictly in-memory, never persisted into local storage
      await sessItem.setValue('ephemeral-token');
      expect(await sessItem.getValue()).toBe('ephemeral-token');
      const localAfter = await localArea.get(null);
      expect(JSON.stringify(localAfter)).not.toContain('ephemeral-token');
    } finally {
      (browser as unknown as { storage?: StorageNamespaceLike }).storage = realStorage;
    }

    // Frozen / read-only storage getter must never throw during import
    const readOnly = Object.defineProperty({}, 'sync', { get: () => undefined, enumerable: true }) as StorageNamespaceLike;
    Object.defineProperty(readOnly, 'local', { value: localArea, enumerable: true });
    expect(() => installStorageFallback(readOnly)).not.toThrow();
  });

  it('isXTopFrameSender rejects embedded iframes on X tabs and non-X senders', () => {
    const rt = 'xmradar@local';
    expect(isXTopFrameSender({ id: rt, frameId: 0, url: 'https://x.com/home', tab: { id: 1, url: 'https://x.com/home' } }, rt)).toBe(true);
    expect(isXTopFrameSender({ id: rt, frameId: 1, url: 'https://ads.evil.example/', tab: { id: 1, url: 'https://x.com/home' } }, rt)).toBe(false);
    expect(isXTopFrameSender({ id: rt, frameId: 1, url: 'https://x.com/embed', tab: { id: 1, url: 'https://x.com/home' } }, rt)).toBe(false);
    expect(isXTopFrameSender({ id: rt, frameId: 0, url: 'https://evil.example/', tab: { id: 1, url: 'https://x.com/home' } }, rt)).toBe(false);
    expect(isXTopFrameSender({ id: 'other', frameId: 0, url: 'https://x.com/home', tab: { id: 1, url: 'https://x.com/home' } }, rt)).toBe(false);
  });

  it('entrypoints contain no unguarded desktop-only browser namespace accesses', () => {
    const files = [
      'src/entrypoints/background.ts',
      'src/entrypoints/popup/main.ts',
      'src/entrypoints/options/main.ts',
      'src/entrypoints/sidepanel/main.ts',
      'src/entrypoints/siwm/main.ts',
    ];
    for (const rel of files) {
      const src = readFileSync(join(process.cwd(), rel), 'utf8');
      expect(src, `${rel} unguarded browser.commands.`).not.toMatch(/\bbrowser\.commands\./);
      expect(src, `${rel} unguarded browser.windows.`).not.toMatch(/\bbrowser\.windows\.(create|onRemoved|onFocusChanged)/);
      expect(src, `${rel} unguarded browser.notifications.`).not.toMatch(/\bbrowser\.notifications\.(create|clear|onClicked)/);
      expect(src, `${rel} unguarded browser.permissions.`).not.toMatch(/\bbrowser\.permissions\.(contains|request)/);
      expect(src, `${rel} unguarded browser.alarms.`).not.toMatch(/\bbrowser\.alarms\.(create|clear|onAlarm)/);
    }
  });

  it('built Firefox manifest includes gecko_android >= 140.0 and Chrome omits browser_specific_settings', () => {
    const ffPath = join(process.cwd(), 'output/firefox-mv3/manifest.json');
    const crPath = join(process.cwd(), 'output/chrome-mv3/manifest.json');
    if (!existsSync(ffPath) || !existsSync(crPath)) {
      if (process.env.XMRADAR_REQUIRE_BUILD === '1') throw new Error('Expected built manifests');
      return;
    }
    const ff = JSON.parse(readFileSync(ffPath, 'utf8'));
    const cr = JSON.parse(readFileSync(crPath, 'utf8'));
    expect(ff.browser_specific_settings?.gecko?.strict_min_version).toBe('140.0');
    expect(ff.browser_specific_settings?.gecko_android?.strict_min_version).toBe('140.0');
    expect(ff.permissions).not.toContain('geckoViewAddons');
    expect(ff.permissions).not.toContain('nativeMessaging');
    expect(ff.permissions).not.toContain('nativeMessagingFromContent');
    expect(cr.browser_specific_settings).toBeUndefined();
    expect(cr.permissions).not.toContain('geckoViewAddons');
    expect(cr.permissions).not.toContain('nativeMessaging');
    expect(cr.minimum_chrome_version).toBe('114');

    const androidAssetManifest = join(process.cwd(), 'android/app/src/main/assets/xmradar/manifest.json');
    if (existsSync(androidAssetManifest)) {
      const am = JSON.parse(readFileSync(androidAssetManifest, 'utf8'));
      expect(am.permissions).toContain('geckoViewAddons');
      expect(am.permissions).toContain('nativeMessaging');
      expect(am.permissions).not.toContain('nativeMessagingFromContent');
      expect(am.browser_specific_settings?.gecko_android?.strict_min_version).toBe('140.0');
    }
  });

  it('probeAndroidSigner short-circuits desktop via getPlatformInfo, probes live on Android, and never caches transient Android errors', async () => {
    resetAndroidSignerProbeCache();
    const desktopSend = vi.fn(async () => ({ androidApp: true }));
    expect(
      await probeAndroidSigner({
        getPlatformInfo: async () => ({ os: 'mac' }),
        sendNativeMessage: desktopSend,
      }),
    ).toEqual({ androidApp: false, nip55Available: false });
    expect(desktopSend).not.toHaveBeenCalled();

    resetAndroidSignerProbeCache();
    expect(await probeAndroidSigner({ getPlatformInfo: async () => ({ os: 'android' }) })).toEqual({
      androidApp: false,
      nip55Available: false,
    });

    resetAndroidSignerProbeCache();
    let failOnce = true;
    let installed = false;
    const sendNativeMessage = vi.fn(async (app: string, msg: object) => {
      expect(app).toBe(ANDROID_NATIVE_APP);
      expect(msg).toEqual({ type: 'probe' });
      if (failOnce) {
        failOnce = false;
        throw new Error('transient delegate reload');
      }
      return JSON.stringify({
        androidApp: true,
        nip55Available: installed,
        signerPackage: installed ? 'com.greenart7c3.nostrsigner' : null,
      });
    });
    const androidRt = { getPlatformInfo: async () => ({ os: 'android' }), sendNativeMessage };

    // Transient error on Android throws instead of poisoning cache into desktop mode
    await expect(probeAndroidSigner(androidRt)).rejects.toThrow('transient delegate reload');

    // Subsequent probe recovers cleanly
    expect(await probeAndroidSigner(androidRt)).toEqual({
      androidApp: true,
      nip55Available: false,
      signerPackage: null,
    });
    // Installing Amber takes effect on the next probe without restarting the worker
    installed = true;
    expect(await probeAndroidSigner(androidRt)).toEqual({
      androidApp: true,
      nip55Available: true,
      signerPackage: 'com.greenart7c3.nostrsigner',
    });
    expect(sendNativeMessage).toHaveBeenCalledTimes(3);
    resetAndroidSignerProbeCache();
  });

  it('nativeGetPublicKey and nativeSignEvent handle NoSignerError, refusal, quiet backgroundPermissionMissing, full event, and sig-only fallback', async () => {
    const sk = generateSecretKey();
    const pk = getPublicKey(sk);
    const template = { kind: 17, created_at: 1700000000, tags: [['i', 'twitter:123']], content: 'xo' };
    const signed = finalizeEvent(template, sk);

    // No NIP-55 app installed -> NoSignerError (triggers managed key fallback)
    await expect(
      nativeGetPublicKey({ sendNativeMessage: vi.fn(async () => ({ noSigner: true, error: 'Install Amber' })) }),
    ).rejects.toBeInstanceOf(NoSignerError);

    // User refusal -> plain Error (NOT NoSignerError, never silently replaced by managed key)
    const refusal = nativeGetPublicKey({ sendNativeMessage: vi.fn(async () => ({ error: 'Cancelled by user' })) });
    await expect(refusal).rejects.toThrow('Cancelled by user');
    await expect(refusal).rejects.not.toBeInstanceOf(NoSignerError);

    // Quiet sign passes quiet=true and surfaces BackgroundPermissionMissingError instead of popping signer UI
    const quietMock = vi.fn(async (_app: string, msg: object) => {
      expect((msg as { quiet?: boolean }).quiet).toBe(true);
      return JSON.stringify({ backgroundPermissionMissing: true, error: 'Approve in Amber' });
    });
    await expect(nativeSignEvent({ sendNativeMessage: quietMock }, template, pk, true)).rejects.toBeInstanceOf(
      BackgroundPermissionMissingError,
    );

    // Full signed event JSON returned by Amber (verifying JSON-string transport used by GeckoView EventCallback)
    const full = await nativeSignEvent(
      { sendNativeMessage: vi.fn(async () => JSON.stringify({ event: signed })) },
      template,
      pk,
    );
    expect(full.id).toBe(signed.id);
    expect(full.sig).toBe(signed.sig);

    // Signature-only fallback returned by minimal NIP-55 signers
    const reconstructed = await nativeSignEvent(
      { sendNativeMessage: vi.fn(async () => ({ sig: signed.sig })) },
      template,
      pk,
    );
    expect(reconstructed.id).toBe(signed.id);
    expect(reconstructed.sig).toBe(signed.sig);
    expect(reconstructed.pubkey).toBe(pk);
  });
});
