import type { XoInbox } from './xo/inbox';
import type { LikerCache } from './xo/verify';
import type { SyncedPosts } from './nostr/synced';
import type { DirectoryStatus } from './identity/directory';
import type { InboxState } from './xap/inbox';
import { storage, type WxtStorageItem } from 'wxt/utils/storage';
import type { Marks } from './xap/marks';
import type { UpdateState } from './update/check';
import type { LogoPack } from './sites/logos';
import { isBadgeIcon, type BadgeIcon } from './identity/badge-look';

export const DEFAULT_RELAYS = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net'];
/**
 * Where posts go when you have neither your own list nor a NIP-65 list (PLAN-RELAYDEFAULTS): the defaults
 * plus two more popular relays that are free to write to, so a post still lands when one is down. Only
 * posts use these two; every lookup stays on DEFAULT_RELAYS.
 */
export const POST_FALLBACK_RELAYS = [...DEFAULT_RELAYS, 'wss://nostr.mom', 'wss://relay.ditto.pub'];
/**
 * Relays that keep profiles and relay/payment lists but refuse notes: read for relay
 * lists, identity setup and badge discovery. Only kind 10133 is published to them
 * (10011 support is unverified), and never posts.
 */
export const INDEX_RELAYS = ['wss://purplepag.es'];
const isIndexRelay = (url: string) => INDEX_RELAYS.includes(url.trim().replace(/\/+$/, '').toLowerCase());
export const withoutIndex = (relays: string[]) => relays.filter((r) => !isIndexRelay(r));
export const DEFAULT_BLOSSOM = 'https://blossom.primal.net';

export interface Settings {
  /** Manually configured relays; empty means "use NIP-65, then defaults". */
  relays: string[];
  blossomServer: string;
  appendSourceLink: boolean;
  debug: boolean;
  /** "Copy to Nostr" in X's share menu; read with `shareMenuOn`, since settings saved before it lack the field. */
  shareMenuX?: boolean;
  /** "Check receipts on swap pages" (NKIP-0001); read with `receiptsOn`, on unless switched off */
  receiptsCheck?: boolean;
  /** "Fetch letters of guarantee on order pages" (PLAN-LOG Round 2 item 9); read with `logFetchOn`, on unless switched off */
  logFetch?: boolean;
  /** "Remove X's share tracking from links"; read with `cleanXLinksOn`, on unless switched off */
  cleanXLinks?: boolean;
  /** "Mark posts on X that you copied to Nostr" (PLAN-SYNCEDMARK); read with `syncedMarkOn`, on unless switched off */
  syncedMark?: boolean;
  /** Tags every copy starts with (PLAN-TAGS) */
  defaultTags?: string[];
  /** "Also add tags as #hashtags at the end of the note"; read with `hashtagLineOn`, on unless switched off */
  hashtagLine?: boolean;
  /** "Check for updates once a day" (PLAN-UPDATECHECK); read with `updateCheckOn`, on unless switched off */
  updateCheck?: boolean;
  /** "Post to my NIP-65 relay list when the box above is empty" (PLAN-NIP65SWITCH); read with `useNip65On`, on unless switched off */
  useNip65?: boolean;
  /** "Help with Sign in with Monero links" (PLAN-SIWM); read with `siwmHelperOn`, on unless switched off */
  siwmHelper?: boolean;
}

export const shareMenuOn = (s: Partial<Settings> | null | undefined) => s?.shareMenuX !== false;
export const receiptsOn = (s: Partial<Settings> | null | undefined) => s?.receiptsCheck !== false;
export const cleanXLinksOn = (s: Partial<Settings> | null | undefined) => s?.cleanXLinks !== false;
export const syncedMarkOn = (s: Partial<Settings> | null | undefined) => s?.syncedMark !== false;
export const hashtagLineOn = (s: Partial<Settings> | null | undefined) => s?.hashtagLine !== false;
export const useNip65On = (s: Partial<Settings> | null | undefined) => s?.useNip65 !== false;
export const siwmHelperOn = (s: Partial<Settings> | null | undefined) => s?.siwmHelper !== false;
export const updateCheckOn = (s: Partial<Settings> | null | undefined) => s?.updateCheck !== false;
export const logFetchOn = (s: Partial<Settings> | null | undefined) => receiptsOn(s) && s?.logFetch !== false;

export const settingsItem = storage.defineItem<Settings>('sync:settings', {
  fallback: { relays: [], blossomServer: DEFAULT_BLOSSOM, appendSourceLink: false, debug: false },
});

/** Merges changes into an object item. Writes from one page run in order, so two autosaves can't drop each other's change. */
function patcher<T extends object>(item: WxtStorageItem<T, Record<string, unknown>>) {
  let writes: Promise<unknown> = Promise.resolve();
  return (patch: Partial<T>): Promise<void> => {
    const write = writes.then(async () => item.setValue({ ...(await item.getValue()), ...patch }));
    writes = write.catch(() => {});
    return write;
  };
}

export const patchSettings = patcher(settingsItem);
/** xmr.club's exchange logos for the saved swap records (PLAN-LOGOS); kept only while site info is on */
export const logoPackItem = storage.defineItem<LogoPack | null>('local:logoPack', { fallback: null });
/** the daily update check's last answer (PLAN-UPDATECHECK) */
export const updateStateItem = storage.defineItem<UpdateState | null>('local:updateCheck', { fallback: null });

/**
 * AI tag suggestions (PLAN-TAGS), per browser: a local model first, or a provider with the user's key.
 * Off by default. The key is its own `local:` item, never synced and never sent to a content script.
 */
export type AiSource = 'local' | 'openai' | 'anthropic';
export interface AiTagSettings {
  on: boolean;
  source: AiSource;
  /** the local or OpenAI-compatible base URL (unused for Anthropic) */
  baseUrl: string;
  model: string;
  /** ask as the composer opens, without a click on Suggest (unset: `autoOn`) */
  auto?: boolean;
  /** the answer goes straight into the tags (default tags the model drops stay one click away) */
  autoAdd?: boolean;
}
/** Unset means on for a local model (nothing leaves the computer) and off for a provider; a choice always wins. */
export const autoOn = (s: Partial<AiTagSettings> | null | undefined) => s?.auto ?? s?.source === 'local';
export const autoAddOn = (s: Partial<AiTagSettings> | null | undefined) => s?.autoAdd ?? s?.source === 'local';
export const DEFAULT_AI_TAGS: AiTagSettings = { on: false, source: 'local', baseUrl: 'http://localhost:11434', model: '' };
export const aiTagsItem = storage.defineItem<AiTagSettings>('local:aiTags', { fallback: DEFAULT_AI_TAGS });
export const aiKeyItem = storage.defineItem<string>('local:aiKey', { fallback: '' });
export const patchAiTags = patcher(aiTagsItem);

/** Last pubkey seen from the signer, used by the options page for NIP-65 lookups. */
/** your NIP-65 write relays as last read, for an hour (PLAN-RELAYDEFAULTS) */
export const nip65CacheItem = storage.defineItem<{ pubkey: string; relays: string[]; at: number } | null>('local:nip65Cache', { fallback: null });
export const pubkeyItem = storage.defineItem<string | null>('local:pubkey', { fallback: null });

/** Hashes of already-published (normalized source URL + content). */
export const postedItem = storage.defineItem<string[]>('local:posted', { fallback: [] });

/** X posts copied to Nostr, by status id (PLAN-SYNCEDMARK); recorded whatever the mark switch says, shown only when it's on. */
export const syncedPostsItem = storage.defineItem<SyncedPosts>('local:syncedPosts', { fallback: {} });

export function parseRelayList(text: string): string[] {
  const out = new Set<string>();
  for (const raw of text.split(/[\s,]+/)) {
    let u: URL;
    try {
      u = new URL(raw.trim());
    } catch {
      continue;
    }
    const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
    if (u.protocol === 'wss:' || (u.protocol === 'ws:' && local)) out.add(u.toString().replace(/\/+$/, ''));
  }
  return [...out];
}

export interface XmrSettingsV2 {
  /** Show Monero badges on X. */
  badgesX: boolean;
  /** Show Monero badges on Nostr web clients (read from R2 on). */
  badgesNostr: boolean;
  /** Look up NIP-39/NIP-A3 claims on relays for handles on screen (relays and X can see which handles). */
  nostrDiscovery: boolean;
  /** Ask to publish a Xap receipt (NKIP-0002 kind 9042) after a tip. */
  tipReceipts: boolean;
}

export interface XmrSettings extends XmrSettingsV2 {
  /** The badge's icon; read through `badgeLook`, which fills in defaults. */
  badgeIcon: BadgeIcon;
  /** Show "XMR" next to the icon (always on with no icon). */
  badgeLabel: boolean;
  /** "Site info from xmr.club" (PLAN-SITEFEED); read with `siteInfoOn`, on unless switched off */
  siteInfo?: boolean;
  /** "In-page warnings" for an incident or a D–F grade; read with `siteWarningsOn` */
  siteWarnings?: boolean;
  /** read addresses, npubs and xmr.bio links from X profiles (PLAN-XCLAIMS); read with `xClaimsOn` */
  xClaims?: boolean;
  /** "Report button on the warning page" (PLAN-NAMEPILL-REPORT); read with `copyReportsOn`, on unless switched off */
  copyReports?: boolean;
  /** "Tell me when I get a Xap" (PLAN-XAPINBOX); read with `xapNotifyOn`, off unless switched on. Also covers xos. */
  xapNotify?: boolean;
  /** the xo button on X posts (PLAN-MONEROLIKE); read with `xoButtonOn`, on unless switched off */
  xoButton?: boolean;
  /** a plain click on xo also likes the post on X (PLAN-XOLIKE); off unless switched on (a hold always does) */
  xoAlsoLike?: boolean;
}

export const siteInfoOn = (s: Partial<XmrSettings> | null | undefined) => s?.siteInfo !== false;
/** X self-claims are read only while X badges are on, and unless switched off */
export const xClaimsOn = (s: Partial<XmrSettings> | null | undefined) => !!s?.badgesX && s?.xClaims !== false;
export const siteWarningsOn = (s: Partial<XmrSettings> | null | undefined) => siteInfoOn(s) && s?.siteWarnings !== false;
export const copyReportsOn = (s: Partial<XmrSettings> | null | undefined) => siteWarningsOn(s) && s?.copyReports !== false;
/** asking relays for Xaps to the user's key links this browser to it, so it's off unless switched on */
export const xapNotifyOn = (s: Partial<XmrSettings> | null | undefined) => s?.xapNotify === true;
export const xoButtonOn = (s: Partial<XmrSettings> | null | undefined) => s?.xoButton !== false;

/** v1, before the redesign: one switch for X badges. */
export interface XmrSettingsV1 {
  badges: boolean;
  nostrDiscovery: boolean;
}

export const migrateXmrSettingsV2 = (v: XmrSettingsV1): XmrSettingsV2 => ({
  badgesX: v.badges,
  badgesNostr: v.badges,
  nostrDiscovery: v.nostrDiscovery,
  tipReceipts: true,
});

/** v3 adds the badge look; values already there (e.g. synced from a newer device) are kept. */
export const migrateXmrSettingsV3 = (v: XmrSettingsV2 & Partial<Pick<XmrSettings, 'badgeIcon' | 'badgeLabel'>>): XmrSettings => ({
  ...v,
  badgeIcon: isBadgeIcon(v.badgeIcon) ? v.badgeIcon : 'mono',
  badgeLabel: typeof v.badgeLabel === 'boolean' ? v.badgeLabel : true,
});

// a separate item, so settings saved before Phase 2 need no migration
export const xmrSettingsItem = storage.defineItem<XmrSettings>('sync:xmrSettings', {
  fallback: { badgesX: true, badgesNostr: true, nostrDiscovery: false, tipReceipts: true, badgeIcon: 'mono', badgeLabel: true },
  version: 3,
  migrations: { 2: migrateXmrSettingsV2, 3: migrateXmrSettingsV3 },
});
export const patchXmrSettings = patcher(xmrSettingsItem);

/** The user's own X handle; `proven` once their NIP-39 proof tweet passed. Used by the identity setup and status. */
/** the marks that make each Xap's amount unique, kept per recipient (src/xap/marks.ts) */
export const xapMarksItem = storage.defineItem<Marks>('local:xapMarks', { fallback: [] });

/** xo (PLAN-MONEROLIKE): the user's own xos by post, received xos, their counts, and senders already checked */
export const xoSentItem = storage.defineItem<Record<string, { id: string; at: number; author?: string }>>('local:xoSent', { fallback: {} });
export const xoInboxItem = storage.defineItem<XoInbox | null>('local:xoInbox', { fallback: null });
export const xoCountsItem = storage.defineItem<Record<string, number>>('local:xoCounts', { fallback: {} });
export const xoLikersItem = storage.defineItem<LikerCache>('local:xoLikers', { fallback: {} });
/** Which key signs (PLAN-MANAGEDID): the user's signer, else the XMRadar identity when none is found (`auto`). */
export type SignerMode = 'auto' | 'signer' | 'managed';
export const signerModeItem = storage.defineItem<SignerMode>('local:signerMode', { fallback: 'auto' });
/** "Also list me on xmr.bio" (PLAN-XMRBIOLIST): on unless unticked, which stays for every later key and address */
export const xmrbioListPrefItem = storage.defineItem<'on' | 'off'>('local:xmrbioListPref', { fallback: 'on' });
export const xmrbioListItem = storage.defineItem<Record<string, { status: 'listed' | 'exists' | 'exists-unlisted' | 'failed'; at: number; error?: string }>>('local:xmrbioList', { fallback: {} });
export const myHandleItem = storage.defineItem<{ handle: string; proven: boolean } | null>('local:myHandle', { fallback: null });

/** The xmr.bio directory (2d) as the options page shows it; the directory itself is kept by the background. */
export const directoryStatusItem = storage.defineItem<DirectoryStatus | null>('local:xmrbioDirectoryStatus', { fallback: null });

/** A handle whose X self-claims changed: x.com tabs drop its badge and look it up again. */
/** Days after which saved letters and receipts are deleted (0: keep; 90 unless chosen); per browser, like the records (PLAN-AUTOCLEAN) */
export const swapRecordDaysItem = storage.defineItem<number>('local:swapRecordDays', { fallback: 90 });
/** The last automatic clean-up that deleted something, for the options page to reload its list */
export const swapRecordsCleanedItem = storage.defineItem<{ at: number; receipts: number; letters: number } | null>('local:swapRecordsCleaned', { fallback: null });
// the Xap inbox (PLAN-XAPINBOX): this device only, dropped when switched off or the key changes
export const xapInboxItem = storage.defineItem<InboxState | null>('local:xapInbox', { fallback: null });
export const xClaimsChangedItem = storage.defineItem<{ handle: string; at: number } | null>('local:xClaimsChanged', { fallback: null });
