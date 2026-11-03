import { DEFAULT_RELAYS, INDEX_RELAYS, POST_FALLBACK_RELAYS, withoutIndex } from '../settings';

/**
 * Where posts go (PLAN-RELAYDEFAULTS): your own list, else your NIP-65 write relays, else XMRadar's picks.
 * Lookups use the same answer but fall back to the 3 defaults only, so no extra relay sees them.
 */

export type PostRelaySource = 'manual' | 'nip65' | 'fallback';
export interface PostRelays {
  relays: string[];
  source: PostRelaySource;
  /** a manual list was set, but only with relays that refuse notes */
  indexOnlyManual?: boolean;
  /** the NIP-65 list is switched off for posts (PLAN-NIP65SWITCH) */
  nip65Off?: boolean;
}

export interface Nip65Cache {
  pubkey: string;
  relays: string[];
  at: number;
}

export const NIP65_TTL_MS = 60 * 60_000;

export interface PostRelayDeps {
  manual(): Promise<string[]>;
  /** whether the NIP-65 list may be used; lookups always pass true, posts pass the switch */
  useNip65(): Promise<boolean>;
  cached(): Promise<Nip65Cache | null>;
  /** the NIP-65 write relays; absent for an answer that must not touch the network */
  fetch?: (pubkey: string) => Promise<string[]>;
  saveCache(c: Nip65Cache): Promise<void>;
  now?: () => number;
}

export async function resolvePostRelays(pubkey: string | null, deps: PostRelayDeps): Promise<PostRelays> {
  const now = deps.now ?? Date.now;
  const manualAll = await deps.manual();
  const manual = withoutIndex(manualAll);
  if (manual.length) return { relays: manual, source: 'manual' };
  const flag = manualAll.length ? { indexOnlyManual: true } : {};
  // switched off: neither the cache nor any relay is asked for the list
  if (!(await deps.useNip65())) return { relays: [...POST_FALLBACK_RELAYS], source: 'fallback', ...flag, nip65Off: true };
  if (pubkey) {
    const c = await deps.cached();
    const fresh = c?.pubkey === pubkey && now() - c.at < NIP65_TTL_MS ? withoutIndex(c.relays) : [];
    if (fresh.length) return { relays: fresh, source: 'nip65', ...flag };
    if (deps.fetch) {
      const found = withoutIndex(await deps.fetch(pubkey).catch(() => []));
      if (found.length) {
        await deps.saveCache({ pubkey, relays: found, at: now() });
        return { relays: found, source: 'nip65', ...flag };
      }
    }
  }
  return { relays: [...POST_FALLBACK_RELAYS], source: 'fallback', ...flag };
}

/** The same answer for lookups: the fallback is the 3 defaults, never the wider post list. */
export const readRelaysOf = (r: PostRelays) => (r.source === 'fallback' ? [...DEFAULT_RELAYS] : r.relays);

/** A retry may go only to relays the first publish of that session used. */
export const republishAllowed = (stored: string[] | undefined, requested: unknown): string[] =>
  stored && Array.isArray(requested) ? requested.filter((r): r is string => typeof r === 'string' && stored.includes(r)) : [];

const host = (url: string) => url.replace(/^wss?:\/\//, '').replace(/\/+$/, '');

/** The line under the relay box in Options; empty when the chips already say it all. */
export function relaysInUseText(r: PostRelays, hasPubkey: boolean): string {
  const index = r.indexOnlyManual ? `${INDEX_RELAYS.map(host).join(', ')} keeps profiles only, so notes go elsewhere. ` : '';
  if (r.source === 'manual') return '';
  const list = r.relays.map(host).join(', ');
  if (r.source === 'nip65') return `${index}In use: ${list} (your NIP-65 relay list).`;
  if (r.nip65Off) return `${index}In use: ${list} (XMRadar's picks).`;
  if (!hasPubkey) return `${index}In use: ${list} (XMRadar's picks). Connect your signer and XMRadar uses your NIP-65 relay list instead, if you have one.`;
  return `${index}When you post, XMRadar uses your NIP-65 relay list if you have one, otherwise ${list}.`;
}
