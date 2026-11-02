/**
 * The daily update check (PLAN-UPDATECHECK). XMRadar is installed from a zip, so no browser updates it:
 * once a day it asks xmradar.app for the latest version number and says so when a newer one is out.
 * Nothing is downloaded; the links go to our GitHub release page, built from the checked version.
 */

export const UPDATE_URL = 'https://xmradar.app/latest.json';
export const UPDATE_ALARM = 'update-check';
export const UPDATE_HOURS = 24;
export const UPDATE_NOTICE_ID = 'xmradar-update';
const RELEASES = 'https://github.com/KYC-rip/xmradar/releases/tag/v';
const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;

export interface UpdateState {
  /** when the last attempt finished, success or not: a failing site is asked at most once a day */
  attemptAt: number;
  /** the version the last valid answer named */
  latest: string | null;
  /** the highest version a notification was shown for; never goes down */
  notified: string | null;
}

/** `{"version":"0.6.1","tag":"v0.6.1",…}` → "0.6.1"; anything else null. */
export function readLatest(json: unknown): string | null {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null;
  const { version, tag } = json as Record<string, unknown>;
  return typeof version === 'string' && VERSION.test(version) && tag === `v${version}` ? version : null;
}

const parts = (v: string) => v.split('.').slice(0, 3).map(Number);
/** a is a newer release than b, by the first three parts (0.6.0.7 is the same release as 0.6.0.6) */
export function isNewer(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a) return false;
  if (!b) return true;
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
}

/** the release page of a checked version; null for anything that isn't one */
export const releaseUrl = (version: string | null | undefined) => (version && VERSION.test(version) ? `${RELEASES}${version}` : null);

/** the version to show as out: held, valid and newer than this copy */
export const updateFor = (state: UpdateState | null | undefined, current: string) =>
  state && releaseUrl(state.latest) && isNewer(state.latest, current) ? state.latest! : null;

interface Item<T> {
  getValue(): Promise<T>;
  setValue(v: T): Promise<void>;
  removeValue(): Promise<void>;
}

export interface UpdateDeps {
  held: Item<UpdateState | null>;
  fetch: typeof fetch;
  readBody: (res: Response, max: number) => Promise<Uint8Array>;
  alarms: { create(name: string, info: { periodInMinutes: number }): Promise<void> | void; clear(name: string): Promise<unknown> | void };
  /** the switch in Options */
  enabled(): Promise<boolean>;
  /** this copy's version (the manifest's) */
  current(): string;
  /** shows the notification; rejects when it couldn't */
  notify(version: string): Promise<void>;
  clearNotice(): Promise<unknown> | void;
  now?: () => number;
}

/**
 * Keeps the check: a daily alarm while it's on, nothing at all while it's off. Each switch starts a new
 * generation, so a request from before a switch-off can neither land nor block the next one.
 */
export function updateKeeper(deps: UpdateDeps) {
  const now = deps.now ?? Date.now;
  let generation = 0;
  let inFlight: { generation: number; done: Promise<void>; abort: AbortController } | null = null;
  /** still the same switch-on, and still on: asked again after every wait, right before acting */
  const still = async (gen: number) => gen === generation && (await deps.enabled()) && gen === generation;

  async function ask(gen: number, signal: AbortSignal) {
    const live = () => gen === generation && !signal.aborted;
    let latest: string | null | undefined;
    try {
      const res = await deps.fetch(UPDATE_URL, {
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        redirect: 'error',
        cache: 'no-store',
        signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (!/^application\/json\b/i.test(res.headers.get('content-type') ?? '')) throw new Error('not JSON');
      latest = readLatest(JSON.parse(new TextDecoder().decode(await deps.readBody(res, 4096))));
      if (!latest) throw new Error('no valid version');
    } catch (e) {
      if (live()) console.warn('[XMRadar] update check', (e as Error).message);
    }
    if (signal.aborted) return;
    const held = await deps.held.getValue();
    // a failure keeps the version last seen; an answer replaces it (a forged high one recovers)
    const next: UpdateState = { attemptAt: now(), latest: latest ?? held?.latest ?? null, notified: held?.notified ?? null };
    if (!live() || !(await still(gen))) return;
    await deps.held.setValue(next);
    await announce(next, gen);
  }

  /**
   * One notification per version, and none for a version not above the last one shown. A notification
   * that no longer matches (this copy was updated, or a forged higher version was followed by the real
   * one) is taken away.
   */
  async function announce(s: UpdateState, gen: number) {
    const out = updateFor(s, deps.current());
    if (!out || (s.notified && !isNewer(out, s.notified))) {
      if (out !== s.notified) await deps.clearNotice();
      return;
    }
    if (!(await still(gen))) return;
    try {
      await deps.notify(out);
    } catch (e) {
      // the popup and Options still say so; the next start or check tries the notification again
      return console.warn('[XMRadar] update notice', (e as Error).message);
    }
    // switched off while it was being shown: take it away again
    if (!(await still(gen))) return void (await deps.clearNotice());
    await deps.held.setValue({ ...s, notified: out });
  }

  /** Ask now, unless a request of this generation is already running. */
  function check(): Promise<void> {
    if (inFlight?.generation === generation) return inFlight.done;
    const abort = new AbortController();
    const gen = generation;
    const run = { generation: gen, abort, done: Promise.resolve() };
    run.done = (async () => {
      if (await deps.enabled()) await ask(gen, abort.signal);
    })().finally(() => {
      if (inFlight === run) inFlight = null;
    });
    inFlight = run;
    return run.done;
  }

  /** The check switched on (or the worker started with it on), or switched off. */
  async function apply(on: boolean) {
    generation++;
    inFlight?.abort.abort();
    inFlight = null;
    if (on) {
      await deps.alarms.create(UPDATE_ALARM, { periodInMinutes: UPDATE_HOURS * 60 });
      const held = await deps.held.getValue();
      if (!held || now() - held.attemptAt >= UPDATE_HOURS * 3600_000) return check();
      // asked recently: a notification not shown yet is tried again, one still showing for an older answer
      // (or for the version now installed) is taken away
      await announce(held, generation);
      return;
    }
    await deps.alarms.clear(UPDATE_ALARM);
    await deps.held.removeValue();
    await deps.clearNotice();
  }

  const onAlarm = (name: string) => (name === UPDATE_ALARM ? check() : undefined);

  return { check, apply, onAlarm };
}
