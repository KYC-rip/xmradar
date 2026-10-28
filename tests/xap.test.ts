import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { finalizeEvent, generateSecretKey, getPublicKey, type Event, type EventTemplate } from 'nostr-tools/pure';
import { describe, expect, it, vi } from 'vitest';
import type { XapTotals } from '../src/messaging';
import { formatXmr, parseXmr, randomPico, shortXmr, uniqueAmount } from '../src/xap/amount';
import { countXaps, VERIFYING_SECS } from '../src/xap/count';
import { parseConfirmation, parseReceipt, receiptTemplate } from '../src/xap/events';
import { currentAddress, type XapQuery } from '../src/xap/fetch';
import { FreshTotals, countFor, countPosts, publishXap, validPosts, withSent, type PublishDeps } from '../src/xap/service';
import { xapTtl, XAP_EMPTY_TTL_MS, XAP_TTL_MS } from '../src/xap/ttl';
import { postKey, postOf, statusIdOf, xPostId } from '../src/xap/post';
import { articleViewSlot, tweetSlot } from '../src/identity/x-handle';
import { confirmText, mineLine, profileLine, totalsLines } from '../src/entrypoints/content/xap-popup';
import { insertXap, ownXap, ownXaps, setXapCount, XAP_SELECTOR } from '../src/entrypoints/content/x-xap';
import { hoverCardSlot } from '../src/identity/x-handle';
import { xapEntry, type Badge, type BadgeEntry } from '../src/identity/resolve';
import { makeDoc } from './helpers';

// mainnet addresses with valid checksums (from the address tests)
const ADDR = '44AFFq5kSiGBoZ4NMDwYtN18obc8AemS33DBLWs3H7otXft3XjrpDtQGv7SqSsaBYBb98uNbr2VBBEt7f2wfn3RVGQBEP3A';
const ADDR2 = '888tNkZrPN6JsEgekjMnABU4TBzc2Dt29EPAvkRxbANsAnjyPbb3iQ1YBRk1UXcdRsiKc9dhwMVgN5S9cQUiyoogDavup3H';
const INTEGRATED = '4LL9oSLmtpccfufTMvppY6JwXNouMBzSkbLYfpAV5Usx3skxNgYeYTRj5UzqtReoS44qo9mtmXCqY45DJ852K5Jv2bYXZKKQePHES9khPK';

const recipientSk = generateSecretKey();
const RECIPIENT = getPublicKey(recipientSk);
const tipperSk = generateSecretKey();
const TIPPER = getPublicKey(tipperSk);
const otherSk = generateSecretKey();
const OTHER = getPublicKey(otherSk);
const NOW = 1_800_000_000;
const T1 = 'a'.repeat(64);
const T2 = 'b'.repeat(64);

const sign = (sk: Uint8Array, t: Partial<EventTemplate>): Event =>
  finalizeEvent({ kind: 9042, content: '', created_at: NOW - 3600, tags: [], ...t } as EventTemplate, sk);

function receipt(opts: { sk?: Uint8Array; amount?: string; address?: string; legacy?: boolean; tags?: string[][]; content?: string; ago?: number } = {}) {
  const tags = opts.tags ?? [
    ['p', RECIPIENT],
    ['amount', opts.amount ?? '0.01'],
    ['unit', 'xmr'],
    ['address', opts.address ?? ADDR],
    ['client', 'test'],
    ...(opts.legacy ? [] : [['v', 'nkip02/1']]),
  ];
  return sign(opts.sk ?? tipperSk, { kind: 9042, tags, content: opts.content ?? '', created_at: NOW - (opts.ago ?? 3600) });
}

function confirmation(r: Event, opts: { sk?: Uint8Array; amount?: string; method?: string; t?: string; extra?: string[][]; tipper?: string } = {}) {
  return sign(opts.sk ?? recipientSk, {
    kind: 9044,
    tags: [
      ['e', r.id],
      ['p', opts.tipper ?? r.pubkey],
      ['amount', opts.amount ?? r.tags.find((t) => t[0] === 'amount')![1]!],
      ['method', opts.method ?? 'tx-proof'],
      ['t', opts.t ?? T1],
      ['v', 'nkip02/1'],
      ...(opts.extra ?? []),
    ],
  });
}

const deletion = (ids: string[], sk = recipientSk) => sign(sk, { kind: 5, tags: ids.map((id) => ['e', id]) });

const count = (events: Event[], extra: Partial<Parameters<typeof countXaps>[0]> = {}) =>
  countXaps({ recipient: RECIPIENT, events, current: [ADDR], now: NOW, ...extra });

describe('amounts (BigInt piconero)', () => {
  it('parses decimal XMR exactly and rejects everything else', () => {
    expect(parseXmr('0.01')).toBe(10_000_000_000n);
    expect(parseXmr('1')).toBe(1_000_000_000_000n);
    expect(parseXmr('0.000000000001')).toBe(1n);
    for (const bad of ['0', '0.0', '0.0000000000001', '-1', '1e-3', '0,01', ' 0.01', '0.01 ', '.5', '1.', '+1', String(0.1 + 0.2)]) expect(parseXmr(bad), bad).toBeNull();
  });
  it('formats round-trip exact, with no float in between', () => {
    for (const s of ['0.01', '1', '0.010000437215', '123.000000000001']) expect(formatXmr(parseXmr(s)!)).toBe(s);
    expect(formatXmr(parseXmr('0.1')! + parseXmr('0.2')!)).toBe('0.3');
    expect(shortXmr(parseXmr('0.010000437215')!)).toBe('0.01');
    expect(shortXmr(parseXmr('0.00000001')!)).toBe('<0.0001');
  });
  it('adds 1–999,999 random piconero', () => {
    expect(randomPico(() => new Uint32Array([0]))).toBe(1n);
    expect(randomPico(() => new Uint32Array([999_998]))).toBe(999_999n);
    // values in the uneven top range are drawn again
    const draws = [2 ** 32 - 1, 5];
    expect(randomPico(() => new Uint32Array([draws.shift()!]))).toBe(6n);
    for (let i = 0; i < 200; i++) {
      const v = randomPico();
      expect(v >= 1n && v <= 999_999n).toBe(true);
    }
    expect(formatXmr(uniqueAmount(parseXmr('0.01')!, 437_215n))).toBe('0.010000437215');
    expect(() => uniqueAmount(1n, 0n)).toThrow();
    expect(() => uniqueAmount(1n, 1_000_000n)).toThrow();
  });
});

describe('receipt template', () => {
  it('has exactly p, amount, unit, address, client and v, empty content, and nothing secret', () => {
    const before = Math.floor(Date.now() / 1000);
    const t = receiptTemplate({ recipient: RECIPIENT, amount: '0.010000437215', address: ADDR });
    expect(t.kind).toBe(9042);
    expect(t.content).toBe('');
    expect(Number.isInteger(t.created_at) && Math.abs(t.created_at - before) <= 5).toBe(true);
    expect(t.tags.map((x) => x[0]).sort()).toEqual(['address', 'amount', 'client', 'p', 'unit', 'v']);
    expect(t.tags).toContainEqual(['v', 'nkip02/1']);
    for (const bad of ['e', 'txid', 'tx', 'tx_key', 'txkey', 'proof']) expect(t.tags.some((x) => x[0] === bad)).toBe(false);
  });
  it('refuses a bad key, amount or an integrated address', () => {
    expect(() => receiptTemplate({ recipient: 'x', amount: '1', address: ADDR })).toThrow();
    expect(() => receiptTemplate({ recipient: RECIPIENT, amount: '0', address: ADDR })).toThrow();
    expect(() => receiptTemplate({ recipient: RECIPIENT, amount: '1', address: INTEGRATED })).toThrow();
  });
});

describe('receipt and confirmation rules', () => {
  it('drops malformed receipts', () => {
    const base = [['p', RECIPIENT], ['amount', '0.01'], ['unit', 'xmr'], ['address', ADDR], ['v', 'nkip02/1']];
    const without = (n: string) => base.filter((t) => t[0] !== n);
    const cases: [string, string[][], string?][] = [
      ['two p', [...base, ['p', OTHER]]],
      ['bad p', [...without('p'), ['p', 'XYZ']]],
      ['two e', [...base, ['e', T1], ['e', T2]]],
      ['two amounts', [...base, ['amount', '1']]],
      ['13 decimals', [...without('amount'), ['amount', '0.0000000000001']]],
      ['zero', [...without('amount'), ['amount', '0']]],
      ['no address', without('address')],
      ['integrated', [...without('address'), ['address', INTEGRATED]]],
      ['other unit', [...without('unit'), ['unit', 'btc']]],
      ['v1 without unit', without('unit')],
      ['unknown v', [...without('v'), ['v', 'nkip02/9']]],
      ['v1 with content', base, 'hi'],
    ];
    for (const [name, tags, content] of cases) expect(parseReceipt(receipt({ tags, content })), name).toBeNull();
  });
  it('reads legacy receipts (no v, text, no unit) and ignores secret tags', () => {
    const legacy = parseReceipt(receipt({ tags: [['p', RECIPIENT], ['amount', '0.5'], ['address', ADDR]], content: 'thanks!' }))!;
    expect(legacy.legacy).toBe(true);
    expect(legacy.amount).toBe(500_000_000_000n);
    const withTxid = parseReceipt(receipt({ tags: [['p', RECIPIENT], ['amount', '0.01'], ['unit', 'xmr'], ['address', ADDR], ['v', 'nkip02/1'], ['txid', T1]] }));
    expect(withTxid).not.toBeNull();
    expect(Object.values(withTxid!).includes(T1)).toBe(false);
  });
  it('drops malformed confirmations, including any that carry a txid or proof', () => {
    const r = receipt();
    expect(parseConfirmation(confirmation(r))).not.toBeNull();
    expect(parseConfirmation(confirmation(r, { method: 'guess' }))).toBeNull();
    expect(parseConfirmation(confirmation(r, { t: 'short' }))).toBeNull();
    expect(parseConfirmation(confirmation(r, { amount: '0' }))).toBeNull();
    for (const tag of ['txid', 'tx', 'tx_key', 'txkey', 'proof']) expect(parseConfirmation(confirmation(r, { extra: [[tag, T1]] })), tag).toBeNull();
  });
});

describe('counting (NKIP-0002 §Counting)', () => {
  it('a valid receipt is claimed; a legacy one too (R7)', () => {
    const c = count([receipt(), receipt({ sk: otherSk, legacy: true, content: 'old', amount: '0.02' })]);
    expect(formatXmr(c.claimed)).toBe('0.03');
    expect(c.claimedTippers).toBe(2);
    expect(c.verified).toBe(0n);
  });
  it('drops self-tips, note tips, duplicates and bad signatures', () => {
    const self = sign(recipientSk, { tags: [['p', RECIPIENT], ['amount', '1'], ['unit', 'xmr'], ['address', ADDR], ['v', 'nkip02/1']] });
    const note = receipt({ tags: [['e', T1], ['p', RECIPIENT], ['amount', '1'], ['unit', 'xmr'], ['address', ADDR], ['v', 'nkip02/1']] });
    const r = receipt();
    const forged = { ...receipt({ sk: otherSk, amount: '5' }), sig: r.sig };
    expect(formatXmr(count([self, note, r, r, forged]).claimed)).toBe('0.01');
  });
  it('claimed: only the current address (R10), and one smallest receipt per tipper', () => {
    const old = receipt({ address: ADDR2, amount: '9' });
    expect(count([old]).claimed).toBe(0n);
    expect(formatXmr(count([receipt({ amount: '0.5' }), receipt({ amount: '0.2' })]).claimed)).toBe('0.2');
  });
  it('a receipt confirmed for two transfers counts once, at the smaller amount', () => {
    const r = receipt({ amount: '0.5' });
    expect(formatXmr(count([r, confirmation(r, { t: T1, amount: '0.4' }), confirmation(r, { t: T2, amount: '0.2' })]).verified)).toBe('0.2');
  });
  it('verified: the lower amount, also for an old address (rule 4)', () => {
    const r = receipt({ address: ADDR2, amount: '0.5' });
    const c = count([r, confirmation(r, { amount: '0.3' })]);
    expect(formatXmr(c.verified)).toBe('0.3');
    expect(c.verifiedTippers).toBe(1);
    const r2 = receipt({ amount: '0.1' });
    expect(formatXmr(count([r2, confirmation(r2, { amount: '0.4' })]).verified)).toBe('0.1');
  });
  it('ignores confirmations by someone else, naming another tipper, or withdrawn', () => {
    const r = receipt();
    expect(count([r, confirmation(r, { sk: otherSk })]).verified).toBe(0n);
    expect(count([r, confirmation(r, { tipper: OTHER })]).verified).toBe(0n);
    const c = confirmation(r);
    const res = count([r, c, deletion([c.id])]);
    expect(res.verified).toBe(0n);
    expect(formatXmr(res.claimed)).toBe('0.01');
    // only the recipient can withdraw
    expect(formatXmr(count([r, c, deletion([c.id], otherSk)]).verified)).toBe('0.01');
  });
  it('one transfer, two receipts: the lowest receipt id is verified, the other stays claimed (R6)', () => {
    const a = receipt({ amount: '0.1' });
    const b = receipt({ sk: otherSk, amount: '0.2' });
    const [low, high] = a.id < b.id ? [a, b] : [b, a];
    const c = count([a, b, confirmation(a, { t: T1 }), confirmation(b, { t: T1 })]);
    expect(c.verified).toBe(parseXmr(low.tags.find((t) => t[0] === 'amount')![1]!));
    expect(c.claimed).toBe(parseXmr(high.tags.find((t) => t[0] === 'amount')![1]!));
  });
  it('legacy receipts are verified only by tx-proof (R13)', () => {
    const legacy = receipt({ legacy: true });
    expect(count([legacy, confirmation(legacy, { method: 'wallet-match' })]).verified).toBe(0n);
    expect(count([legacy, confirmation(legacy, { method: 'tx-proof' })]).verified).toBe(parseXmr('0.01'));
    const v1 = receipt();
    expect(count([v1, confirmation(v1, { method: 'wallet-match' })]).verified).toBe(parseXmr('0.01'));
  });
  it('sums exactly in piconero', () => {
    const rs = ['0.000000000001', '0.1', '0.2'].map((amount, i) => receipt({ sk: [tipperSk, otherSk, generateSecretKey()][i], amount }));
    expect(formatXmr(count(rs).claimed)).toBe('0.300000000001');
  });

  describe('verifying: own, recent, and no confirmation event for it at all', () => {
    const mine = (r: Event) => ({ me: { pubkey: TIPPER, sent: new Set([r.id]) } });
    const state = (events: Event[], r: Event) => count(events, mine(r)).mine.find((m) => m.id === r.id)!.state;
    it('no confirmation event at 10 min: verifying; at 29:59 too; at 30:00 claimed', () => {
      const r = receipt({ ago: 600 });
      const c = count([r], mine(r));
      expect(c.verifying).toBe(parseXmr('0.01'));
      expect(c.claimed).toBe(0n);
      expect(state([receipt({ ago: VERIFYING_SECS - 1 })], receipt({ ago: VERIFYING_SECS - 1 }))).toBe('verifying');
      expect(state([receipt({ ago: VERIFYING_SECS })], receipt({ ago: VERIFYING_SECS }))).toBe('claimed');
    });
    it('confirmed at 10 min: verified', () => {
      const r = receipt({ ago: 600 });
      expect(state([r, confirmation(r)], r)).toBe('verified');
    });
    it('a confirmation event that does not count leaves it claimed, never verifying', () => {
      const r = receipt({ ago: 600 });
      const c = confirmation(r);
      expect(state([r, c, deletion([c.id])], r), 'deleted').toBe('claimed');
      expect(state([r, confirmation(r, { sk: otherSk })], r), 'wrong signer').toBe('claimed');
      expect(state([r, confirmation(r, { extra: [['txid', T1]] })], r), 'txid').toBe('claimed');
      // two receipts on one transfer: the higher id loses the dedupe, and that one is ours
      const pair = [receipt({ ago: 600, amount: '0.3' }), receipt({ sk: otherSk, ago: 600, amount: '0.3' })];
      const [low, high] = pair[0]!.id < pair[1]!.id ? pair : [pair[1]!, pair[0]!];
      const asTipper = (ev: Event) => ({ me: { pubkey: ev.pubkey, sent: new Set([ev.id]) } });
      const dd = count([low!, high!, confirmation(low!, { t: T2 }), confirmation(high!, { t: T2 })], asTipper(high!));
      expect(dd.mine.find((m) => m.id === high!.id)!.state, 'dedupe').toBe('claimed');
      expect(dd.verified).toBe(parseXmr('0.3'));
      const legacy = receipt({ legacy: true, ago: 600 });
      expect(state([legacy, confirmation(legacy, { method: 'wallet-match' })], legacy), 'legacy wallet-match').toBe('claimed');
      const lc = confirmation(legacy, { method: 'tx-proof' });
      expect(state([legacy, lc, deletion([lc.id])], legacy), 'legacy deleted tx-proof').toBe('claimed');
    });
    it("someone else's receipt is never verifying; nor one this device didn't record", () => {
      const theirs = receipt({ sk: otherSk, ago: 300 });
      expect(count([theirs], { me: { pubkey: TIPPER, sent: new Set([theirs.id]) } }).verifying).toBe(0n);
      const r = receipt({ ago: 300 });
      const c = count([r], { me: { pubkey: TIPPER, sent: new Set() } });
      expect(c.verifying).toBe(0n);
      expect(c.mine[0]).toMatchObject({ state: 'claimed', recorded: false });
    });
  });
});

describe('current address (R10)', () => {
  it('NIP-A3 first (monero or xmr), kind 0 only without one', () => {
    const payto = sign(recipientSk, { kind: 10133, tags: [['payto', 'bitcoin', 'x'], ['payto', 'xmr', ADDR]] });
    const meta = sign(recipientSk, { kind: 0, content: JSON.stringify({ monero: ADDR2 }) });
    expect(currentAddress([payto, meta], RECIPIENT)).toBe(ADDR);
    expect(currentAddress([meta], RECIPIENT)).toBe(ADDR2);
    expect(currentAddress([sign(recipientSk, { kind: 0, content: JSON.stringify({ monero_address: INTEGRATED }) })], RECIPIENT)).toBeNull();
    expect(currentAddress([sign(otherSk, { kind: 10133, tags: [['payto', 'monero', ADDR]] })], RECIPIENT)).toBeNull();
  });
});

/** A fake relay set answering filters from a list of events. */
function relaysWith(events: () => Event[]): XapQuery {
  return async (_relays, f) =>
    events().filter(
      (e) =>
        (!f.kinds || f.kinds.includes(e.kind)) &&
        (!f.authors || f.authors.includes(e.pubkey)) &&
        (!f.ids || f.ids.includes(e.id)) &&
        (!f['#p'] || e.tags.some((t) => t[0] === 'p' && f['#p']!.includes(t[1]!))) &&
        (!f['#e'] || e.tags.some((t) => t[0] === 'e' && f['#e']!.includes(t[1]!))) &&
        (!f['#i'] || e.tags.some((t) => t[0] === 'i' && f['#i']!.includes(t[1]!))),
    );
}

describe('totals service', () => {
  it('counts claimed against the address read now: an address change drops old-address claims, not verified ones', async () => {
    const oldClaim = receipt({ address: ADDR, amount: '0.2' });
    const oldVerified = receipt({ sk: otherSk, address: ADDR, amount: '0.1' });
    let world = [sign(recipientSk, { kind: 10133, tags: [['payto', 'monero', ADDR]], created_at: NOW - 9000 }), oldClaim, oldVerified, confirmation(oldVerified)];
    const deps = { query: relaysWith(() => world), lookupRelays: async () => ['wss://a'], me: async () => ({ pubkey: null, sent: [] }), now: () => NOW * 1000 };
    const before = (await countFor([RECIPIENT], deps)).get(RECIPIENT)!;
    expect(before).toMatchObject({ verified: '0.1', claimed: '0.2', address: ADDR });
    world = [...world, sign(recipientSk, { kind: 10133, tags: [['payto', 'monero', ADDR2]], created_at: NOW - 10 })];
    const after = (await countFor([RECIPIENT], deps)).get(RECIPIENT)!;
    expect(after).toMatchObject({ verified: '0.1', claimed: '0', address: ADDR2 });
  });
  it('fresh totals: popups share one fetch, reuse it under 15 s, and refetch after', async () => {
    let t = 0;
    const fetchOne = vi.fn(async () => ({ at: t }) as XapTotals);
    const fresh = new FreshTotals(fetchOne, () => t);
    await Promise.all([fresh.get(RECIPIENT), fresh.get(RECIPIENT)]);
    expect(fetchOne).toHaveBeenCalledTimes(1);
    t = 14_000;
    await fresh.get(RECIPIENT);
    expect(fetchOne).toHaveBeenCalledTimes(1);
    t = 15_000;
    expect((await fresh.get(RECIPIENT)).at).toBe(15_000);
    fresh.forget(RECIPIENT);
    await fresh.get(RECIPIENT);
    expect(fetchOne).toHaveBeenCalledTimes(3);
  });
  it('an empty result is cached briefly, since it can be a relay hiccup', () => {
    const t = { verified: '0', verifiedTippers: 0, verifying: '0', claimed: '0', claimedTippers: 0, address: ADDR, mine: [], at: 0 };
    expect(xapTtl(t)).toBe(XAP_EMPTY_TTL_MS);
    expect(xapTtl({ ...t, claimed: '0.0016' })).toBe(XAP_TTL_MS);
  });
  it('keeps at most 200 sent records', () => {
    let list: ReturnType<typeof withSent> = [];
    for (let i = 0; i < 205; i++) list = withSent(list, { receiptId: String(i), recipient: RECIPIENT, amount: '1', address: ADDR, at: i });
    expect(list.length).toBe(200);
    expect(list[0]!.receiptId).toBe('5');
  });
});

describe('xap-publish', () => {
  const deps = (over: Partial<PublishDeps> = {}): PublishDeps => ({
    query: relaysWith(() => [sign(recipientSk, { kind: 10133, tags: [['payto', 'monero', ADDR]] })]),
    lookupRelays: async () => ['wss://a'],
    myRelays: async () => ['wss://mine', 'wss://purplepag.es'],
    pubkey: async () => TIPPER,
    sign: async (t) => finalizeEvent(t, tipperSk),
    publish: async (relays) => relays.map((relay) => ({ relay, ok: true, message: 'ok' })),
    record: vi.fn(async () => {}),
    ...over,
  });
  const req = { recipient: RECIPIENT, address: ADDR, amount: '0.010000437215' };

  it('signs the exact receipt, publishes outside index relays and records it', async () => {
    const d = deps();
    const signed: EventTemplate[] = [];
    const res = await publishXap(req, { ...d, sign: async (t) => (signed.push(t), finalizeEvent(t, tipperSk)) });
    expect(signed[0]!.tags).toContainEqual(['amount', '0.010000437215']);
    expect(res.results.map((r) => r.relay)).toContain('wss://mine');
    expect(res.results.map((r) => r.relay)).not.toContain('wss://purplepag.es');
    expect(d.record).toHaveBeenCalledWith(expect.objectContaining({ receiptId: res.id, amount: '0.010000437215' }));
  });
  it('refuses bad input, a self-Xap, no signer, and an address that changed', async () => {
    await expect(publishXap({ ...req, recipient: 'nope' }, deps())).rejects.toThrow();
    await expect(publishXap({ ...req, address: INTEGRATED }, deps())).rejects.toThrow();
    await expect(publishXap({ ...req, amount: '0.0000000000001' }, deps())).rejects.toThrow();
    await expect(publishXap(req, deps({ pubkey: async () => RECIPIENT }))).rejects.toThrow(/tipped itself/);
    await expect(publishXap(req, deps({ pubkey: async () => null }))).rejects.toThrow(/signer/);
    const sign = vi.fn();
    await expect(publishXap({ ...req, address: ADDR2 }, deps({ sign }))).rejects.toThrow('ADDRESS_CHANGED');
    expect(sign).not.toHaveBeenCalled();
  });
  it('records nothing when every relay failed', async () => {
    const d = deps({ publish: async (relays) => relays.map((relay) => ({ relay, ok: false, message: 'no' })) });
    await publishXap(req, d);
    expect(d.record).not.toHaveBeenCalled();
  });
});

describe('popup copy', () => {
  const t = (o: Partial<XapTotals>): XapTotals => ({ verified: '0', verifiedTippers: 0, verifying: '0', claimed: '0', claimedTippers: 0, address: ADDR, mine: [], at: 0, ...o });
  it('shows the three states separately and never sums them', () => {
    const lines = totalsLines(t({ verified: '0.004', verifiedTippers: 2, verifying: '0.01', claimed: '0.002', claimedTippers: 1 }), null, 'xbtoshi');
    expect(lines).toEqual(['ɱ 0.004 ✓ verified (2 tippers)', 'ɱ 0.01 verifying (yours, usually about 20 min)', '+ɱ 0.002 claimed (1 tipper, not yet confirmed by @xbtoshi)']);
    expect(lines.join(' ')).not.toMatch(/0\.016|0\.006|0\.014/);
    expect(totalsLines(t({}), null, 'x')).toEqual(['No Xaps yet']);
  });
  it('shows a cached verified figure while loading, never a cached claimed one', () => {
    const cached = t({ verified: '0.004', verifiedTippers: 1, claimed: '9' });
    expect(totalsLines(null, cached, 'x')).toEqual(['ɱ 0.004 ✓ verified (1 tipper)', 'Claimed: updating…']);
    expect(totalsLines(null, null, 'x')).toEqual(['Loading Xaps…']);
  });
  it('the confirmation names both keys and the amount, and says no txid', () => {
    const text = confirmText('xbtoshi', '0.010000437215');
    expect(text).toContain('your Nostr key');
    expect(text).toContain("@xbtoshi's Nostr key");
    expect(text).toContain('0.010000437215 XMR');
    expect(text).toContain('never contains your transaction id');
  });
  it('explains your own receipt', () => {
    expect(mineLine(t({ mine: [{ amount: '0.01', state: 'claimed', recorded: false }] }), 'x')).toMatch(/another device/);
    expect(mineLine(t({ mine: [{ amount: '0.01', state: 'verifying', recorded: true }] }), 'x')).toMatch(/verifying/);
  });
});

describe('Xap recipient', () => {
  const nostr = (o: Partial<BadgeEntry>): BadgeEntry => ({ source: 'nostr', address: ADDR, check: { ok: true, type: 'standard' }, verified: true, method: 'nip39:client', pubkey: RECIPIENT, createdAt: 1, ...o });
  it('is the newest verified Nostr entry, even when xmr.bio is primary', () => {
    const xmrbio: BadgeEntry = { source: 'xmrbio', address: ADDR2, check: { ok: true, type: 'standard' }, verified: true, method: 'xmrbio' };
    const newer = nostr({ pubkey: OTHER, createdAt: 5 });
    const badge: Badge = { handle: 'x', primary: xmrbio, entries: [xmrbio, nostr({}), newer, nostr({ verified: false, createdAt: 9 })], differ: true };
    expect(xapEntry(badge)).toBe(newer);
    expect(xapEntry({ ...badge, entries: [xmrbio] })).toBeNull();
    expect(xapEntry({ ...badge, entries: [nostr({ check: { ok: true, type: 'integrated' } })] })).toBeNull();
  });
});

describe('action-bar button', () => {
  const raw = readFileSync(join(process.cwd(), 'tests/fixtures/x-share-menu.html'), 'utf8');
  const setup = () => {
    document.body.innerHTML = raw;
    return document.querySelector('article')!;
  };
  it('goes once before the share button, cleaned of X ids, and clicks stay ours', () => {
    const article = setup();
    const onClick = vi.fn();
    const articleClick = vi.fn();
    article.addEventListener('click', articleClick);
    const el = insertXap(article, { handle: 'XBToshi', key: '1:xbtoshi', pubkey: RECIPIENT, onClick })!;
    const bar = article.querySelector('[role="group"]')!;
    expect(bar.children[bar.children.length - 2]).toBe(el);
    expect(bar.lastElementChild!.querySelector('button[aria-haspopup="menu"]')).not.toBeNull();
    expect(el.querySelectorAll('[data-testid], [id]').length).toBe(0);
    const btn = el.querySelector('button')!;
    expect(btn.getAttribute('aria-label')).toBe('Xap @XBToshi (Monero tip)');
    expect(el.querySelector('svg')!.getAttribute('viewBox')).toBe('0 0 6000 6000');
    expect(el.querySelector('[data-xmradar="xap-count"]')!.textContent).toBe('');
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true });
    btn.dispatchEvent(ev);
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(ev.defaultPrevented).toBe(true);
    expect(articleClick).not.toHaveBeenCalled();
    expect(document.querySelectorAll(XAP_SELECTOR).length).toBe(1);
  });
  it('hover colours the icon and its backdrop orange, as X does for its own buttons', () => {
    const el = insertXap(setup(), { handle: 'x', key: 'k', onClick: () => {} })!;
    const btn = el.querySelector('button')!;
    const tone = btn.firstElementChild as HTMLElement;
    const rest = tone.style.color;
    btn.dispatchEvent(new Event('pointerenter'));
    expect(tone.style.color).toMatch(/#f26822|rgb\(242, 104, 34\)/);
    btn.dispatchEvent(new Event('pointerleave'));
    expect(tone.style.color).toBe(rest);
  });
  it('shows the verified total, else the claimed one as "~", never the two summed', () => {
    const el = insertXap(setup(), { handle: 'XBToshi', key: 'k', onClick: () => {} })!;
    const totals = { verified: '0', verifiedTippers: 0, verifying: '0.5', claimed: '0', claimedTippers: 0, address: ADDR, mine: [], at: 0 };
    setXapCount(el, 'XBToshi', totals);
    expect(el.querySelector('[data-xmradar="xap-count"]')!.textContent).toBe('');
    setXapCount(el, 'XBToshi', { ...totals, claimed: '0.001600188038', claimedTippers: 1 });
    expect(el.querySelector('[data-xmradar="xap-count"]')!.textContent).toBe('~0.0016');
    expect(el.querySelector('button')!.getAttribute('aria-label')).toBe('Xap @XBToshi (Monero tip), ~ɱ 0.001600188038 claimed by 1 tipper, not confirmed');
    setXapCount(el, 'XBToshi', { ...totals, claimed: '3', claimedTippers: 2, verified: '0.004' });
    // both present: the verified figure alone, never 3.004
    expect(el.querySelector('[data-xmradar="xap-count"]')!.textContent).toBe('0.004');
    setXapCount(el, 'XBToshi', { ...totals, verified: '0.004' });
    expect(el.querySelector('[data-xmradar="xap-count"]')!.textContent).toBe('0.004');
    expect(el.querySelector('button')!.getAttribute('aria-label')).toBe('Xap @XBToshi (Monero tip), ɱ 0.004 verified');
  });
  it('the logo turns into the coloured Monero logo once the post has Xaps, with one coin flip per post', () => {
    const el = insertXap(setup(), { handle: 'XBToshi', key: 'k', pubkey: RECIPIENT, post: '777', onClick: () => {} })!;
    const svg = el.querySelector('svg')!;
    const fills = () => [...svg.querySelectorAll('path')].map((p) => (p.style.display === 'none' ? 'hidden' : p.getAttribute('fill')));
    expect(fills()).toEqual(['hidden', 'currentColor', 'currentColor']);
    const animate = vi.fn();
    (svg as unknown as { animate: typeof animate }).animate = animate;
    const totals = { verified: '0', verifiedTippers: 0, verifying: '0', claimed: '0.0017', claimedTippers: 1, address: ADDR, mine: [], at: 0 };
    setXapCount(el, 'XBToshi', totals, true);
    expect(fills()).toEqual(['#fff', '#f36e36', '#575757']);
    setXapCount(el, 'XBToshi', totals, true);
    expect(animate).toHaveBeenCalledTimes(1);
    setXapCount(el, 'XBToshi', { ...totals, claimed: '0' }, true);
    expect(fills()).toEqual(['hidden', 'currentColor', 'currentColor']);
  });
  it('a post with two action bars (an X Article on its own page) gets a button in each, both counted', () => {
    const article = setup();
    const bar = article.querySelector('[role="group"]')!;
    // as on a tweet's page: the top bar sits in the article body's own nested <article>
    const body = article.ownerDocument.createElement('article');
    body.dataset.testid = 'twitterArticleReadView';
    body.append(bar.cloneNode(true));
    bar.parentElement!.insertBefore(body, bar.parentElement!.firstChild);
    const first = insertXap(article, { handle: 'XBToshi', key: 'k', pubkey: RECIPIENT, post: '777', onClick: () => {} })!;
    expect(ownXaps(article)).toHaveLength(2);
    expect(first).toBe(ownXaps(article)[0]);
    // inserting again adds nothing
    insertXap(article, { handle: 'XBToshi', key: 'k', pubkey: RECIPIENT, post: '777', onClick: () => {} });
    expect(article.querySelectorAll(XAP_SELECTOR)).toHaveLength(2);
    for (const el of ownXaps(article)) expect(el.dataset).toMatchObject({ post: '777', pubkey: RECIPIENT, handle: 'XBToshi' });
  });
  it("never touches a button outside the tweet's own action bar", () => {
    const article = setup();
    const el = insertXap(article, { handle: 'XBToshi', key: 'k', onClick: () => {} })!;
    expect(ownXap(article)).toBe(el);
    // a Xap button somewhere else in the article (e.g. a quoted post) isn't this tweet's
    const elsewhere = el.cloneNode(true) as HTMLElement;
    article.querySelector('[data-testid="tweetText"]')!.append(elsewhere);
    el.remove();
    expect(ownXap(article)).toBeNull();
  });
  it('strips all of X data attributes from the clone', () => {
    const article = setup();
    article.querySelector('[data-testid="reply"]')!.parentElement!.setAttribute('data-engagement', 'reply');
    const el = insertXap(article, { handle: 'x', key: 'k', onClick: () => {} })!;
    const xs = [el, ...el.querySelectorAll('*')].flatMap((n) => [...n.attributes].filter((a) => a.name.startsWith('data-') && !['data-xmradar', 'data-key', 'data-handle'].includes(a.name)));
    expect(xs.map((a) => a.name)).toEqual([]);
  });
  it('inserts nothing into a bar without the reply or share button', () => {
    const article = setup();
    article.querySelector('[role="group"]')!.lastElementChild!.remove();
    expect(insertXap(article, { handle: 'x', key: 'k', onClick: () => {} })).toBeNull();
  });
});

describe('hover card', () => {
  it('puts the badge after the name, from the visible name link', () => {
    const doc = makeDoc(
      'https://x.com/home',
      `<div data-testid="HoverCard"><a href="/XBToshi" aria-hidden="true" role="link" tabindex="-1"><img></a>
       <a href="/XBToshi" role="link"><div id="row"><div dir="ltr"><span>CyberSatoshi</span></div></div></a>
       <a href="/XBToshi" role="link" tabindex="-1"><span>@XBToshi</span></a></div>`,
    );
    const slot = hoverCardSlot(doc.querySelector('[data-testid="HoverCard"]')!)!;
    expect(slot).toMatchObject({ handle: 'XBToshi', key: 'hover:xbtoshi' });
    expect(slot.anchor.id).toBe('row');
  });
});

describe('external post tips (NKIP-0002, R14–R16)', () => {
  const ID = '2113662765525282909';
  const POST = `https://x.com/i/status/${ID}`;
  const postReceipt = (opts: { sk?: Uint8Array; to?: string; amount?: string; i?: string[][]; ago?: number } = {}) =>
    receipt({
      sk: opts.sk,
      ago: opts.ago,
      tags: [
        ['p', opts.to ?? RECIPIENT],
        ...(opts.i ?? [['i', POST], ['k', 'web']]),
        ['amount', opts.amount ?? '0.01'],
        ['unit', 'xmr'],
        ['address', ADDR],
        ['client', 'test'],
        ['v', 'nkip02/1'],
      ],
    });

  it('one canonical spelling: https://x.com/i/status/<id>, nothing else', () => {
    expect(xPostId(ID)).toBe(POST);
    for (const bad of ['0123', '', 'abc', '1'.repeat(21)]) expect(() => xPostId(bad), bad).toThrow();
    expect(statusIdOf(POST)).toBe(ID);
    for (const bad of [`https://x.com/XBToshi/status/${ID}`, `https://twitter.com/i/status/${ID}`, `HTTPS://X.COM/i/status/${ID}`, `${POST}/`, `${POST}?s=20`, `${POST}#x`, 'https://x.com/i/status/0123'])
      expect(statusIdOf(bad), bad).toBeNull();
  });

  it('the receipt names the post with i and k, never e (R15)', () => {
    const t = receiptTemplate({ recipient: RECIPIENT, amount: '0.01', address: ADDR, post: ID, now: NOW });
    expect(t.tags).toContainEqual(['i', POST]);
    expect(t.tags).toContainEqual(['k', 'web']);
    expect(t.tags.some((x) => x[0] === 'e')).toBe(false);
    expect(() => receiptTemplate({ recipient: RECIPIENT, amount: '0.01', address: ADDR, post: '012' })).toThrow();
    expect(receiptTemplate({ recipient: RECIPIENT, amount: '0.01', address: ADDR }).tags.some((x) => x[0] === 'i')).toBe(false);
  });

  it('a receipt counts toward a post only with one canonical i, one k = web and no e', () => {
    expect(postOf(postReceipt())).toBe(POST);
    const cases: [string, string[][]][] = [
      ['handle form', [['i', `https://x.com/XBToshi/status/${ID}`], ['k', 'web']]],
      ['twitter.com', [['i', `https://twitter.com/i/status/${ID}`], ['k', 'web']]],
      ['wrong k', [['i', POST], ['k', 'x']]],
      ['no k', [['i', POST]]],
      ['two i', [['i', POST], ['i', 'https://x.com/i/status/1'], ['k', 'web']]],
      ['two k', [['i', POST], ['k', 'web'], ['k', 'web']]],
      ['e and i', [['e', T1], ['i', POST], ['k', 'web']]],
    ];
    for (const [what, i] of cases) expect(postOf(postReceipt({ i })), what).toBeNull();
  });

  it('post tips count toward the profile; a post counts only its own receipts', () => {
    const forPost = postReceipt({ amount: '0.02' });
    const otherPost = postReceipt({ sk: otherSk, i: [['i', 'https://x.com/i/status/1'], ['k', 'web']] });
    const profile = receipt({ sk: otherSk, amount: '0.03' });
    const all = [forPost, otherPost, profile];
    // the profile counts every tip without e: the smallest claim per tipper
    expect(count(all)).toMatchObject({ claimedTippers: 2 });
    expect(count(all, { post: POST })).toMatchObject({ claimed: parseXmr('0.02'), claimedTippers: 1 });
    // e and i: a note tip, so neither the post nor the profile counts it
    expect(count([postReceipt({ i: [['e', T1], ['i', POST], ['k', 'web']] })], { post: POST }).claimedTippers).toBe(0);
  });

  it('countPosts binds each post to its key (R14) and confirms within the post', async () => {
    const mine = postReceipt({ amount: '0.02' });
    const toOther = postReceipt({ sk: otherSk, to: OTHER });
    const world = [sign(recipientSk, { kind: 10133, tags: [['payto', 'monero', ADDR]], created_at: NOW - 9000 }), mine, toOther, confirmation(mine)];
    const deps = { query: relaysWith(() => world), lookupRelays: async () => ['wss://a'], me: async () => ({ pubkey: null, sent: [] }), now: () => NOW * 1000 };
    const out = await countPosts([{ id: ID, pubkey: RECIPIENT }], deps);
    // the receipt paid to another key never counts for this author's post
    expect(out.get(postKey(RECIPIENT, ID))).toMatchObject({ verified: '0.02', verifiedTippers: 1, claimed: '0', address: ADDR });
  });

  it('a confirmed post receipt beyond the newest 500 is fetched by id and verified', async () => {
    const old = postReceipt({ amount: '0.03', ago: 90_000 });
    const newer = Array.from({ length: 500 }, (_, n) => postReceipt({ sk: generateSecretKey(), amount: '0.001', ago: 100 + n }));
    const world = [sign(recipientSk, { kind: 10133, tags: [['payto', 'monero', ADDR]], created_at: NOW - 9000 }), old, ...newer, confirmation(old)];
    // relays honour the limit, newest first
    const base = relaysWith(() => world);
    const query: XapQuery = async (r, f) => (await base(r, f)).sort((a, b) => b.created_at - a.created_at).slice(0, f.limit ?? Infinity);
    const deps = { query, lookupRelays: async () => ['wss://a'], me: async () => ({ pubkey: null, sent: [] }), now: () => NOW * 1000 };
    expect((await countPosts([{ id: ID, pubkey: RECIPIENT }], deps)).get(postKey(RECIPIENT, ID))).toMatchObject({ verified: '0.03' });
  });

  it('validPosts keeps well-formed, distinct posts only', () => {
    expect(validPosts([{ id: ID, pubkey: RECIPIENT }, { id: ID, pubkey: RECIPIENT }, { id: '01', pubkey: RECIPIENT }, { id: ID, pubkey: 'x' }, null], 50)).toEqual([{ id: ID, pubkey: RECIPIENT }]);
    expect(validPosts('nope', 50)).toEqual([]);
    expect(validPosts(Array.from({ length: 1000 }, (_, n) => ({ id: String(n + 1), pubkey: RECIPIENT })), 50)).toHaveLength(50);
    // malformed entries don't use up the cap
    expect(validPosts([...Array.from({ length: 150 }, () => ({ id: 'x', pubkey: RECIPIENT })), { id: ID, pubkey: RECIPIENT }], 50)).toEqual([{ id: ID, pubkey: RECIPIENT }]);
  });

  it('publish names the post and refuses a malformed one', async () => {
    const signed: EventTemplate[] = [];
    const d: PublishDeps = {
      query: relaysWith(() => [sign(recipientSk, { kind: 10133, tags: [['payto', 'monero', ADDR]] })]),
      lookupRelays: async () => ['wss://a'],
      myRelays: async () => [],
      pubkey: async () => TIPPER,
      sign: async (t) => (signed.push(t), finalizeEvent(t, tipperSk)),
      publish: async (relays) => relays.map((relay) => ({ relay, ok: true, message: 'ok' })),
      record: async () => {},
    };
    await publishXap({ recipient: RECIPIENT, address: ADDR, amount: '0.01', post: ID }, d);
    expect(signed[0]!.tags).toContainEqual(['i', POST]);
    await expect(publishXap({ recipient: RECIPIENT, address: ADDR, amount: '0.01', post: `https://x.com/i/status/${ID}` }, d)).rejects.toThrow('Bad post');
  });

  it('the confirm step names the post (R16); the profile line stands apart from the post figure', () => {
    expect(confirmText('XBToshi', '0.01', ID)).toContain(`the post you tipped (x.com/i/status/${ID})`);
    expect(confirmText('XBToshi', '0.01')).not.toContain('post');
    const t = { verified: '0.004', verifiedTippers: 1, verifying: '0', claimed: '0.5', claimedTippers: 2, address: ADDR, mine: [], at: 0 };
    expect(profileLine(t, 'XBToshi')).toBe('All Xaps to @XBToshi: ɱ 0.004 ✓ verified, +ɱ 0.5 claimed');
    expect(profileLine({ ...t, verified: '0', claimed: '0' }, 'XBToshi')).toBe('All Xaps to @XBToshi: none yet');
    expect(profileLine({ ...t, verified: '0', verifying: '0.01', claimed: '0' }, 'XBToshi')).toBe('All Xaps to @XBToshi: ɱ 0.01 verifying (yours)');
  });

  it("the tweet's own status id, not a quoted tweet's", () => {
    const doc = makeDoc('https://x.com/home', `<article data-testid="tweet">
      <div data-testid="User-Name"><div><a href="/XBToshi">CyberSatoshi</a></div><a href="/XBToshi/status/${ID}">1h</a></div>
      <div role="link"><div data-testid="User-Name"><div><a href="/other">Other</a></div><a href="/other/status/42">2h</a></div></div>
    </article>`);
    expect(tweetSlot(doc.querySelector('article')!)).toMatchObject({ handle: 'XBToshi', statusId: ID });
    // a status link in the name row by someone else never names the post
    const other = makeDoc('https://x.com/home', `<article data-testid="tweet"><div data-testid="User-Name"><div><a href="/XBToshi">CyberSatoshi</a></div><a href="/other/status/42">1h</a></div></article>`);
    expect(tweetSlot(other.querySelector('article')!)?.statusId).toBeUndefined();
    // a tweet's own page: the timestamp link sits under the text, next to analytics links and a quote
    const focal = makeDoc('https://x.com/XBToshi/status/' + ID, `<article data-testid="tweet">
      <div data-testid="User-Name"><div><a href="/XBToshi">CyberSatoshi</a></div></div>
      <div role="link"><a href="/other/status/42"><time>2h</time></a></div>
      <a href="/XBToshi/status/${ID}/analytics">Views</a><a href="/XBToshi/status/${ID}"><time>1h</time></a>
    </article>`);
    expect(tweetSlot(focal.querySelector('article')!)?.statusId).toBe(ID);
    // an X Article's reading page: author and post from the URL
    const view = makeDoc('https://x.com/XBToshi/article/' + ID, '<article data-testid="twitterArticleReadView"></article>').querySelector('article')!;
    expect(articleViewSlot(view, { hostname: 'x.com', pathname: `/XBToshi/article/${ID}` })).toMatchObject({ handle: 'XBToshi', statusId: ID, article: view });
    expect(articleViewSlot(view, { hostname: 'x.com', pathname: '/home' })).toBeNull();
    expect(articleViewSlot(view, { hostname: 'x.com', pathname: '/i/article/1' })).toBeNull();
    const bare = makeDoc('https://x.com/home', `<article data-testid="tweet"><div data-testid="User-Name"><div><a href="/XBToshi">CyberSatoshi</a></div></div></article>`);
    expect(tweetSlot(bare.querySelector('article')!)?.statusId).toBeUndefined();
  });
});

