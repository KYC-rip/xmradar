/**
 * `wxt/utils/storage` for the Ripley X bundle (aliased in vite.ripley.config.ts). There is no extension
 * storage in X's page: values come from Ripley — seeded with the bundle (`__xmradarRipleyState`, keyed like
 * WXT's `local:…` / `sync:…` keys) and replaced by `xmradar:state` events when a switch changes. Writes stay
 * in this page's memory (an xap amount's mark, which xo buttons were seen) and are never sent anywhere.
 *
 * Nothing here is trusted by Ripley: X's own scripts share this page and could change these values, so the
 * answers that matter (badges, totals) are decided by Ripley with its own settings, not from this state.
 */
type Watcher<T> = (value: T, old: T) => void;

const values = new Map<string, unknown>();
const watchers = new Map<string, Set<Watcher<unknown>>>();

/** Ripley's values for these keys, replacing what the page held; watchers see each change. */
export function applyState(state: unknown) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return;
  for (const [key, value] of Object.entries(state as Record<string, unknown>)) {
    const old = values.get(key);
    values.set(key, value);
    for (const w of watchers.get(key) ?? []) w(value, old);
  }
}

export interface RipleyItem<T> {
  readonly key: string;
  readonly fallback: T;
  readonly defaultValue: T;
  getValue(): Promise<T>;
  setValue(value: T): Promise<void>;
  removeValue(): Promise<void>;
  watch(cb: Watcher<T>): () => void;
}

function defineItem<T>(key: string, opts: { fallback?: T; defaultValue?: T } = {}): RipleyItem<T> {
  const fallback = (opts.fallback ?? opts.defaultValue ?? null) as T;
  const read = (): T => (values.has(key) && values.get(key) != null ? (values.get(key) as T) : fallback);
  return {
    key,
    fallback,
    defaultValue: fallback,
    getValue: async () => read(),
    setValue: async (value) => applyState({ [key]: value }),
    removeValue: async () => applyState({ [key]: null }),
    watch(cb) {
      const set = watchers.get(key) ?? new Set();
      watchers.set(key, set);
      // WXT hands watchers the fallback for a missing value
      const w: Watcher<unknown> = (v, o) => cb((v ?? fallback) as T, (o ?? fallback) as T);
      set.add(w);
      return () => set.delete(w);
    },
  };
}

export const storage = { defineItem };
export type WxtStorageItem<T, _M = unknown> = RipleyItem<T>;
