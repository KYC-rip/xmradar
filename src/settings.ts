import { storage } from 'wxt/utils/storage';

export const DEFAULT_RELAYS = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net'];
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
