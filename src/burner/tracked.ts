/** Keeps the background alive and the pages informed while a free inbox is created (PLAN-POPUP §3). */

export const PING_MS = 10_000;
/** A `creating` mark older than this is from a worker that died mid-create. */
export const CREATING_STALE_MS = 90_000;
/** How long a failed create stays on show. */
export const LAST_ERROR_MS = 10 * 60_000;

export interface CreatingState {
  startedAt: number;
}
export interface LastError {
  message: string;
  at: number;
}

interface Slot<T> {
  setValue(v: T | null): Promise<void>;
}

export interface TrackDeps {
  creating: Slot<CreatingState>;
  lastError: Slot<LastError>;
  /**
   * Any extension API call: Chrome resets the worker's idle timer on each one.
   * Firefox's event page is also kept by API activity (checked in manual test 4).
   */
  ping: () => unknown;
  now?: () => number;
}

let running = false;

/**
 * Runs one create with the keepalive on and the state stored where the pages can see it,
 * so a popup that closes mid-create finds the result (or the error) when it opens again.
 * A second call while one runs is refused without touching the stored state.
 */
export async function trackCreate<T>(run: () => Promise<T>, d: TrackDeps): Promise<T> {
  if (running) throw new Error('Busy: getting an address. Try again in a moment.');
  running = true;
  const now = d.now ?? Date.now;
  const ping = () => {
    try {
      void Promise.resolve(d.ping()).catch(() => {});
    } catch {
      // a failed ping only costs the keepalive
    }
  };
  ping();
  const timer = setInterval(ping, PING_MS);
  try {
    await d.lastError.setValue(null);
    await d.creating.setValue({ startedAt: now() });
    return await run();
  } catch (e) {
    await d.lastError.setValue({ message: e instanceof Error ? e.message : String(e), at: now() }).catch(() => {});
    throw e;
  } finally {
    clearInterval(timer);
    await d.creating.setValue(null).catch(() => {});
    running = false;
  }
}

export const isCreating = (c: CreatingState | null, now = Date.now()) => !!c && now - c.startedAt < CREATING_STALE_MS;
export const shownError = (e: LastError | null, now = Date.now()) => (e && now - e.at < LAST_ERROR_MS ? e.message : null);
