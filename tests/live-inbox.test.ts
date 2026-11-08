import { finalizeEvent, generateSecretKey, type Event } from 'nostr-tools/pure';
import { describe, expect, it, vi } from 'vitest';
import { liveController, liveSubscription, matches, RECONNECT_MAX_MS, throttledCheck, type LiveFilter } from '../src/nostr/live';
import { liveHeartbeat, BEAT_MS } from '../src/entrypoints/content/x-live';

// PLAN-LIVEINBOX
const sk = generateSecretKey();
const ME = 'a'.repeat(64);
const xo = (tags: string[][], at = 1000, key = sk) => finalizeEvent({ kind: 17, created_at: at, content: 'ɱ❤', tags }, key);

class FakeWs {
  static all: FakeWs[] = [];
  sent: unknown[] = [];
  closed = false;
  on: Record<string, ((ev: { data?: unknown }) => void)[]> = {};
  constructor(public url: string) {
    FakeWs.all.push(this);
  }
  addEventListener(t: string, f: (ev: { data?: unknown }) => void) {
    (this.on[t] ??= []).push(f);
  }
  send(d: string) {
    this.sent.push(JSON.parse(d));
  }
  close() {
    this.closed = true;
  }
  emit(t: string, data?: unknown) {
    for (const f of this.on[t] ?? []) f({ data: data === undefined ? undefined : JSON.stringify(data) });
  }
}
const filters: LiveFilter[] = [
  { kinds: [17], '#p': [ME], since: 900 },
  { kinds: [17], '#X': ['twitter:xbtoshi'], since: 900 },
  { kinds: [9042], '#p': [ME], since: 900 },
];

describe('the live subscription', () => {
  it('one REQ with the filters; a signed, matching event comes through once', () => {
    FakeWs.all = [];
    const got: Event[] = [];
    const s = liveSubscription({ relays: ['wss://a', 'wss://b'], filters, onEvent: (e) => got.push(e), ws: (u) => new FakeWs(u) });
    const [a] = FakeWs.all;
    a!.emit('open');
    const req = a!.sent[0] as unknown[];
    expect(req[0]).toBe('REQ');
    expect(req.slice(2)).toEqual(filters);
    const sub = req[1];
    const good = xo([['p', ME], ['i', 'https://x.com/i/status/1']]);
    a!.emit('message', ['EVENT', sub, good]);
    a!.emit('message', ['EVENT', sub, good]); // again: ignored
    a!.emit('message', ['EVENT', sub, { ...xo([['p', ME]]), sig: 'f'.repeat(128) }]); // bad signature
    a!.emit('message', ['EVENT', sub, xo([['p', 'b'.repeat(64)]])]); // not ours
    a!.emit('message', ['EVENT', sub, xo([['p', ME]], 10)]); // before since
    a!.emit('message', ['EVENT', 'other', xo([['p', ME]], 2000)]); // another subscription
    a!.emit('message', ['NOTICE', 'slow down']); // informational
    expect(got.map((e) => e.id)).toEqual([good.id]);
    expect(a!.closed).toBe(false);
    s.stop();
    expect(a!.sent.at(-1)).toEqual(['CLOSE', sub]);
    expect(a!.closed).toBe(true);
  });
  it('the handle filter matches the X tag; a Xap matches its kind', () => {
    expect(matches(xo([['X', 'twitter:xbtoshi']]), filters[1]!)).toBe(true);
    expect(matches(xo([['X', 'twitter:other']]), filters[1]!)).toBe(false);
    expect(matches(finalizeEvent({ kind: 9042, created_at: 1000, content: '', tags: [['p', ME]] }, sk), filters[2]!)).toBe(true);
  });
  it('reconnects 5 → 10 → … 60 s; CLOSED or AUTH leaves the relay closed', () => {
    vi.useFakeTimers();
    FakeWs.all = [];
    const s = liveSubscription({ relays: ['wss://a'], filters, onEvent: () => {}, ws: (u) => new FakeWs(u) });
    const delays: number[] = [];
    for (let i = 0; i < 6; i++) {
      const ws = FakeWs.all.at(-1)!;
      ws.emit('close');
      const before = FakeWs.all.length;
      let waited = 0;
      while (FakeWs.all.length === before && waited < 120_000) {
        vi.advanceTimersByTime(1000);
        waited += 1000;
      }
      delays.push(waited);
    }
    expect(delays).toEqual([5000, 10000, 20000, 40000, 60000, RECONNECT_MAX_MS]);
    const ws = FakeWs.all.at(-1)!;
    ws.emit('open');
    ws.emit('message', ['CLOSED', (ws.sent[0] as unknown[])[1], 'auth-required']);
    const n = FakeWs.all.length;
    vi.advanceTimersByTime(120_000);
    expect(FakeWs.all.length).toBe(n);
    s.stop();
    vi.useRealTimers();
  });
});

describe('the live subscription, later', () => {
  it('backs off when a relay accepts then closes; serving (EOSE) starts it over; a reconnect asks from 2 min back', () => {
    vi.useFakeTimers();
    FakeWs.all = [];
    let now = 10_000;
    const s = liveSubscription({ relays: ['wss://a'], filters, onEvent: () => {}, ws: (u) => new FakeWs(u), nowSecs: () => now });
    const waitNext = () => {
      const before = FakeWs.all.length;
      let waited = 0;
      while (FakeWs.all.length === before && waited < 120_000) {
        vi.advanceTimersByTime(1000);
        waited += 1000;
      }
      return waited;
    };
    let ws = FakeWs.all.at(-1)!;
    ws.emit('open');
    expect((ws.sent[0] as unknown[])[2]).toEqual(filters[0]); // first REQ: the filters as given
    ws.emit('close');
    expect(waitNext()).toBe(5000);
    ws = FakeWs.all.at(-1)!;
    ws.emit('open'); // accepted, never served
    ws.emit('close');
    expect(waitNext()).toBe(10000);
    ws = FakeWs.all.at(-1)!;
    ws.emit('open');
    expect(((ws.sent[0] as unknown[])[2] as LiveFilter).since).toBe(now - 120);
    ws.emit('message', ['EOSE', (ws.sent[0] as unknown[])[1]]);
    ws.emit('close');
    expect(waitNext()).toBe(5000);
    now += 1;
    s.stop();
    vi.useRealTimers();
  });
  it('nothing comes through after stop', () => {
    FakeWs.all = [];
    const got: Event[] = [];
    const s = liveSubscription({ relays: ['wss://a'], filters, onEvent: (e) => got.push(e), ws: (u) => new FakeWs(u) });
    const ws = FakeWs.all[0]!;
    ws.emit('open');
    const sub = (ws.sent[0] as unknown[])[1];
    s.stop();
    ws.emit('message', ['EVENT', sub, xo([['p', ME]])]);
    expect(got).toEqual([]);
  });
});

describe('the check throttle', () => {
  it('a burst runs one check after 3 s; the next not before 20 s; one during a check runs once after', async () => {
    vi.useFakeTimers();
    let runs = 0;
    let release: () => void = () => {};
    const t = throttledCheck(() => new Promise<void>((r) => ((runs += 1), (release = r))), { gapMs: 20_000, debounceMs: 3_000 });
    t.trigger();
    t.trigger();
    t.trigger();
    await vi.advanceTimersByTimeAsync(2_999);
    expect(runs).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(runs).toBe(1);
    t.trigger(); // during the check
    t.trigger();
    release();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(runs).toBe(1); // the 20 s gap
    await vi.advanceTimersByTimeAsync(10_000);
    expect(runs).toBe(2);
    release();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runs).toBe(2);
    vi.useRealTimers();
  });
});

describe('the controller', () => {
  const setup = (o: { on?: boolean; pk?: string | null; handle?: string | null; checked?: { xo: number | null; xap: number | null } } = {}) => {
    let t = 1_000_000;
    const state = { on: o.on ?? true, pk: o.pk === undefined ? ME : o.pk, handle: o.handle === undefined ? 'xbtoshi' : o.handle };
    const subs: { relays: string[]; filters: LiveFilter[]; stopped: boolean }[] = [];
    const intervals: (() => void)[] = [];
    const trig = { xo: 0, xap: 0 };
    const c = liveController(
      {
        on: async () => state.on,
        pubkey: async () => state.pk,
        handle: async () => state.handle,
        relays: async () => ['wss://a', 'wss://b'],
        subscribe: (relays, filters) => {
          const s = { relays, filters, stopped: false };
          subs.push(s);
          return { stop: () => void (s.stopped = true) };
        },
        checkedAt: async () => o.checked ?? { xo: t - 10_000, xap: t - 10_000 },
        kinds: { xo: 17, xap: 9042, handleTag: (h) => `twitter:${h}` },
        now: () => t,
        setInterval: (fn) => (intervals.push(fn), intervals.length),
        clearInterval: () => {},
      },
      { xo: () => void trig.xo++, xap: () => void trig.xap++ },
    );
    return { c, subs, intervals, trig, state, tick: (ms: number) => ((t += ms), intervals.forEach((f) => f())) };
  };
  it('a heartbeat opens one subscription with the three filters; two tabs don’t open two', async () => {
    const { c, subs } = setup();
    await Promise.all([c.heartbeat(), c.heartbeat()]);
    expect(subs.length).toBe(1);
    expect(subs[0]!.filters.map((f) => Object.keys(f).find((k) => k.startsWith('#')))).toEqual(['#p', '#X', '#p']);
    expect(subs[0]!.filters[1]!['#X']).toEqual(['twitter:xbtoshi']);
  });
  it('no proven handle: no #X filter; switch off or no key: nothing opened', async () => {
    const a = setup({ handle: null });
    await a.c.heartbeat();
    expect(a.subs[0]!.filters.length).toBe(2);
    const b = setup({ on: false });
    await b.c.heartbeat();
    const d = setup({ pk: null });
    await d.c.heartbeat();
    expect(b.subs.length + d.subs.length).toBe(0);
  });
  it('closes 70 s after the last heartbeat; a new heartbeat keeps it', async () => {
    const { c, subs, tick } = setup();
    await c.heartbeat();
    tick(50_000);
    await c.heartbeat();
    tick(60_000);
    expect(subs[0]!.stopped).toBe(false);
    tick(11_000);
    expect(subs[0]!.stopped).toBe(true);
    expect(c.running).toBe(false);
  });
  it('a new key or handle reopens it with the new filters', async () => {
    const { c, subs, state } = setup();
    await c.heartbeat();
    state.handle = 'other';
    await c.heartbeat();
    expect(subs.length).toBe(2);
    expect(subs[0]!.stopped).toBe(true);
    expect(subs[1]!.filters[1]!['#X']).toEqual(['twitter:other']);
  });
  it('no relay to hold: nothing opens, and the next heartbeat tries again', async () => {
    const relays = vi.fn(async () => [] as string[]);
    const empty = liveController(
      {
        on: async () => true,
        pubkey: async () => ME,
        handle: async () => null,
        relays,
        subscribe: () => ({ stop: () => {} }),
        checkedAt: async () => ({ xo: null, xap: null }),
        kinds: { xo: 17, xap: 9042, handleTag: (h) => h },
      },
      { xo: () => {}, xap: () => {} },
    );
    await empty.heartbeat();
    expect(empty.running).toBe(false);
    await empty.heartbeat();
    expect(relays).toHaveBeenCalledTimes(2);
  });
  it('opening catches up each kind on its own clock', async () => {
    const t0 = 1_000_000;
    const mixed = setup({ checked: { xo: t0 - 60_000, xap: t0 - 5 * 60_000 } });
    await mixed.c.heartbeat();
    expect(mixed.trig).toEqual({ xo: 0, xap: 1 });
    const never = setup({ checked: { xo: null, xap: null } });
    await never.c.heartbeat();
    expect(never.trig).toEqual({ xo: 1, xap: 1 });
  });
});

describe('the content heartbeat', () => {
  it('beats on start and every 25 s while visible and on; none hidden or off', async () => {
    vi.useFakeTimers();
    let vis: DocumentVisibilityState = 'visible';
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => vis });
    const sent: number[] = [];
    let flip: (on: boolean) => void = () => {};
    const off: (() => void)[] = [];
    liveHeartbeat({ onInvalidated: (cb) => off.push(cb) }, { initial: Promise.resolve(true), watch: (cb) => ((flip = cb), () => {}), send: async () => void sent.push(Date.now()) });
    await vi.advanceTimersByTimeAsync(0);
    expect(sent.length).toBe(1);
    await vi.advanceTimersByTimeAsync(BEAT_MS);
    expect(sent.length).toBe(2);
    vis = 'hidden';
    await vi.advanceTimersByTimeAsync(BEAT_MS * 2);
    expect(sent.length).toBe(2);
    vis = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
    expect(sent.length).toBe(3);
    flip(false);
    await vi.advanceTimersByTimeAsync(BEAT_MS * 2);
    expect(sent.length).toBe(3);
    flip(true);
    expect(sent.length).toBe(4);
    off.forEach((f) => f());
    vi.useRealTimers();
  });
});
