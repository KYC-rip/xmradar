import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { finalizeEvent, generateSecretKey, getPublicKey, type Event } from 'nostr-tools/pure';
import { describe, expect, it, vi } from 'vitest';
import { readRelaysFrom, undoTemplate, XO_CONTENT, xoOf, xoRelayOrder, xoTemplate } from '../src/xo/event';
import { MAX_SENT, rememberSent } from '../src/xo/sent';
import { applyXo, candidates, freshXoInbox, MAX_PENDING, OVERLAP_SECS, xoCounts, xoKeeper, xoNotice, xoSince, type XoInbox } from '../src/xo/inbox';
import type { ProofResult } from '../src/identity/nostr';
import { knownLiker, LIKER_TTL_MS, MAX_LIKER_CACHE, rememberLiker, verifyLiker, type Liker } from '../src/xo/verify';

// PLAN-MONEROLIKE
const NOW = 1_800_000_000_000;
const SECS = NOW / 1000;
const me = generateSecretKey();
const ME = getPublicKey(me);
const people = Array.from({ length: 14 }, () => generateSecretKey());
const PK = people.map((sk) => getPublicKey(sk));
const ADDRESS = (JSON.parse(readFileSync(join(process.cwd(), 'tests/fixtures/nkip0003-v1.json'), 'utf8')) as { test_wallet: { primary_address: string } }).test_wallet.primary_address;
const sign = (sk: Uint8Array, t: { kind: number; tags: string[][]; content: string; created_at: number }) => finalizeEvent(t, sk);
const xo = (from: number, post: string, at = SECS - 60, to = ME) => sign(people[from]!, xoTemplate(post, to, at));

describe('the xo event', () => {
  it('names the post as Xaps do, and its author', () => {
    const t = xoTemplate('123', ME, SECS);
    expect(t).toMatchObject({ kind: 17, content: XO_CONTENT, tags: [['k', 'web'], ['i', 'https://x.com/i/status/123'], ['p', ME]] });
    expect(xoOf({ ...t }, SECS)).toEqual({ statusId: '123', author: ME });
  });
  it('anything else is no xo', () => {
    const t = xoTemplate('123', ME, SECS);
    const bad = [
      { ...t, content: '+' },
      { ...t, kind: 7 },
      { ...t, created_at: SECS + 3600 },
      { ...t, tags: [...t.tags, ['k', 'web']] },
      { ...t, tags: [...t.tags, ['e', 'x']] },
      { ...t, tags: [...t.tags, ['p', PK[0]!]] },
      { ...t, tags: t.tags.filter((x) => x[0] !== 'p') },
      { ...t, tags: [['k', 'web'], ['i', 'https://evil.example/status/1'], ['p', ME]] },
    ];
    for (const b of bad) expect(xoOf(b, SECS)).toBeNull();
  });
  it('taking one back is a NIP-09 deletion of it', () => {
    expect(undoTemplate('a'.repeat(64), SECS)).toEqual({ kind: 5, created_at: SECS, content: '', tags: [['e', 'a'.repeat(64)], ['k', '17']] });
  });
  it('read relays: read and unmarked count, write-only and non-wss don’t', () => {
    const list = { tags: [['r', 'wss://a.example/'], ['r', 'wss://b.example', 'read'], ['r', 'wss://c.example', 'write'], ['r', 'ws://d.example'], ['p', 'x']] };
    expect(readRelaysFrom(list)).toEqual(['wss://a.example', 'wss://b.example']);
    expect(readRelaysFrom(null)).toEqual([]);
  });
  it('someone’s list can’t point this browser at localhost, the LAN or odd ports', () => {
    const list = { tags: [['r', 'wss://localhost'], ['r', 'wss://127.0.0.1'], ['r', 'wss://192.168.1.10'], ['r', 'wss://relay.example:8443'], ['r', 'wss://u:p@relay.example'], ['r', 'wss://ok.example']] };
    expect(readRelaysFrom(list)).toEqual(['wss://ok.example']);
  });
  it('cut to the cap, the author’s read relays and the defaults are what stay', () => {
    const mine = Array.from({ length: 12 }, (_, i) => `wss://m${i}.example`);
    const out = xoRelayOrder(['wss://author.example'], ['wss://d1.example', 'wss://d2.example', 'wss://d3.example'], mine);
    expect(out.length).toBe(10);
    expect(out.slice(0, 4)).toEqual(['wss://author.example', 'wss://d1.example', 'wss://d2.example', 'wss://d3.example']);
    expect(xoRelayOrder(['wss://a.example'], ['wss://a.example'], ['wss://a.example'])).toEqual(['wss://a.example']);
  });
  it('the sent record keeps the newest 2,000', () => {
    let m = {};
    for (let i = 0; i < 5; i++) m = rememberSent(m, String(i), { id: `e${i}`, at: i }, 3);
    expect(Object.keys(m).sort()).toEqual(['2', '3', '4']);
    expect(MAX_SENT).toBe(2000);
  });
});

describe('verifyLiker', () => {
  const sk = people[0]!;
  const pk = PK[0]!;
  const payto = (addr = ADDRESS) => sign(sk, { kind: 10133, created_at: SECS - 100, content: '', tags: [['payto', 'monero', addr]] });
  const claim = (handle = 'alice', tweet = '111') => sign(sk, { kind: 10011, created_at: SECS - 100, content: '', tags: [['i', `twitter:${handle}`, tweet]] });
  const deps = (events: Event[], proof = vi.fn(async (_h: string, _t: string, _p: string): Promise<ProofResult> => ({ status: 'verified', via: 'oembed' }))) => ({ query: async () => events, relays: ['wss://r'], proof });

  it('a Monero address and a confirmed X account: ok, with the handle', async () => {
    const d = deps([payto(), claim()]);
    expect(await verifyLiker(pk, d)).toEqual({ ok: true, handle: 'alice' });
    expect(d.proof).toHaveBeenCalledWith('alice', '111', pk);
  });
  it('no address, a bad address, no claim, or a proof that fails: not a Monero person', async () => {
    expect(await verifyLiker(pk, deps([claim()]))).toEqual({ ok: false });
    expect(await verifyLiker(pk, deps([payto('4notanaddress'), claim()]))).toEqual({ ok: false });
    expect(await verifyLiker(pk, deps([payto()]))).toEqual({ ok: false });
    expect(await verifyLiker(pk, deps([payto(), claim()], vi.fn(async (): Promise<ProofResult> => ({ status: 'failed', reason: 'no npub' }))))).toEqual({ ok: false });
  });
  it('nothing from relays, or a proof that couldn’t be fetched: no answer yet', async () => {
    expect(await verifyLiker(pk, deps([]))).toBeNull();
    expect(await verifyLiker(pk, deps([payto(), claim()], vi.fn(async (): Promise<ProofResult> => ({ status: 'error', reason: 'timeout' }))))).toBeNull();
  });
  it('someone else’s events or forged ones don’t count', async () => {
    const forged = { ...payto(), sig: '0'.repeat(128) };
    expect(await verifyLiker(pk, deps([forged, claim()]))).toEqual({ ok: false });
    expect(await verifyLiker(PK[1]!, deps([payto(), claim()]))).toBeNull();
  });
  it('answers are kept a day, up to the cap', () => {
    let c = rememberLiker({}, 'a', { ok: true, handle: 'a' }, NOW);
    expect(knownLiker(c, 'a', NOW + 1000)).toEqual({ ok: true, handle: 'a' });
    expect(knownLiker(c, 'a', NOW + LIKER_TTL_MS)).toBeNull();
    for (let i = 0; i < MAX_LIKER_CACHE + 5; i++) c = rememberLiker(c, `k${i}`, { ok: false }, NOW + i);
    expect(Object.keys(c).length).toBe(MAX_LIKER_CACHE);
    expect(c.a).toBeUndefined();
  });
});

describe('the xo inbox', () => {
  const ok = (h: string): Liker => ({ ok: true, handle: h });
  const all = (l: Liker | null) => () => l;
  const run = (s: XoInbox, events: Event[], likerOf: (pk: string) => Liker | null, deletions: Event[] = [], now = NOW) =>
    applyXo(s, { xos: candidates(s, events, now), deletions, likerOf, now });

  it('the first check lists without telling; later ones tell, once per person per post', () => {
    let { state, notify } = run(freshXoInbox(ME), [xo(0, '1')], all(ok('alice')));
    expect(notify).toEqual([]);
    expect(xoCounts(state)).toEqual({ '1': 1 });
    ({ state, notify } = run(state, [xo(0, '1', SECS - 30), xo(1, '1'), xo(1, '2')], (pk) => ok(pk === PK[1] ? 'bob' : 'alice')));
    expect(notify.map((n) => [n.handle, n.statusId])).toEqual([['bob', '1'], ['bob', '2']]);
    expect(xoCounts(state)).toEqual({ '1': 2, '2': 1 });
    expect(state.unread).toBe(2);
    // the same events again (the 2-day overlap) count nothing twice
    ({ state, notify } = run(state, [xo(1, '1'), xo(1, '2')], all(ok('bob'))));
    expect(notify).toEqual([]);
  });
  it('only verified Monero people count; unknown senders wait, then count once known', () => {
    let { state } = run(freshXoInbox(ME), [], all(null));
    const e = xo(2, '9');
    ({ state } = run(state, [e], all({ ok: false })));
    expect(xoCounts(state)).toEqual({});
    const e2 = xo(3, '9');
    let notify;
    ({ state, notify } = run(state, [e2], all(null)));
    expect(state.pending.map((p) => p.ev.id)).toEqual([e2.id]);
    expect(notify).toEqual([]);
    // next check: the relay no longer returns it, the pending list still has it
    ({ state, notify } = run(state, [], all(ok('carol'))));
    expect(notify.map((n) => n.handle)).toEqual(['carol']);
    expect(state.pending).toEqual([]);
  });
  it('a pending xo is dropped after a week, and the list is capped', () => {
    let { state } = run(freshXoInbox(ME), [], all(null));
    ({ state } = run(state, [xo(4, '5')], all(null)));
    ({ state } = run(state, [], all(null), [], NOW + 8 * 86_400_000));
    expect(state.pending).toEqual([]);
    expect(MAX_PENDING).toBe(500);
  });
  it('a sender’s deletion takes their xo back; someone else’s doesn’t', () => {
    let { state } = run(freshXoInbox(ME), [], all(null));
    const e = xo(5, '7');
    ({ state } = run(state, [e], all(ok('dan'))));
    const fake = sign(people[6]!, undoTemplate(e.id, SECS));
    ({ state } = run(state, [], all(ok('dan')), [fake]));
    expect(xoCounts(state)).toEqual({ '7': 1 });
    const real = sign(people[5]!, undoTemplate(e.id, SECS));
    ({ state } = run(state, [], all(ok('dan')), [real]));
    expect(xoCounts(state)).toEqual({});
    expect(state.items).toEqual([]);
  });
  it('forged xos and forged deletions count for nothing', () => {
    let { state } = run(freshXoInbox(ME), [], all(null));
    const real = xo(7, '8');
    const forged = { ...xo(8, '8'), sig: '0'.repeat(128) };
    ({ state } = run(state, [real, forged], all(ok('eve'))));
    expect(xoCounts(state)).toEqual({ '8': 1 });
    const fakeDelete = { ...sign(people[7]!, undoTemplate(real.id, SECS)), sig: '0'.repeat(128) };
    ({ state } = run(state, [], all(ok('eve')), [fakeDelete]));
    expect(xoCounts(state)).toEqual({ '8': 1 });
  });
  it('xos to someone else, and the user’s own, aren’t counted', () => {
    const { state } = run(freshXoInbox(ME), [xo(0, '1', SECS - 60, PK[3]!), sign(me, xoTemplate('1', ME, SECS - 60))], all(ok('x')));
    expect(xoCounts(state)).toEqual({});
  });
  it('looks back two days past the last xo, 30 days the first time', () => {
    expect(xoSince(freshXoInbox(ME), NOW)).toBe(SECS - 30 * 86_400);
    expect(xoSince({ ...freshXoInbox(ME), sinceAt: SECS }, NOW)).toBe(SECS - OVERLAP_SECS);
  });
  it('the notification', () => {
    const it1 = { id: '1', statusId: '1', liker: 'a', handle: 'alice', at: 1 };
    expect(xoNotice([it1])).toBe('@alice sent your post an xo');
    expect(xoNotice([it1, { ...it1, id: '2', liker: 'b', handle: 'bob' }])).toBe('@alice and 1 other sent your post an xo');
    expect(xoNotice([it1, { ...it1, id: '2', statusId: '2', liker: 'b', handle: 'bob' }, { ...it1, id: '3', liker: 'c', handle: 'c' }])).toBe('@alice and 2 others sent your posts xos');
  });
  it('a check asks about at most 10 new senders; the rest wait for the next', async () => {
    let held: XoInbox | null = { ...freshXoInbox(ME), baseline: 'done', sinceAt: SECS - 3600 };
    const verify = vi.fn(async (): Promise<Liker | null> => ({ ok: true, handle: 'x' }));
    const events = PK.map((_, i) => xo(i, String(100 + i)));
    const k = xoKeeper({
      held: { getValue: async () => held, setValue: async (v) => void (held = v), removeValue: async () => void (held = null) },
      counts: { setValue: async () => {} },
      enabled: async () => true,
      pubkey: async () => ME,
      relays: async () => ['wss://r'],
      read: async () => ({ events, readable: ['wss://r'] }),
      query: async () => [],
      known: async () => null,
      verify,
      alarms: { create: () => {}, clear: () => {}, get: async () => ({ periodInMinutes: 30 }) },
      notify: async () => {},
      clearNotice: async () => {},
      now: () => NOW,
    });
    await k.check();
    expect(verify).toHaveBeenCalledTimes(10);
    expect(Object.keys(xoCounts(held!)).length).toBe(10);
    expect(held!.pending.length).toBe(4);
  });
});

import { xoKey, mergeBadge, type BadgeEntry } from '../src/identity/resolve';
describe('xoKey (PLAN-XOKEYS)', () => {
  const base = { address: ADDRESS, check: { ok: true as const, type: 'standard' as const }, verified: true };
  it('a Nostr-verified key first, else the key the account linked on xmr.bio, else none', () => {
    const nostr: BadgeEntry = { ...base, source: 'nostr', method: 'nip39:x', pubkey: PK[0]! };
    const bio: BadgeEntry = { ...base, source: 'xmrbio', method: 'xmrbio:directory', pubkey: PK[1]! };
    expect(xoKey(mergeBadge('a', [bio, nostr]))).toBe(PK[0]);
    expect(xoKey(mergeBadge('a', [bio]))).toBe(PK[1]);
    expect(xoKey(mergeBadge('a', [{ ...bio, pubkey: undefined }]))).toBeNull();
  });
});

import { proofTweetText } from '../src/identity/proof-tweet';
import { containsNpub } from '../src/identity/nostr';
import { npubEncode as npubOf } from 'nostr-tools/nip19';
describe('the proof tweet', () => {
  it('ends with where it’s from, and still proves the key', () => {
    const npub = npubOf(PK[0]!);
    const text = proofTweetText(npub);
    expect(text).toBe(`Verifying that I control the following Nostr public key: ${npub}\n\ntry it on: XMRadar.app`);
    expect(containsNpub(text, npub)).toBe(true);
  });
});
