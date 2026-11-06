import { verifyEvent, type Event } from 'nostr-tools/pure';

/**
 * A live relay subscription for the inbox (PLAN-LIVEINBOX), held only while an X tab is visible. One socket per
 * relay, one REQ; a validly signed event matching a filter is handed on. The inbox keepers still do the work:
 * this only says "look now". A dropped socket comes back after 5 s, doubling to 60 s; a relay that CLOSEs the
 * subscription (or wants AUTH) is left until the next start. NOTICEs are informational and ignored.
 */

export interface LiveFilter {
  kinds: number[];
  since: number;
  [tag: `#${string}`]: string[];
}

type WsLike = {
  addEventListener(type: string, fn: (ev: { data?: unknown }) => void): void;
  send(data: string): void;
  close(): void;
};
export type WsFactory = (url: string) => WsLike;

export interface LiveDeps {
  relays: string[];
  filters: LiveFilter[];
  onEvent: (e: Event) => void;
  ws?: WsFactory;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (t: unknown) => void;
  /** seconds; a reconnect asks only from 2 minutes back (more than the longest backoff), not the whole session */
  nowSecs?: () => number;
}

export const RECONNECT_MIN_MS = 5_000;
export const RECONNECT_MAX_MS = 60_000;

/** Does this event match the filter: its kind, `since`, and each `#x` tag filter. */
export function matches(e: Event, f: LiveFilter): boolean {
  if (!f.kinds.includes(e.kind) || e.created_at < f.since) return false;
  for (const [k, want] of Object.entries(f) as [string, unknown][]) {
    if (!k.startsWith('#') || !Array.isArray(want)) continue;
    const name = k.slice(1);
    if (!e.tags.some((t) => t[0] === name && want.includes(String(t[1])))) return false;
  }
  return true;
}

/** verifyEvent caches its verdict on the object; check a fresh plain copy. */
const signed = (e: Event) => verifyEvent({ id: e.id, pubkey: e.pubkey, created_at: e.created_at, kind: e.kind, tags: e.tags, content: e.content, sig: e.sig });

export function liveSubscription(deps: LiveDeps): { stop(): void } {
  const make = deps.ws ?? ((url: string) => new WebSocket(url) as unknown as WsLike);
  const later = deps.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
  const cancel = deps.clearTimeout ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  const sub = `live${Math.random().toString(36).slice(2, 10)}`;
  const nowSecs = deps.nowSecs ?? (() => Math.floor(Date.now() / 1000));
  const opened = new Set<string>();
  let stopped = false;
  const sockets = new Map<string, WsLike>();
  const timers = new Map<string, unknown>();
  const seen = new Set<string>();

  function open(relay: string, delay: number) {
    if (stopped) return;
    let ws: WsLike;
    try {
      ws = make(relay);
    } catch {
      return retry(relay, delay);
    }
    sockets.set(relay, ws);
    let done = false;
    const drop = (again: boolean) => {
      if (done) return;
      done = true;
      sockets.delete(relay);
      try {
        ws.close();
      } catch {
        /* closed */
      }
      if (again) retry(relay, delay);
    };
    ws.addEventListener('open', () => {
      try {
        // a reconnect late in a long session asks from 2 minutes back, not from the start
        const floor = nowSecs() - 120;
        ws.send(JSON.stringify(['REQ', sub, ...deps.filters.map((f) => (opened.has(relay) ? { ...f, since: Math.max(f.since, floor) } : f))]));
        opened.add(relay);
      } catch {
        drop(true);
      }
    });
    ws.addEventListener('message', (ev) => {
      if (stopped || done) return;
      let msg: unknown;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (!Array.isArray(msg)) return;
      // a relay that ends the subscription or wants AUTH is left until the next start
      // a relay that asks for AUTH (NIP-42) is dropped for this session; the 30-minute check still reads it
      if ((msg[0] === 'CLOSED' && msg[1] === sub) || msg[0] === 'AUTH') return drop(false);
      // serving the subscription: the next drop starts the backoff over (not on connect, or a relay that
      // accepts and closes again would be retried every 5 s)
      if (msg[0] === 'EOSE' && msg[1] === sub) delay = 0;
      if (msg[0] !== 'EVENT' || msg[1] !== sub) return;
      const e = msg[2] as Event;
      if (!e || typeof e !== 'object' || typeof e.id !== 'string' || seen.has(e.id)) return;
      if (!deps.filters.some((f) => matches(e, f)) || !signed(e)) return;
      seen.add(e.id);
      if (seen.size > 2000) seen.clear();
      deps.onEvent(e);
    });
    ws.addEventListener('error', () => drop(true));
    ws.addEventListener('close', () => drop(true));
  }

  function retry(relay: string, delay: number) {
    if (stopped) return;
    const wait = Math.min(Math.max(delay * 2, RECONNECT_MIN_MS), RECONNECT_MAX_MS);
    timers.set(relay, later(() => open(relay, wait), wait));
  }

  for (const r of deps.relays) open(r, 0);

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      for (const t of timers.values()) cancel(t);
      timers.clear();
      for (const ws of sockets.values()) {
        try {
          ws.send(JSON.stringify(['CLOSE', sub]));
        } catch {
          /* not open */
        }
        try {
          ws.close();
        } catch {
          /* closed */
        }
      }
      sockets.clear();
    },
  };
}

/** One check at a time per kind, at most every `gapMs`; a trigger during a check or the gap runs once after. */
export function throttledCheck(run: () => Promise<unknown>, deps: { gapMs: number; debounceMs: number; now?: () => number; setTimeout?: (fn: () => void, ms: number) => unknown }) {
  const now = deps.now ?? Date.now;
  const later = deps.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
  let last = -Infinity;
  let running = false;
  let queued = false;
  let timer = false;
  const fire = async () => {
    timer = false;
    if (running) return void (queued = true);
    running = true;
    queued = false;
    last = now();
    try {
      await run();
    } catch {
      /* the keeper logs */
    } finally {
      running = false;
      if (queued) trigger();
    }
  };
  function trigger() {
    if (running) return void (queued = true);
    if (timer) return;
    timer = true;
    later(() => void fire(), Math.max(deps.debounceMs, last + deps.gapMs - now()));
  }
  return { trigger };
}

export interface ControllerDeps {
  on: () => Promise<boolean>;
  pubkey: () => Promise<string | null>;
  /** the proven X handle, lowercase, or null */
  handle: () => Promise<string | null>;
  relays: (pubkey: string) => Promise<string[]>;
  subscribe: (relays: string[], filters: LiveFilter[]) => { stop(): void };
  /** when each kind was last checked in full (ms), or null */
  checkedAt: () => Promise<{ xo: number | null; xap: number | null }>;
  kinds: { xo: number; xap: number; handleTag: (h: string) => string };
  now?: () => number;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (t: unknown) => void;
}

export const LIVE_IDLE_MS = 70_000;
export const LIVE_CATCH_UP_MS = 2 * 60_000;

/**
 * The live inbox's life: a heartbeat opens it (one at a time, whatever the number of X tabs), 70 s without one
 * closes it, a new key or handle reopens it. Opening after a while away also asks each kind whose full check is
 * over 2 minutes old to run now. Returns the triggers the caller wires to the keepers.
 */
export function liveController(deps: ControllerDeps, triggers: { xo: () => void; xap: () => void }) {
  const now = deps.now ?? Date.now;
  const every = deps.setInterval ?? ((fn, ms) => setInterval(fn, ms));
  const cancel = deps.clearInterval ?? ((t) => clearInterval(t as ReturnType<typeof setInterval>));
  let live: { key: string; sub: { stop(): void }; timer: unknown } | null = null;
  let seen = 0;
  let queue: Promise<void> = Promise.resolve();
  function stop() {
    if (!live) return;
    cancel(live.timer);
    live.sub.stop();
    live = null;
  }
  function heartbeat(): Promise<void> {
    seen = now();
    queue = queue
      .then(async () => {
        const pk = await deps.pubkey();
        if (!(await deps.on()) || !pk) return stop();
        const handle = await deps.handle();
        const key = `${pk}:${handle ?? ''}`;
        if (live?.key === key) return;
        stop();
        const since = Math.floor(now() / 1000) - 60;
        const filters: LiveFilter[] = [
          { kinds: [deps.kinds.xo], '#p': [pk], since },
          ...(handle ? [{ kinds: [deps.kinds.xo], '#X': [deps.kinds.handleTag(handle)], since }] : []),
          { kinds: [deps.kinds.xap], '#p': [pk], since },
        ];
        const relays = await deps.relays(pk);
        // no relay to hold: nothing opens, and the next heartbeat tries again
        if (!relays.length) return;
        const sub = deps.subscribe(relays, filters);
        const timer = every(() => {
          if (now() - seen > LIVE_IDLE_MS) stop();
        }, 30_000);
        live = { key, sub, timer };
        const at = await deps.checkedAt();
        const stale = (t: number | null) => t == null || now() - t > LIVE_CATCH_UP_MS;
        if (stale(at.xo)) triggers.xo();
        if (stale(at.xap)) triggers.xap();
      })
      .catch(() => {});
    return queue;
  }
  return { heartbeat, stop, get running() { return !!live; } };
}
