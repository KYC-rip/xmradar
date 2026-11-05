import { finalizeEvent, generateSecretKey, getPublicKey, type Event } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';
import { xoTemplate } from '../src/xo/event';
import { applyXo, candidates, freshXoInbox, HANDLE_BASELINE_SECS, handleSince, inboxFor, OVERLAP_SECS, xoCounts, xoKeeper, xoNotice, type XoInbox } from '../src/xo/inbox';
import type { Liker } from '../src/xo/verify';
import { accepted0612 } from './fixtures/xo-0612';

// PLAN-XOREACH
const NOW = 1_800_000_000_000;
const SECS = NOW / 1000;
const me = generateSecretKey();
const ME = getPublicKey(me);
const people = Array.from({ length: 6 }, () => generateSecretKey());
const PK = people.map((sk) => getPublicKey(sk));
const xo = (from: number, post: string, to: string | null, handle = 'me', at = SECS - 60) => finalizeEvent(xoTemplate(post, to, handle, at), people[from]!);
const ok = (h: string): Liker => ({ ok: true, handle: h });
const run = (s: XoInbox, events: Event[], opts: { handle?: string | null; handleBaseline?: boolean; liker?: Liker | null } = {}) =>
  applyXo(s, { xos: candidates(s, events, NOW, opts.handle === undefined ? (s.handle ?? null) : opts.handle), deletions: [], likerOf: () => (opts.liker === undefined ? ok('alice') : opts.liker), now: NOW, handleBaseline: opts.handleBaseline });

describe('xos by handle', () => {
  it('a handle-only xo to my proven handle counts; to another handle, or before a handle is proven, it doesn’t', () => {
    const done = { ...freshXoInbox(ME, 'me'), baseline: 'done' as const, sinceAt: SECS - 3600, handleSinceAt: SECS - 3600 };
    expect(xoCounts(run(done, [xo(0, '1', null)]).state)).toEqual({ '1': 1 });
    expect(xoCounts(run(done, [xo(0, '1', null, 'someoneelse')]).state)).toEqual({});
    expect(xoCounts(run({ ...done, handle: null }, [xo(0, '1', null)], { handle: null }).state)).toEqual({});
  });
  it('an xo with a p to another key is never taken by handle', () => {
    const done = { ...freshXoInbox(ME, 'me'), baseline: 'done' as const, sinceAt: SECS - 3600, handleSinceAt: SECS - 3600 };
    expect(xoCounts(run(done, [xo(0, '1', PK[5]!)]).state)).toEqual({});
  });
  it('handle-only xos sent before the handle was read are told once, as before you set up, even when checked later', () => {
    // the handle was adopted at SECS - 30: xos at SECS - 60 came before
    let s: XoInbox = { ...freshXoInbox(ME, 'me', SECS - 30), baseline: 'done', sinceAt: SECS - 3600 };
    let r = run(s, [xo(0, '1', null), xo(1, '2', null)], { handleBaseline: true, liker: null });
    // senders not checked yet: nothing told, they wait
    expect(r.notify).toEqual([]);
    r = run(r.state, []);
    expect(r.notify.length).toBe(2);
    expect(r.notify.every((n) => n.early)).toBe(true);
    expect(xoNotice(r.notify)).toBe('1 Monero person sent your posts xos before you set up XMRadar');
    s = r.state;
    r = run(s, [xo(2, '4', null, 'me', SECS - 10)]);
    expect(r.notify.map((n) => n.early)).toEqual([undefined]);
    expect(xoNotice(r.notify)).toBe('@alice sent your post an xo');
  });
  it('a first key baseline tells nothing but the early ones', () => {
    const s = freshXoInbox(ME, 'me', SECS - 30);
    const r = run(s, [xo(0, '1', ME), xo(1, '2', null)], { handleBaseline: true });
    expect(r.notify.map((n) => n.statusId)).toEqual(['2']);
    expect(xoCounts(r.state)).toEqual({ '1': 1, '2': 1 });
  });
  it('counts distinct people in the early notice', () => {
    const items = [0, 1, 2].map((i) => ({ id: String(i), statusId: '1', liker: PK[i]!, handle: `p${i}`, at: 1, early: true }));
    expect(xoNotice(items)).toBe('3 Monero people sent your posts xos before you set up XMRadar');
  });
  it('a handle baseline that finds nothing still counts as run', () => {
    const s: XoInbox = { ...freshXoInbox(ME, 'me'), baseline: 'done', sinceAt: SECS - 3600 };
    expect(run(s, [], { handleBaseline: true }).state.handleSinceAt).toBe(SECS);
  });
  it('looks back 180 days the first time, two days past the newest after', () => {
    expect(handleSince(freshXoInbox(ME, 'me'), NOW)).toBe(SECS - HANDLE_BASELINE_SECS);
    expect(handleSince({ ...freshXoInbox(ME, 'me'), handleSinceAt: SECS }, NOW)).toBe(SECS - OVERLAP_SECS);
  });
});

describe('the inbox across handles', () => {
  const held: XoInbox = { ...freshXoInbox(ME), baseline: 'done', sinceAt: SECS, likes: { '1': { [PK[0]!]: 'a'.repeat(64) } } };
  it('a 0.6.12 inbox (no handle) adopts the proven handle and keeps its counts', () => {
    const old = { ...held } as XoInbox;
    delete old.handle;
    delete old.handleSinceAt;
    const s = inboxFor(old, ME, 'me', SECS);
    expect(s.handle).toBe('me');
    expect(s.handleSinceAt).toBeNull();
    expect(xoCounts(s)).toEqual({ '1': 1 });
  });
  it('no proven handle right now keeps the inbox; a different handle or key starts over', () => {
    const mine = { ...held, handle: 'me' };
    expect(inboxFor(mine, ME, null, SECS)).toBe(mine);
    expect(inboxFor(mine, ME, 'me', SECS)).toBe(mine);
    expect(xoCounts(inboxFor(mine, ME, 'other', SECS))).toEqual({});
    expect(xoCounts(inboxFor(mine, PK[0]!, 'me', SECS))).toEqual({});
  });
});

describe('the keeper reads the handle too', () => {
  it('asks relays for #X with my handle once proven, and drops keyed xos found that way', async () => {
    let state: XoInbox | null = { ...freshXoInbox(ME), baseline: 'done', sinceAt: SECS - 3600 };
    const filters: Record<string, unknown>[] = [];
    // an old keyed xo found only by #X must not be counted from the 180-day window
    const oldKeyed = xo(3, '9', ME, 'me', SECS - 100 * 86_400);
    const handleOnly = xo(4, '8', null, 'me', SECS - 100 * 86_400);
    const k = xoKeeper({
      held: { getValue: async () => state, setValue: async (v) => void (state = v), removeValue: async () => void (state = null) },
      counts: { setValue: async () => {} },
      enabled: async () => true,
      pubkey: async () => ME,
      handle: async () => 'Me',
      relays: async () => ['wss://r'],
      read: async (_r, f) => {
        filters.push(f as Record<string, unknown>);
        return { events: '#X' in f ? [oldKeyed, handleOnly] : [], readable: ['wss://r'] };
      },
      query: async () => [],
      known: async () => ok('bob'),
      verify: async () => ok('bob'),
      alarms: { create: () => {}, clear: () => {}, get: async () => ({ periodInMinutes: 30 }) },
      notify: async () => {},
      clearNotice: async () => {},
      now: () => NOW,
    });
    await k.check();
    expect(filters[1]).toMatchObject({ kinds: [17], '#X': ['twitter:me'], since: SECS - HANDLE_BASELINE_SECS, limit: 500 });
    expect(xoCounts(state!)).toEqual({ '8': 1 });
    expect(state!.handle).toBe('me');
  });
});

describe('a handle read no relay answered', () => {
  it('doesn’t run or end the handle baseline', async () => {
    let state: XoInbox | null = { ...freshXoInbox(ME, 'me', SECS - 30), baseline: 'done', sinceAt: SECS - 3600 };
    const k = xoKeeper({
      held: { getValue: async () => state, setValue: async (v) => void (state = v), removeValue: async () => void (state = null) },
      counts: { setValue: async () => {} },
      enabled: async () => true,
      pubkey: async () => ME,
      handle: async () => 'me',
      relays: async () => ['wss://r'],
      read: async (_r, f) => ('#X' in f ? { events: [], readable: [] } : { events: [], readable: ['wss://r'] }),
      query: async () => [],
      known: async () => ok('bob'),
      verify: async () => ok('bob'),
      alarms: { create: () => {}, clear: () => {}, get: async () => ({ periodInMinutes: 30 }) },
      notify: async () => {},
      clearNotice: async () => {},
      now: () => NOW,
    });
    await k.check();
    expect(state!.handleSinceAt).toBeNull();
    expect(handleSince(state!, NOW)).toBe(SECS - HANDLE_BASELINE_SECS);
  });
});

describe('released clients (0.6.12) and the new xos', () => {
  it('a keyed xo with the new X tag still counts; a handle-only one is dropped', () => {
    expect(accepted0612(xo(0, '1', ME), ME, SECS)).toBe(true);
    expect(accepted0612(xo(0, '1', null), ME, SECS)).toBe(false);
  });
  it('the new parser counts a 0.6.12 xo (p only)', () => {
    const old = finalizeEvent({ kind: 17, created_at: SECS - 60, content: 'ɱ❤', tags: [['k', 'web'], ['i', 'https://x.com/i/status/1'], ['p', ME]] }, people[0]!);
    const s = { ...freshXoInbox(ME), baseline: 'done' as const, sinceAt: SECS - 3600 };
    expect(xoCounts(run(s, [old], { handle: null }).state)).toEqual({ '1': 1 });
  });
});
