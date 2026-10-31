import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SiteEntry, SiteFeed } from '../src/sites/feed';
import { lookalikeIndex, lookalikeOf, oneTypo } from '../src/sites/lookalike';
import {
  ALLOW_RULE_FIRST,
  allowRules,
  checkGuard,
  guardMatch,
  guardRules,
  NAME_RULE_FIRST,
  nameRegex,
  nameRules,
  parseGuardHash,
  shouldGuard,
  TYPO_RULE_FIRST,
  typoDomains,
  typoMatch,
  typoRules,
  type DnrRule,
} from '../src/sites/guard-rules';
import { CONTINUE_MS, guardKeeper, type GuardTokens } from '../src/sites/guard-keeper';
import { renderGuard } from '../src/ui/guard-view';
import { bannerFor } from '../src/entrypoints/content/site';
import live from './fixtures/xmrclub-feed-hosts.json';

const entry = (s: { id: string; name: string; grade: string; hosts: string[]; category?: string }): SiteEntry => ({ category: 'exchanges', incident: false, url: `https://xmr.club/x/${s.id}`, ...s });
const feedOf = (sites: SiteEntry[]): SiteFeed => ({ issuedAt: 1, expiresAt: 2, sites });
const LIVE = lookalikeIndex(feedOf(live.sites.map(entry)));
const RULES = nameRules(LIVE);
const TOKEN = '0123456789abcdef0123456789abcdef';
const hash = (u: string, t = TOKEN) => `#t=${t}&u=${u}`;
const ruleHit = (url: string) => RULES.some((r) => new RegExp(r.regex, 'i').test(url) && !r.excluded.some((d) => new URL(url).hostname === d || new URL(url).hostname.endsWith(`.${d}`)));

describe('letter swaps count as one typo', () => {
  it.each([
    ['pegasussawp', 'pegasusswap'],
    ['pegassuswap', 'pegasusswap'],
    ['trocadro', 'trocador'],
  ])('%s', (a, b) => expect(oneTypo(a, b)).toBe(true));
  it('the edits it already counted, and not two changes', () => {
    expect(oneTypo('trocadorr', 'trocador')).toBe(true);
    expect(oneTypo('trocdor', 'trocador')).toBe(true);
    expect(oneTypo('trocadox', 'trocador')).toBe(true);
    expect(oneTypo('trocador', 'trocador')).toBe(false);
    expect(oneTypo('otrcadro', 'trocador')).toBe(false);
  });
  it('OrangeFren-confirmed PegasusSwap copies are now red', () => {
    expect(lookalikeOf(LIVE, 'pegasussawp.com')?.kind).toBe('typo');
    expect(lookalikeOf(LIVE, 'pegassuswap.com')?.kind).toBe('typo');
  });
});

describe('name rules', () => {
  it('one per coin listing name, none for other categories', () => {
    const labels = RULES.flatMap((r) => r.labels);
    expect(labels).toContain('trocador');
    expect(labels).toContain('pegasusswap');
    // Element is chat (tools): no pre-load rule. Foundation Passport is a wallet: a rule, with foundation.app excluded
    expect(labels).not.toContain('element');
    expect(RULES.find((r) => r.labels.includes('foundation'))!.excluded).toContain('foundation.app');
    expect(RULES.length).toBeLessThan(900);
    expect(new Set(labels).size).toBe(labels.length);
  });
  it('excludes exactly the listed domains the regex would catch', () => {
    const r = RULES.find((x) => x.labels.includes('trocador'))!;
    expect(r.excluded).toContain('trocador.app');
    for (const d of r.excluded) expect(new RegExp(r.regex, 'i').test(`https://${d}/`)).toBe(true);
  });
  // the table Chrome's own matcher (testMatchOutcome) was run on, PLAN-PRELOAD §0
  const re = new RegExp(nameRegex(['trocador']), 'i');
  it.each([
    'https://www-trocador.app/',
    'https://trocador-app.im/',
    'https://trocador.app.evil.com/x',
    'https://trocador.io/',
    'http://trocador.site:8080/x?y',
    'https://user@trocador.app.evil.com/',
    'https://user:pw@trocador.io/',
    'https://TROCADOR-APP.IM/',
    'https://a.b.trocador.c.d/',
    'https://xn--trocador-mnze-5ob.com/',
    'https://trocador.app./',
  ])('matches %s', (u) => expect(re.test(u)).toBe(true));
  it.each([
    'https://nottrocador.com/',
    'https://trocadorx.com/',
    'https://evil.com/?q=trocador.app',
    'https://evil.com/trocador.app',
    'https://evil.com#trocador.app',
    'https://trocador@evil.com/',
    'ftp://trocador.io/',
    // an intranet name with no dot
    'https://trocador/',
    'http://trocador:8080/x',
    'https://www-trocador/',
  ])('does not match %s', (u) => expect(re.test(u)).toBe(false));
  it('a listed host written with a trailing dot is still the listed host', () => {
    expect(guardMatch(LIVE, RULES, new URL('https://trocador.app./'))).toBeNull();
  });
  it('RE2 syntax only: no lookaround or backreferences', () => {
    for (const r of RULES) expect(r.regex).not.toMatch(/\(\?[=!<]|\\[1-9]/);
  });
  it('no listed host is sent to the guard page', () => {
    for (const s of live.sites) for (const h of s.hosts) if (!h.endsWith('.onion')) expect(ruleHit(`https://${h}/`), h).toBe(false);
  });
  it('popular domains: none is sent to the guard page', () => {
    const domains = readFileSync(join(process.cwd(), 'tests/fixtures/popular-domains.txt'), 'utf8').split(/\s+/).filter(Boolean);
    expect(domains.filter((d) => ruleHit(`https://${d}/`))).toEqual([]);
  });
});

describe('DNR rules', () => {
  const rules = guardRules(RULES, 'chrome-extension://abc/guard.html', TOKEN);
  it('redirect main frames to the guard page with the token and the whole URL', () => {
    expect(rules[0]!.id).toBe(NAME_RULE_FIRST);
    expect(rules[0]!.action).toEqual({ type: 'redirect', redirect: { regexSubstitution: `chrome-extension://abc/guard.html#t=${TOKEN}&u=\\0` } });
    expect(rules.every((r) => r.condition.resourceTypes[0] === 'main_frame' && r.priority === 1)).toBe(true);
  });
  it('allow rules outrank them, one exact host each', () => {
    expect(allowRules(['a.example', 'b.example'])).toEqual([
      { id: ALLOW_RULE_FIRST, priority: 2, action: { type: 'allow' }, condition: { requestDomains: ['a.example'], resourceTypes: ['main_frame'] } },
      { id: ALLOW_RULE_FIRST + 1, priority: 2, action: { type: 'allow' }, condition: { requestDomains: ['b.example'], resourceTypes: ['main_frame'] } },
    ]);
  });
});

describe('guard hash', () => {
  it('the URL is everything after &u=', () => {
    for (const u of ['https://x.example/?a=1&b=2', 'https://x.example/p=q', 'https://x.example/#frag', 'https://x.example/?q=%26&u=evil']) {
      expect(parseGuardHash(hash(u))?.url.href).toBe(new URL(u).href);
    }
  });
  it.each([hash('javascript:alert(1)'), hash('data:text/html,x'), hash('/relative'), '#t=short&u=https://x.example/', '', '#u=https://x.example/'])('refuses %s', (h) => expect(parseGuardHash(h)).toBeNull());
});

describe('guard answers', () => {
  const ask = (u: string, o: Partial<Parameters<typeof checkGuard>[0]> = {}) => checkGuard({ hash: hash(u), tokens: [TOKEN], on: true, index: LIVE, rules: RULES, ...o });
  it('red for a copy, with the feed target', () => {
    expect(ask('https://www-trocador.app/swap?x=1')).toEqual({ kind: 'red', host: 'www-trocador.app', url: 'https://www-trocador.app/swap?x=1', why: 'segment', target: 'trocador.app', name: 'Trocador' });
    expect(ask('https://trocador-app.im/')).toMatchObject({ kind: 'red', target: 'trocador.app' });
  });
  it('same-name for the name on another domain', () => {
    expect(ask('https://pegasusswap.site/')).toMatchObject({ kind: 'same-name', host: 'pegasusswap.site', target: 'pegasusswap.com', name: 'PegasusSwap' });
  });
  it('the name inside an address the matcher has no stronger word for: still a page, never a pass', () => {
    expect(ask('https://trocador.de.evil.com/')).toMatchObject({ kind: 'name', target: 'trocador.app', name: 'Trocador' });
    expect(ask('https://trocador-fan-blog.com/')).toMatchObject({ kind: 'name', target: 'trocador.app' });
    expect(ask('https://trocador-münze.com/')).toMatchObject({ kind: 'name', host: 'xn--trocador-mnze-5ob.com', target: 'trocador.app' });
  });
  it('invalid without our token or our rule', () => {
    expect(ask('https://www-trocador.app/', { tokens: ['f'.repeat(32)] })).toEqual({ kind: 'invalid' });
    expect(ask('https://www-trocador.app/', { tokens: [] })).toEqual({ kind: 'invalid' });
    expect(ask('https://github.com/')).toEqual({ kind: 'invalid' });
    expect(ask('https://trocador.app/')).toEqual({ kind: 'invalid' });
  });
  it('off: a plain link, no warning', () => {
    expect(ask('https://www-trocador.app/', { on: false })).toEqual({ kind: 'off', host: 'www-trocador.app', url: 'https://www-trocador.app/' });
  });
  it('guardMatch picks the coin listing', () => {
    expect(guardMatch(LIVE, RULES, new URL('https://pegasusswap.site/'))?.site.name).toBe('PegasusSwap');
  });
});

/** In-memory stand-ins for chrome.declarativeNetRequest and storage. */
function fakes(now = 1_000_000) {
  const dynamic: DnrRule[] = [];
  const session: DnrRule[] = [];
  const update = (list: DnrRule[]) => async (o: { removeRuleIds?: number[]; addRules?: DnrRule[] }) => {
    const keep = list.filter((r) => !(o.removeRuleIds ?? []).includes(r.id));
    list.splice(0, list.length, ...keep, ...(o.addRules ?? []));
  };
  const item = <T>(v: T) => ({ v, async getValue() { return this.v; }, async setValue(x: T) { this.v = x; } });
  const tokens = item<GuardTokens | null>(null);
  const continued = item<Record<string, number>>({});
  const continuedListed = item<Record<string, number>>({});
  const dismissed = item<Record<string, number>>({});
  let n = 0;
  const clock = { now };
  const keeper = guardKeeper({
    dnr: { getDynamicRules: async () => dynamic, updateDynamicRules: update(dynamic), getSessionRules: async () => session, updateSessionRules: update(session) },
    guardUrl: () => 'chrome-extension://abc/guard.html',
    tokens,
    continued,
    continuedListed,
    dismissed,
    now: () => clock.now,
    randomHex: () => (++n).toString(16).padStart(32, '0'),
  });
  return { keeper, dynamic, session, tokens, continued, continuedListed, dismissed, clock };
}
const FEED = { index: LIVE, issuedAt: 1 };

describe('guard keeper', () => {
  it('puts the rules in place and takes them all away when warnings go off', async () => {
    const f = fakes();
    await f.keeper.apply(true, FEED);
    expect(f.dynamic.filter((r) => r.id < TYPO_RULE_FIRST).length).toBe(RULES.length);
    f.continued.v = { 'www-trocador.app': f.clock.now + 1000 };
    await f.keeper.apply(true, FEED);
    expect(f.session.map((r) => r.condition.requestDomains)).toEqual([['www-trocador.app']]);
    await f.keeper.apply(false, FEED);
    expect(f.dynamic).toEqual([]);
    expect(f.session).toEqual([]);
    expect(f.tokens.v).toBeNull();
    // the user's own Continue choice comes back with warnings
    await f.keeper.apply(true, FEED);
    expect(f.session.map((r) => r.condition.requestDomains)).toEqual([['www-trocador.app']]);
  });
  it('a new feed gets a new token; the old one works for a minute', async () => {
    const f = fakes();
    await f.keeper.apply(true, FEED);
    const first = f.tokens.v!.current;
    await f.keeper.apply(true, FEED);
    expect(f.tokens.v!.current).toBe(first);
    await f.keeper.apply(true, { index: LIVE, issuedAt: 2 });
    expect(f.tokens.v!.current).not.toBe(first);
    expect((await f.keeper.check(hash('https://www-trocador.app/', first), true, FEED)).kind).toBe('red');
    f.clock.now += 61_000;
    expect((await f.keeper.check(hash('https://www-trocador.app/', first), true, FEED)).kind).toBe('invalid');
  });
  it('rules whose token storage lost track (worker stopped mid-update) are rewritten', async () => {
    const f = fakes();
    await f.keeper.apply(true, FEED);
    const inRules = f.tokens.v!.current;
    // storage says another token than the browser redirects with
    f.tokens.v = { ...f.tokens.v!, current: 'e'.repeat(32) };
    await f.keeper.apply(true, FEED);
    const now = (f.dynamic[0]!.action as { redirect: { regexSubstitution: string } }).redirect.regexSubstitution;
    expect(now).toContain(`#t=${f.tokens.v!.current}&u=`);
    // a redirect made with the rules' old token still verifies for the grace minute
    expect((await f.keeper.check(hash('https://www-trocador.app/', inRules), true, FEED)).kind).toBe('red');
  });
  it('a redirect from the previous feed still gets its page after an update drops that listing', async () => {
    const f = fakes();
    const one = { index: lookalikeIndex(feedOf([entry({ id: 't', name: 'Trocador', grade: 'A', hosts: ['trocador.app'] })])), issuedAt: 1 };
    const two = { index: lookalikeIndex(feedOf([entry({ id: 'p', name: 'PegasusSwap', grade: 'A', hosts: ['pegasusswap.com'] })])), issuedAt: 2 };
    await f.keeper.apply(true, one);
    const old = f.tokens.v!.current;
    await f.keeper.apply(true, two);
    expect(await f.keeper.check(hash('https://www-trocador.app/', old), true, two)).toMatchObject({ kind: 'red', target: 'trocador.app' });
    // with the new token, the dropped listing is nothing
    expect((await f.keeper.check(hash('https://www-trocador.app/', f.tokens.v!.current), true, two)).kind).toBe('invalid');
    f.clock.now += 61_000;
    expect((await f.keeper.check(hash('https://www-trocador.app/', old), true, two)).kind).toBe('invalid');
  });
  it('checking adds nothing; Continue adds one allow and both records', async () => {
    const f = fakes();
    await f.keeper.apply(true, FEED);
    const t = f.tokens.v!.current;
    for (const u of ['https://www-trocador.app/', 'https://trocador-fan-blog.com/', 'https://pegasusswap.site/']) await f.keeper.check(hash(u, t), true, FEED);
    expect(f.session).toEqual([]);
    expect(f.continued.v).toEqual({});
    expect(await f.keeper.continue(hash('https://www-trocador.app/a?b=1&c=2', t), true, FEED)).toEqual({ url: 'https://www-trocador.app/a?b=1&c=2' });
    expect(f.session.map((r) => r.condition.requestDomains)).toEqual([['www-trocador.app']]);
    expect(f.continued.v).toEqual({ 'www-trocador.app': f.clock.now + CONTINUE_MS });
    expect(f.dismissed.v).toEqual({ 'www-trocador.app': f.clock.now + CONTINUE_MS });
  });
  it('Continue refuses what the page may not open', async () => {
    const f = fakes();
    await f.keeper.apply(true, FEED);
    const t = f.tokens.v!.current;
    await expect(f.keeper.continue(hash('https://github.com/', t), true, FEED)).rejects.toThrow();
    await expect(f.keeper.continue(hash('https://www-trocador.app/', 'f'.repeat(32)), true, FEED)).rejects.toThrow();
    await expect(f.keeper.continue(hash('https://www-trocador.app/', t), false, FEED)).rejects.toThrow();
    expect(f.session).toEqual([]);
  });
  it('dismissing the in-page banner never creates an allow', async () => {
    const f = fakes();
    f.dismissed.v = { 'www-trocador.app': f.clock.now + CONTINUE_MS };
    await f.keeper.apply(true, FEED);
    expect(f.session).toEqual([]);
  });
  it('expired Continue choices are dropped', async () => {
    const f = fakes();
    f.continued.v = { 'old.example': f.clock.now - 1, 'new.example': f.clock.now + 1 };
    await f.keeper.apply(true, FEED);
    expect(f.session.map((r) => r.condition.requestDomains)).toEqual([['new.example']]);
  });
  it('a refused rule update removes the old rules instead of leaving them pointing at a dead page', async () => {
    const f = fakes();
    await f.keeper.apply(true, FEED);
    expect(f.dynamic.length).toBeGreaterThan(0);
    const real = f.keeper;
    // the next update is refused (as Chrome does for a regex over its memory limit)
    const dnr = { getDynamicRules: async () => f.dynamic, updateDynamicRules: async (o: { removeRuleIds?: number[]; addRules?: DnrRule[] }) => {
      if (o.addRules?.length) throw new Error('memoryLimitExceeded');
      f.dynamic.splice(0, f.dynamic.length, ...f.dynamic.filter((r) => !(o.removeRuleIds ?? []).includes(r.id)));
    }, getSessionRules: async () => f.session, updateSessionRules: async () => {} };
    const k = guardKeeper({ dnr, guardUrl: () => 'chrome-extension://new/guard.html', tokens: f.tokens, continued: f.continued, continuedListed: f.continuedListed, dismissed: f.dismissed, now: () => f.clock.now, randomHex: () => 'a'.repeat(32) });
    await expect(k.apply(true, FEED)).rejects.toThrow('memoryLimitExceeded');
    expect(f.dynamic).toEqual([]);
    expect(f.tokens.v).toBeNull();
    expect(real).toBeTruthy();
  });
  it('without the DNR API nothing happens and checks still answer', async () => {
    const keeper = guardKeeper({ dnr: undefined, guardUrl: () => '', tokens: { getValue: async () => null, setValue: async () => {} }, continued: { getValue: async () => ({}), setValue: async () => {} }, continuedListed: { getValue: async () => ({}), setValue: async () => {} }, dismissed: { getValue: async () => ({}), setValue: async () => {} }, now: Date.now, randomHex: () => TOKEN });
    await keeper.apply(true, FEED);
    expect((await keeper.check(hash('https://www-trocador.app/'), true, FEED)).kind).toBe('invalid');
  });
});

describe('guard page', () => {
  const page = () => {
    document.body.innerHTML = readFileSync(join(process.cwd(), 'src/entrypoints/guard/index.html'), 'utf8').replace(/^[\s\S]*<body>|<\/body>[\s\S]*$/g, '').replace(/<script[\s\S]*?<\/script>/g, '');
    return (id: string) => document.getElementById(id)!;
  };
  const base = { host: 'www-trocador.app', url: 'https://www-trocador.app/', target: 'trocador.app', name: 'Trocador' };
  it('red: feed link, Continue only behind Details, untrusted clicks ignored', () => {
    const $ = page();
    let continued = 0;
    renderGuard(document, { kind: 'red', why: 'segment', ...base }, () => continued++);
    expect($('guard').className).toContain('red');
    expect($('title').textContent).toBe("This isn't trocador.app.");
    expect($('text').textContent).toContain('www-trocador.app looks like trocador.app (listed on xmr.club as Trocador)');
    expect(($('go') as HTMLAnchorElement).href).toBe('https://trocador.app/');
    expect($('continue').hidden).toBe(true);
    $('details').click();
    expect($('continue').hidden).toBe(true);
    $('continue').click();
    expect(continued).toBe(0);
  });
  it('same-name and name: amber, both buttons', () => {
    let $ = page();
    renderGuard(document, { kind: 'same-name', ...base, host: 'pegasusswap.site', target: 'pegasusswap.com', name: 'PegasusSwap' }, () => {});
    expect($('guard').className).toContain('amber');
    expect($('title').textContent).toBe('This is not pegasusswap.com.');
    expect($('continue').hidden).toBe(false);
    expect($('continue').textContent).toBe('Continue to pegasusswap.site');
    $ = page();
    renderGuard(document, { kind: 'name', ...base, host: 'trocador.de.evil.com' }, () => {});
    expect($('title').textContent).toBe("This site's address contains trocador.app's name.");
    expect($('continue').hidden).toBe(false);
  });
  it('listed phishing names the list', () => {
    const $ = page();
    renderGuard(document, { kind: 'red', why: 'listed-phishing', ...base }, () => {});
    expect($('text').textContent).toBe('xmr.club lists www-trocador.app as a phishing copy of trocador.app (Trocador).');
  });
  it('invalid: text only; off: a plain link', () => {
    let $ = page();
    renderGuard(document, { kind: 'invalid' }, () => {});
    expect($('title').textContent).toBe('Nothing to check here.');
    expect($('go').hidden && $('continue').hidden && $('plain').hidden).toBe(true);
    $ = page();
    renderGuard(document, { kind: 'off', host: 'www-trocador.app', url: 'https://www-trocador.app/' }, () => {});
    expect(($('plain') as HTMLAnchorElement).href).toBe('https://www-trocador.app/');
    expect($('go').hidden).toBe(true);
  });
});

describe('in-page same-name banner', () => {
  const info = (category: string) => ({ sites: [], outOfDate: false, issuedAt: 1, lookalike: { kind: 'same-name' as const, imitates: 'x.com', target: 'x.com', name: 'X', category } });
  it('for a coin listing, not for others', () => {
    expect(bannerFor(info('exchanges'))).not.toBeNull();
    expect(bannerFor(info('wallets'))).not.toBeNull();
    expect(bannerFor(info('hosting'))).toBeNull();
  });
});

const TYPOS = typoDomains(LIVE);
const IDN = new URL('https://tr\u043ecador.app/').href; // Cyrillic о

describe('typo set (PLAN-PRELOAD2)', () => {
  it('holds one-typo copies of coin names on their own suffix', () => {
    for (const d of ['pegasussawp.com', 'pegassuswap.com', 'pegasusswapp.com', 'trocadro.app', 'trocad0r.app']) expect(TYPOS.has(d), d).toBe(true);
    expect(TYPOS.get('pegasussawp.com')!.site.name).toBe('PegasusSwap');
  });
  it('leaves out the real names, other suffixes, known unrelated sites, short and non-coin names, and rn/vv readings', () => {
    for (const d of ['pegasusswap.com', 'trocador.app', 'pegasussawp.io', 'foundation.app', 'elemnet.io', 'sparnowwallet.com']) expect(TYPOS.has(d), d).toBe(false);
    for (const b of TYPOS.values()) expect(b.brand.length).toBeGreaterThanOrEqual(7);
    expect(TYPOS.size).toBeGreaterThan(10_000);
    expect(TYPOS.size).toBeLessThan(100_000);
  });
  it('no popular domain and no listed host is in it', () => {
    const domains = readFileSync(join(process.cwd(), 'tests/fixtures/popular-domains.txt'), 'utf8').split(/\s+/).filter(Boolean);
    expect(domains.filter((d) => typoMatch(TYPOS, d))).toEqual([]);
    for (const site of live.sites) for (const h of site.hosts) expect(typoMatch(TYPOS, h), h).toBeNull();
  });
  it('becomes rules of at most 20k domains after the name rules', () => {
    const rules = typoRules([...TYPOS.keys()].sort(), 'chrome-extension://abc/guard.html', TOKEN);
    expect(rules[0]!.id).toBe(TYPO_RULE_FIRST);
    expect(rules.every((r) => (r.condition.requestDomains?.length ?? 0) <= 20_000)).toBe(true);
    expect(rules.reduce((n, r) => n + r.condition.requestDomains!.length, 0)).toBe(TYPOS.size);
    expect(rules[0]!.condition.regexFilter).toBe('^https?://.*');
    expect(rules[0]!.action).toEqual({ type: 'redirect', redirect: { regexSubstitution: `chrome-extension://abc/guard.html#t=${TOKEN}&u=\\0` } });
  });
  const ask = (u: string) => checkGuard({ hash: hash(u), tokens: [TOKEN], on: true, index: LIVE, rules: RULES, typos: TYPOS });
  it('the guard answers red for a typo copy and its subdomains, from the set', () => {
    expect(ask('https://pegasussawp.com/')).toMatchObject({ kind: 'red', why: 'typo', target: 'pegasusswap.com', name: 'PegasusSwap' });
    expect(ask('https://www.pegasussawp.com/swap')).toMatchObject({ kind: 'red', target: 'pegasusswap.com' });
  });
  it('a typo label inside another host stays a deliberate null', () => {
    expect(ask('https://pegasussawp.evil.com/')).toEqual({ kind: 'invalid' });
    expect(lookalikeOf(LIVE, 'pegasussawp.com.evil.com')).toBeNull();
  });
  it('a page replaced after load: red for a coin look-alike, not for other listings', () => {
    expect(ask(IDN)).toMatchObject({ kind: 'red', why: 'homoglyph', target: 'trocador.app' });
    // Element (tools) one letter off: red in-page, but no full page
    expect(lookalikeOf(LIVE, 'elemnet.io')?.kind).toBe('typo');
    expect(ask('https://elemnet.io/')).toEqual({ kind: 'invalid' });
  });
  it('shouldGuard: red kinds of coin listings only', () => {
    expect(shouldGuard({ kind: 'homoglyph', category: 'exchanges' })).toBe(true);
    expect(shouldGuard({ kind: 'segment', category: 'wallets' })).toBe(true);
    expect(shouldGuard({ kind: 'listed-phishing', category: 'exchanges' })).toBe(true);
    expect(shouldGuard({ kind: 'same-name', category: 'exchanges' })).toBe(false);
    expect(shouldGuard({ kind: 'typo', category: 'tools' })).toBe(false);
    expect(shouldGuard(null)).toBe(false);
  });
});

describe('guard keeper with typo rules', () => {
  it('writes the typo rules after the name rules, with the same token', async () => {
    const f = fakes();
    await f.keeper.apply(true, FEED);
    const typo = f.dynamic.filter((r) => r.id >= TYPO_RULE_FIRST);
    expect(typo.length).toBe(Math.ceil(TYPOS.size / 20_000));
    expect((typo[0]!.action as { redirect: { regexSubstitution: string } }).redirect.regexSubstitution).toContain(`#t=${f.tokens.v!.current}&`);
    await f.keeper.apply(false, FEED);
    expect(f.dynamic).toEqual([]);
  });
  it('a refused typo update keeps the name rules', async () => {
    const f = fakes();
    const dnr = {
      getDynamicRules: async () => f.dynamic,
      updateDynamicRules: async (o: { removeRuleIds?: number[]; addRules?: DnrRule[] }) => {
        if (o.addRules?.some((r) => r.id >= TYPO_RULE_FIRST)) throw new Error('too many domains');
        f.dynamic.splice(0, f.dynamic.length, ...f.dynamic.filter((r) => !(o.removeRuleIds ?? []).includes(r.id)), ...(o.addRules ?? []));
      },
      getSessionRules: async () => f.session,
      updateSessionRules: async () => {},
    };
    const k = guardKeeper({ dnr, guardUrl: () => 'chrome-extension://abc/guard.html', tokens: f.tokens, continued: f.continued, continuedListed: f.continuedListed, dismissed: f.dismissed, now: () => f.clock.now, randomHex: () => 'b'.repeat(32) });
    await k.apply(true, FEED);
    expect(f.dynamic.length).toBe(RULES.length);
    expect(f.dynamic.every((r) => r.id < TYPO_RULE_FIRST)).toBe(true);
  });
  it('the guard sees a typo copy from the previous feed for the grace minute', async () => {
    const f = fakes();
    await f.keeper.apply(true, FEED);
    const old = f.tokens.v!.current;
    const other = { index: lookalikeIndex(feedOf([entry({ id: 't', name: 'Trocador', grade: 'A', hosts: ['trocador.app'] })])), issuedAt: 2 };
    await f.keeper.apply(true, other);
    expect(await f.keeper.check(hash('https://pegasussawp.com/', old), true, other)).toMatchObject({ kind: 'red', target: 'pegasusswap.com' });
  });
  it('after load: the guard address for a red coin match only, never once continued or without rules', async () => {
    const f = fakes();
    const sent: string[] = [];
    const go = async (to: string) => void sent.push(to);
    expect(await f.keeper.afterLoad(IDN, true, FEED, go)).toBeNull(); // no rules yet
    await f.keeper.apply(true, FEED);
    expect(await f.keeper.afterLoad(IDN, true, FEED, go)).toBe(`chrome-extension://abc/guard.html#t=${f.tokens.v!.current}&u=${IDN}`);
    expect(sent).toHaveLength(1);
    for (const u of ['https://pegasusswap.site/', 'https://elemnet.io/', 'javascript:alert(1)']) expect(await f.keeper.afterLoad(u, true, FEED, go)).toBeNull();
    expect(await f.keeper.afterLoad(IDN, false, FEED, go)).toBeNull();
    // other red kinds of coin listings: a look-alike letter in a subdomain (segment), a typo the rules missed
    expect(await f.keeper.afterLoad(new URL('https://tr\u043ecador.app.evil.com/').href, true, FEED, go)).not.toBeNull();
    expect(await f.keeper.afterLoad('https://pegasussawp.com/', true, FEED, go)).not.toBeNull();
    f.continued.v = { [new URL(IDN).hostname]: f.clock.now + 1000 };
    expect(await f.keeper.afterLoad(IDN, true, FEED, go)).toBeNull();
  });
  it('a Continue clicked while an after-load decision is pending is seen by it', async () => {
    const f = fakes();
    await f.keeper.apply(true, FEED);
    const t = f.tokens.v!.current;
    const sent: string[] = [];
    // Continue is queued first; the after-load decision runs after it in the chain and must not redirect
    const c = f.keeper.continue(hash(IDN, t), true, FEED);
    const a = f.keeper.afterLoad(IDN, true, FEED, async (to) => void sent.push(to));
    await c;
    expect(await a).toBeNull();
    expect(sent).toEqual([]);
  });
  it('typo rules with a stale token are rewritten even when the name rules are current', async () => {
    const f = fakes();
    await f.keeper.apply(true, FEED);
    const first = f.dynamic.find((r) => r.id === TYPO_RULE_FIRST)! as DnrRule & { action: { redirect: { regexSubstitution: string } } };
    first.action.redirect.regexSubstitution = first.action.redirect.regexSubstitution.replace(/#t=[0-9a-f]{32}/, `#t=${'c'.repeat(32)}`);
    await f.keeper.apply(true, FEED);
    const now = f.dynamic.find((r) => r.id === TYPO_RULE_FIRST)! as typeof first;
    expect(now.action.redirect.regexSubstitution).toContain(`#t=${f.tokens.v!.current}&`);
  });
});
