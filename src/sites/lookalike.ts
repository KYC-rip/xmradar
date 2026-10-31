import { parse } from 'tldts';
import { CONFUSABLES } from './confusables';
import { gradeRank, normalizeHost, PLATFORM_HOSTS, validFeedHost, type SiteEntry, type SiteFeed } from './feed';
import type { Lookalike, LookalikeKind } from './lookalike-text';

export type { Lookalike, LookalikeKind } from './lookalike-text';

/**
 * Lookalike warnings (PLAN-LOOKALIKE): a host that poses as a listed service (`www-trocador.app`,
 * `trоcador.app` with a Cyrillic о, `trocadorr.app`). Matched in the background against the feed
 * XMRadar already holds; the visited host is never sent anywhere.
 */

/** Hosting that serves anyone's site under its own suffix: a listing there seeds no brand. */
const SHARED_HOSTING = [
  'github.io',
  'gitlab.io',
  'codeberg.page',
  'pages.dev',
  'workers.dev',
  'vercel.app',
  'netlify.app',
  'web.app',
  'firebaseapp.com',
  'herokuapp.com',
  'notion.site',
  'carrd.co',
  'linktr.ee',
  'blogspot.com',
  'wordpress.com',
  'tumblr.com',
  'onion.ly',
];

/** Words too common to stand for one service. */
const GENERIC = new Set(
  ('monero xmr wallet wallets crypto bitcoin btc coin coins exchange swap swaps trade market proton privacy secure mail email ' +
    'cloud vpn pay cash money bank shop store card cards gift gifts sim sims phone host hosting server node mixer dex defi token ' +
    'tokens chain block app apps web site online official support help login account').split(' '),
);

/** Words phishing hosts put next to a brand (`www-`, `secure-`, `-login`). */
const FILLER = new Set(
  ('www web app apps login signin secure security official support help account accounts verify auth my en us online site mirror ' +
    'swap exchange wallet io com net org xyz new real safe onion tor').split(' '),
);

/** Suffixes a copy puts after a brand inside a longer host (`trocador.com.evil.net`), besides the brand's own. */
const COPY_SUFFIXES = new Set('com net org io xyz app co me info biz cc to ru su'.split(' '));

const PARSE = { allowPrivateDomains: true } as const;

/** A platform or shared-hosting host, or one of their subdomains, or a private (PSL) suffix. */
export function isPlatformHost(host: string): boolean {
  const h = normalizeHost(host);
  const under = (d: string) => h === d || h.endsWith(`.${d}`);
  return [...PLATFORM_HOSTS].some(under) || SHARED_HOSTING.some(under) || parse(h, PARSE).isPrivate === true;
}

// ---- punycode (RFC 3492), decode only: tldts and `location.hostname` give the xn-- form ----

const BASE = 36;
function decodePunycode(input: string): string | null {
  const out: number[] = [];
  const dash = input.lastIndexOf('-');
  for (let j = 0; j < Math.max(dash, 0); j++) out.push(input.charCodeAt(j));
  let n = 128;
  let bias = 72;
  let i = 0;
  for (let k = dash > 0 ? dash + 1 : 0; k < input.length; ) {
    const oldI = i;
    for (let w = 1, t = BASE; ; t += BASE) {
      if (k >= input.length) return null;
      const c = input.charCodeAt(k++);
      const digit = c >= 48 && c < 58 ? c - 22 : c >= 65 && c < 91 ? c - 65 : c >= 97 && c < 123 ? c - 97 : BASE;
      if (digit >= BASE) return null;
      i += digit * w;
      const th = t <= bias ? 1 : t >= bias + 26 ? 26 : t - bias;
      if (digit < th) break;
      w *= BASE - th;
      if (i > 0x10ffff * 64) return null;
    }
    const len = out.length + 1;
    let delta = oldI === 0 ? Math.floor((i - oldI) / 700) : (i - oldI) >> 1;
    delta += Math.floor(delta / len);
    let kk = 0;
    for (; delta > 455; kk += BASE) delta = Math.floor(delta / 35);
    bias = kk + Math.floor((36 * delta) / (delta + 38));
    n += Math.floor(i / len);
    i %= len;
    if (n > 0x10ffff) return null;
    out.splice(i++, 0, n);
  }
  return String.fromCodePoint(...out);
}

/** A label as people read it: `xn--trcador-hhg` → `trоcador`; undecodable labels stay as they are. */
export const unicodeLabel = (label: string) => (label.startsWith('xn--') ? (decodePunycode(label.slice(4)) ?? label) : label);

/**
 * What a label looks like: compatibility-decomposed (fullwidth and mathematical letters become plain
 * ones, accents split off), marks and invisible format characters removed, lower-cased, each character
 * mapped through Unicode's confusables, then the ASCII lookalikes rn→m, vv→w, 0→o, 1→l.
 */
export function skeleton(label: string): string {
  let s = '';
  for (const ch of label.normalize('NFKD').replace(/[\p{M}\p{Cf}]/gu, '').toLowerCase()) s += CONFUSABLES[ch] ?? ch;
  return s.replace(/rn/g, 'm').replace(/vv/g, 'w').replace(/0/g, 'o').replace(/1/g, 'l');
}

/** Whether a and b differ by exactly one insertion, deletion or substitution. */
function oneEdit(a: string, b: string): boolean {
  if (a === b || Math.abs(a.length - b.length) > 1) return false;
  const [s, l] = a.length <= b.length ? [a, b] : [b, a];
  let i = 0;
  while (i < s.length && s[i] === l[i]) i++;
  return s.length === l.length ? s.slice(i + 1) === l.slice(i + 1) : s.slice(i) === l.slice(i + 1);
}

interface Brand {
  /** the skeleton of the listed registrable label */
  brand: string;
  /** the listed registrable label as written (`trocador`) */
  raw: string;
  domain: string;
  suffix: string;
  site: SiteEntry;
  target: string;
  /** for ties: graded before ungraded, better grade first, then feed order */
  rank: number;
}

export interface LookalikeIndex {
  brands: Brand[];
  listed: Set<string>;
  phishing: Map<string, Lookalike>;
}

/** The host a link to `domain` opens: the domain itself when listed, else the listing's first host on it. */
function targetFor(site: SiteEntry, domain: string): string | null {
  if (site.hosts.includes(domain)) return domain;
  return site.hosts.find((h) => !h.endsWith('.onion') && validFeedHost(h) && parse(h, PARSE).domain === domain) ?? null;
}

/** The brands and listed domains of a feed (built once per feed). */
export function lookalikeIndex(feed: SiteFeed): LookalikeIndex {
  const brands: Brand[] = [];
  const listed = new Set<string>();
  const phishing = new Map<string, Lookalike>();
  const seeds = new Map<SiteEntry, Brand>();
  feed.sites.forEach((site, order) => {
    for (const host of site.hosts) {
      if (host.endsWith('.onion') || isPlatformHost(host)) continue;
      const p = parse(host, PARSE);
      if (!p.domain || !p.domainWithoutSuffix || !p.publicSuffix || p.isIp) continue;
      listed.add(p.domain);
      const raw = unicodeLabel(p.domainWithoutSuffix);
      const brand = skeleton(raw);
      const target = targetFor(site, p.domain);
      if (!target || brands.some((b) => b.site === site && b.domain === p.domain)) continue;
      const b: Brand = { brand, raw, domain: p.domain, suffix: p.publicSuffix, site, target, rank: (site.grade ? gradeRank(site.grade) : 99) * 10_000 + order };
      if (!seeds.has(site)) seeds.set(site, b);
      if (brand.length >= 5 && !/^\d+$/.test(brand) && !GENERIC.has(brand)) brands.push(b);
    }
  });
  for (const site of feed.sites) {
    // a listing only on a platform or an onion still has its phishing list: link its first web host
    const seed = seeds.get(site);
    const host = seed?.target ?? site.hosts.find((h) => !h.endsWith('.onion') && validFeedHost(h));
    if (!host) continue;
    const imitates = seed?.domain ?? parse(host, PARSE).domain ?? host;
    for (const h of site.phishingHosts ?? []) {
      if (!phishing.has(h)) phishing.set(h, { kind: 'listed-phishing', imitates, target: host, name: site.name });
    }
  }
  return { brands, listed, phishing };
}

/** Longest brand, then graded before ungraded and the better grade, then feed order. */
const best = (list: Brand[]) => list.sort((a, b) => b.brand.length - a.brand.length || a.rank - b.rank)[0];
const result = (kind: LookalikeKind, b: Brand | undefined): Lookalike | null => (b ? { kind, imitates: b.domain, target: b.target, name: b.site.name } : null);

/** Whether `host` poses as a listed service, and how (strongest kind first); null for anything else. */
export function lookalikeOf(index: LookalikeIndex, host: string): Lookalike | null {
  const h = normalizeHost(host);
  // the signed feed's own phishing list overrides every exit below, platforms included
  const known = index.phishing.get(h);
  if (known) return known;
  if (!h || h.endsWith('.onion') || isPlatformHost(h)) return null;
  const p = parse(h, PARSE);
  if (!p.domain || !p.domainWithoutSuffix || p.isIp || index.listed.has(p.domain)) return null;
  const reg = unicodeLabel(p.domainWithoutSuffix);
  const L = skeleton(reg);

  // a disguised registrable label: looks like the brand, isn't written like it
  const homoglyph = index.brands.filter((b) => b.brand === L && reg !== b.raw);
  if (homoglyph.length) return result('homoglyph', best(homoglyph));

  // the brand inside the host, only where it reads as a copy: followed by its own or a common suffix
  // (`trocador.app.evil.com`, `trocador.com.evil.net`, `trocador-app.com`) or joined to filler words (`www-trocador.app`,
  // `secure-trocador.…`); a bare word in another name (`venice-hotels.com`) is not one
  const labels = [...(p.subdomain ? p.subdomain.split('.').map(unicodeLabel) : []), reg];
  const segment = index.brands.filter((b) => {
    const suffix = b.suffix.split('.');
    return labels.some((label, at) => {
      const bits = label.split('-');
      for (let i = 0; i < bits.length; i++) {
        for (let j = i + 1; j <= bits.length; j++) {
          if (skeleton(bits.slice(i, j).join('-')) !== b.brand) continue;
          const rest = [...bits.slice(0, i), ...bits.slice(j)].map((x) => x.toLowerCase());
          if (rest.length) {
            if (rest.every((x) => FILLER.has(x) || suffix.includes(x))) return true;
          } else if (at < labels.length - 1 && (suffix.every((x, k) => labels[at + 1 + k] === x) || COPY_SUFFIXES.has(labels[at + 1]!))) {
            return true;
          }
        }
      }
      return false;
    });
  });
  if (segment.length) return result('segment', best(segment));

  const typo = index.brands.filter((b) => b.brand.length >= 7 && b.suffix === p.publicSuffix && oneEdit(L, b.brand));
  if (typo.length) return result('typo', best(typo));

  // the same plain name on another suffix: weak, an unrelated site of that name is plausible
  return result('same-name', best(index.brands.filter((b) => reg === b.raw)));
}
