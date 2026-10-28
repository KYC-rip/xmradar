import { storage, type WxtStorageItem } from 'wxt/utils/storage';
import type { Marks } from './xap/marks';
import { isBadgeIcon, type BadgeIcon } from './identity/badge-look';

export const DEFAULT_RELAYS = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net'];
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
}

export const shareMenuOn = (s: Partial<Settings> | null | undefined) => s?.shareMenuX !== false;

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

/** Last pubkey seen from the signer, used by the options page for NIP-65 lookups. */
export const pubkeyItem = storage.defineItem<string | null>('local:pubkey', { fallback: null });

/** Hashes of already-published (normalized source URL + content). */
export const postedItem = storage.defineItem<string[]>('local:posted', { fallback: [] });

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
}

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
export const myHandleItem = storage.defineItem<{ handle: string; proven: boolean } | null>('local:myHandle', { fallback: null });
