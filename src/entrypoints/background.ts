import { neventEncode } from 'nostr-tools/nip19';
import { verifyEvent } from 'nostr-tools/pure';
import { installBridge } from '../bridge';
import type { BgRequest, BgResponse, ImageInfo, OpenComposerMsg, Wrapped } from '../messaging';
import { uploadBlob } from '../nostr/blossom';
import { checkBlossomAuth, dedupeKey, sha256Hex } from '../nostr/event';
import { fetchWriteRelays, publishToRelays } from '../nostr/relays';
import { assertFetchableImageUrl } from '../nostr/url-guard';
import { checkSessionSender, isExtensionPageSender } from '../sender';
import { DEFAULT_RELAYS, postedItem, pubkeyItem, settingsItem } from '../settings';
import { storage } from 'wxt/utils/storage';

const MENU_ID = 'xmradar';
const SESSION_TTL_MS = 15 * 60_000;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const NIP65_TTL_MS = 60 * 60_000;

interface Session {
  id: string;
  tabId: number;
  expires: number;
}

// storage.session survives MV3 service-worker suspension, unlike module state
const sessionsItem = storage.defineItem<Session[]>('session:composerSessions', { fallback: [] });
const nip65Cache = storage.defineItem<{ pubkey: string; relays: string[]; at: number } | null>('local:nip65Cache', { fallback: null });

// image bytes between fetch-image and upload-image; refetched if the worker was suspended
const imageCache = new Map<string, { bytes: ArrayBuffer; mime: string }>();

export default defineBackground(() => {
  browser.runtime.onInstalled.addListener(async () => {
    await browser.contextMenus.removeAll();
    browser.contextMenus.create({
      id: MENU_ID,
      title: 'Copy post to Nostr',
      contexts: ['page', 'selection', 'image', 'link'],
    });
  });

  browser.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId !== MENU_ID || !tab) return;
    void openComposer(tab, info.frameId ?? 0, {
      selection: info.selectionText,
      srcUrl: info.mediaType === 'image' ? info.srcUrl : undefined,
    });
  });

  browser.commands.onCommand.addListener(async (command, tab) => {
    if (command !== 'open-composer') return;
    tab ??= (await browser.tabs.query({ active: true, currentWindow: true }))[0];
    if (tab) void openComposer(tab, 0, { fromCommand: true });
  });

  browser.runtime.onMessage.addListener((msg: BgRequest, sender, sendResponse) => {
    handle(msg, sender).then(
      (data) => sendResponse({ ok: true, data } satisfies Wrapped<unknown>),
      (err) => sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) } satisfies Wrapped<unknown>),
    );
    return true;
  });
});

function notify(message: string) {
  void browser.notifications.create({
    type: 'basic',
    iconUrl: browser.runtime.getURL('/icon/128.png'),
    title: 'XMRadar',
    message,
  });
}

async function openComposer(tab: Browser.tabs.Tab, frameId: number, extra: Omit<OpenComposerMsg, 'type' | 'sessionId'>) {
  if (tab.id == null || !/^(https?|file):/.test(tab.url ?? '')) {
    notify("This page can't be used (browser-internal page or store).");
    return;
  }
  const tabId = tab.id;
  const session: Session = { id: crypto.randomUUID(), tabId, expires: Date.now() + SESSION_TTL_MS };
  const live = (await sessionsItem.getValue()).filter((s) => s.expires > Date.now());
  await sessionsItem.setValue([...live, session]);

  try {
    // injected only now, after the user's gesture, rather than on every page load
    await browser.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, world: 'MAIN', func: installBridge });
  } catch (e) {
    await endSession(session.id);
    notify(`Could not attach to this page: ${(e as Error).message}`);
    return;
  }

  const msg: OpenComposerMsg = { type: 'open-composer', sessionId: session.id, ...extra };
  try {
    await browser.tabs.sendMessage(tabId, msg, { frameId });
  } catch {
    // content script missing: page loaded before install/reload, or frame not covered
    try {
      await browser.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, files: ['/content-scripts/content.js'] });
      await browser.tabs.sendMessage(tabId, msg, { frameId });
    } catch (e) {
      await endSession(session.id);
      notify(`Could not open the composer here: ${(e as Error).message}`);
    }
  }
}

async function endSession(id: string) {
  await sessionsItem.setValue((await sessionsItem.getValue()).filter((s) => s.id !== id && s.expires > Date.now()));
}

async function requireSession(sessionId: string, sender: Browser.runtime.MessageSender) {
  checkSessionSender(await sessionsItem.getValue(), sessionId, sender, browser.runtime.id);
}

const isExtensionPage = (sender: Browser.runtime.MessageSender) => isExtensionPageSender(sender, browser.runtime.id, browser.runtime.getURL('/'));

async function loadImage(url: string): Promise<{ bytes: ArrayBuffer; mime: string }> {
  assertFetchableImageUrl(url);
  const res = await fetch(url, { credentials: 'omit', signal: AbortSignal.timeout(20_000) });
  // redirects are followed (CDNs use them), so re-check where we actually ended up
  if (res.redirected) assertFetchableImageUrl(res.url);
  if (!res.ok) throw new Error(`Image fetch failed (${res.status})`);
  const bytes = await res.arrayBuffer();
  if (bytes.byteLength > MAX_IMAGE_BYTES) throw new Error('Image is larger than 20 MB');
  const mime = (res.headers.get('content-type') ?? 'application/octet-stream').split(';')[0]!.trim();
  if (!mime.startsWith('image/') && !mime.startsWith('video/')) throw new Error(`Not an image (${mime})`);
  return { bytes, mime };
}

async function imageDim(bytes: ArrayBuffer, mime: string): Promise<string | undefined> {
  try {
    const bmp = await createImageBitmap(new Blob([bytes], { type: mime }));
    const dim = `${bmp.width}x${bmp.height}`;
    bmp.close();
    return dim;
  } catch {
    return undefined;
  }
}

async function resolveRelays(pubkey: string): Promise<string[]> {
  const { relays } = await settingsItem.getValue();
  if (relays.length) return relays;
  const cached = await nip65Cache.getValue();
  if (cached?.pubkey === pubkey && Date.now() - cached.at < NIP65_TTL_MS && cached.relays.length) return cached.relays;
  const fromNip65 = await fetchWriteRelays(pubkey, DEFAULT_RELAYS).catch(() => []);
  if (fromNip65.length) {
    await nip65Cache.setValue({ pubkey, relays: fromNip65, at: Date.now() });
    return fromNip65;
  }
  return DEFAULT_RELAYS;
}

async function handle(msg: BgRequest, sender: Browser.runtime.MessageSender): Promise<BgResponse<BgRequest['type']>> {
  switch (msg.type) {
    case 'fetch-image': {
      await requireSession(msg.sessionId, sender);
      const { bytes, mime } = await loadImage(msg.url);
      const sha256 = await sha256Hex(bytes);
      imageCache.set(sha256, { bytes, mime });
      return { sha256, mime, size: bytes.byteLength, dim: await imageDim(bytes, mime) } satisfies ImageInfo;
    }
    case 'upload-image': {
      await requireSession(msg.sessionId, sender);
      let img = imageCache.get(msg.sha256);
      if (!img) {
        img = await loadImage(msg.url);
        if ((await sha256Hex(img.bytes)) !== msg.sha256) throw new Error('Image changed since it was hashed');
      }
      checkBlossomAuth(msg.auth, msg.sha256);
      const { blossomServer } = await settingsItem.getValue();
      const url = await uploadBlob(blossomServer, img.bytes, img.mime, msg.sha256, msg.auth);
      imageCache.delete(msg.sha256);
      return { url };
    }
    case 'publish': {
      await requireSession(msg.sessionId, sender);
      if (msg.event.kind !== 1 || !verifyEvent(msg.event)) throw new Error('Refusing to publish an invalid event');
      await pubkeyItem.setValue(msg.event.pubkey);
      const relays = await resolveRelays(msg.event.pubkey);
      const key = await dedupeKey(msg.sourceUrl, msg.text);
      const results = await publishToRelays(relays, msg.event);
      const okRelays = results.filter((r) => r.ok).map((r) => r.relay);
      if (okRelays.length) {
        const posted = await postedItem.getValue();
        await postedItem.setValue([...posted.filter((k) => k !== key), key].slice(-1000));
      }
      const nevent = neventEncode({ id: msg.event.id, author: msg.event.pubkey, relays: okRelays.slice(0, 3) });
      return { results, nevent };
    }
    case 'check-duplicate': {
      await requireSession(msg.sessionId, sender);
      return { duplicate: (await postedItem.getValue()).includes(await dedupeKey(msg.sourceUrl, msg.text)) };
    }
    case 'close-session': {
      await requireSession(msg.sessionId, sender);
      await endSession(msg.sessionId);
      return null;
    }
    case 'load-nip65': {
      if (!isExtensionPage(sender)) throw new Error('Not allowed');
      const { relays } = await settingsItem.getValue();
      const found = await fetchWriteRelays(msg.pubkey, [...new Set([...DEFAULT_RELAYS, ...relays])]);
      if (found.length) await nip65Cache.setValue({ pubkey: msg.pubkey, relays: found, at: Date.now() });
      return { relays: found };
    }
    case 'test-signer': {
      if (!isExtensionPage(sender)) throw new Error('Not allowed');
      return { pubkey: await testSigner() };
    }
  }
}

/** Extension pages have no window.nostr, so ask the signer from a real web page. */
async function testSigner(): Promise<string> {
  const tab = await browser.tabs.create({ url: 'https://example.com/', active: true });
  const tabId = tab.id!;
  try {
    await new Promise<void>((resolve, reject) => {
      const done = (err?: Error) => {
        clearTimeout(timer);
        browser.tabs.onUpdated.removeListener(listener);
        if (err) reject(err);
        else resolve();
      };
      const timer = setTimeout(() => done(new Error('Test page did not load')), 15_000);
      const listener = (id: number, info: Browser.tabs.OnUpdatedInfo) => {
        if (id === tabId && info.status === 'complete') done();
      };
      browser.tabs.onUpdated.addListener(listener);
      // the page may have finished loading before the listener was attached
      void browser.tabs.get(tabId).then((t) => t.status === 'complete' && done(), () => {});
    });
    const [res] = await browser.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: async () => {
        const w = window as unknown as { nostr?: { getPublicKey(): Promise<string> } };
        for (let i = 0; i < 30 && !w.nostr; i++) await new Promise((r) => setTimeout(r, 100));
        if (!w.nostr) return { error: 'No NIP-07 signer found (install Alby or nos2x, or unlock it)' };
        try {
          return { pubkey: await w.nostr.getPublicKey() };
        } catch (e) {
          return { error: String((e as Error)?.message ?? e) };
        }
      },
    });
    const out = res?.result as { pubkey?: string; error?: string } | undefined;
    if (!out?.pubkey) throw new Error(out?.error ?? 'Signer test failed');
    await pubkeyItem.setValue(out.pubkey);
    return out.pubkey;
  } finally {
    await browser.tabs.remove(tabId).catch(() => {});
  }
}
