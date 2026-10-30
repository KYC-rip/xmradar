import { validateMoneroAddress } from '../xmr/address';
import { PINNED_XMRBIO_KEYS, toTimestamp, verifySignedEnvelope } from './envelope';
import type { BadgeEntry } from './resolve';
import { XMRBIO_API } from './xmrbio';

/**
 * Passive source A (PLAN-PHASE2 §4.3, 2d): xmr.bio's signed directory of listed, X-verified profiles,
 * downloaded whole so xmr.bio never learns which accounts you look at. Contract (PLAN-KYCRIP K1):
 * 404 = not live yet, 503 = no build (keep ours), `X-Directory-Stale: 1` = usable but old, an older
 * `generated_at` than ours = ignored silently, more than 10 minutes in the future = a trust event (DIR-1).
 */

export const DIRECTORY_URL = `${XMRBIO_API}/directory`;
export const DIRECTORY_HOURS = 6;
export const DIRECTORY_MAX_BYTES = 4 * 1024 * 1024;
const FUTURE_MS = 10 * 60_000;
const HANDLE = /^[a-z0-9_]{1,15}$/;

export interface DirectoryEntry {
  handle: string;
  address: string;
  verifiedAt: string;
}

/** What's kept in storage: plain JSON, rebuilt into a Map on load. */
export interface StoredDirectory {
  generatedAt: number;
  /** the pinned key that signed it */
  keyId: string;
  fetchedAt: number;
  /** the server said it may be out of date */
  stale: boolean;
  entries: DirectoryEntry[];
}

export class DirectoryTrustError extends Error {}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * A downloaded directory, verified and checked. Returns null when it is not newer than the one held
 * (a cache or KV replica serving an older build), and throws on anything else that is wrong.
 */
export function readDirectory(
  envelope: unknown,
  held: { generatedAt: number } | null,
  opts: { now?: number; keys?: ReadonlySet<string>; stale?: boolean } = {},
): StoredDirectory | null {
  const now = opts.now ?? Date.now();
  const { data, key } = verifySignedEnvelope(envelope, opts.keys ?? PINNED_XMRBIO_KEYS);
  if (!isObj(data) || data.v !== 1 || data.service !== 'xmr.bio') throw new Error('Unsupported directory version');
  const generatedAt = typeof data.generated_at === 'string' ? toTimestamp(data.generated_at) : NaN;
  if (Number.isNaN(generatedAt)) throw new Error('Bad generated_at');
  if (generatedAt > now + FUTURE_MS) throw new DirectoryTrustError('Directory is dated in the future');
  if (held && generatedAt <= held.generatedAt) return null;
  if (!Array.isArray(data.entries)) throw new Error('Bad entries');
  const seen = new Set<string>();
  const entries: DirectoryEntry[] = [];
  let dropped = 0;
  for (const e of data.entries) {
    // unknown fields (K2–K4, K6) are ignored; an entry this reader can't use is dropped, not fatal
    const ok = isObj(e) && typeof e.handle === 'string' && HANDLE.test(e.handle) && typeof e.address === 'string' && typeof e.verified_at === 'string' && !Number.isNaN(toTimestamp(e.verified_at)) && !seen.has(e.handle) && validateMoneroAddress(e.address).ok;
    if (!ok) {
      dropped++;
      continue;
    }
    seen.add(e.handle as string);
    entries.push({ handle: e.handle as string, address: e.address as string, verifiedAt: e.verified_at as string });
  }
  if (dropped) console.warn(`[XMRadar] xmr.bio directory: ${dropped} entries dropped`);
  return { generatedAt, keyId: key, fetchedAt: now, stale: !!opts.stale, entries };
}

/** Handle → badge entry, for `resolveHandles`' `directory` source. */
export function directoryIndex(d: StoredDirectory | null): (handle: string) => BadgeEntry[] {
  const map = new Map<string, BadgeEntry>();
  for (const e of d?.entries ?? []) {
    map.set(e.handle, { source: 'xmrbio', address: e.address, check: validateMoneroAddress(e.address), verified: true, method: 'xmrbio:directory' });
  }
  return (handle) => {
    const hit = map.get(handle.toLowerCase());
    return hit ? [hit] : [];
  };
}

export type DirectoryFetch =
  | { kind: 'ok'; envelope: unknown; stale: boolean }
  | { kind: 'not-live' }
  | { kind: 'unavailable'; status: number };

/** One download: no cookies, referrer, redirects or HTTP cache; JSON, size-capped while it arrives, 20 s. */
export async function fetchDirectory(fetchFn: typeof fetch, readBody: (res: Response, max: number) => Promise<Uint8Array>, signal?: AbortSignal): Promise<DirectoryFetch> {
  const timeout = AbortSignal.timeout(20_000);
  const res = await fetchFn(DIRECTORY_URL, {
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
    redirect: 'error',
    cache: 'no-store',
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (res.status === 404) return { kind: 'not-live' };
  if (!res.ok) return { kind: 'unavailable', status: res.status };
  if (!/^application\/json\b/i.test(res.headers.get('content-type') ?? '')) throw new Error('Directory is not JSON');
  const text = new TextDecoder().decode(await readBody(res, DIRECTORY_MAX_BYTES));
  return { kind: 'ok', envelope: JSON.parse(text), stale: res.headers.get('x-directory-stale') === '1' };
}

/** The directory as the options page shows it. */
export interface DirectoryStatus {
  state: 'ok' | 'not-live' | 'unavailable' | 'error' | 'trust';
  /** when this status was set (ms) */
  at: number;
  count?: number;
  /** the held directory's build time (ms) */
  generatedAt?: number;
  /** the server said it may be out of date */
  stale?: boolean;
  message?: string;
}

interface Item<T> {
  getValue(): Promise<T>;
  setValue(v: T): Promise<void>;
  removeValue(): Promise<void>;
}

export interface KeeperDeps {
  held: Item<StoredDirectory | null>;
  status: Item<DirectoryStatus | null>;
  fetch: typeof fetch;
  readBody: (res: Response, max: number) => Promise<Uint8Array>;
  alarms: { create(name: string, info: { periodInMinutes?: number; delayInMinutes?: number }): Promise<void>; clear(name: string): Promise<boolean | void> };
  /** badges on X are switched on */
  enabled(): Promise<boolean>;
  /** a new build was taken, or the directory was dropped: cached badges are out of date */
  changed(): Promise<void> | void;
  now?: () => number;
  keys?: ReadonlySet<string>;
}

export const DIRECTORY_ALARM = 'xmrbio-directory';
export const DIRECTORY_RETRY_ALARM = 'xmrbio-directory-retry';
export const DIRECTORY_RETRY_MINUTES = 60;

/**
 * Keeps the directory: a 6-hour alarm while badges are on, a 1-hour retry after a failed or
 * not-yet-published download, and nothing at all while they're off. Each switch-on starts a new
 * generation, so a download from before a switch-off can neither land nor block the next one.
 */
export function directoryKeeper(deps: KeeperDeps) {
  const now = deps.now ?? Date.now;
  let lookup: Promise<(handle: string) => BadgeEntry[]> | null = null;
  let generation = 0;
  let inFlight: { generation: number; done: Promise<void>; abort: AbortController } | null = null;

  const load = () => {
    lookup ??= deps.held.getValue().then(directoryIndex, (e) => {
      // a failed read is retried next time rather than kept
      lookup = null;
      throw e;
    });
    return lookup;
  };

  async function download(gen: number, signal: AbortSignal) {
    const held = await deps.held.getValue();
    const current = () => gen === generation && !signal.aborted;
    const setStatus = async (s: Omit<DirectoryStatus, 'at' | 'count' | 'generatedAt'>, d = held) => {
      if (!current()) return;
      await deps.status.setValue({ ...s, at: now(), ...(d ? { count: d.entries.length, generatedAt: d.generatedAt } : {}) });
      if (s.state !== 'ok') await deps.alarms.create(DIRECTORY_RETRY_ALARM, { delayInMinutes: DIRECTORY_RETRY_MINUTES });
    };
    try {
      const got = await fetchDirectory(deps.fetch, deps.readBody, signal);
      if (got.kind === 'not-live') return await setStatus({ state: 'not-live' });
      // 503: no build yet or a broken one; ours stays
      if (got.kind === 'unavailable') return await setStatus({ state: 'unavailable', message: `HTTP ${got.status}` });
      const next = readDirectory(got.envelope, held, { now: now(), keys: deps.keys, stale: got.stale });
      if (!current() || !(await deps.enabled())) return;
      // an older build from a cache or replica is ignored without a word (K1 consistency window)
      if (!next) return await setStatus({ state: 'ok', stale: got.stale });
      await deps.held.setValue(next);
      lookup = Promise.resolve(directoryIndex(next));
      await deps.changed();
      await setStatus({ state: 'ok', stale: next.stale }, next);
    } catch (e) {
      if (!current()) return;
      const message = (e as Error).message;
      console.warn('[XMRadar] xmr.bio directory', message);
      await setStatus({ state: e instanceof DirectoryTrustError ? 'trust' : 'error', message });
    }
  }

  /** Download now, unless a download of this generation is already running. */
  function refresh(): Promise<void> {
    if (inFlight?.generation === generation) return inFlight.done;
    const abort = new AbortController();
    const gen = generation;
    const run = { generation: gen, abort, done: Promise.resolve() };
    run.done = (async () => {
      if (await deps.enabled()) await download(gen, abort.signal);
    })().finally(() => {
      if (inFlight === run) inFlight = null;
    });
    inFlight = run;
    return run.done;
  }

  /** Badges switched on (or the worker started with them on), or switched off. */
  async function apply(on: boolean) {
    generation++;
    inFlight?.abort.abort();
    inFlight = null;
    if (on) {
      await deps.alarms.create(DIRECTORY_ALARM, { periodInMinutes: DIRECTORY_HOURS * 60 });
      const [held, st] = await Promise.all([deps.held.getValue(), deps.status.getValue()]);
      const fresh = held && now() - held.fetchedAt < DIRECTORY_HOURS * 3600_000;
      // a failed or unpublished try is retried by its own alarm, not on every worker start
      const retrying = st && st.state !== 'ok' && now() - st.at < DIRECTORY_RETRY_MINUTES * 60_000;
      if (retrying) {
        // the retry alarm may be gone (cleared with the browser's alarms, or set by an older version)
        const left = DIRECTORY_RETRY_MINUTES - (now() - st.at) / 60_000;
        await deps.alarms.create(DIRECTORY_RETRY_ALARM, { delayInMinutes: Math.max(1, left) });
      } else if (!fresh) await refresh();
      return;
    }
    await Promise.all([deps.alarms.clear(DIRECTORY_ALARM), deps.alarms.clear(DIRECTORY_RETRY_ALARM)]);
    const had = await deps.held.getValue();
    await Promise.all([deps.held.removeValue(), deps.status.removeValue()]);
    lookup = null;
    if (had) await deps.changed();
  }

  const onAlarm = (name: string) => (name === DIRECTORY_ALARM || name === DIRECTORY_RETRY_ALARM ? refresh() : undefined);

  return { lookup: load, refresh, apply, onAlarm };
}
