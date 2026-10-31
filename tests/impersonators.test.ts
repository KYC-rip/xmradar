import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { describe, expect, it } from 'vitest';
import { FEED_READER_V, readFeed } from '../src/sites/feed';
import { lookalikeIndex, lookalikeOf } from '../src/sites/lookalike';
import { checkGuard, guardRules, nameRules, shouldGuard, typoDomains } from '../src/sites/guard-rules';
import { guardKeeper, type GuardTokens } from '../src/sites/guard-keeper';
import type { DnrRule } from '../src/sites/guard-rules';

const sk = ed25519.utils.randomSecretKey();
const KEYS = new Set([bytesToHex(ed25519.getPublicKey(sk))]);
const sign = (payload: unknown) => {
  const text = JSON.stringify(payload);
  return { payload: text, signature: bytesToHex(ed25519.sign(new TextEncoder().encode(text), sk)), public_key: bytesToHex(ed25519.getPublicKey(sk)), alg: 'ed25519' };
};

const NOW = 1_800_000_000;
const site = (id: string, name: string, category: string, hosts: string[]) => ({ id, name, category, grade: 'A', incident: false, url: `https://xmr.club/x/${id}`, hosts });
const payload = (impersonators: unknown) => ({
  v: 1,
  issuer: 'xmr.club',
  issued_at: NOW - 10,
  expires_at: NOW + 1000,
  sites: [
    site('pegasusswap', 'PegasusSwap', 'exchanges', ['pegasusswap.com']),
    site('trocador', 'Trocador', 'exchanges', ['trocador.app', 'tz6trocador.onion']),
    site('somegit', 'SomeGit', 'tools', ['somegit.github.io']),
    site('onlyonion', 'OnlyOnion', 'exchanges', ['abcdefonion.onion']),
    site('passport', 'Foundation Passport', 'wallets', ['foundation.xyz']),
  ],
  impersonators,
});
const read = (imps: unknown) => readFeed(sign(payload(imps)), NOW, 0, KEYS);
const LIVE_SHAPE = [
  { host: 'pegasussawp.com', imitates: 'pegasusswap', name: 'PegasusSwap', added: '2026-10-31' },
  { host: 'www-trocador.app', imitates: 'trocador', name: 'Trocador', added: '2026-10-31' },
  { host: 'trocador-app.im', imitates: 'trocador', name: 'Trocador', added: '2026-10-31' },
];

describe('reading impersonators', () => {
  it('the live shape', () => {
    const f = read(LIVE_SHAPE);
    expect(f.reader).toBe(FEED_READER_V);
    expect(FEED_READER_V).toBe(7);
    expect(f.impersonators).toEqual([
      { host: 'pegasussawp.com', siteId: 'pegasusswap', added: '2026-10-31' },
      { host: 'www-trocador.app', siteId: 'trocador', added: '2026-10-31' },
      { host: 'trocador-app.im', siteId: 'trocador', added: '2026-10-31' },
    ]);
  });
  it('drops bad entries', () => {
    const f = read([
      { host: 'x.example', imitates: 'nosuchlisting' },
      { host: 'Not a host', imitates: 'trocador' },
      { host: 'abc.onion', imitates: 'trocador' },
      { host: 'pegasussawp.com', imitates: 'pegasusswap', added: 'yesterday' },
      { host: 'PEGASUSSAWP.COM', imitates: 'pegasusswap' },
      'pegasussawp.com',
      null,
    ]);
    expect(f.impersonators).toEqual([{ host: 'pegasussawp.com', siteId: 'pegasusswap', added: null }]);
    expect(read('nope').impersonators).toBeUndefined();
    expect(read(undefined).impersonators).toBeUndefined();
  });
  it('keeps at most 10,000', () => {
    const many = Array.from({ length: 10_050 }, (_, i) => ({ host: `copy${i}.example`, imitates: 'pegasusswap' }));
    expect(read(many).impersonators).toHaveLength(10_000);
  });
});

describe('the safety filter', () => {
  const kept = (hosts: string[], imitates = 'pegasusswap') => lookalikeIndex(read(hosts.map((host) => ({ host, imitates })))).impersonators;
  it('keeps the live entries', () => {
    expect(lookalikeIndex(read(LIVE_SHAPE)).impersonators).toEqual(['pegasussawp.com', 'www-trocador.app', 'trocador-app.im']);
  });
  it.each([
    'github.io',
    'user.github.io',
    'gist.github.com',
    'foo.vercel.app',
    'a.substack.com',
    'www.youtube.com',
    'co.uk',
    'foundation.app',
    'www.foundation.app',
    'trocador.app',
    'x.trocador.app',
    'somegit.github.io',
    'a.somegit.github.io',
  ])('never an entry that could cover a real site: %s', (h) => expect(kept([h])).toEqual([]));
  it('a parent of a listed host is dropped', () => {
    const f = readFeed(sign({ ...payload([{ host: 'example.net', imitates: 'pegasusswap' }]), sites: [site('pegasusswap', 'PegasusSwap', 'exchanges', ['swap.example.net'])] }), NOW, 0, KEYS);
    expect(lookalikeIndex(f).impersonators).toEqual([]);
  });
  it('an onion-only listing has nothing to link: dropped', () => {
    expect(kept(['onioncopy.example'], 'onlyonion')).toEqual([]);
  });
});

describe('precedence and exact hosts', () => {
  it('a www. entry stays exact and never widens to the apex', () => {
    const f = read([{ host: 'www.copy-pegasus.example', imitates: 'pegasusswap' }]);
    expect(f.impersonators![0]!.host).toBe('www.copy-pegasus.example');
    const idx = lookalikeIndex(f);
    expect(lookalikeOf(idx, 'www.copy-pegasus.example')?.kind).toBe('listed-phishing');
    expect(lookalikeOf(idx, 'copy-pegasus.example')?.kind ?? null).not.toBe('listed-phishing');
  });
  it('the top-level list wins over the older per-listing field for the same host', () => {
    const f = readFeed(
      sign({
        ...payload([{ host: 'shared-copy.example', imitates: 'pegasusswap' }]),
        sites: [site('pegasusswap', 'PegasusSwap', 'exchanges', ['pegasusswap.com']), { ...site('trocador', 'Trocador', 'exchanges', ['trocador.app']), phishing_hosts: ['shared-copy.example'] }],
      }),
      NOW,
      0,
      KEYS,
    );
    expect(lookalikeOf(lookalikeIndex(f), 'shared-copy.example')).toMatchObject({ kind: 'listed-phishing', name: 'PegasusSwap' });
  });
});

describe('a confirmation outranks an earlier Continue', () => {
  it('the live trocador-app.im case: continued before it was listed → guarded again; continued on the listed page → allowed', async () => {
    const before = lookalikeIndex(read([]));
    const after = lookalikeIndex(read(LIVE_SHAPE));
    const session: DnrRule[] = [];
    const dynamic: DnrRule[] = [];
    const item = <T>(v: T) => ({ v, async getValue() { return this.v; }, async setValue(x: T) { this.v = x; } });
    const tokens = item<GuardTokens | null>(null);
    const continued = item<Record<string, number>>({});
    const continuedListed = item<Record<string, number>>({});
    const upd = (list: DnrRule[]) => async (o: { removeRuleIds?: number[]; addRules?: DnrRule[] }) =>
      void list.splice(0, list.length, ...list.filter((r) => !(o.removeRuleIds ?? []).includes(r.id)), ...(o.addRules ?? []));
    const keeper = guardKeeper({
      dnr: { getDynamicRules: async () => dynamic, updateDynamicRules: upd(dynamic), getSessionRules: async () => session, updateSessionRules: upd(session) },
      guardUrl: () => 'chrome-extension://abc/guard.html',
      tokens,
      continued,
      continuedListed,
      dismissed: item<Record<string, number>>({}),
      now: () => NOW * 1000,
      randomHex: () => 'e'.repeat(32),
    });
    // Continue on the name page, before xmr.club listed it
    await keeper.apply(true, { index: before, issuedAt: 1 });
    await keeper.continue(`#t=${'e'.repeat(32)}&u=https://trocador-app.im/`, true, { index: before, issuedAt: 1 });
    expect(session.map((r) => r.condition.requestDomains)).toEqual([['trocador-app.im']]);
    // the list now confirms it: the old allow goes, and the after-load check guards it again
    await keeper.apply(true, { index: after, issuedAt: 2 });
    expect(session).toEqual([]);
    const sent: string[] = [];
    expect(await keeper.afterLoad('https://trocador-app.im/', true, { index: after, issuedAt: 2 }, async (to) => void sent.push(to))).not.toBeNull();
    // Continue on the page that said "xmr.club lists this": that choice holds
    await keeper.continue(`#t=${tokens.v!.current}&u=https://trocador-app.im/`, true, { index: after, issuedAt: 2 });
    expect(continuedListed.v).toHaveProperty(['trocador-app.im']);
    expect(session.map((r) => r.condition.requestDomains)).toEqual([['trocador-app.im']]);
  });
});

describe('Continue on a parent host', () => {
  const setup = () => {
    const session: DnrRule[] = [];
    const dynamic: DnrRule[] = [];
    const item = <T>(v: T) => ({ v, async getValue() { return this.v; }, async setValue(x: T) { this.v = x; } });
    const upd = (list: DnrRule[]) => async (o: { removeRuleIds?: number[]; addRules?: DnrRule[] }) =>
      void list.splice(0, list.length, ...list.filter((r) => !(o.removeRuleIds ?? []).includes(r.id)), ...(o.addRules ?? []));
    const continued = item<Record<string, number>>({ 'pegasus-mirror.example': NOW * 1000 + 3_600_000 });
    const keeper = guardKeeper({
      dnr: { getDynamicRules: async () => dynamic, updateDynamicRules: upd(dynamic), getSessionRules: async () => session, updateSessionRules: upd(session) },
      guardUrl: () => 'chrome-extension://abc/guard.html',
      tokens: item<GuardTokens | null>(null),
      continued,
      continuedListed: item<Record<string, number>>({}),
      dismissed: item<Record<string, number>>({}),
      now: () => NOW * 1000,
      randomHex: () => 'f'.repeat(32),
    });
    return { keeper, session };
  };
  it('a copy xmr.club confirms under it is excluded from the allow and guarded after load', async () => {
    const { keeper, session } = setup();
    const idx = lookalikeIndex(read([{ host: 'pay.pegasus-mirror.example', imitates: 'pegasusswap' }]));
    await keeper.apply(true, { index: idx, issuedAt: 1 });
    expect(session).toHaveLength(1);
    expect(session[0]!.condition).toMatchObject({ requestDomains: ['pegasus-mirror.example'], excludedRequestDomains: ['pay.pegasus-mirror.example'] });
    const go = async () => {};
    expect(await keeper.afterLoad('https://pay.pegasus-mirror.example/', true, { index: idx, issuedAt: 1 }, go)).not.toBeNull();
  });
  it('a red subdomain of a continued host is let through by the after-load check, as by the rule', async () => {
    const { keeper } = setup();
    const idx = lookalikeIndex(read([]));
    await keeper.apply(true, { index: idx, issuedAt: 1 });
    // pegasusswap followed by its own suffix: a red segment match on a coin listing, under the continued host
    const red = 'https://pegasusswap.com.pegasus-mirror.example/';
    expect(lookalikeOf(idx, new URL(red).hostname)?.kind).toBe('segment');
    expect(await keeper.afterLoad(red, true, { index: idx, issuedAt: 1 }, async () => {})).toBeNull();
  });
  it('several confirmed copies under a continued host are all excluded', async () => {
    const { keeper, session } = setup();
    const idx = lookalikeIndex(read([{ host: 'a.pegasus-mirror.example', imitates: 'pegasusswap' }, { host: 'b.pegasus-mirror.example', imitates: 'pegasusswap' }]));
    await keeper.apply(true, { index: idx, issuedAt: 1 });
    expect(session[0]!.condition.excludedRequestDomains).toEqual(['a.pegasus-mirror.example', 'b.pegasus-mirror.example']);
  });
  it('a per-listing www. entry stays exact', () => {
    const f = readFeed(sign({ ...payload(undefined), sites: [{ ...site('pegasusswap', 'PegasusSwap', 'exchanges', ['pegasusswap.com']), phishing_hosts: ['www.copy-pegasus.example'] }] }), NOW, 0, KEYS);
    const idx = lookalikeIndex(f);
    expect(lookalikeOf(idx, 'www.copy-pegasus.example')?.kind).toBe('listed-phishing');
    expect(lookalikeOf(idx, 'copy-pegasus.example')?.kind ?? null).not.toBe('listed-phishing');
  });
});

describe('matching and guarding', () => {
  const index = lookalikeIndex(read([...LIVE_SHAPE, { host: 'pegasus-swap-exchange.net', imitates: 'pegasusswap' }]));
  it('a listed copy and its subdomains are listed-phishing', () => {
    expect(lookalikeOf(index, 'pegasussawp.com')).toMatchObject({ kind: 'listed-phishing', target: 'pegasusswap.com', name: 'PegasusSwap' });
    expect(lookalikeOf(index, 'www.pegasussawp.com')).toMatchObject({ kind: 'listed-phishing', target: 'pegasusswap.com' });
    expect(lookalikeOf(index, 'pegasussawp.com.evil.net')?.kind).not.toBe('listed-phishing');
  });
  it('the guard answers for a copy no name or typo rule matches', () => {
    const TOKEN = '0123456789abcdef0123456789abcdef';
    const a = checkGuard({ hash: `#t=${TOKEN}&u=https://pegasus-swap-exchange.net/`, tokens: [TOKEN], on: true, index, rules: nameRules(index), typos: typoDomains(index) });
    expect(a).toMatchObject({ kind: 'red', why: 'listed-phishing', target: 'pegasusswap.com', name: 'PegasusSwap' });
  });
  it('confirmed copies are guarded for any category', () => {
    expect(shouldGuard({ kind: 'listed-phishing', category: 'tools' })).toBe(true);
  });
  it('they go into the exact-domain rules, the dropped ones never', async () => {
    const idx = lookalikeIndex(read([...LIVE_SHAPE, { host: 'user.github.io', imitates: 'pegasusswap' }, { host: 'foundation.app', imitates: 'passport' }]));
    const dynamic: DnrRule[] = [];
    const item = <T>(v: T) => ({ v, async getValue() { return this.v; }, async setValue(x: T) { this.v = x; } });
    const keeper = guardKeeper({
      dnr: {
        getDynamicRules: async () => dynamic,
        updateDynamicRules: async (o) => void dynamic.splice(0, dynamic.length, ...dynamic.filter((r) => !(o.removeRuleIds ?? []).includes(r.id)), ...(o.addRules ?? [])),
        getSessionRules: async () => [],
        updateSessionRules: async () => {},
      },
      guardUrl: () => 'chrome-extension://abc/guard.html',
      tokens: item<GuardTokens | null>(null),
      continued: item<Record<string, number>>({}),
      continuedListed: item<Record<string, number>>({}),
      dismissed: item<Record<string, number>>({}),
      now: () => NOW * 1000,
      randomHex: () => 'd'.repeat(32),
    });
    await keeper.apply(true, { index: idx, issuedAt: 1 });
    const domains = dynamic.flatMap((r) => r.condition.requestDomains ?? []);
    for (const h of ['pegasussawp.com', 'www-trocador.app', 'trocador-app.im']) expect(domains).toContain(h);
    for (const h of ['user.github.io', 'foundation.app', 'pegasusswap.com', 'trocador.app']) expect(domains).not.toContain(h);
    expect(guardRules(nameRules(idx), 'x', 'y').length).toBeGreaterThan(0);
  });
});
