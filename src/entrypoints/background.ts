import { naddrEncode, neventEncode } from 'nostr-tools/nip19';
import { verifyEvent, type Event, type EventTemplate } from 'nostr-tools/pure';
import { installBridge } from '../bridge';
import { TokenBucket } from '../identity/bucket';
import { EntryCache } from '../identity/cache';
import { HANDLE_RE, normalizeHandle } from '../identity/envelope';
import { KIND_IDENTITIES, KIND_PAYTO, moneroPayto, parseTweetProof, twitterClaims, verifyTwitterProof, type ProofResult } from '../identity/nostr';
import { buildMerged, kindFor, newestOwn, setupTargets, tweetUrl, type SetupAction } from '../identity/setup';
import { validateMoneroAddress } from '../xmr/address';
import { mergeBadge, resolveHandles, withoutNostr, type Badge } from '../identity/resolve';
import { resolveXmrbio, type SeenEntries } from '../identity/xmrbio';
import { BURNER_CREATE_PORT, type BurnerCreateEvent } from '../messaging';
import type { BgRequest, BgResponse, ImageInfo, OpenComposerMsg, OpenTipMsg, PreparedSetup, ResolveHandlesResult, SetupRequest, SetupStatus, Wrapped, XmrbioResult, XmrbioStatus } from '../messaging';
import { setupStatusLast, xmrbioLinked } from '../identity/status';
import { uploadBlob } from '../nostr/blossom';
import { statusIdFromUrl } from '../extractors/x-article';
import { KIND_ARTICLE, checkBlossomAuth, checkPublishable, checkSigned, dedupeKey, sha256Hex } from '../nostr/event';
import { allRelaysFrom, fetchWriteRelays, publishToRelays, readEach } from '../nostr/relays';
import { assertFetchableImageUrl } from '../nostr/url-guard';
import { checkSessionSender, checkShareMenuSender, isExtensionPageSender, isXUrl, shareMenuRateLimit, withoutTab } from '../sender';
import { DEFAULT_RELAYS, INDEX_RELAYS, withoutIndex, myHandleItem, postedItem, pubkeyItem, settingsItem, xmrSettingsItem } from '../settings';
import { storage } from 'wxt/utils/storage';
import { activeInbox, burnerCreatingItem, burnerInboxItem, burnerLastErrorItem, burnFreeInbox, createFreeInbox, forgetImportedInbox, importInbox, type BurnerDeps } from '../burner/service';
import { idbTokenStore } from '../burner/token-store';
import { trackCreate } from '../burner/tracked';

const MENU_ID = 'xmradar';
const TIP_MENU_ID = 'xmradar-tip';
const X_PATTERNS = ['https://x.com/*', 'https://twitter.com/*', 'https://mobile.x.com/*', 'https://mobile.twitter.com/*'];
const SESSION_TTL_MS = 15 * 60_000;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const NIP65_TTL_MS = 60 * 60_000;
const BADGE_TTL_MS = 6 * 3600_000;
// a "no badge" answer may come from relays that were briefly down, so it is rechecked sooner
const NO_BADGE_TTL_MS = 3600_000;
const PROOF_OK_TTL_MS = 7 * 86400_000;
const PROOF_FAIL_TTL_MS = 86400_000;
const MAX_HANDLES_PER_CALL = 200;

interface Session {
  id: string;
  tabId: number;
  expires: number;
}

// storage.session survives MV3 service-worker suspension, unlike module state
const sessionsItem = storage.defineItem<Session[]>('session:composerSessions', { fallback: [] });
// last share-menu copy per tab, for the 2 s rate limit
const shareMenuLast = storage.defineItem<Record<number, number>>('session:shareMenuLast', { fallback: {} });
const SHARE_MENU_GAP_MS = 2000;
const resolveSeen = storage.defineItem<SeenEntries>('local:xmrbioResolveSeen', { fallback: [] });
// resolves run one at a time so concurrent lookups can't overwrite each other's replay guard entry
let resolveQueue: Promise<unknown> = Promise.resolve();
const nip65Cache = storage.defineItem<{ pubkey: string; relays: string[]; at: number } | null>('local:nip65Cache', { fallback: null });

type CacheEntries<V> = [string, { v: V; at: number }][];
const badgeCacheItem = storage.defineItem<CacheEntries<Badge>>('local:badgeCache', { fallback: [] });
const proofCacheItem = storage.defineItem<CacheEntries<ProofResult>>('local:proofCache', { fallback: [] });
let caches: Promise<{ badges: EntryCache<Badge>; proofs: EntryCache<ProofResult> }> | null = null;
let persistTimer: ReturnType<typeof setTimeout> | undefined;
// RATE-2: only relay (source B) lookups are throttled; burst 50, refill 2/s, per tab
const buckets = new Map<number, TokenBucket>();

// image bytes between fetch-image and upload-image; refetched if the worker was suspended
const imageCache = new Map<string, { bytes: ArrayBuffer; mime: string }>();

const burner: BurnerDeps = { meta: { get: () => burnerInboxItem.getValue(), set: (v) => burnerInboxItem.setValue(v) }, tokens: idbTokenStore };

export default defineBackground(() => {
  browser.runtime.onInstalled.addListener(async () => {
    await browser.contextMenus.removeAll();
    browser.contextMenus.create({
      id: MENU_ID,
      title: 'Copy post to Nostr',
      contexts: ['page', 'selection', 'image', 'link'],
    });
    browser.contextMenus.create({
      id: TIP_MENU_ID,
      title: 'Tip with Monero (look up on xmr.bio)',
      contexts: ['page', 'selection', 'image', 'link'],
      documentUrlPatterns: X_PATTERNS,
    });
  });

  browser.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId === TIP_MENU_ID && tab?.id != null) {
      const msg: OpenTipMsg = { type: 'open-tip' };
      void deliver(tab.id, info.frameId ?? 0, msg).catch((e) => notify(`Could not open the tip popup: ${(e as Error).message}`));
      return;
    }
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

  browser.tabs.onRemoved.addListener((tabId) => {
    buckets.delete(tabId);
    void shareMenuLast.getValue().then((last) => (tabId in last ? shareMenuLast.setValue(withoutTab(last, tabId)) : undefined));
  });

  // drop an inbox that expired while the worker was asleep
  void activeInbox(burner).catch(() => {});

  browser.runtime.onConnect.addListener((port) => {
    if (port.name !== BURNER_CREATE_PORT) return;
    if (!port.sender || !isExtensionPage(port.sender)) return port.disconnect();
    let open = true;
    port.onDisconnect.addListener(() => (open = false));
    const post = (m: BurnerCreateEvent) => open && port.postMessage(m);
    // the create doesn't depend on the port: a popup that closes finds the result in storage
    trackCreate(() => createFreeInbox(burner, (hashes) => post({ type: 'progress', hashes })), {
      creating: burnerCreatingItem,
      lastError: burnerLastErrorItem,
      ping: () => browser.runtime.getPlatformInfo(),
    }).then(
      (inbox) => post({ type: 'done', email: inbox.email }),
      (e) => post({ type: 'error', message: e instanceof Error ? e.message : String(e) }),
    );
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
    await deliver(tabId, frameId, msg);
  } catch (e) {
    await endSession(session.id);
    notify(`Could not open the composer here: ${(e as Error).message}`);
  }
}

async function deliver(tabId: number, frameId: number, msg: OpenComposerMsg | OpenTipMsg) {
  try {
    await browser.tabs.sendMessage(tabId, msg, { frameId });
  } catch {
    // content script missing: page loaded before install/reload, or frame not covered
    await browser.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, files: ['/content-scripts/content.js'] });
    await browser.tabs.sendMessage(tabId, msg, { frameId });
  }
}

async function endSession(id: string) {
  await sessionsItem.setValue((await sessionsItem.getValue()).filter((s) => s.id !== id && s.expires > Date.now()));
}

async function requireSession(sessionId: string, sender: Browser.runtime.MessageSender) {
  checkSessionSender(await sessionsItem.getValue(), sessionId, sender, browser.runtime.id);
}

const isExtensionPage = (sender: Browser.runtime.MessageSender) => isExtensionPageSender(sender, browser.runtime.id, browser.runtime.getURL('/'));

// the tab URL covers the popup opening inside an embedded frame on x.com
const isXContentScript = (sender: Browser.runtime.MessageSender) => sender.id === browser.runtime.id && (isXUrl(sender.url) || isXUrl(sender.tab?.url));

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
  // index relays refuse notes, so they're dropped from every source of post relays
  const relays = withoutIndex((await settingsItem.getValue()).relays);
  if (relays.length) return relays;
  const cached = await nip65Cache.getValue();
  if (cached?.pubkey === pubkey && Date.now() - cached.at < NIP65_TTL_MS && cached.relays.length) return cached.relays;
  const fromNip65 = withoutIndex(await fetchWriteRelays(pubkey, [...DEFAULT_RELAYS, ...INDEX_RELAYS]).catch(() => []));
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
      checkPublishable(msg.event, msg.sourceUrl, statusIdFromUrl);
      if (!verifyEvent(msg.event)) throw new Error('Refusing to publish an invalid event');
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
      if (msg.event.kind !== KIND_ARTICLE) return { results, nevent };
      const identifier = msg.event.tags.find((t) => t[0] === 'd')![1]!;
      return { results, nevent, naddr: naddrEncode({ kind: KIND_ARTICLE, pubkey: msg.event.pubkey, identifier, relays: okRelays.slice(0, 3) }) };
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
      const found = withoutIndex(await fetchWriteRelays(msg.pubkey, [...new Set([...DEFAULT_RELAYS, ...INDEX_RELAYS, ...relays])]));
      if (found.length) await nip65Cache.setValue({ pubkey: msg.pubkey, relays: found, at: Date.now() });
      return { relays: found };
    }
    case 'test-signer': {
      if (!isExtensionPage(sender)) throw new Error('Not allowed');
      return { pubkey: await testSigner() };
    }
    case 'share-menu-copy': {
      const tabId = checkShareMenuSender(sender, browser.runtime.id);
      // one per tab every 2 s; in session storage, so a suspended worker doesn't reset it
      const next = shareMenuRateLimit(await shareMenuLast.getValue(), tabId, Date.now(), SHARE_MENU_GAP_MS);
      if (!next) throw new Error('Too fast; try again');
      await shareMenuLast.setValue(next);
      void openComposer(sender.tab!, 0, { fromShareMenu: true });
      return null;
    }
    case 'resolve-handles': {
      if (!isXContentScript(sender) || sender.tab?.id == null) throw new Error('Not allowed');
      return resolveBadges(msg.handles, sender.tab.id);
    }
    case 'setup-status': {
      if (!isExtensionPage(sender)) throw new Error('Not allowed');
      return setupStatus();
    }
    case 'setup-prepare': {
      if (!isExtensionPage(sender)) throw new Error('Not allowed');
      return setupPrepare(msg.action);
    }
    case 'setup-sign': {
      if (!isExtensionPage(sender)) throw new Error('Not allowed');
      return setupSign(msg.id);
    }
    case 'setup-retry': {
      if (!isExtensionPage(sender)) throw new Error('Not allowed');
      return setupRetry(msg.id);
    }
    case 'setup-cancel': {
      if (!isExtensionPage(sender)) throw new Error('Not allowed');
      await setupItem.setValue(null);
      return null;
    }
    case 'xmrbio-resolve': {
      if (!isXContentScript(sender) && !isExtensionPage(sender)) throw new Error('Not allowed');
      return resolveQueued(msg.handle);
    }
    case 'burner-import': {
      if (!isExtensionPage(sender)) throw new Error('Not allowed');
      const inbox = await importInbox(burner, String(msg.email), String(msg.token));
      return { email: inbox.email };
    }
    case 'burner-burn': {
      if (!isExtensionPage(sender)) throw new Error('Not allowed');
      return burnFreeInbox(burner);
    }
    case 'burner-forget': {
      if (!isExtensionPage(sender)) throw new Error('Not allowed');
      await forgetImportedInbox(burner);
      return null;
    }
  }
}

function loadCaches() {
  caches ??= Promise.all([badgeCacheItem.getValue(), proofCacheItem.getValue()]).then(([b, p]) => ({
    badges: new EntryCache(b),
    proofs: new EntryCache(p),
  }));
  return caches;
}

function persistCaches() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(async () => {
    const { badges, proofs } = await loadCaches();
    await Promise.all([badgeCacheItem.setValue(badges.entries()), proofCacheItem.setValue(proofs.entries())]);
  }, 1000);
}

async function cachedVerify(handle: string, tweetId: string, pubkey: string): Promise<ProofResult> {
  const { proofs } = await loadCaches();
  const key = `${handle}:${tweetId}:${pubkey}`;
  const ttl = (r: ProofResult) => (r.status === 'verified' ? PROOF_OK_TTL_MS : PROOF_FAIL_TTL_MS);
  const hit = proofs.get(key, Date.now(), ttl);
  if (hit) return hit;
  const result = await verifyTwitterProof(handle, tweetId, pubkey);
  // network errors aren't cached, so the next sighting tries again
  if (result.status !== 'error') proofs.set(key, result, Date.now());
  return result;
}

async function resolveBadges(handles: string[], tabId: number): Promise<ResolveHandlesResult> {
  const { badgesX: enabled, nostrDiscovery } = await xmrSettingsItem.getValue();
  if (!enabled) return { badges: [], pending: [] };
  const valid = [...new Set(handles.filter((h) => typeof h === 'string' && HANDLE_RE.test(h)))].slice(0, MAX_HANDLES_PER_CALL);
  const { badges: cache } = await loadCaches();
  const now = Date.now();
  const out: [string, Badge][] = [];
  const misses: string[] = [];
  for (const h of valid) {
    const hit = cache.get(normalizeHandle(h), now, (b) => (b.primary ? BADGE_TTL_MS : NO_BADGE_TTL_MS));
    if (!hit) misses.push(h);
    // with discovery off, Nostr entries cached earlier must not come back
    else out.push([hit.handle, nostrDiscovery ? hit : withoutNostr(hit)]);
  }
  if (!misses.length) return { badges: out, pending: [] };
  if (!nostrDiscovery) {
    // no other passive source until the signed directory (Phase 2d)
    for (const h of misses) out.push([normalizeHandle(h), mergeBadge(h, [])]);
    return { badges: out, pending: [] };
  }
  let bucket = buckets.get(tabId);
  if (!bucket) buckets.set(tabId, (bucket = new TokenBucket(50, 2)));
  const granted = bucket.take(misses.length);
  const batch = misses.slice(0, granted);
  if (batch.length) {
    const { relays } = await settingsItem.getValue();
    const found = await resolveHandles(batch, { discovery: true, relays: [...new Set([...DEFAULT_RELAYS, ...INDEX_RELAYS, ...relays])], verify: cachedVerify });
    for (const [key, badge] of found) {
      cache.set(key, badge, Date.now());
      out.push([key, badge]);
    }
    persistCaches();
  }
  return { badges: out, pending: misses.slice(granted) };
}

/** Extension pages have no window.nostr, so signer calls run in a throwaway web page tab. */
async function withSignerTab<T>(run: (tabId: number) => Promise<T>): Promise<T> {
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
      const timer = setTimeout(() => done(new Error('Signer page did not load')), 15_000);
      const listener = (id: number, info: Browser.tabs.OnUpdatedInfo) => {
        if (id === tabId && info.status === 'complete') done();
      };
      browser.tabs.onUpdated.addListener(listener);
      // the page may have finished loading before the listener was attached
      void browser.tabs.get(tabId).then((t) => t.status === 'complete' && done(), () => {});
    });
    // the tab is visible, so make sure it's still the page we opened before running anything in it
    const now = await browser.tabs.get(tabId);
    if (!now.url?.startsWith('https://example.com/')) throw new Error('The signer tab was navigated away; try again');
    return await run(tabId);
  } finally {
    await browser.tabs.remove(tabId).catch(() => {});
  }
}

async function testSigner(): Promise<string> {
  const pubkey = await withSignerTab(async (tabId) => {
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
    return out.pubkey;
  });
  await pubkeyItem.setValue(pubkey);
  return pubkey;
}

/**
 * One-shot signing of exactly this event (PLAN-PHASE2 §4.8). It doesn't go through the page
 * bridge, whose allowlist stays {1, 24242}; the result is checked against the template.
 */
async function signExact(template: EventTemplate, pubkey: string): Promise<Event> {
  const signed = await withSignerTab(async (tabId) => {
    const [res] = await browser.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      args: [template],
      func: async (ev: EventTemplate) => {
        const w = window as unknown as { nostr?: { signEvent(e: EventTemplate): Promise<unknown> } };
        for (let i = 0; i < 30 && !w.nostr; i++) await new Promise((r) => setTimeout(r, 100));
        if (!w.nostr) return { error: 'No NIP-07 signer found (install Alby or nos2x, or unlock it)' };
        try {
          return { event: await w.nostr.signEvent(ev) };
        } catch (e) {
          return { error: String((e as Error)?.message ?? e) };
        }
      },
    });
    const out = res?.result as { event?: Event; error?: string } | undefined;
    if (!out?.event) throw new Error(out?.error ?? 'The signer did not sign');
    return out.event;
  });
  checkSigned(template, signed, pubkey);
  return signed;
}

// ---- own-account setup (Phase 2c) ----

interface PendingSetup {
  id: string;
  action: SetupAction;
  template: EventTemplate;
  pubkey: string;
  relays: string[];
  /** id of the list the change was built on, re-checked before signing */
  baseId: string | null;
  expires: number;
  signed?: Event;
  failed?: string[];
}

const setupItem = storage.defineItem<PendingSetup | null>('session:setupPending', { fallback: null });
const SETUP_TTL_MS = 10 * 60_000;

async function requirePubkey(): Promise<string> {
  const pubkey = await pubkeyItem.getValue();
  if (!pubkey) throw new Error('Connect your signer first');
  return pubkey;
}

/** Your NIP-65 relays (read and write), your manual relays, the defaults and the index relays, where badge discovery looks. */
async function setupRelays(pubkey: string): Promise<string[]> {
  const { relays } = await settingsItem.getValue();
  const lists = await readEach([...new Set([...DEFAULT_RELAYS, ...INDEX_RELAYS, ...relays])], { kinds: [10002], authors: [pubkey] }, 4000);
  const nip65 = allRelaysFrom(newestOwn(lists.events, 10002, pubkey));
  return [...new Set([...nip65, ...relays, ...DEFAULT_RELAYS, ...INDEX_RELAYS])];
}

/** One xmr.bio /resolve at a time, so the freshness guard sees responses in order. */
function resolveQueued(handle: string): Promise<XmrbioResult> {
  const run = resolveQueue.then(async () => {
    const stored = await resolveSeen.getValue();
    const { result, seen } = await resolveXmrbio(handle, Array.isArray(stored) ? stored : []);
    await resolveSeen.setValue(seen);
    return result;
  });
  resolveQueue = run.catch(() => {});
  return run;
}

/** The user's own handle on xmr.bio, for the status panel (a click, never passive). */
async function xmrbioStatus(handle: string, pubkey: string): Promise<XmrbioStatus> {
  try {
    const r = await resolveQueued(handle);
    if (!r.found) return { found: false };
    return { found: true, address: r.identity.address, check: r.check, linked: xmrbioLinked(r.identity.proofs, pubkey) };
  } catch (e) {
    return { found: 'error', reason: e instanceof Error ? e.message : String(e) };
  }
}

async function setupStatus(): Promise<SetupStatus> {
  const status = await readSetupStatus();
  await setupStatusLast.setValue({ at: Date.now(), status });
  return status;
}

async function readSetupStatus(): Promise<SetupStatus> {
  const pubkey = await requirePubkey();
  const relays = await setupRelays(pubkey);
  const read = await readEach(relays, { kinds: [KIND_PAYTO, KIND_IDENTITIES], authors: [pubkey] });
  const payto = newestOwn(read.events, KIND_PAYTO, pubkey);
  const ids = newestOwn(read.events, KIND_IDENTITIES, pubkey);
  const mine = await myHandleItem.getValue();
  const p = payto ? moneroPayto(payto) : null;
  const xmrbio = mine ? xmrbioStatus(mine.handle, pubkey) : Promise.resolve(null);
  let link: SetupStatus['link'] = null;
  if (mine && ids) {
    const claim = twitterClaims(ids, new Set([normalizeHandle(mine.handle)]))[0];
    if (claim) {
      const proof = await cachedVerify(claim.handle, claim.tweetId, pubkey);
      link = { handle: claim.handle, tweetUrl: tweetUrl(claim.handle, claim.tweetId), proof };
    }
  }
  // a deleted or broken proof un-proves the handle; a transient X error doesn't
  if (mine) {
    const proven = link?.proof.status === 'verified' ? true : link?.proof.status === 'error' ? mine.proven : false;
    if (proven !== mine.proven) await myHandleItem.setValue({ handle: mine.handle, proven });
  }
  return { pubkey, relays: read.readable, unreadable: read.unreadable, address: p ? { address: p.address, check: p.check } : null, link, xmrbio: await xmrbio };
}

async function setupPrepare(req: SetupRequest): Promise<PreparedSetup> {
  const pubkey = await requirePubkey();
  let action: SetupAction;
  if (req.type === 'add-address') {
    const check = validateMoneroAddress(req.address.trim());
    if (!check.ok) throw new Error(`Not a valid Monero mainnet address (${check.reason})`);
    action = { type: 'add-address', address: req.address.trim() };
  } else if (req.type === 'remove-address') {
    action = { type: 'remove-address' };
  } else {
    const mine = await myHandleItem.getValue();
    if (!mine) throw new Error('Confirm your X handle first');
    const handle = normalizeHandle(mine.handle);
    if (req.type === 'unlink-x') {
      action = { type: 'unlink-x', handle };
    } else {
      const tweetId = parseTweetProof(req.tweetUrl.trim(), handle);
      if (!tweetId) throw new Error(`Paste the link to your proof tweet: it must be a tweet by @${handle} (x.com/${handle}/status/…)`);
      const proof = await verifyTwitterProof(handle, tweetId, pubkey);
      if (proof.status === 'error') throw new Error(`Couldn't reach X to check the tweet (${proof.reason}). Try again in a moment.`);
      if (proof.status === 'failed') throw new Error(`The tweet doesn't prove the link: ${proof.reason}. It must be posted by @${handle} and contain your npub.`);
      action = { type: 'link-x', handle, tweetId };
    }
  }
  const kind = kindFor(action);
  const read = await readEach(await setupRelays(pubkey), { kinds: [kind], authors: [pubkey] });
  // relays we couldn't read might hold a newer list; skip them rather than overwrite it blind
  if (!read.readable.length) throw new Error("Couldn't read your current list from any relay, so nothing was published. Try again.");
  const current = newestOwn(read.events, kind, pubkey);
  const template = buildMerged(current, action);
  const id = crypto.randomUUID();
  const targets = setupTargets(kind, read.readable);
  if (!targets.length) throw new Error("Couldn't read your current list from a relay that accepts it, so nothing was published. Try again.");
  await setupItem.setValue({ id, action, template, pubkey, relays: targets, baseId: current?.id ?? null, expires: Date.now() + SETUP_TTL_MS });
  return { id, kind, pubkey, before: current?.tags ?? null, after: template.tags, relays: targets, unreadable: read.unreadable };
}

async function setupPending(id: string): Promise<PendingSetup> {
  const pending = await setupItem.getValue();
  if (pending && pending.expires < Date.now()) await setupItem.setValue(null);
  if (!pending || pending.id !== id || pending.expires < Date.now()) throw new Error('This change expired. Start it again.');
  return pending;
}

async function setupPublish(pending: PendingSetup, event: Event, relays: string[]) {
  const results = await publishToRelays(relays, event);
  const failed = results.filter((r) => !r.ok).map((r) => r.relay);
  await setupItem.setValue({ ...pending, signed: event, failed });
  if (results.some((r) => r.ok) && (pending.action.type === 'link-x' || pending.action.type === 'unlink-x')) {
    await myHandleItem.setValue({ handle: pending.action.handle, proven: pending.action.type === 'link-x' });
  }
  return { results };
}

async function setupSign(id: string) {
  const pending = await setupPending(id);
  if (pending.signed) throw new Error('Already signed; use "retry failed relays"');
  if (pending.action.type === 'link-x' || pending.action.type === 'unlink-x') {
    const mine = await myHandleItem.getValue();
    if (!mine || normalizeHandle(mine.handle) !== pending.action.handle) throw new Error('Your confirmed X handle changed. Start this step again.');
  }
  // the list may have changed (another device) since it was reviewed; never sign over a newer one
  const kind = pending.template.kind;
  const recheck = await readEach(pending.relays, { kinds: [kind], authors: [pending.pubkey] });
  if (!recheck.readable.length) throw new Error("Couldn't re-read your list before signing. Try again.");
  if ((newestOwn(recheck.events, kind, pending.pubkey)?.id ?? null) !== pending.baseId) {
    await setupItem.setValue(null);
    throw new Error('Your list changed since you reviewed it. Review the change again.');
  }
  const event = await signExact(pending.template, pending.pubkey);
  return setupPublish(pending, event, pending.relays);
}

async function setupRetry(id: string) {
  const pending = await setupPending(id);
  if (!pending.signed || !pending.failed?.length) throw new Error('Nothing to retry');
  return setupPublish(pending, pending.signed, pending.failed);
}
