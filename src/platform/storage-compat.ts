/**
 * Fallback storage shim for runtimes where `browser.storage.sync` or `browser.storage.session`
 * is undefined (PLAN-ANDROID). Desktop Chrome, Firefox, and Firefox Android 140+ expose both
 * areas natively, so this is a no-op there.
 *
 * - Missing `sync` delegates to `browser.storage.local` under a namespaced prefix.
 * - Missing `session` uses an in-memory Map so guard tokens, SIWM challenges, and composer
 *   sessions never persist across app restarts.
 */

export interface SimpleStorageArea {
  get(keys?: string | string[] | Record<string, unknown> | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
  clear(): Promise<void>;
}

export interface StorageNamespaceLike {
  local?: SimpleStorageArea;
  sync?: SimpleStorageArea;
  session?: SimpleStorageArea;
}

const SYNC_PREFIX = '__xmradar_sync__:';

function normalizeKeys(keys: string | string[] | Record<string, unknown> | null | undefined): { list: string[] | null; defaults: Record<string, unknown> } {
  if (keys == null) return { list: null, defaults: {} };
  if (typeof keys === 'string') return { list: [keys], defaults: {} };
  if (Array.isArray(keys)) return { list: keys, defaults: {} };
  return { list: Object.keys(keys), defaults: keys };
}

export function createPrefixedLocalArea(local: SimpleStorageArea, prefix = SYNC_PREFIX): SimpleStorageArea {
  return {
    async get(keys) {
      const { list, defaults } = normalizeKeys(keys);
      if (list === null) {
        const all = await local.get(null);
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(all)) {
          if (k.startsWith(prefix)) out[k.slice(prefix.length)] = v;
        }
        return out;
      }
      const raw = await local.get(list.map((k) => prefix + k));
      const out: Record<string, unknown> = {};
      for (const k of list) {
        const pk = prefix + k;
        if (pk in raw) out[k] = raw[pk];
        else if (k in defaults) out[k] = defaults[k];
      }
      return out;
    },
    async set(items) {
      const mapped: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(items)) mapped[prefix + k] = v;
      await local.set(mapped);
    },
    async remove(keys) {
      const list = Array.isArray(keys) ? keys : [keys];
      await local.remove(list.map((k) => prefix + k));
    },
    async clear() {
      const all = await local.get(null);
      const owned = Object.keys(all).filter((k) => k.startsWith(prefix));
      if (owned.length) await local.remove(owned);
    },
  };
}

export function createMemoryStorageArea(): SimpleStorageArea {
  const map = new Map<string, unknown>();
  return {
    async get(keys) {
      const { list, defaults } = normalizeKeys(keys);
      if (list === null) return Object.fromEntries(map.entries());
      const out: Record<string, unknown> = {};
      for (const k of list) {
        if (map.has(k)) out[k] = map.get(k);
        else if (k in defaults) out[k] = defaults[k];
      }
      return out;
    },
    async set(items) {
      for (const [k, v] of Object.entries(items)) map.set(k, v);
    },
    async remove(keys) {
      for (const k of Array.isArray(keys) ? keys : [keys]) map.delete(k);
    },
    async clear() {
      map.clear();
    },
  };
}

/** Patches missing `sync` or `session` areas onto `storageApi` in place (safe against frozen/read-only objects). */
export function installStorageFallback(storageApi: StorageNamespaceLike | null | undefined): { patchedSync: boolean; patchedSession: boolean } {
  let patchedSync = false;
  let patchedSession = false;
  if (!storageApi) return { patchedSync, patchedSession };
  if (!storageApi.sync && storageApi.local) {
    try {
      storageApi.sync = createPrefixedLocalArea(storageApi.local);
      patchedSync = true;
    } catch {
      // read-only / non-configurable getter on browser.storage: leave untouched rather than crashing import
    }
  }
  if (!storageApi.session) {
    try {
      storageApi.session = createMemoryStorageArea();
      patchedSession = true;
    } catch {
      // read-only / non-configurable getter on browser.storage
    }
  }
  return { patchedSync, patchedSession };
}

/** Applies the fallback to WXT's `browser.storage` binding when running in an extension context. */
export function ensureBrowserStorage(browserObj?: { storage?: StorageNamespaceLike }): void {
  const b = browserObj ?? (globalThis as { browser?: { storage?: StorageNamespaceLike } }).browser;
  if (b?.storage) installStorageFallback(b.storage);
}
