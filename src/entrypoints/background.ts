import { naddrEncode, neventEncode } from 'nostr-tools/nip19';
import { verifyEvent, type Event, type EventTemplate } from 'nostr-tools/pure';
import { installBridge } from '../bridge';
import { normalizeHandle } from '../identity/envelope';
import { KIND_IDENTITIES, KIND_PAYTO, moneroPayto, parseTweetProof, poolQuery, twitterClaims, verifyTwitterProof, type ProofResult, validEvent } from '../identity/nostr';
import { buildMerged, kindFor, newestOwn, setupTargets, tweetUrl, type SetupAction } from '../identity/setup';
import { validateMoneroAddress } from '../xmr/address';
import { directoryKeeper, type StoredDirectory } from '../identity/directory';
import type { Badge } from '../identity/resolve';
import type { SeenEntries } from '../identity/xmrbio';
import { claimKeeper, type XClaimStore } from '../identity/xclaims';
import { BURNER_CREATE_PORT, type BurnerCreateEvent } from '../messaging';
import type { BgRequest, BgResponse, ImageInfo, OpenComposerMsg, OpenTipMsg, PreparedSetup, SetupRequest, SetupStatus, Wrapped, XmrbioStatus } from '../messaging';
import { setupStatusLast, xmrbioLinked } from '../identity/status';
import { uploadBlob } from '../nostr/blossom';
import { liveController, liveSubscription, throttledCheck } from '../nostr/live';
import { scaledMs } from '../nostr/load-media';
import { resolveXVideo, type VideoFound } from '../nostr/x-video';
import { loadMedia } from '../nostr/load-media';
import { statusIdFromUrl } from '../extractors/x-article';
import { KIND_ARTICLE, checkBlossomAuth, checkPublishable, checkSigned, dedupeKey, sha256Hex } from '../nostr/event';
import { allRelaysFrom, fetchWriteRelays, publishToRelays, readEach, readRelay } from '../nostr/relays';
import { checkSessionSender, checkShareMenuSender, isExtensionPageSender, isSignerPage, isXUrl, SIGNER_PAGE, shareMenuRateLimit, withoutTab } from '../sender';
import { setAuto, suggestFor, tagsReady } from '../ai/requests';
import { signerModeItem, syncedPostsItem, xmrbioListItem, xmrbioListPrefItem } from '../settings';
import { recordSynced, type SyncedPost } from '../nostr/synced';
import { proofCandidateItem, setupDoneItem } from '../settings';
import { DEFAULT_RELAYS, directoryStatusItem, nip65CacheItem, siwmHelperOn, useNip65On, INDEX_RELAYS, withoutIndex, myHandleItem, postedItem, pubkeyItem, receiptsOn, settingsItem, siteInfoOn, updateCheckOn, updateStateItem, logoPackItem, xapInboxItem, xapNotifyOn, siteWarningsOn, copyReportsOn, swapRecordDaysItem, swapRecordsCleanedItem, xapMarksItem, xClaimsChangedItem, xClaimsOn, xmrSettingsItem } from '../settings';
import { storage } from 'wxt/utils/storage';
import { activeInbox, burnerCreatingItem, burnerInboxItem, burnerLastErrorItem, burnFreeInbox, createFreeInbox, forgetImportedInbox, importInbox, type BurnerDeps } from '../burner/service';
import { idbTokenStore } from '../burner/token-store';
import { xapPoolQuery } from '../xap/fetch';
import { publishXap, withSent, type SentXap } from '../xap/service';
import type { RecordLinks, SiteInfo, XapTotals } from '../messaging';
import { trackCreate } from '../burner/tracked';
import { checkPageReceipt, savedSignatureLine, type CheckDeps } from '../receipts/check';
import { letterOrderLink, receiptOrderLink } from '../receipts/order-link';
import { lookalikeIndex, lookalikeOf, type LookalikeIndex } from '../sites/lookalike';
import { badgeFor, FEED_READER_V, FEED_URL, leadSite, publicSite, readFeed, sitesFor, worstGrade, type SiteFeed, type TabState } from '../sites/feed';
import { fetchManifest } from '../receipts/fetch';
import { buildExport } from '../receipts/export';
import { idbReceiptStore } from '../receipts/store';
import { buildLetterExport } from '../log/export';
import { verifyLetter } from '../log/pgp';
import { letterRequests } from '../log/service';
import { idbLetterStore } from '../log/store';
import { swapRecordsKeeper } from '../receipts/cleanup';
import { checkPublicRecord } from '../receipts/witness';
import { markFor, withMark } from '../xap/marks';
import { GUARD_PATH } from '../sites/guard-rules';
import { guardKeeper, type DnrApi, type GuardTokens } from '../sites/guard-keeper';
import { reportCopy, reportFlags } from '../sites/report';
import { healthStore, type Health } from '../nostr/relay-health';
import { readRelaysOf, republishAllowed, resolvePostRelays } from '../nostr/post-relays';
import { releaseUrl, UPDATE_NOTICE_ID, updateFor, updateKeeper } from '../update/check';
import { setGlobalBadge, setTabBadge, updateBadge, type BadgeAction } from '../update/badge';
import { logoKeeper } from '../sites/logos';
import { INBOX_NOTICE_ID, inboxKeeper, MAX_RELAYS } from '../xap/inbox';
import { KIND_XO, readRelaysFrom, undoTemplate, xoHandleValue, xoRelayOrder, xoTemplate } from '../xo/event';
import { KIND_RECEIPT } from '../xap/events';
import { idbKeyStore, managedIdentity } from '../identity/managed';
import { listOutcome, listPlan, registerTemplate, XMRBIO_REGISTER_URL, type ListRecord } from '../identity/xmrbio-list';
import { bySignerMode, NoSignerError } from '../identity/signer-mode';
import { rememberSent } from '../xo/sent';
import { XO_NOTICE_ID, xoKeeper } from '../xo/inbox';
import { knownLiker, rememberLiker, verifyLiker } from '../xo/verify';
import { xoButtonOn, xoCountsItem, xoInboxItem, xoLikersItem, xoSentItem } from '../settings';
import { shootQuote, shotGate, validRequest, type Crop, type ShotDeps } from '../capture/quote-shot';
import { cappedText, siwmService, type SiwmStore } from '../siwm/service';
import { xLookups } from '../service/x-lookups';
import { boundedBody } from '../service/bounded-body';

const MENU_ID = 'xmradar';
const TIP_MENU_ID = 'xmradar-tip';
const X_PATTERNS = ['https://x.com/*', 'https://twitter.com/*', 'https://mobile.x.com/*', 'https://mobile.twitter.com/*'];
const SESSION_TTL_MS = 15 * 60_000;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

interface Session {
  id: string;
  tabId: number;
  expires: number;
}
// one quoted-post picture per composer session (PLAN-QUOTESHOT), kept apart from the session records
const quoteShots = shotGate(storage.defineItem<string[]>('session:quoteShots', { fallback: [] }));

// storage.session survives MV3 service-worker suspension, unlike module state
const sessionsItem = storage.defineItem<Session[]>('session:composerSessions', { fallback: [] });
// last share-menu copy per tab, for the 2 s rate limit
const shareMenuLast = storage.defineItem<Record<number, number>>('session:shareMenuLast', { fallback: {} });
const SHARE_MENU_GAP_MS = 2000;
const resolveSeen = storage.defineItem<SeenEntries>('local:xmrbioResolveSeen', { fallback: [] });
// the relays each composer session's publish went to: a retry may use only those (PLAN-RELAYDEFAULTS)
const publishRelaysItem = storage.defineItem<Record<string, string[]>>('session:publishRelays', { fallback: {} });
// relays that keep failing are skipped for a day (PLAN-DEADRELAYS)
const relayHealth = healthStore(storage.defineItem<Health>('local:relayHealth', { fallback: {} }));
// best effort: the post went out either way, so a storage error must not turn it into a failure
// Sign in with Monero links waiting in a consent window (PLAN-SIWM); XMRadar holds no key, the user's wallet signs
const siwm = siwmService({
  store: storage.defineItem<SiwmStore>('session:siwm', { fallback: {} }),
  now: Date.now,
  randomId: () => crypto.randomUUID(),
  openWindow: async (id) => (await browser.windows.create({ url: browser.runtime.getURL(`/siwm.html#${id}`), type: 'popup', width: 520, height: 720 }))?.id,
  post: async (url, body) => {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
    return { status: r.status, text: await cappedText(r) };
  },
});
const recordHealth = (results: Parameters<typeof relayHealth.record>[0]) => relayHealth.record(results).catch((e) => console.warn('[XMRadar] relay health', (e as Error).message));

type CacheEntries<V> = [string, { v: V; at: number }][];
const badgeCacheItem = storage.defineItem<CacheEntries<Badge>>('local:badgeCache', { fallback: [] });
const proofCacheItem = storage.defineItem<CacheEntries<ProofResult>>('local:proofCache', { fallback: [] });

// image bytes between fetch-image and upload-image; refetched if the worker was suspended. At most 8 entries
// and 64 MB together (a video can be 50 MB), oldest dropped first
const imageCache = new Map<string, { bytes: ArrayBuffer; mime: string }>();
const IMAGE_CACHE_BYTES = 64 * 1024 * 1024;
function cacheImage(sha256: string, img: { bytes: ArrayBuffer; mime: string }) {
  imageCache.delete(sha256);
  const total = () => [...imageCache.values()].reduce((s, v) => s + v.bytes.byteLength, 0);
  while (imageCache.size && (imageCache.size >= 8 || total() + img.bytes.byteLength > IMAGE_CACHE_BYTES)) imageCache.delete(imageCache.keys().next().value!);
  imageCache.set(sha256, img);
}
// X videos found (PLAN-XVIDEO): at most 8, by tweet and media id, for the worker's life; failures aren't kept
const videoCache = new Map<string, VideoFound>();


// Xap (NKIP-0002)
const xapSentItem = storage.defineItem<SentXap[]>('local:xapsSent', { fallback: [] });
const xapCacheItem = storage.defineItem<CacheEntries<XapTotals>>('local:xapTotalsCache', { fallback: [] });
const xapLastItem = storage.defineItem<number>('session:xapLast', { fallback: 0 });
const xmrUsdItem = storage.defineItem<{ usd: number; at: number } | null>('session:xmrUsd', { fallback: null });
const XAP_GAP_MS = 10_000;
/** your relays for xap lookups: your NIP-65 list while a signer is known, else the manual ones */
const myXapRelays = async () => {
  const pubkey = await pubkeyItem.getValue();
  return pubkey ? await resolveRelays(pubkey).catch(() => []) : (await settingsItem.getValue()).relays;
};
/** where profiles and receipts are looked up: defaults, index relays and yours */
const xapLookupRelays = async () => [...new Set([...DEFAULT_RELAYS, ...INDEX_RELAYS, ...(await myXapRelays())])];

// badges, proofs, xap totals, the price and xmr.bio lookups: shared with Ripley's X app (service/x-lookups.ts)
const lookups = xLookups({
  items: { badgeCache: badgeCacheItem, proofCache: proofCacheItem, xapCache: xapCacheItem, xmrUsd: xmrUsdItem, xmrbioSeen: resolveSeen },
  fetch: (...args) => fetch(...args),
  query: poolQuery,
  xapQuery: xapPoolQuery,
  settings: () => xmrSettingsItem.getValue(),
  badgeRelays: async () => (await settingsItem.getValue()).relays,
  xapRelays: myXapRelays,
  me: async () => ({ pubkey: await pubkeyItem.getValue(), sent: await xapSentItem.getValue() }),
  directory: () => directory.lookup(),
  selfClaims: () => claims.lookup(),
});

// saved letters and receipts deleted after the chosen days (PLAN-AUTOCLEAN)
const swapRecords = swapRecordsKeeper({
  stores: { receipts: idbReceiptStore, letters: idbLetterStore },
  days: () => swapRecordDaysItem.getValue(),
  alarms: browser.alarms,
  cleaned: (c) => swapRecordsCleanedItem.setValue(c),
});

// the daily update check: XMRadar is installed from a zip, so no browser updates it (PLAN-UPDATECHECK)
const updates = updateKeeper({
  held: updateStateItem,
  fetch: (...args) => fetch(...args),
  readBody: boundedBody,
  alarms: browser.alarms,
  enabled: async () => updateCheckOn(await settingsItem.getValue()),
  current: () => browser.runtime.getManifest().version,
  notify: async (version) => {
    await browser.notifications.create(UPDATE_NOTICE_ID, {
      type: 'basic',
      iconUrl: browser.runtime.getURL('/icon/128.png'),
      title: 'XMRadar',
      message: `XMRadar ${version} is out. Click to see what's new and download.`,
    });
  },
  clearNotice: () => browser.notifications.clear(UPDATE_NOTICE_ID).catch(() => {}),
});

// the user's own relays and the defaults, where XMRadar publishes every receipt; index relays keep none
const xapInboxRelays = async (pubkey: string) => [...new Set(withoutIndex([...(await resolveRelays(pubkey).catch(() => [])), ...DEFAULT_RELAYS]))].slice(0, MAX_RELAYS);

// Xap notifications (PLAN-XAPINBOX): off unless switched on, since asking relays for Xaps to the user's key
// tells them this browser watches it
const xapInbox = inboxKeeper({
  held: xapInboxItem,
  enabled: async () => xapNotifyOn(await xmrSettingsItem.getValue()),
  pubkey: () => pubkeyItem.getValue(),
  relays: (pubkey) => xapInboxRelays(pubkey),
  read: (relays, filter, timeoutMs) => readEach(relays, filter, timeoutMs),
  query: xapPoolQuery,
  alarms: browser.alarms,
  notify: async (message) => {
    await browser.notifications.create(INBOX_NOTICE_ID, { type: 'basic', iconUrl: browser.runtime.getURL('/icon/128.png'), title: 'XMRadar', message });
  },
  clearNotice: () => browser.notifications.clear(INBOX_NOTICE_ID).then(() => {}, () => {}),
});

// xo (PLAN-MONEROLIKE): a key's read relays (NIP-65), where its owner looks for xos; an hour in memory
const readRelayCache = new Map<string, { relays: string[]; at: number }>();
async function nip65ReadRelays(pubkey: string): Promise<string[]> {
  const hit = readRelayCache.get(pubkey);
  if (hit && Date.now() - hit.at < 3600_000) return hit.relays;
  const lists = await xapPoolQuery(await xapLookupRelays(), { kinds: [10002], authors: [pubkey] }).catch(() => []);
  // only a list the key really signed
  const newest = lists.filter((e) => e.pubkey === pubkey && e.kind === 10002 && validEvent(e)).sort((a, b) => b.created_at - a.created_at)[0] ?? null;
  const relays = readRelaysFrom(newest).slice(0, 4);
  readRelayCache.set(pubkey, { relays, at: Date.now() });
  return relays;
}
/** Where an xo goes: the sender's post relays, the author's read relays and the defaults (the shared floor). */
// an author with no key known (PLAN-XOREACH): the defaults, the floor both sides read, then the sender's own
const xoRelays = async (me: string, author: string | null) => xoRelayOrder(author ? withoutIndex(await nip65ReadRelays(author)) : [], DEFAULT_RELAYS, withoutIndex(await resolveRelays(me).catch(() => [])));

// its own read relays and the defaults first: that's where senders put xos
const xoInboxRelays = async (pubkey: string) => xoRelayOrder(withoutIndex(await nip65ReadRelays(pubkey)), DEFAULT_RELAYS, withoutIndex(await resolveRelays(pubkey).catch(() => [])), MAX_RELAYS);

const xoInbox = xoKeeper({
  held: xoInboxItem,
  counts: xoCountsItem,
  // with the Xap notifications: one switch for "tell me what Monero people send me"
  enabled: async () => xapNotifyOn(await xmrSettingsItem.getValue()),
  pubkey: () => pubkeyItem.getValue(),
  // PLAN-XOREACH: xos sent to the handle before the user had a key
  handle: async () => {
    const m = await myHandleItem.getValue();
    return m?.proven ? m.handle : null;
  },
  relays: (pubkey) => xoInboxRelays(pubkey),
  read: (relays, filter) => readEach(relays, filter, 6000),
  query: xapPoolQuery,
  known: async (pk) => knownLiker(await xoLikersItem.getValue(), pk, Date.now()),
  verify: async (pk) => {
    const liker = await verifyLiker(pk, { query: xapPoolQuery, relays: await xapLookupRelays(), proof: (h, t, key) => verifyTwitterProof(h, t, key) });
    if (liker) await xoLikersItem.setValue(rememberLiker(await xoLikersItem.getValue(), pk, liker, Date.now()));
    return liker;
  },
  alarms: browser.alarms,
  notify: async (message) => {
    await browser.notifications.create(XO_NOTICE_ID, { type: 'basic', iconUrl: browser.runtime.getURL('/icon/128.png'), title: 'XMRadar', message });
  },
  clearNotice: () => browser.notifications.clear(XO_NOTICE_ID).then(() => {}, () => {}),
});
const xoLastItem = storage.defineItem<Record<number, number>>('session:xoLast', { fallback: {} });

// the live inbox (PLAN-LIVEINBOX): while an X tab is visible, one subscription on the inbox relays, with the
// same filters the 30-minute checks send; an event just makes that kind's check run now (2 s after it, at most
// one every 5 s per kind: a burst of xos is a few checks, not one each)
const LIVE_RELAYS = 6;
const xoLive = throttledCheck(() => xoInbox.check(), { gapMs: 5_000, debounceMs: 2_000 });
const xapLive = throttledCheck(() => xapInbox.check(), { gapMs: 5_000, debounceMs: 2_000 });
const liveInbox = liveController(
  {
    on: async () => xapNotifyOn(await xmrSettingsItem.getValue()),
    pubkey: () => pubkeyItem.getValue(),
    handle: async () => {
      const me = await myHandleItem.getValue();
      return me?.proven ? me.handle.toLowerCase() : null;
    },
    // the xo and Xap relays together, the xo keeper's order first (its NIP-65 read relays), at most 6
    relays: async (pk) => [...new Set([...(await xoInboxRelays(pk).catch(() => [])), ...(await xapInboxRelays(pk).catch(() => []))])].slice(0, LIVE_RELAYS),
    subscribe: (relays, filters) => liveSubscription({ relays, filters, onEvent: (e) => (e.kind === KIND_XO ? xoLive : xapLive).trigger() }),
    checkedAt: async () => ({ xo: (await xoInboxItem.getValue())?.checkedAt ?? null, xap: (await xapInboxItem.getValue())?.checkedAt ?? null }),
    kinds: { xo: KIND_XO, xap: KIND_RECEIPT, handleTag: xoHandleValue },
  },
  { xo: () => xoLive.trigger(), xap: () => xapLive.trigger() },
);
// the switch turned off, or the key or handle changed: close now (a change reopens on the next heartbeat)
xmrSettingsItem.watch((s) => {
  if (!xapNotifyOn(s)) liveInbox.stop();
});
pubkeyItem.watch(() => liveInbox.stop());
myHandleItem.watch(() => liveInbox.stop());

// a quoted post's picture (PLAN-QUOTESHOT): capture, decode and crop stay here; only the crop goes back
const bitmapOf = async (dataUrl: string) => createImageBitmap(await (await fetch(dataUrl)).blob());
async function pngDataUrl(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:image/png;base64,${btoa(bin)}`;
}
const shotDeps: ShotDeps = {
  activeTab: async (windowId) => (await browser.tabs.query({ active: true, windowId }))[0],
  capture: (windowId) => browser.tabs.captureVisibleTab(windowId, { format: 'png' }),
  size: async (dataUrl) => {
    const bmp = await bitmapOf(dataUrl);
    const size = { width: bmp.width, height: bmp.height };
    bmp.close();
    return size;
  },
  crop: async (dataUrl, a: Crop) => {
    const bmp = await bitmapOf(dataUrl);
    const canvas = new OffscreenCanvas(a.sw, a.sh);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('unsupported');
    try {
      ctx.drawImage(bmp, a.sx, a.sy, a.sw, a.sh, 0, 0, a.sw, a.sh);
    } finally {
      bmp.close();
    }
    return pngDataUrl(await canvas.convertToBlob({ type: 'image/png' }));
  },
  isX: (url) => isXUrl(url),
};

const burner: BurnerDeps = { meta: { get: () => burnerInboxItem.getValue(), set: (v) => burnerInboxItem.setValue(v) }, tokens: idbTokenStore };

export default defineBackground(() => {
  // site info: a 12-hour alarm while it's on, and a fresh copy at startup when the kept one is old
  browser.alarms.onAlarm.addListener((a) => {
    if (a.name === SITE_FEED_ALARM) void refreshSiteFeed();
    void directory.onAlarm(a.name);
    void swapRecords.onAlarm(a.name);
    void updates.onAlarm(a.name);
    void xapInbox.onAlarm(a.name);
    void xoInbox.onAlarm(a.name);
  });
  void xapInbox.apply();
  void xoInbox.apply();
  xmrSettingsItem.watch((s, old) => {
    if (xapNotifyOn(s) !== xapNotifyOn(old)) {
      void xapInbox.apply();
      void xoInbox.apply();
    }
  });
  pubkeyItem.watch((pk, old) => {
    void xapInbox.apply();
    void xoInbox.apply();
    // another key now signs (switching between the signer and the XMRadar identity, PLAN-MANAGEDID): what
    // the old key sent can't be taken back by this one, and the handle must be proven again for it
    if (old && pk && old !== pk) void rebindToKey();
  });
  myHandleItem.watch((m, old) => {
    if ((m?.proven ? m.handle : null) !== (old?.proven ? old.handle : null)) void xoInbox.apply();
  });
  void settingsItem.getValue().then((s) => updates.apply(updateCheckOn(s)));
  settingsItem.watch((s, old) => {
    if (updateCheckOn(s) !== updateCheckOn(old)) {
      void updates.apply(updateCheckOn(s));
      void syncUpdateBadge();
    }
  });
  // the icon says when a newer version is out, on every tab without a badge of its own (PLAN-UPDATEBADGE)
  void syncUpdateBadge();
  updateStateItem.watch(() => void syncUpdateBadge());
  // the update notification opens the release page of the version it names, built from the checked number
  browser.notifications.onClicked.addListener(async (id) => {
    // a Xap notification opens the list in Options, never a post a tipper named
    if (id === XO_NOTICE_ID) {
      await xoInbox.markRead();
      await browser.tabs.create({ url: browser.runtime.getURL('/options.html?xaps#badges') });
      return;
    }
    if (id === INBOX_NOTICE_ID) {
      await xapInbox.markRead();
      await browser.tabs.create({ url: browser.runtime.getURL('/options.html?xaps#badges') });
      return;
    }
    if (id !== UPDATE_NOTICE_ID) return;
    await browser.notifications.clear(id).catch(() => {});
    const url = releaseUrl(updateFor(await updateStateItem.getValue(), browser.runtime.getManifest().version));
    if (url) await browser.tabs.create({ url });
  });
  void swapRecords.apply();
  swapRecordDaysItem.watch(() => void swapRecords.apply());
  void xmrSettingsItem.getValue().then((s) => directory.apply(s.badgesX));
  // switched off while the worker wasn't running: nothing may stay kept
  void xmrSettingsItem.getValue().then((s) => (xClaimsOn(s) ? undefined : claims.clear()));
  void xmrSettingsItem.getValue().then((s) => applySiteInfoSetting(siteInfoOn(s)));
  // a pack missed while the worker was down (or kept by a version without logos)
  void siteFeedItem.getValue().then((f) => logos.sync(f));
  void applyGuard();
  // the guard page's address is new each browser session (use_dynamic_url): this listener starts the worker
  // at browser start, so the rules are rewritten to the new address before the first navigations
  browser.runtime.onStartup.addListener(() => void applyGuard());
  siteFeedItem.watch(() => void applyGuard());
  xmrSettingsItem.watch((s, old) => {
    if (siteInfoOn(s) !== siteInfoOn(old)) void applySiteInfoSetting(siteInfoOn(s));
    if (siteWarningsOn(s) !== siteWarningsOn(old)) void applyGuard();
    if (s.badgesX !== old?.badgesX) void directory.apply(s.badgesX);
    if (xClaimsOn(old) && !xClaimsOn(s)) void claims.clear();
  });
  // a tab that moves to another page starts with no receipt or site state (the browser resets its badge)
  // the lookalike half of the badge comes from the address itself, so a copy that never loads still shows it
  browser.tabs.onUpdated.addListener((tabId, change) => {
    if (change.url) void dropTabState(tabId).then(() => addressBadge(tabId, change.url!)).then(() => guardAfterLoad(tabId, change.url!));
  });
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

  browser.windows.onRemoved.addListener((windowId) => void siwm.windowClosed(windowId).catch(() => {}));

  browser.tabs.onRemoved.addListener((tabId) => {
    lookups.dropRateKey(tabId);
    receiptChecks.delete(tabId);
    void dropTabState(tabId);
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
  await setPublishRelays(id, null);
}

async function requireSession(sessionId: string, sender: Browser.runtime.MessageSender) {
  checkSessionSender(await sessionsItem.getValue(), sessionId, sender, browser.runtime.id);
}

/**
 * The X post a copy came from, with the copy's reference, for the mark on X (PLAN-SYNCEDMARK). Never
 * fails the publish: the event is out on the relays whatever happens to this note of it.
 */
let syncedWrites: Promise<void> = Promise.resolve();
function rememberSynced(sourceUrl: string, event: { id: string; pubkey: string; kind: number; tags: string[][] }, okRelays: string[]) {
  // one write at a time, so two publishes finishing together both keep their mark
  syncedWrites = syncedWrites.then(() => writeSynced(sourceUrl, event, okRelays));
  return syncedWrites;
}
async function writeSynced(sourceUrl: string, event: { id: string; pubkey: string; kind: number; tags: string[][] }, okRelays: string[]) {
  try {
    const id = statusIdFromUrl(sourceUrl);
    if (!id) return;
    const relays = okRelays.slice(0, 3);
    const d = event.tags.find((t) => t[0] === 'd')?.[1];
    const entry: SyncedPost =
      event.kind === KIND_ARTICLE && d !== undefined
        ? { ref: naddrEncode({ kind: KIND_ARTICLE, pubkey: event.pubkey, identifier: d, relays }), kind: 'article', at: Date.now() }
        : { ref: neventEncode({ id: event.id, author: event.pubkey, relays }), kind: 'note', at: Date.now() };
    await syncedPostsItem.setValue(recordSynced(await syncedPostsItem.getValue(), id, entry));
  } catch {}
}

const isExtensionPage = (sender: Browser.runtime.MessageSender) => isExtensionPageSender(sender, browser.runtime.id, browser.runtime.getURL('/'));

// the tab URL covers the popup opening inside an embedded frame on x.com
const isXContentScript = (sender: Browser.runtime.MessageSender) => sender.id === browser.runtime.id && (isXUrl(sender.url) || isXUrl(sender.tab?.url));

const loadImage = (url: string, kind?: 'video') => loadMedia(url, kind, { fetch: (...a) => fetch(...a), readBody: boundedBody, imageMax: MAX_IMAGE_BYTES });

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

/**
 * Where a post goes: your list, else your NIP-65 write relays, else XMRadar's picks (PLAN-RELAYDEFAULTS).
 * `use` is required: only posts follow the NIP-65 switch (PLAN-NIP65SWITCH); lookups always read the list.
 */
function postRelays(pubkey: string | null, use: 'post' | 'lookup', network = true) {
  return resolvePostRelays(pubkey, {
    manual: async () => (await settingsItem.getValue()).relays,
    useNip65: async () => use === 'lookup' || useNip65On(await settingsItem.getValue()),
    cached: () => nip65CacheItem.getValue(),
    fetch: network ? (pk) => fetchWriteRelays(pk, [...DEFAULT_RELAYS, ...INDEX_RELAYS]) : undefined,
    saveCache: (c) => nip65CacheItem.setValue(c),
  });
}

/** The same for lookups, whose fallback is only the 3 defaults. */
async function resolveRelays(pubkey: string): Promise<string[]> {
  return readRelaysOf(await postRelays(pubkey, 'lookup'));
}

/** Kept per live session only, written before the publish so a retry always finds it. */
async function setPublishRelays(sessionId: string, relays: string[] | null) {
  const live = new Set((await sessionsItem.getValue()).filter((s) => s.expires > Date.now()).map((s) => s.id));
  const next = Object.fromEntries(Object.entries(await publishRelaysItem.getValue()).filter(([id]) => live.has(id) && id !== sessionId));
  if (relays && live.has(sessionId)) next[sessionId] = relays;
  // at most 50 sessions; the newest stay
  await publishRelaysItem.setValue(Object.fromEntries(Object.entries(next).slice(-50)));
}

async function handle(msg: BgRequest, sender: Browser.runtime.MessageSender): Promise<BgResponse<BgRequest['type']>> {
  switch (msg.type) {
    case 'capture-quote': {
      await requireSession(msg.sessionId, sender);
      const tab = sender.tab;
      // the composer's own top frame only
      if (sender.frameId !== 0 || tab?.id == null || tab.windowId == null) throw new Error('Not allowed');
      if (!validRequest(msg)) throw new Error('Bad request');
      // claimed and stored before capturing, so neither a second ask nor a restarted worker gets another
      if (!(await quoteShots.claim(msg.sessionId))) throw new Error('Already taken');
      const canCrop = typeof OffscreenCanvas !== 'undefined' && typeof createImageBitmap !== 'undefined' && 'convertToBlob' in OffscreenCanvas.prototype;
      if (!canCrop || !browser.tabs.captureVisibleTab) throw new Error('unsupported');
      return { dataUrl: await shootQuote({ id: tab.id, windowId: tab.windowId }, msg, shotDeps) };
    }
    case 'fetch-image': {
      await requireSession(msg.sessionId, sender);
      const { bytes, mime } = await loadImage(msg.url, msg.kind === 'video' ? 'video' : undefined);
      const sha256 = await sha256Hex(bytes);
      // a few images per post at most; an abandoned one doesn't stay for the worker's lifetime
      cacheImage(sha256, { bytes, mime });
      // a video's size comes from X (the resolver), not from decoding it here
      return { sha256, mime, size: bytes.byteLength, dim: mime.startsWith('video/') ? undefined : await imageDim(bytes, mime) } satisfies ImageInfo;
    }
    case 'resolve-video': {
      await requireSession(msg.sessionId, sender);
      const key = `${msg.statusId}:${msg.mediaId}`;
      const hit = videoCache.get(key);
      if (hit) return hit;
      const found = await resolveXVideo(String(msg.statusId), String(msg.mediaId));
      // only a found file is kept: a failure is asked again next time, and never pushes a found one out
      if (found.ok) {
        if (videoCache.size >= 8) videoCache.delete(videoCache.keys().next().value!);
        videoCache.set(key, found);
      }
      return found;
    }
    case 'upload-image': {
      await requireSession(msg.sessionId, sender);
      let img = imageCache.get(msg.sha256);
      if (!img) {
        img = await loadImage(msg.url, msg.kind === 'video' ? 'video' : undefined);
        if ((await sha256Hex(img.bytes)) !== msg.sha256) throw new Error('Image changed since it was hashed');
      }
      try {
        checkBlossomAuth(msg.auth, msg.sha256);
        const { blossomServer } = await settingsItem.getValue();
        const timeout = img.mime.startsWith('video/') ? scaledMs(30_000, img.bytes.byteLength) : 30_000;
        return { url: await uploadBlob(blossomServer, img.bytes, img.mime, msg.sha256, msg.auth, timeout) };
      } finally {
        imageCache.delete(msg.sha256);
      }
    }
    case 'publish': {
      await requireSession(msg.sessionId, sender);
      checkPublishable(msg.event, msg.sourceUrl, statusIdFromUrl);
      if (!verifyEvent(msg.event)) throw new Error('Refusing to publish an invalid event');
      await pubkeyItem.setValue(msg.event.pubkey);
      const { relays: all, source } = await postRelays(msg.event.pubkey, 'post');
      const { use: relays, skipped, overridden } = await relayHealth.partition(all);
      // only the relays used: a skipped one can't be retried
      await setPublishRelays(msg.sessionId, relays);
      const key = await dedupeKey(msg.sourceUrl, msg.text);
      const results = await publishToRelays(relays, msg.event);
      await recordHealth(results);
      const notes = { skipped, overridden, source };
      const okRelays = results.filter((r) => r.ok).map((r) => r.relay);
      if (okRelays.length) {
        const posted = await postedItem.getValue();
        await postedItem.setValue([...posted.filter((k) => k !== key), key].slice(-1000));
        await rememberSynced(msg.sourceUrl, msg.event, okRelays);
      }
      const nevent = neventEncode({ id: msg.event.id, author: msg.event.pubkey, relays: okRelays.slice(0, 3) });
      if (msg.event.kind !== KIND_ARTICLE) return { results, nevent, ...notes };
      const identifier = msg.event.tags.find((t) => t[0] === 'd')![1]!;
      return { results, nevent, ...notes, naddr: naddrEncode({ kind: KIND_ARTICLE, pubkey: msg.event.pubkey, identifier, relays: okRelays.slice(0, 3) }) };
    }
    case 'republish': {
      // the same signed event again, to relays that failed: no new signature, no duplicate (same id),
      // and only to relays from the user's own list
      await requireSession(msg.sessionId, sender);
      if (!verifyEvent(msg.event)) throw new Error('Refusing to publish an invalid event');
      const relays = republishAllowed((await publishRelaysItem.getValue())[msg.sessionId], msg.relays);
      if (!relays.length) throw new Error('No relays to retry');
      const results = await publishToRelays(relays, msg.event);
      await recordHealth(results);
      const okRelays = results.filter((r) => r.ok).map((r) => r.relay);
      // the event is the one signed for this session's post; a source that isn't an X post marks nothing
      if (okRelays.length && typeof msg.sourceUrl === 'string') await rememberSynced(msg.sourceUrl, msg.event, okRelays);
      return { results };
    }
    case 'check-duplicate': {
      await requireSession(msg.sessionId, sender);
      return { duplicate: (await postedItem.getValue()).includes(await dedupeKey(msg.sourceUrl, msg.text)) };
    }
    case 'ai-tags-ready': {
      await requireSession(msg.sessionId, sender);
      return tagsReady();
    }
    case 'suggest-tags': {
      await requireSession(msg.sessionId, sender);
      return suggestFor(msg);
    }
    case 'set-ai-auto': {
      await requireSession(msg.sessionId, sender);
      return setAuto(msg);
    }
    case 'close-session': {
      await requireSession(msg.sessionId, sender);
      await endSession(msg.sessionId);
      return null;
    }
    case 'siwm-open': {
      // a link clicked in a page (the content script; the page's host comes from the browser, not the page) or pasted in the consent window
      // pasted: the consent window is already open and shows it
      if (isExtensionPage(sender)) return siwm.open(msg.uri, null, false);
      if (sender.id !== browser.runtime.id || sender.tab?.id == null) throw new Error('Not allowed');
      if (!siwmHelperOn(await settingsItem.getValue())) return null;
      let host: string;
      try {
        host = new URL(sender.url ?? '').host;
      } catch {
        throw new Error('Not allowed');
      }
      if (!host) throw new Error('Not allowed');
      return siwm.open(msg.uri, host);
    }
    case 'siwm-get': {
      if (!isExtensionPage(sender)) throw new Error('Not allowed');
      return siwm.get(msg.id);
    }
    case 'siwm-submit': {
      if (!isExtensionPage(sender)) throw new Error('Not allowed');
      return siwm.submit(msg.id, msg.signature);
    }
    case 'siwm-close': {
      if (!isExtensionPage(sender)) throw new Error('Not allowed');
      await siwm.close(msg.id);
      return null;
    }
    case 'relays-in-use': {
      if (!isExtensionPage(sender)) throw new Error('Not allowed');
      // never asks a relay: Options opening doesn't look up your npub
      const pubkey = await pubkeyItem.getValue();
      return { ...(await postRelays(pubkey, 'post', false)), hasPubkey: !!pubkey };
    }
    case 'load-nip65': {
      if (!isExtensionPage(sender)) throw new Error('Not allowed');
      const { relays } = await settingsItem.getValue();
      const found = withoutIndex(await fetchWriteRelays(msg.pubkey, [...new Set([...DEFAULT_RELAYS, ...INDEX_RELAYS, ...relays])]));
      if (found.length) await nip65CacheItem.setValue({ pubkey: msg.pubkey, relays: found, at: Date.now() });
      return { relays: found };
    }
    case 'test-signer': {
      if (!isExtensionPage(sender)) throw new Error('Not allowed');
      return { pubkey: await testSigner() };
    }
    // the identity card in Options (PLAN-MANAGEDID); extension pages only, the key never leaves for a page
    case 'identity-state': {
      if (!isExtensionPage(sender)) throw new Error('Not allowed');
      return { mode: await signerModeItem.getValue(), managed: await managed.pubkey(), current: await pubkeyItem.getValue() };
    }
    case 'identity-mode': {
      if (!isExtensionPage(sender)) throw new Error('Not allowed');
      if (msg.mode !== 'auto' && msg.mode !== 'signer' && msg.mode !== 'managed') throw new Error('Bad mode');
      // "only my signer" needs a signer that answers: the choice isn't taken (and the key in use doesn't
      // change) until one does
      if (msg.mode === 'signer') {
        const pubkey = await signerPubkey();
        await signerModeItem.setValue('signer');
        await pubkeyItem.setValue(pubkey);
        return null;
      }
      await signerModeItem.setValue(msg.mode);
      // the key now in use, so everything keyed to it follows
      if (msg.mode === 'managed') await pubkeyItem.setValue((await managed.ensure()).pubkey);
      return null;
    }
    case 'identity-export': {
      if (!isExtensionPage(sender) || !sender.url?.startsWith(browser.runtime.getURL('/options.html'))) throw new Error('Not allowed');
      return { nsec: await managed.exportNsec() };
    }
    case 'identity-delete': {
      if (!isExtensionPage(sender)) throw new Error('Not allowed');
      const was = await managed.pubkey();
      await managed.forget();
      if ((await signerModeItem.getValue()) === 'managed') await signerModeItem.setValue('auto');
      if (was && (await pubkeyItem.getValue()) === was) await pubkeyItem.setValue(null);
      return null;
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
    case 'xap-totals': {
      if (!isXContentScript(sender) || sender.tab?.id == null) throw new Error('Not allowed');
      return lookups.xapTotals(msg.recipients, !!msg.fresh, sender.tab.id);
    }
    // RipleyOS only (its own wallet makes the receipt); the extension never sends it
    case 'xap-pending':
      throw new Error('Not allowed');
    case 'xap-publish': {
      checkShareMenuSender(sender, browser.runtime.id);
      if (!(await xmrSettingsItem.getValue()).tipReceipts) throw new Error('Xap receipts are turned off in XMRadar’s options');
      // one receipt every 10 s; each still needs the signer's own prompt
      const last = await xapLastItem.getValue();
      if (Date.now() - last < XAP_GAP_MS) throw new Error('RATE_LIMITED');
      await xapLastItem.setValue(Date.now());
      const res = await publishXap(msg, {
        query: xapPoolQuery,
        lookupRelays: xapLookupRelays,
        myRelays: resolveRelays,
        // the signer's key right now, not the one saved at the last test: the user may have switched accounts
        pubkey: testSigner,
        sign: signExact,
        publish: publishToRelays,
        record: async (s) => xapSentItem.setValue(withSent(await xapSentItem.getValue(), s)),
      });
      // the next ask, popup or action bar, goes to the relays
      await lookups.forgetXap(msg.recipient, msg.post);
      // published: the next Xap to this recipient (and post) gets a new mark
      // best effort: the receipt is out, so a storage error here must not read as a failed publish
      if (res.results.some((r) => r.ok))
        await xapMarksItem
          .getValue()
          .then((m) => xapMarksItem.setValue(withMark(m, markFor(msg.recipient, msg.address, msg.post), null, Date.now())))
          .catch(() => {});
      return res;
    }
    case 'x-live': {
      if (!isXContentScript(sender)) throw new Error('Not allowed');
      await liveInbox.heartbeat();
      return null;
    }
    case 'xo-send':
    case 'xo-undo': {
      // a real click on an X post's xo button, in the top frame of an x.com tab
      const xoTab = checkShareMenuSender(sender, browser.runtime.id);
      if (!xoButtonOn(await xmrSettingsItem.getValue())) throw new Error('xo is turned off in XMRadar’s options');
      if (typeof msg.post !== 'string' || !/^[1-9]\d{0,19}$/.test(msg.post)) throw new Error('Bad post');
      // one a second per tab
      const allowed = shareMenuRateLimit(await xoLastItem.getValue(), xoTab, Date.now(), 1000);
      if (!allowed) throw new Error('RATE_LIMITED');
      await xoLastItem.setValue(allowed);
      const sent = await xoSentItem.getValue();
      const nowSecs = Math.floor(Date.now() / 1000);
      if (msg.type === 'xo-send') {
        // no key known (PLAN-XOREACH): the xo goes to the handle and waits for its owner to set up
        const author = msg.author ?? null;
        if (author !== null && (typeof author !== 'string' || !/^[0-9a-f]{64}$/.test(author))) throw new Error('Bad author');
        if (typeof msg.handle !== 'string' || !HANDLE_RE.test(msg.handle)) throw new Error('Bad handle');
        // your own post too, as on X: it counts as one, shown from the sent record, never notified
        if (sent[msg.post]) return { ok: true, id: sent[msg.post]!.id };
        // one quiet visit to the signer page: its key and the signature together
        const { pubkey: me, event } = await signQuietly(xoTemplate(msg.post, author, msg.handle, nowSecs));
        const results = await publishToRelays(await xoRelays(me, author), event);
        if (!results.some((r) => r.ok)) return { ok: false, error: 'No relay took it' };
        await xoSentItem.setValue(rememberSent(await xoSentItem.getValue(), msg.post, { id: event.id, at: Date.now(), ...(author ? { author } : {}) })).catch(() => {});
        return { ok: true, id: event.id };
      }
      const mine = sent[msg.post];
      if (!mine) return { ok: true };
      const { pubkey: me, event } = await signQuietly(undoTemplate(mine.id, nowSecs));
      const results = await publishToRelays(await xoRelays(me, mine.author ?? null), event);
      // forgotten only once a relay took the deletion, so the button never says undone when it isn't
      if (!results.some((r) => r.ok)) return { ok: false, error: 'Couldn’t undo: no relay took it' };
      const rest = { ...(await xoSentItem.getValue()) };
      delete rest[msg.post];
      await xoSentItem.setValue(rest).catch(() => {});
      return { ok: true };
    }
    // the setup card on X (PLAN-XOREACH): a launcher only; keys and signing stay on extension pages
    case 'setup-card-state': {
      checkShareMenuSender(sender, browser.runtime.id);
      const pubkey = await pubkeyItem.getValue();
      if (!pubkey) return { complete: false };
      const known = await setupDoneItem.getValue();
      if (known?.pubkey === pubkey) return { complete: known.done };
      // not checked for this key yet: a proven handle is worth one status check, anything less isn't done
      if (!(await myHandleItem.getValue())?.proven) return { complete: false };
      try {
        await setupStatus();
        return { complete: !!(await setupDoneItem.getValue())?.done };
      } catch {
        return { complete: false };
      }
    }
    case 'open-setup': {
      const tabId = checkShareMenuSender(sender, browser.runtime.id);
      const hint = typeof msg.handleHint === 'string' && HANDLE_RE.test(msg.handleHint) ? msg.handleHint : '';
      await browser.tabs.create({ url: browser.runtime.getURL('/setup.html') + (hint ? `#${hint}` : ''), openerTabId: tabId, index: (sender.tab?.index ?? 0) + 1 });
      return null;
    }
    case 'proof-tweet-seen': {
      checkShareMenuSender(sender, browser.runtime.id);
      if (typeof msg.handle !== 'string' || !HANDLE_RE.test(msg.handle) || typeof msg.statusId !== 'string' || !/^[1-9]\d{0,19}$/.test(msg.statusId)) throw new Error('Bad tweet');
      const pubkey = await pubkeyItem.getValue();
      // only a suggestion for setup.html: linking still checks the tweet on X itself
      if (pubkey) await proofCandidateItem.setValue({ handle: msg.handle, statusId: msg.statusId, pubkey, at: Date.now() });
      return null;
    }
    case 'xap-post-totals': {
      if (!isXContentScript(sender) || sender.tab?.id == null) throw new Error('Not allowed');
      return lookups.xapPostTotals(msg.posts, !!msg.fresh, sender.tab.id);
    }
    case 'xmr-price': {
      // only a tip popup asks; those open on x.com only
      if (!isXContentScript(sender) || sender.tab?.id == null) throw new Error('Not allowed');
      return { usd: await lookups.xmrUsd() };
    }
    case 'resolve-handles': {
      if (!isXContentScript(sender) || sender.tab?.id == null) throw new Error('Not allowed');
      return lookups.resolveHandles(msg.handles, sender.tab.id);
    }
    case 'x-claims-seen': {
      if (!isXContentScript(sender)) throw new Error('Not allowed');
      return claims.seen(msg);
    }
    case 'setup-status': {
      if (!isExtensionPage(sender)) throw new Error('Not allowed');
      return setupStatus();
    }
    case 'xmrbio-list': {
      if (!isExtensionPage(sender)) throw new Error('Not allowed');
      return setupStatus(true);
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
      return lookups.xmrbioResolve(msg.handle);
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
    case 'receipt-found': {
      // the top frame of a tab; its URL comes from the browser, never from the message (PLAN-NKIP01 §4.2)
      const tabId = sender.tab?.id;
      const pageUrl = sender.tab?.url;
      if (sender.id !== browser.runtime.id || tabId == null || sender.frameId !== 0 || !pageUrl) throw new Error('Not allowed');
      if (!receiptsOn(await settingsItem.getValue())) throw new Error('Receipt checks are off');
      if (typeof msg.text !== 'string') throw new Error('Bad receipt');
      if (!receiptBudget(tabId)) throw new Error('Too many receipts on this page');
      return checkPageReceipt(msg.text, pageUrl, receiptDeps, { eventId: typeof msg.eventId === 'string' ? msg.eventId : undefined });
    }
    // which order this tab shows (PLAN-LOG §2), and letters found there: from the tab's URL, never the message
    case 'log-page':
      return letters().logPage(sender);
    case 'log-found':
      return letters().logFound(msg, sender);
    case 'receipt-badge': {
      // the receipt half of this tab's toolbar badge; the site half comes from 'site-info'
      const tabId = sender.tab?.id;
      if (sender.id !== browser.runtime.id || tabId == null || sender.frameId !== 0) throw new Error('Not allowed');
      if (!['ok', 'caution', 'warn', 'none'].includes(msg.level)) throw new Error('Bad level');
      await tabStateReady;
      const state = tabStates.get(tabId) ?? {};
      if (msg.level === 'none') delete state.receipt;
      else state.receipt = msg.level;
      tabStates.set(tabId, state);
      persistTabState();
      await applyBadge(tabId);
      return null;
    }
    case 'site-info': {
      // only the hostname arrives; the match runs here, on the device (PLAN-SITEFEED §2)
      const tabId = sender.tab?.id;
      if (sender.id !== browser.runtime.id || tabId == null || sender.frameId !== 0) throw new Error('Not allowed');
      const empty = { sites: [], outOfDate: false, issuedAt: null };
      if (!siteInfoOn(await xmrSettingsItem.getValue()) || typeof msg.host !== 'string') return empty;
      const feed = await siteFeedItem.getValue();
      if (!feed) return empty;
      const sites = sitesFor(feed, msg.host).map(publicSite);
      const lookalike = lookalikeOf(lookalikesFor(feed), msg.host);
      const info: SiteInfo = { sites, lookalike, outOfDate: Date.now() / 1000 >= feed.expiresAt, issuedAt: feed.issuedAt };
      await tabStateReady;
      const state = tabStates.get(tabId) ?? {};
      if (sites.length) state.site = { grade: worstGrade(sites), incident: sites.some((s) => s.incident), ...(leadSite(sites)?.intern ? { intern: true } : {}) };
      else delete state.site;
      if (lookalike) state.lookalike = lookalike.kind;
      else delete state.lookalike;
      tabStates.set(tabId, state);
      siteInfoByTab.set(tabId, info);
      persistTabState();
      await applyBadge(tabId);
      return info;
    }
    case 'guard-check':
    case 'guard-continue': {
      if (!isGuardPage(sender) || typeof msg.hash !== 'string') throw new Error('Not allowed');
      const [on, feed] = await guardInputs();
      if (msg.type === 'guard-continue') return guard.continue(msg.hash, on, feed);
      const a = await guard.check(msg.hash, on, feed);
      // the Report button: red, not listed yet, and the setting on; and whether this browser sent it already
      const flags = await reportFlags(a, copyReportsOn(await xmrSettingsItem.getValue()), guardReportedItem);
      return a.kind === 'red' && flags.report ? { ...a, ...flags } : a;
    }
    case 'guard-report': {
      if (!isGuardPage(sender) || typeof msg.hash !== 'string') throw new Error('Not allowed');
      const [on, feed] = await guardInputs();
      const a = await guard.check(msg.hash, on, feed);
      return { status: await reportCopy(a, copyReportsOn(await xmrSettingsItem.getValue()), guardReportedItem, (...args) => fetch(...args)) };
    }
    case 'site-tab': {
      // the popup asks by tab id, so it never needs the tab's URL
      if (!isExtensionPage(sender)) throw new Error('Not allowed');
      await tabStateReady;
      return siteInfoByTab.get(msg.tabId) ?? { sites: [], outOfDate: false, issuedAt: null };
    }
    case 'receipts-list': {
      if (!isExtensionPage(sender)) throw new Error('Not allowed');
      return (await idbReceiptStore.list()).sort((a, b) => b.savedAt - a.savedAt);
    }
    case 'receipt-delete': {
      if (!isExtensionPage(sender)) throw new Error('Not allowed');
      await idbReceiptStore.delete(msg.commitment);
      return null;
    }
    case 'receipt-export': {
      if (!isExtensionPage(sender)) throw new Error('Not allowed');
      const s = await idbReceiptStore.get(msg.commitment);
      if (!s) throw new Error('No such receipt');
      return buildExport(s, await idbReceiptStore.getPolicy(s.receipt.policy_hash), Date.now());
    }
    case 'record-links': {
      // one answer for the whole list; nothing when site info is off or the kept feed is out of date
      if (!isExtensionPage(sender)) throw new Error('Not allowed');
      const links: RecordLinks = { receipts: {}, letters: {} };
      if (!siteInfoOn(await xmrSettingsItem.getValue())) return links;
      const [feed, saved, kept] = await Promise.all([siteFeedItem.getValue(), idbReceiptStore.list(), idbLetterStore.list()]);
      const now = Date.now();
      for (const s of saved) {
        const l = receiptOrderLink(feed, s.receipt.issuer, s.receipt.order_id, now);
        if (l) links.receipts[s.commitment] = l;
      }
      for (const k of kept) {
        const l = letterOrderLink(feed, k.siteId, k.orderId, now);
        if (l) links.letters[k.id] = l;
      }
      return links;
    }
    case 'receipt-signature': {
      if (!isExtensionPage(sender)) throw new Error('Not allowed');
      const s = await idbReceiptStore.get(msg.commitment);
      if (!s) throw new Error('No such receipt');
      return savedSignatureLine(s);
    }
    case 'xap-inbox-check': {
      if (!isExtensionPage(sender)) throw new Error('Not allowed');
      await Promise.all([xapInbox.checkNow(), xoInbox.check()]);
      return null;
    }
    case 'update-check-now': {
      if (!isExtensionPage(sender)) throw new Error('Not allowed');
      return updates.checkNow();
    }
    case 'xap-inbox-read': {
      if (!isExtensionPage(sender)) throw new Error('Not allowed');
      await Promise.all([xapInbox.markRead(), xoInbox.markRead()]);
      return null;
    }
    case 'letters-list': {
      if (!isExtensionPage(sender)) throw new Error('Not allowed');
      return (await idbLetterStore.list()).sort((a, b) => b.savedAt - a.savedAt);
    }
    case 'letter-delete': {
      if (!isExtensionPage(sender)) throw new Error('Not allowed');
      await idbLetterStore.delete(msg.id);
      return null;
    }
    case 'letter-export': {
      if (!isExtensionPage(sender)) throw new Error('Not allowed');
      const l = await idbLetterStore.get(msg.id);
      if (!l) throw new Error('No such letter');
      return buildLetterExport(l, Date.now());
    }
    case 'receipt-record': {
      // only from Options, at the user's request, an hour after the order at the earliest (§12)
      if (!isExtensionPage(sender)) throw new Error('Not allowed');
      const found = await idbReceiptStore.get(msg.commitment);
      if (!found) throw new Error('No such receipt');
      // the manifest as it is now: a key revoked or relays changed since the order page count
      const fresh = await fetchManifest(found.receipt.issuer).catch(() => null);
      const s = fresh ? { ...found, manifest: fresh } : found;
      const mine = await resolveRelays((await pubkeyItem.getValue()) ?? '').catch(() => DEFAULT_RELAYS);
      const record = await checkPublicRecord(s, mine, (relay, filter) => readRelay(relay, filter, 5000), Date.now());
      await idbReceiptStore.put({ ...s, publicRecord: record });
      return record;
    }
  }
}

// ---- site info from the xmr.club feed (PLAN-SITEFEED) ----

const siteFeedItem = storage.defineItem<SiteFeed | null>('local:siteFeed', { fallback: null });

// the xmr.bio directory (2d): downloaded whole every hour while badges are on, never per handle
const directoryItem = storage.defineItem<StoredDirectory | null>('local:xmrbioDirectory', { fallback: null });
const directory = directoryKeeper({
  held: directoryItem,
  status: directoryStatusItem,
  fetch: (...args) => fetch(...args),
  readBody: boundedBody,
  alarms: browser.alarms,
  enabled: async () => (await xmrSettingsItem.getValue()).badgesX,
  // badges looked up before may now have, lose or change an xmr.bio entry; x.com tabs follow the status item
  changed: () => lookups.clearBadges(),
});
// exchange logos for the saved records: xmr.club's pack, named with its hash in the signed list (PLAN-LOGOS)
const logos = logoKeeper({
  held: logoPackItem,
  feed: () => siteFeedItem.getValue(),
  fetch: (...args) => fetch(...args),
  readBody: boundedBody,
  sha256Hex: (b) => sha256Hex(b as Uint8Array<ArrayBuffer>),
  enabled: async () => siteInfoOn(await xmrSettingsItem.getValue()),
});
const SITE_FEED_ALARM = 'site-feed';
const SITE_FEED_HOURS = 12;
const tabStates = new Map<number, TabState>();
const siteInfoByTab = new Map<number, SiteInfo>();
// the per-tab state outlives a suspended service worker: kept in session storage, loaded before use
const tabStateItem = storage.defineItem<[number, TabState, SiteInfo | null][]>('session:tabSiteState', { fallback: [] });
const tabStateReady = tabStateItem.getValue().then((rows) => {
  for (const [id, state, info] of Array.isArray(rows) ? rows : []) {
    if (!tabStates.has(id)) tabStates.set(id, state);
    if (info && !siteInfoByTab.has(id)) siteInfoByTab.set(id, info);
  }
});
let tabStateWrite: ReturnType<typeof setTimeout> | undefined;
function persistTabState() {
  clearTimeout(tabStateWrite);
  tabStateWrite = setTimeout(() => void tabStateItem.setValue([...tabStates].map(([id, s]) => [id, s, siteInfoByTab.get(id) ?? null])), 200);
}
/** Forget a tab's receipt and site state and clear its badge (navigation, close). */
async function dropTabState(tabId: number) {
  await tabStateReady;
  tabStates.delete(tabId);
  siteInfoByTab.delete(tabId);
  persistTabState();
  await clearTabBadge(tabId);
}

// both browsers take `text: null` for a tab (fall back to the global badge); the types don't say so
const badgeAction = browser.action as unknown as BadgeAction;
const clearTabBadge = (tabId: number) => setTabBadge(badgeAction, tabId, { text: '', color: '' });

/** The global badge and the icon's title, from the update state; cleared when up to date or switched off. */
async function syncUpdateBadge() {
  try {
    const b = updateBadge(await updateStateItem.getValue(), browser.runtime.getManifest().version, updateCheckOn(await settingsItem.getValue()));
    await setGlobalBadge(badgeAction, b);
  } catch (e) {
    // a storage hiccup only costs the ↑ until the next change
    console.warn('[XMRadar] update badge', (e as Error).message);
  }
}
// the brands of the feed in hand, rebuilt only when a newer feed arrives
let lookalikeCache: { issuedAt: number; index: LookalikeIndex } | null = null;
function lookalikesFor(feed: SiteFeed): LookalikeIndex {
  if (lookalikeCache?.issuedAt !== feed.issuedAt) lookalikeCache = { issuedAt: feed.issuedAt, index: lookalikeIndex(feed) };
  return lookalikeCache.index;
}

// ---- warnings before a page loads (PLAN-PRELOAD) ----

const dnr = (browser as unknown as { declarativeNetRequest?: DnrApi }).declarativeNetRequest;
const guard = guardKeeper({
  dnr,
  guardUrl: () => browser.runtime.getURL(GUARD_PATH),
  tokens: storage.defineItem<GuardTokens | null>('session:guardTokens', { fallback: null }),
  continued: storage.defineItem<Record<string, number>>('local:guardContinued', { fallback: {} }),
  continuedListed: storage.defineItem<Record<string, number>>('local:guardContinuedListed', { fallback: {} }),
  dismissed: storage.defineItem<Record<string, number>>('local:siteBannerDismissed', { fallback: {} }),
  now: Date.now,
  randomHex: () => [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join(''),
});
async function guardInputs(): Promise<[boolean, { index: LookalikeIndex; issuedAt: number } | null]> {
  const on = siteWarningsOn(await xmrSettingsItem.getValue());
  const feed = await siteFeedItem.getValue();
  return [on, feed ? { index: lookalikesFor(feed), issuedAt: feed.issuedAt } : null];
}
/** hosts reported to xmr.club from this browser, this session */
const guardReportedItem = storage.defineItem<string[]>('session:guardReported', { fallback: [] });
const applyGuard = () =>
  guardInputs()
    .then(([on, feed]) => guard.apply(on, feed))
    .catch((e) => console.warn('[XMRadar] guard rules', (e as Error).message));
/** Only XMRadar's guard page, open in a tab, may ask about a guarded address. */
function isGuardPage(sender: Browser.runtime.MessageSender): boolean {
  if (sender.id !== browser.runtime.id || sender.tab?.id == null || !sender.url) return false;
  try {
    const u = new URL(sender.url);
    return u.pathname === GUARD_PATH && (u.origin === new URL(browser.runtime.getURL('/')).origin || u.host === browser.runtime.id);
  } catch {
    return false;
  }
}
/** A copy no rule could list (look-alike letters, a listed copy) is replaced by the guard page once it starts loading. */
async function guardAfterLoad(tabId: number, url: string) {
  const [on, feed] = await guardInputs();
  await guard
    .afterLoad(url, on, feed, async (to) => {
      // still on exactly that address: a tab that moved on keeps its new page
      const tab = await browser.tabs.get(tabId).catch(() => null);
      if (tab?.url !== new URL(url).href) return;
      await browser.tabs.update(tabId, { url: to }).catch(() => {});
    })
    .catch(() => {});
}
/** The lookalike badge for a tab's new address, before (or without) its page loading. */
async function addressBadge(tabId: number, url: string) {
  let host: string;
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return;
    host = u.hostname;
  } catch {
    return;
  }
  if (!siteInfoOn(await xmrSettingsItem.getValue())) return;
  const feed = await siteFeedItem.getValue();
  const lookalike = feed && lookalikeOf(lookalikesFor(feed), host);
  if (!lookalike) return;
  await tabStateReady;
  const state = tabStates.get(tabId) ?? {};
  state.lookalike = lookalike.kind;
  tabStates.set(tabId, state);
  persistTabState();
  await applyBadge(tabId);
}

// bumped when the setting goes off, so a download that finishes later is dropped
let siteFeedGeneration = 0;

/** The toolbar badge for a tab, from its receipt and site state together (one owner, no flicker). */
async function applyBadge(tabId: number) {
  const { text, color } = badgeFor(tabStates.get(tabId) ?? {});
  await setTabBadge(badgeAction, tabId, { text, color });
}

/** Download the feed: no cookies or referrer, no redirects, JSON, 2 MB, 15 s; one at a time; kept only if it verifies and is newer. */
let siteFeedInFlight: Promise<void> | null = null;
const refreshSiteFeed = () => (siteFeedInFlight ??= downloadSiteFeed().finally(() => (siteFeedInFlight = null)));

async function downloadSiteFeed() {
  const generation = siteFeedGeneration;
  if (!siteInfoOn(await xmrSettingsItem.getValue())) return;
  try {
    const res = await fetch(FEED_URL, { credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (!/^application\/json\b/i.test(res.headers.get('content-type') ?? '')) throw new Error('Feed is not JSON');
    const text = new TextDecoder().decode(await boundedBody(res, 2 * 1024 * 1024));
    const kept = await siteFeedItem.getValue();
    // a copy an older XMRadar parsed doesn't block a same-age one parsed with more fields
    const keptAt = kept?.reader === FEED_READER_V ? kept.issuedAt : 0;
    const feed = readFeed(JSON.parse(text), Math.floor(Date.now() / 1000), keptAt);
    if (generation !== siteFeedGeneration || !siteInfoOn(await xmrSettingsItem.getValue())) return;
    await siteFeedItem.setValue(feed);
    void logos.sync(feed);
  } catch (e) {
    // the kept copy stays; the popup says when it's out of date
    console.warn('[XMRadar] site feed', (e as Error).message);
  }
}

async function applySiteInfoSetting(on: boolean) {
  if (on) {
    await browser.alarms.create(SITE_FEED_ALARM, { periodInMinutes: SITE_FEED_HOURS * 60 });
    const kept = await siteFeedItem.getValue();
    if (!kept || kept.reader !== FEED_READER_V || Date.now() / 1000 - kept.issuedAt > SITE_FEED_HOURS * 3600) await refreshSiteFeed();
    return;
  }
  siteFeedGeneration++;
  await browser.alarms.clear(SITE_FEED_ALARM);
  await siteFeedItem.removeValue();
  await logoPackItem.removeValue();
  await tabStateReady;
  siteInfoByTab.clear();
  for (const [tabId, state] of tabStates) {
    delete state.site;
    delete state.lookalike;
    await applyBadge(tabId);
  }
  persistTabState();
}


// at most 10 receipt checks per tab a minute: a page re-rendering doesn't refetch the manifest each time
const receiptChecks = new Map<number, number[]>();
function receiptBudget(tabId: number): boolean {
  const now = Date.now();
  const recent = (receiptChecks.get(tabId) ?? []).filter((t) => now - t < 60_000);
  if (recent.length >= 10) return false;
  receiptChecks.set(tabId, [...recent, now]);
  return true;
}

/** Letters of guarantee need both the receipt checks and the xmr.club feed (PLAN-LOG Round 3 switch matrix). */
const letterChecksOn = async () => receiptsOn(await settingsItem.getValue()) && siteInfoOn(await xmrSettingsItem.getValue());
const letters = () =>
  letterRequests({ runtimeId: browser.runtime.id, checksOn: letterChecksOn, feed: () => siteFeedItem.getValue(), budget: receiptBudget, verifyLetter, store: idbLetterStore, now: Date.now });

const receiptDeps: CheckDeps = {
  store: idbReceiptStore,
  // Firefox grants host access separately from install; Chrome grants <all_urls> at install
  hasAccess: (origin) => browser.permissions.contains({ origins: [`${origin}/*`] }),
};


// X self-claims (PLAN-XCLAIMS): what profiles you opened show about themselves, kept on this device only
const xClaimsItem = storage.defineItem<XClaimStore | null>('local:xClaims', { fallback: null });
const claims = claimKeeper({
  store: xClaimsItem,
  changedItem: xClaimsChangedItem,
  enabled: async () => xClaimsOn(await xmrSettingsItem.getValue()),
  dropBadge: (handle) => lookups.dropBadge(handle),
  dropAllBadges: () => lookups.clearBadges(),
});

// ---- which key signs (PLAN-MANAGEDID) ----

/** Key-bound state goes when the signing key changes; the inboxes already restart per key. */
async function rebindToKey() {
  await Promise.all([
    xoSentItem.setValue({}),
    xapSentItem.setValue([]),
    myHandleItem.getValue().then((m) => (m?.proven ? myHandleItem.setValue({ ...m, proven: false }) : undefined)),
  ]).catch((e) => console.warn('[XMRadar] identity rebind', (e as Error).message));
}


const managed = managedIdentity(idbKeyStore);

/**
 * `auto` (default): the user's signer; when the signer page finds none at all, the XMRadar identity, made
 * on first use and announced, and the mode becomes `managed` so later signatures skip the tab. A signer
 * that refuses or fails is never replaced. `signer` never uses the XMRadar identity; `managed` always does.
 */
async function managedFallback(): Promise<void> {
  const { created } = await managed.ensure();
  await signerModeItem.setValue('managed');
  if (created)
    await browser.notifications
      .create('xmradar-identity', {
        type: 'basic',
        iconUrl: browser.runtime.getURL('/icon/128.png'),
        title: 'XMRadar',
        message: 'No Nostr signer was found, so XMRadar made a Nostr identity for you. It’s kept in this browser only, without a password. See Options → Monero identity.',
      })
      .catch(() => {});
}

async function testSigner(): Promise<string> {
  const pubkey = await bySignerMode(await signerModeItem.getValue(), signerPubkey, async () => (await managed.ensure()).pubkey, managedFallback);
  await pubkeyItem.setValue(pubkey);
  return pubkey;
}

/**
 * Exactly this key signs this template. `pubkey` always comes from `testSigner`, which already chose the key
 * (and made the XMRadar identity when there's no signer), so there's no fallback here: falling back would
 * sign with a different key than the one asked for.
 */
async function signExact(template: EventTemplate, pubkey: string): Promise<Event> {
  const mode = await signerModeItem.getValue();
  if (mode === 'managed' || (await managed.pubkey()) === pubkey) {
    const event = await managed.sign(template);
    checkSigned(template, event, pubkey);
    return event;
  }
  return signerSignExact(template, pubkey);
}

async function signQuietly(template: EventTemplate): Promise<{ pubkey: string; event: Event }> {
  const out = await bySignerMode(
    await signerModeItem.getValue(),
    () => signerSignQuietly(template),
    async () => ({ pubkey: (await managed.ensure()).pubkey, event: await managed.sign(template) }),
    managedFallback,
  );
  checkSigned(template, out.event, out.pubkey);
  await pubkeyItem.setValue(out.pubkey);
  return out;
}

/** Extension pages have no window.nostr, so signer calls run in a throwaway tab on our own page (no script of its own). */
async function withSignerTab<T>(run: (tabId: number) => Promise<T>, active = true): Promise<T> {
  const tab = await browser.tabs.create({ url: SIGNER_PAGE, active });
  const tabId = tab.id!;
  try {
    await new Promise<void>((resolve, reject) => {
      const done = (err?: Error) => {
        clearTimeout(timer);
        browser.tabs.onUpdated.removeListener(listener);
        if (err) reject(err);
        else resolve();
      };
      const timer = setTimeout(() => done(new Error('Signer page did not load (xmradar.app)')), 15_000);
      const listener = (id: number, info: Browser.tabs.OnUpdatedInfo) => {
        if (id === tabId && info.status === 'complete') done();
      };
      browser.tabs.onUpdated.addListener(listener);
      // the page may have finished loading before the listener was attached
      void browser.tabs.get(tabId).then((t) => t.status === 'complete' && done(), () => {});
    });
    // the tab is visible, so make sure it's still the page we opened before running anything in it
    const now = await browser.tabs.get(tabId);
    if (!isSignerPage(now.url)) throw new Error('The signer tab was navigated away; try again');
    return await run(tabId);
  } finally {
    await browser.tabs.remove(tabId).catch(() => {});
  }
}

async function signerPubkey(): Promise<string> {
  const pubkey = await withSignerTab(async (tabId) => {
    const [res] = await browser.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: async () => {
        const w = window as unknown as { nostr?: { getPublicKey(): Promise<string> } };
        for (let i = 0; i < 30 && !w.nostr; i++) await new Promise((r) => setTimeout(r, 100));
        if (!w.nostr) return { noSigner: true, error: 'No NIP-07 signer found (install Alby or nos2x, or unlock it)' };
        try {
          return { pubkey: await w.nostr.getPublicKey() };
        } catch (e) {
          return { error: String((e as Error)?.message ?? e) };
        }
      },
    });
    const out = res?.result as { pubkey?: string; error?: string; noSigner?: boolean } | undefined;
    if (out?.noSigner) throw new NoSignerError(out.error);
    if (!out?.pubkey) throw new Error(out?.error ?? 'Signer test failed');
    return out.pubkey;
  });
  return pubkey;
}

/**
 * The signer's key and its signature of exactly this event, in one visit to the signer page, opened behind
 * the current tab (PLAN-MONEROLIKE: an xo shouldn't take the user away from X). The signer still shows its
 * own prompt when it asks. Checked against the template and the key it named.
 */
async function signerSignQuietly(template: EventTemplate): Promise<{ pubkey: string; event: Event }> {
  const out = await withSignerTab(async (tabId) => {
    const [res] = await browser.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      args: [template],
      func: async (ev: EventTemplate) => {
        const w = window as unknown as { nostr?: { getPublicKey(): Promise<string>; signEvent(e: EventTemplate): Promise<unknown> } };
        for (let i = 0; i < 30 && !w.nostr; i++) await new Promise((r) => setTimeout(r, 100));
        if (!w.nostr) return { noSigner: true, error: 'No NIP-07 signer found (install Alby or nos2x, or unlock it)' };
        try {
          const pubkey = await w.nostr.getPublicKey();
          return { pubkey, event: await w.nostr.signEvent(ev) };
        } catch (e) {
          return { error: String((e as Error)?.message ?? e) };
        }
      },
    });
    const r = res?.result as { pubkey?: string; event?: Event; error?: string; noSigner?: boolean } | undefined;
    if (r?.noSigner) throw new NoSignerError(r.error);
    if (!r?.pubkey || !r.event) throw new Error(r?.error ?? 'The signer did not sign');
    return { pubkey: r.pubkey, event: r.event };
  }, false);
  checkSigned(template, out.event, out.pubkey);
  return out;
}

/**
 * One-shot signing of exactly this event (PLAN-PHASE2 §4.8). It doesn't go through the page
 * bridge, whose allowlist stays {1, 24242}; the result is checked against the template.
 */
async function signerSignExact(template: EventTemplate, pubkey: string): Promise<Event> {
  const signed = await withSignerTab(async (tabId) => {
    const [res] = await browser.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      args: [template],
      func: async (ev: EventTemplate) => {
        const w = window as unknown as { nostr?: { signEvent(e: EventTemplate): Promise<unknown> } };
        for (let i = 0; i < 30 && !w.nostr; i++) await new Promise((r) => setTimeout(r, 100));
        if (!w.nostr) return { noSigner: true, error: 'No NIP-07 signer found (install Alby or nos2x, or unlock it)' };
        try {
          return { event: await w.nostr.signEvent(ev) };
        } catch (e) {
          return { error: String((e as Error)?.message ?? e) };
        }
      },
    });
    const out = res?.result as { event?: Event; error?: string; noSigner?: boolean } | undefined;
    if (out?.noSigner) throw new NoSignerError(out.error);
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


/** The user's own handle on xmr.bio, for the status panel (a click, never passive). */
async function xmrbioStatus(handle: string, pubkey: string): Promise<XmrbioStatus> {
  try {
    const r = await lookups.xmrbioResolve(handle);
    if (!r.found) return { found: false };
    // /resolve finds unlisted profiles too; the directory copy XMRadar holds is what badges come from
    const dir = await directoryItem.getValue().catch(() => null);
    const listed = dir ? dir.entries.some((e) => e.handle === handle.toLowerCase()) : undefined;
    return { found: true, address: r.identity.address, check: r.check, linked: xmrbioLinked(r.identity.proofs, pubkey), ...(listed === undefined ? {} : { listed }) };
  } catch (e) {
    return { found: 'error', reason: e instanceof Error ? e.message : String(e) };
  }
}

async function setupStatus(listNow = false): Promise<SetupStatus> {
  let status = await readSetupStatus();
  // "Also list me on xmr.bio" (PLAN-XMRBIOLIST): once the link is verified and xmr.bio doesn't know the handle
  const mine = await myHandleItem.getValue();
  const record = mine ? await listOnXmrbio(status, mine.handle, listNow) : null;
  if (record && record.status !== 'failed' && status.xmrbio?.found !== true && mine) status = { ...status, xmrbio: await xmrbioStatus(mine.handle, status.pubkey) };
  status = { ...status, listing: record ? { status: record.status, at: record.at, ...(record.error ? { error: record.error } : {}) } : null };
  await setupStatusLast.setValue({ at: Date.now(), status });
  await setupDoneItem.setValue({ pubkey: status.pubkey, done: !!status.address?.check.ok && status.link?.proof.status === 'verified' }).catch(() => {});
  return status;
}

let listQueue: Promise<unknown> = Promise.resolve();
/**
 * Lists the linked account on xmr.bio, at most once per handle + key + address unless `explicit` (the button):
 * only with a verified link, a valid standard address or subaddress, and xmr.bio not knowing the handle (the
 * button also tries when xmr.bio couldn't be asked; the server refuses an existing profile). A profile deleted
 * on xmr.bio is never listed again on its own: its record stays until the button is pressed.
 */
function listOnXmrbio(status: SetupStatus, handle: string, explicit: boolean): Promise<ListRecord | null> {
  // queued, never merged: two automatic checks at once send once (the second sees the record), and a click
  // always gets its own try after whatever is running
  const run = listQueue.then(() => listOnce(status, handle, explicit));
  listQueue = run.catch(() => {});
  return run;
}

async function listOnce(status: SetupStatus, handle: string, explicit: boolean): Promise<ListRecord | null> {
  const plan = listPlan(status, handle, { explicit, pref: await xmrbioListPrefItem.getValue(), records: await xmrbioListItem.getValue() });
  if (!plan.send) return plan.had;
  const { key, address, tweetId } = plan;
  let outcome: ListRecord;
  try {
    const event = await signExact(registerTemplate(plan.handle, address, tweetId, Math.floor(Date.now() / 1000)), status.pubkey);
    const res = await fetch(XMRBIO_REGISTER_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ handle: plan.handle, address, tweet_id: tweetId, event }),
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      redirect: 'error',
      // the server's X lookups stop at 12 s
      signal: AbortSignal.timeout(20_000),
    });
    let body: { success?: boolean; error?: unknown; reason?: unknown } | null = null;
    try {
      body = JSON.parse(await cappedText(res, 4096));
    } catch {
      body = null;
    }
    outcome = { ...listOutcome(res.status, body), at: Date.now() };
  } catch (e) {
    outcome = { status: 'failed', at: Date.now(), error: (e as Error).message.slice(0, 200) };
  }
  await xmrbioListItem.setValue({ ...(await xmrbioListItem.getValue()), [key]: outcome }).catch(() => {});
  return outcome;
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
      const proof = await lookups.verify(claim.handle, claim.tweetId, pubkey);
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
