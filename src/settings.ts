import { storage } from 'wxt/utils/storage';

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
}

export const settingsItem = storage.defineItem<Settings>('sync:settings', {
  fallback: { relays: [], blossomServer: DEFAULT_BLOSSOM, appendSourceLink: false, debug: false },
});

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

export interface XmrSettings {
  /** Show Monero badges on X. */
  badges: boolean;
  /** Look up NIP-39/NIP-A3 claims on relays for handles on screen (relays and X can see which handles). */
  nostrDiscovery: boolean;
}

// a separate item, so settings saved before Phase 2 need no migration
export const xmrSettingsItem = storage.defineItem<XmrSettings>('sync:xmrSettings', {
  fallback: { badges: true, nostrDiscovery: false },
});

/** The user's own X handle; `proven` once their NIP-39 proof tweet passed. Used to hide their own badge. */
export const myHandleItem = storage.defineItem<{ handle: string; proven: boolean } | null>('local:myHandle', { fallback: null });
