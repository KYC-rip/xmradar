import { best, KNOWN_UNRELATED, lookalikeOf, oneTypo, skeleton, type Brand, type LookalikeIndex } from './lookalike';
import { COIN_CATEGORIES, type LookalikeKind } from './lookalike-text';

/**
 * Warnings before a page loads (PLAN-PRELOAD): the browser's own request rules send a navigation to an
 * address that carries a coin listing's name to XMRadar's guard page, before any request reaches the site.
 * Built from the signed feed only; the guard page then asks the background what the address is.
 */

/** The guard page, as WXT emits it. */
export const GUARD_PATH = '/guard.html';
/** XMRadar's own rule ids: name rules in the first range, the user's Continue choices in the second. */
export const NAME_RULE_FIRST = 100_000;
/** the whole dynamic range XMRadar owns: name rules from NAME_RULE_FIRST, typo rules from TYPO_RULE_FIRST */
export const NAME_RULE_LAST = 100_999;
export const TYPO_RULE_FIRST = 100_900;
/** domains per typo rule (Chrome and Firefox both took 150k in one; kept small so no rule nears a limit) */
const TYPO_CHUNK = 20_000;
export const ALLOW_RULE_FIRST = 101_000;
export const ALLOW_RULE_LAST = 105_999;
/** Chrome refuses a 1000th regex rule. */
const MAX_NAME_RULES = 900;

const LABEL = /^[a-z0-9-]+$/;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');

/**
 * The address carries `label` as a whole name part of its host: at the start or after `.`/`-`, then only
 * `-` parts until a `.` (`trocador.app`, `www-trocador.app`, `trocador-app.im`, `a.trocador.b.c`). A host
 * with no dot after the name (an intranet `trocador`) is left alone. Userinfo (`user@`) is skipped. RE2
 * syntax (no lookaround), and small enough for Chrome's per-rule regex memory limit (measured: adding a
 * second alternative for the name as the last label exceeded it).
 */
export const nameRegex = (labels: string[]) => {
  const alt = labels.length === 1 ? escapeRe(labels[0]!) : `(?:${labels.map(escapeRe).join('|')})`;
  return `^https?://(?:[^/?#]*@)?(?:[^/?#@:]*[.-])?${alt}(?:-[^/?#@:.]*)*\\.[^/?#@:]*(?::[0-9]+)?(?:[/?#]|$)`;
};

export interface NameRule {
  /** listed ASCII labels this rule stands for */
  labels: string[];
  regex: string;
  /** listed (and known unrelated) registrable domains the regex would also match: never redirected */
  excluded: string[];
}

/** One rule per coin listing's name (`trocador`), packed several to a rule only past Chrome's regex limit. */
export function nameRules(index: LookalikeIndex): NameRule[] {
  const labels = [...new Set(index.brands.filter((b) => COIN_CATEGORIES.has(b.site.category) && LABEL.test(b.raw)).map((b) => b.raw))].sort();
  const per = Math.ceil(labels.length / MAX_NAME_RULES) || 1;
  const rules: NameRule[] = [];
  for (let i = 0; i < labels.length; i += per) {
    const group = labels.slice(i, i + per);
    const regex = nameRegex(group);
    const re = new RegExp(regex, 'i');
    rules.push({ labels: group, regex, excluded: [...index.listed, ...KNOWN_UNRELATED].filter((d) => re.test(`https://${d}/`)).sort() });
  }
  return rules;
}

/** The subset of chrome.declarativeNetRequest.Rule that XMRadar writes. */
export interface DnrRule {
  id: number;
  priority: number;
  action: { type: 'redirect'; redirect: { regexSubstitution: string } } | { type: 'allow' };
  condition: { regexFilter?: string; requestDomains?: string[]; excludedRequestDomains?: string[]; resourceTypes: ['main_frame'] };
}

/** The redirect rules: the original URL travels in the guard page's fragment, after the build's token. */
export function guardRules(rules: NameRule[], guardUrl: string, token: string): DnrRule[] {
  return rules.map((r, i) => ({
    id: NAME_RULE_FIRST + i,
    priority: 1,
    action: { type: 'redirect', redirect: { regexSubstitution: `${guardUrl}#t=${token}&u=\\0` } },
    condition: { regexFilter: r.regex, ...(r.excluded.length ? { excludedRequestDomains: r.excluded } : {}), resourceTypes: ['main_frame'] },
  }));
}

/** Typos are only listed for names long enough that one changed letter rarely makes another real name. */
const TYPO_MIN = 7;
const TYPO_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789-';

/** Every label one typo away from `w`: a letter dropped, added, changed or two neighbours swapped. */
function typoLabels(w: string): Set<string> {
  const v = new Set<string>();
  for (let i = 0; i < w.length; i++) {
    v.add(w.slice(0, i) + w.slice(i + 1));
    for (const c of TYPO_ALPHABET) v.add(w.slice(0, i) + c + w.slice(i + 1));
    if (i < w.length - 1) v.add(w.slice(0, i) + w[i + 1] + w[i] + w.slice(i + 2));
  }
  for (let i = 0; i <= w.length; i++) for (const c of TYPO_ALPHABET) v.add(w.slice(0, i) + c + w.slice(i));
  v.delete(w);
  return v;
}

/**
 * One-typo copies of each coin listing's name on its own suffix (`pegasussawp.com`), for the browser to send
 * to the guard page before they load (PLAN-PRELOAD2 §1). A variant is kept only when the matcher's own
 * skeleton test agrees it is a typo or a look-alike of the name (so `sparnowwallet`, whose `rn` reads as `m`,
 * is left out). Listed and known-unrelated domains are never in it.
 */
export function typoDomains(index: LookalikeIndex): Map<string, Brand> {
  const out = new Map<string, Brand>();
  const skip = new Set([...index.listed, ...KNOWN_UNRELATED]);
  for (const b of index.brands) {
    if (b.brand.length < TYPO_MIN || !COIN_CATEGORIES.has(b.site.category) || !LABEL.test(b.raw)) continue;
    for (const v of typoLabels(b.raw)) {
      if (v.startsWith('-') || v.endsWith('-')) continue;
      const sk = skeleton(v);
      if (sk !== b.brand && !oneTypo(sk, b.brand)) continue;
      const d = `${v}.${b.suffix}`;
      if (skip.has(d)) continue;
      const had = out.get(d);
      if (!had || best([had, b]) === b) out.set(d, b);
    }
  }
  return out;
}

/** The typo set as redirect rules of at most TYPO_CHUNK domains each; `\0` is the whole URL. */
export function typoRules(domains: string[], guardUrl: string, token: string): DnrRule[] {
  const rules: DnrRule[] = [];
  for (let i = 0; i < domains.length; i += TYPO_CHUNK) {
    rules.push({
      id: TYPO_RULE_FIRST + rules.length,
      priority: 1,
      action: { type: 'redirect', redirect: { regexSubstitution: `${guardUrl}#t=${token}&u=\\0` } },
      condition: { regexFilter: '^https?://.*', requestDomains: domains.slice(i, i + TYPO_CHUNK), resourceTypes: ['main_frame'] },
    });
  }
  return rules;
}

/** The typo-set entry a host is, or is under. */
export function typoMatch(typos: Map<string, Brand>, host: string): Brand | null {
  const labels = host.replace(/\.$/, '').split('.');
  for (let i = 0; i < labels.length - 1; i++) {
    const b = typos.get(labels.slice(i).join('.'));
    if (b) return b;
  }
  return null;
}

/**
 * Whether a page gets the full guard page: a copy xmr.club confirmed (any listing), or another red match on a
 * coin listing (PLAN-PRELOAD2 §3, PLAN-IMPERSONATORS §3).
 */
export const shouldGuard = (l: { kind: LookalikeKind; category?: string } | null) =>
  !!l && (l.kind === 'listed-phishing' || (l.kind !== 'same-name' && COIN_CATEGORIES.has(l.category ?? '')));

/**
 * Session rules that let the hosts the user chose to continue to through. An allow covers the host's
 * subdomains (that is how `requestDomains` works), so `except` names the ones it must not: listed copies
 * under it that the user has not continued to themselves.
 */
export const allowRules = (hosts: string[], except: (host: string) => string[] = () => []): DnrRule[] =>
  hosts.slice(0, ALLOW_RULE_LAST - ALLOW_RULE_FIRST + 1).map((host, i) => {
    const excluded = except(host);
    return {
      id: ALLOW_RULE_FIRST + i,
      priority: 2,
      action: { type: 'allow' },
      condition: { requestDomains: [host], ...(excluded.length ? { excludedRequestDomains: excluded } : {}), resourceTypes: ['main_frame'] },
    };
  });

/** `#t=<token>&u=<original URL>`: the URL is everything after the first `&u=`, never split on `&`. */
export function parseGuardHash(hash: string): { token: string; url: URL } | null {
  const m = /^#t=([0-9a-f]{32})&u=([\s\S]+)$/.exec(hash);
  if (!m) return null;
  let url: URL;
  try {
    url = new URL(m[2]!);
  } catch {
    return null;
  }
  return url.protocol === 'http:' || url.protocol === 'https:' ? { token: m[1]!, url } : null;
}

const under = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`);

/** The coin listing whose name rule sends `url` to the guard page (the same test the browser ran), or null. */
export function guardMatch(index: LookalikeIndex, rules: NameRule[], url: URL): Brand | null {
  const host = url.hostname.replace(/\.$/, '');
  if (!host.includes('.')) return null;
  const hit: Brand[] = [];
  for (const r of rules) {
    if (r.excluded.some((d) => under(host, d))) continue;
    for (const label of r.labels) {
      if (new RegExp(nameRegex([label]), 'i').test(url.href)) hit.push(...index.brands.filter((b) => b.raw === label && COIN_CATEGORIES.has(b.site.category)));
    }
  }
  return best([...hit]) ?? null;
}

export type GuardAnswer =
  | { kind: 'invalid' }
  | { kind: 'off'; host: string; url: string }
  | {
      /** red: posing as the listing; same-name: its name on another domain; name: its name inside the address */
      kind: 'red' | 'same-name' | 'name';
      host: string;
      url: string;
      /** the matcher's kind for a red answer */
      why?: LookalikeKind;
      target: string;
      name: string;
      /** the listing's xmr.club id, from the feed */
      siteId: string;
      /** the background's word: the Report button shows (red, not already listed, setting on) */
      report?: boolean;
      /** this host was reported from this browser already */
      reported?: boolean;
    };

/** What the guard page shows for `hash`; never an allow or a navigation by itself (PLAN-PRELOAD §4). */
export function checkGuard(input: {
  hash: string;
  tokens: string[];
  on: boolean;
  index: LookalikeIndex | null;
  rules: NameRule[];
  typos?: Map<string, Brand>;
}): GuardAnswer {
  const parsed = parseGuardHash(input.hash);
  if (!parsed || !input.tokens.includes(parsed.token)) return { kind: 'invalid' };
  const { url } = parsed;
  if (!input.on || !input.index) return { kind: 'off', host: url.hostname, url: url.href };
  const base = { host: url.hostname, url: url.href };
  const l = lookalikeOf(input.index, url.hostname);
  const red = l && l.kind !== 'same-name' ? ({ kind: 'red', ...base, why: l.kind, target: l.target, name: l.name, siteId: l.siteId ?? '' } as const) : null;
  const brand = guardMatch(input.index, input.rules, url);
  if (brand) {
    if (red) return red;
    if (l) return { kind: 'same-name', ...base, target: l.target, name: l.name, siteId: l.siteId ?? brand.site.id };
    return { kind: 'name', ...base, target: brand.target, name: brand.site.name, siteId: brand.site.id };
  }
  // a typo copy sent by the typo rule: the set is the reason, the matcher's word is used when it agrees
  const typo = input.typos && typoMatch(input.typos, url.hostname);
  if (typo) return red ?? { kind: 'red', ...base, why: 'typo', target: typo.target, name: typo.site.name, siteId: typo.site.id };
  // a page the background replaced after load (look-alike letters, listed copies): only a red coin match
  return red && shouldGuard(l) ? red : { kind: 'invalid' };
}
