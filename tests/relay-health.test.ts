import { describe, expect, it } from 'vitest';
import { healthStore, MAX_HEALTH, partition, recordResults, relayNotice, SKIP_MS, type Health } from '../src/nostr/relay-health';
import { settled } from '../src/nostr/retry';
import { autoCloses } from '../src/entrypoints/content/publish-pill';

const ok = (relay: string) => ({ relay, ok: true, message: 'ok' });
const dead = (relay: string) => ({ relay, ok: false, message: 'connection failure: connection failed' });
const blocked = (relay: string) => ({ relay, ok: false, message: 'blocked: you do not have a Nostr Plebs NIP-05' });
const A = 'wss://a.relay';
const B = 'wss://b.relay';

describe('recordResults', () => {
  it('skips a relay for a day after 3 failures in a row; success clears it', () => {
    let h: Health = {};
    h = recordResults(h, [dead(A)], 1);
    h = recordResults(h, [blocked(A)], 2);
    expect(h[A]).toEqual({ fails: 2, at: 2 });
    h = recordResults(h, [dead(A)], 3);
    expect(h[A]).toEqual({ fails: 3, at: 3, skipUntil: 3 + SKIP_MS });
    // tried again after the day: a failure re-arms at once
    const later = 3 + SKIP_MS + 1;
    expect(recordResults(h, [dead(A)], later)[A]).toEqual({ fails: 4, at: later, skipUntil: later + SKIP_MS });
    expect(recordResults(h, [ok(A)], later)[A]).toBeUndefined();
  });

  it('keeps the newest 200, ties by name', () => {
    let h: Health = {};
    for (let i = 0; i < MAX_HEALTH + 5; i++) h = recordResults(h, [dead(`wss://r${String(i).padStart(3, '0')}`)], i);
    expect(Object.keys(h)).toHaveLength(MAX_HEALTH);
    expect(h['wss://r000']).toBeUndefined();
    expect(h['wss://r204']).toBeDefined();
    const tie = recordResults({}, Array.from({ length: MAX_HEALTH + 1 }, (_, i) => dead(`wss://t${String(i).padStart(3, '0')}`)), 5);
    expect(tie['wss://t200']).toBeUndefined();
    expect(tie['wss://t000']).toBeDefined();
  });
});

describe('partition', () => {
  const h: Health = { [A]: { fails: 3, at: 0, skipUntil: 100 } };
  it('skips only within the day, in order', () => {
    expect(partition(h, [A, B], 50)).toEqual({ use: [B], skipped: [A], overridden: false });
    expect(partition(h, [A, B], 100)).toEqual({ use: [A, B], skipped: [], overridden: false });
  });
  it('never skips everything, and says so', () => {
    expect(partition(h, [A], 50)).toEqual({ use: [A], skipped: [], overridden: true });
    expect(partition(h, [], 50)).toEqual({ use: [], skipped: [], overridden: false });
  });
});

describe('healthStore', () => {
  it('loses no failure when two publishes record at once', async () => {
    let v: Health = {};
    const s = healthStore({ getValue: async () => v, setValue: async (x) => void (v = x) }, () => 1);
    await Promise.all([s.record([dead(A)]), s.record([dead(A)])]);
    expect(v[A]!.fails).toBe(2);
    await s.record([dead(A)]);
    // a partition asked after a record sees it
    expect(await s.partition([A, B])).toEqual({ use: [B], skipped: [A], overridden: false });
  });
});

describe('settled: when the pill can close', () => {
  it('needs at least one relay, and 2 when a Retry is still possible', () => {
    expect(settled([ok(A), ok(B)])).toBe(true);
    expect(settled([ok(A), ok(B), dead('wss://c')])).toBe(true);
    expect(settled([ok(A), dead(B)])).toBe(false);
    expect(settled([ok(A), blocked(B)])).toBe(true);
    expect(settled([dead(A), blocked(B)])).toBe(false);
    expect(settled([])).toBe(false);
  });
  it('the pill follows it', () => {
    const base = { kind: 'published' as const, link: { href: '', label: '' }, ref: '', copyLabel: '' };
    expect(autoCloses({ ...base, results: [ok(A), ok(B), dead('wss://c')] })).toBe(true);
    expect(autoCloses({ ...base, results: [ok(A), dead(B)] })).toBe(false);
  });
});

describe('relayNotice', () => {
  it('names the skipped relays and where to fix them', () => {
    expect(relayNotice([A], 'nip65', false)).toBe(
      "Skipped 1 relay that failed on your last 3 posts: a.relay. XMRadar tries it again once a day. It's in your NIP-65 relay list; remove it in your Nostr client's relay settings.",
    );
    expect(relayNotice([A, B], 'manual', false)).toBe(
      'Skipped 2 relays that failed on your last 3 posts: a.relay, b.relay. XMRadar tries each again once a day. Remove them under Options → Posting → Relays.',
    );
    expect(relayNotice([A], 'fallback', false)).toBe('Skipped 1 relay that failed on your last 3 posts: a.relay. XMRadar tries it again once a day.');
  });
  it('says when all were tried anyway, and nothing otherwise', () => {
    expect(relayNotice([], 'nip65', true)).toBe('Every relay has been failing lately, so XMRadar tried them all.');
    expect(relayNotice([], 'nip65', false)).toBe('');
  });
});
