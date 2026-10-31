// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { describe, expect, it } from 'vitest';
import { bannerFor, mountBanner } from '../src/entrypoints/content/site';
import { badgeFor, publicSite, readFeed, type SiteEntry, type SiteFeed } from '../src/sites/feed';
import { isPlatformHost, lookalikeIndex, lookalikeOf, skeleton, unicodeLabel } from '../src/sites/lookalike';
import { lookalikeHref, lookalikeText, type Lookalike } from '../src/sites/lookalike-text';
import { renderSiteCard } from '../src/ui/site-card';
import live from './fixtures/xmrclub-feed-hosts.json';

const entry = (s: { id: string; name: string; grade: string; hosts: string[]; phishingHosts?: string[] }): SiteEntry => ({ category: 'exchanges', incident: false, url: `https://xmr.club/x/${s.id}`, ...s });
const feedOf = (sites: SiteEntry[]): SiteFeed => ({ issuedAt: 1, expiresAt: 2, sites });
const LIVE = lookalikeIndex(feedOf(live.sites.map(entry)));
// the form a browser hands over in `location.hostname`
const browserHost = (h: string) => new URL(`https://${h}/`).hostname;
const kind = (h: string) => lookalikeOf(LIVE, h)?.kind ?? null;

describe('red: a host posing as a listed service', () => {
  it.each(['www-trocador.app', 'trocador-app.com', 'trocador.app.evil.com', 'secure-trocador.app.login.xyz', 'login-trocador.app', 'trocador.app.com', 'trocador.com.evil.net', 'trocador.io.evil.com', 'www.trocador.xyz.evil.com'])('%s → segment', (h) => {
    expect(lookalikeOf(LIVE, h)).toEqual({ kind: 'segment', imitates: 'trocador.app', target: 'trocador.app', name: 'Trocador' });
  });
  it.each([
    ['Cyrillic о', browserHost('trоcador.app')],
    ['Greek ο', browserHost('trοcador.app')],
    ['a digit 0', 'trocad0r.app'],
    ['rn for m', 'rnullvad.net'.replace('.net', '.org')],
    ['fullwidth (raw)', 'ｔrocador.app'],
    ['mathematical bold (raw)', '𝐭rocador.app'],
    ['zero-width joiner (raw)', 'tro‍cador.app'],
    ['combining mark (raw)', 'trócador.app'],
  ])('%s → homoglyph', (_, h) => {
    expect(kind(h)).toBe('homoglyph');
  });
  it('another suffix after the brand: foundation.xyz is copied as foundation.app.evil.com', () => {
    expect(lookalikeOf(LIVE, 'foundation.app.evil.com')).toMatchObject({ kind: 'segment', imitates: 'foundation.xyz' });
  });
  it('one letter off a long brand, same suffix → typo', () => {
    expect(lookalikeOf(LIVE, 'trocadorr.app')).toMatchObject({ kind: 'typo', imitates: 'trocador.app' });
    expect(kind('trocadr.app')).toBe('typo');
  });
  it('browsers fold fullwidth and mathematical letters into the real name: no warning there', () => {
    expect(browserHost('ｔrocador.app')).toBe('trocador.app');
    expect(kind(browserHost('ｔrocador.app'))).toBeNull();
  });
});

describe('same-name: the plain name on another suffix', () => {
  it.each(['trocador.io', 'trocador.xyz'])('%s', (h) => {
    expect(lookalikeOf(LIVE, h)).toEqual({ kind: 'same-name', imitates: 'trocador.app', target: 'trocador.app', name: 'Trocador' });
  });
});

describe('null', () => {
  it.each([
    'trocador.app',
    'www.trocador.app',
    'app.trocador.app',
    '65bsisadnxvw4kfz7h7a3jwcyenrhluuj3kd5toslfzxbk5q4m3wy6qd.onion',
    'github.com',
    'gist.github.com',
    'github.dev',
    'github.blog',
    'foo.github.io',
    'x.vercel.app',
    'a.substack.com',
    'music.youtube.com',
    'old.reddit.com',
    'foo.matrix.to',
    'x.com.br',
    'tota.io',
    'monero.com',
    'swap.io',
    '127.0.0.1',
    'localhost',
    // a typo plus another suffix: two weak signals, too many unrelated names
    'trocadorr.io',
    'trocadr.xyz',
    // a listed word inside another name is not a copy
    'venice-hotels.com',
    'brave-heart.org',
    'trocador.evil.com',
    'venice.hotels.com',
  ])('%s', (h) => {
    expect(kind(h)).toBeNull();
  });
  it('every host in the live feed', () => {
    for (const s of live.sites) for (const h of s.hosts) expect([h, kind(h)]).toEqual([h, null]);
  });
  it('a typo of a 6-character brand', () => {
    const idx = lookalikeIndex(feedOf([entry({ id: 'a', name: 'Abcdef', grade: 'A', hosts: ['abcdef.com'] })]));
    expect(lookalikeOf(idx, 'abcdeg.com')).toBeNull();
    expect(lookalikeOf(idx, 'abcdef.net')?.kind).toBe('same-name');
  });
  it('a .co.uk listing: the brand is the label before the whole suffix', () => {
    const idx = lookalikeIndex(feedOf([entry({ id: 'u', name: 'Uklisted', grade: 'A', hosts: ['uklisted.co.uk'] })]));
    expect(lookalikeOf(idx, 'co.uk')).toBeNull();
    expect(lookalikeOf(idx, 'shop.uklisted.co.uk')).toBeNull();
    expect(lookalikeOf(idx, 'uklisted.co.uk.evil.net')?.kind).toBe('segment');
    expect(lookalikeOf(idx, 'uklisted-co-uk.com')?.kind).toBe('segment');
  });
  it('listings on platforms seed no brand', () => {
    const idx = lookalikeIndex(feedOf([entry({ id: 'g', name: 'Somegit', grade: 'A', hosts: ['github.com', 'somegit.github.io'] })]));
    expect(idx.brands).toEqual([]);
    expect(lookalikeOf(idx, 'www-github.com')).toBeNull();
    expect(isPlatformHost('raw.githubusercontent.com') && isPlatformHost('monero.stackexchange.com')).toBe(true);
  });
});

describe('popular legitimate domains', () => {
  const domains = readFileSync(join(process.cwd(), 'tests/fixtures/popular-domains.txt'), 'utf8').split(/\s+/).filter(Boolean);
  it('none comes out red; the same-name ones are exactly these', () => {
    expect(domains.length).toBeGreaterThan(500);
    const found = domains.map((d) => [d, kind(d)] as const).filter(([, k]) => k);
    expect(found).toEqual([['foundation.app', 'same-name']]);
  });
});

describe('strength and ties', () => {
  const idx = lookalikeIndex(
    feedOf([
      entry({ id: 'b', name: 'Bitcoinvn', grade: 'B', hosts: ['bitcoinvn.io'] }),
      entry({ id: 't2', name: 'Trocador Cards', grade: 'B', hosts: ['trocador.app'] }),
      entry({ id: 't', name: 'Trocador', grade: 'A', hosts: ['trocador.app'] }),
      entry({ id: 'w', name: 'Wwwfirst', grade: 'A', hosts: ['www.wwwfirst.net', 'wwwfirst.onion.example.onion'] }),
    ]),
  );
  it('segment beats typo', () => {
    expect(lookalikeOf(idx, 'www-trocador.bitcoinvm.io')).toMatchObject({ kind: 'segment', imitates: 'trocador.app' });
  });
  it('the better grade names the listing', () => {
    expect(lookalikeOf(idx, 'trocador.io')?.name).toBe('Trocador');
  });
  it("the link opens the listing's own host on that domain", () => {
    expect(lookalikeOf(idx, 'wwwfirst.org')).toMatchObject({ imitates: 'wwwfirst.net', target: 'www.wwwfirst.net' });
  });
});

describe('phishing_hosts from the signed feed', () => {
  const sk = ed25519.utils.randomSecretKey();
  const KEYS = new Set([bytesToHex(ed25519.getPublicKey(sk))]);
  const NOW = 1_793_261_226;
  const signed = (sites: unknown[]) => {
    const payload = JSON.stringify({ v: 1, issuer: 'xmr.club', issued_at: NOW, expires_at: NOW + 1000, sites });
    return { payload, signature: bytesToHex(ed25519.sign(new TextEncoder().encode(payload), sk)), public_key: bytesToHex(ed25519.getPublicKey(sk)), alg: 'ed25519' };
  };
  const site = (phishing_hosts: unknown) => ({ id: 'trocador', name: 'Trocador', category: 'exchanges', grade: 'A', incident: false, url: 'https://xmr.club/exchanges/trocador', hosts: ['trocador.app'], phishing_hosts });
  it('parsed, validated, deduped and capped at 50; kept out of what pages get', () => {
    const many = Array.from({ length: 60 }, (_, i) => `p${i}.example.com`);
    const [s] = readFeed(signed([site(['WWW.Trocador-Swap.com', 'trocador-swap.com', 'not a host', 7, '10.0.0.1', ...many])]), NOW, 0, KEYS).sites;
    expect(s!.phishingHosts![0]).toBe('trocador-swap.com');
    expect(s!.phishingHosts).toHaveLength(50);
    expect(publicSite(s!).phishingHosts).toBeUndefined();
    expect(readFeed(signed([site('nope')]), NOW, 0, KEYS).sites[0]!.phishingHosts).toBeUndefined();
  });
  it('a listing only on a platform or an onion keeps its phishing list', () => {
    const idx = lookalikeIndex(
      feedOf([
        entry({ id: 'g', name: 'Gitonly', grade: 'B', hosts: ['gitonly.github.io'], phishingHosts: ['gitonly-github.io.example.com'] }),
        entry({ id: 'o', name: 'Onionly', grade: '', hosts: ['abcdefghijklmnop.onion'], phishingHosts: ['onionly.example.com'] }),
      ]),
    );
    expect(lookalikeOf(idx, 'gitonly-github.io.example.com')).toEqual({ kind: 'listed-phishing', imitates: 'gitonly.github.io', target: 'gitonly.github.io', name: 'Gitonly' });
    // nothing on the web to send people to: no link, so no entry
    expect(lookalikeOf(idx, 'onionly.example.com')).toBeNull();
  });
  it('an exact entry is red, even on shared hosting or a listed host', () => {
    const idx = lookalikeIndex(feedOf([entry({ id: 't', name: 'Trocador', grade: 'A', hosts: ['trocador.app', 'mirror.example.org'], phishingHosts: ['trocad0r.github.io', 'mirror.example.org', 'tr.example.net'] })]));
    for (const h of ['trocad0r.github.io', 'www.trocad0r.github.io', 'mirror.example.org', 'tr.example.net']) {
      expect(lookalikeOf(idx, h)).toEqual({ kind: 'listed-phishing', imitates: 'trocador.app', target: 'trocador.app', name: 'Trocador' });
    }
  });
});

describe('labels and skeletons', () => {
  it('decodes punycode the way the browser encoded it', () => {
    for (const w of ['trоcador', 'münchen', 'bücher', 'пример']) expect(unicodeLabel(browserHost(`${w}.app`).split('.')[0]!)).toBe(w);
    expect(unicodeLabel('xn--')).toBe('');
    expect(unicodeLabel('xn--zz!')).toBe('xn--zz!');
  });
  it('maps lookalikes to the plain name', () => {
    for (const w of ['trоcador', 'trοcador', 'ｔrocador', '𝐭rocador', 'tro‍cador', 'trócador', 'TROCADOR', 'trocad0r']) expect(skeleton(w)).toBe('trocador');
    expect(skeleton('rnullvad')).toBe(skeleton('mullvad'));
  });
});

describe('what the user sees', () => {
  const red: Lookalike = { kind: 'segment', imitates: 'trocador.app', target: 'trocador.app', name: 'Trocador' };
  const amber: Lookalike = { ...red, kind: 'same-name' };
  it('badge: receipt warn > red lookalike > incident > receipt caution > same-name > intern > receipt ok > grade', () => {
    expect(badgeFor({ receipt: 'warn', lookalike: 'segment' })).toEqual({ text: '!', color: '#d93025' });
    expect(badgeFor({ lookalike: 'homoglyph', site: { grade: 'C', incident: true } })).toEqual({ text: '!', color: '#d93025' });
    expect(badgeFor({ lookalike: 'same-name', site: { grade: 'C', incident: true } })).toEqual({ text: 'C', color: '#d93025' });
    expect(badgeFor({ lookalike: 'same-name', receipt: 'caution' })).toEqual({ text: '!', color: '#b26a00' });
    expect(badgeFor({ lookalike: 'same-name', site: { grade: '', incident: false, intern: true } })).toEqual({ text: '?', color: '#b26a00' });
    expect(badgeFor({ lookalike: 'same-name', receipt: 'ok' })).toEqual({ text: '?', color: '#b26a00' });
    expect(badgeFor({ lookalike: 'listed-phishing', receipt: 'ok', site: { grade: 'A', incident: false } }).text).toBe('!');
  });
  it('banner: red kinds only, even with no listing; same-name never', () => {
    expect(bannerFor({ sites: [], lookalike: red, outOfDate: false, issuedAt: 1 })).toEqual({ lookalike: red });
    expect(bannerFor({ sites: [], lookalike: amber, outOfDate: false, issuedAt: 1 })).toBeNull();
    expect(bannerFor({ sites: [], lookalike: null, outOfDate: false, issuedAt: 1 })).toBeNull();
  });
  it('the banner links the listed host only, whatever the page URL says', () => {
    // a closed shadow root: keep a handle on it while the banner mounts
    let root: ShadowRoot | undefined;
    const attach = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function (init) {
      return (root = attach.call(this, init));
    };
    history.replaceState(null, '', '/?u=https://evil.example/');
    const host = mountBanner(document, { lookalike: red }, () => {});
    Element.prototype.attachShadow = attach;
    expect(root!.querySelector('.msg')!.textContent).toContain('looks like trocador.app');
    expect(root!.querySelector('.bar')!.className).toBe('bar');
    const a = root!.querySelector('a')!;
    expect([a.href, a.textContent, a.rel]).toEqual(['https://trocador.app/', 'Go to trocador.app', 'noopener noreferrer']);
    expect(root!.innerHTML).not.toContain('evil');
    host.remove();
    expect(lookalikeText(red)).toBe("This site's name looks like trocador.app (listed on xmr.club as Trocador), but it isn't. Copies of exchange sites take the coins you send.");
    expect(lookalikeHref(red)).toBe('https://trocador.app/');
    expect(lookalikeText({ ...red, kind: 'listed-phishing' })).toBe('xmr.club lists this site as a phishing copy of trocador.app (Trocador).');
  });
  it('popup card: shown for a lookalike alone, red or amber, with the feed-built link', () => {
    const root = document.createElement('div');
    root.className = 'hidden';
    renderSiteCard(root, { sites: [], lookalike: red, outOfDate: false, issuedAt: 1 });
    expect(root.classList.contains('hidden')).toBe(false);
    expect(root.querySelector('.warn')!.textContent).toContain('looks like trocador.app');
    expect((root.querySelector('a') as HTMLAnchorElement).href).toBe('https://trocador.app/');
    renderSiteCard(root, { sites: [], lookalike: amber, outOfDate: false, issuedAt: 1 });
    expect(root.querySelector('.caution')!.textContent).toContain('same name as trocador.app');
    renderSiteCard(root, { sites: [], lookalike: null, outOfDate: false, issuedAt: 1 });
    expect(root.classList.contains('hidden')).toBe(true);
  });
});
