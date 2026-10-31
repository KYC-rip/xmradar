import { normalizeHost } from './feed';
import { lookalikeOf, type Brand, type LookalikeIndex } from './lookalike';
import {
  ALLOW_RULE_FIRST,
  ALLOW_RULE_LAST,
  allowRules,
  checkGuard,
  guardRules,
  NAME_RULE_FIRST,
  NAME_RULE_LAST,
  nameRules,
  shouldGuard,
  TYPO_RULE_FIRST,
  typoDomains,
  typoRules,
  type DnrRule,
  type GuardAnswer,
  type NameRule,
} from './guard-rules';

/** The parts of chrome.declarativeNetRequest the keeper uses. */
export interface DnrApi {
  getDynamicRules(): Promise<{ id: number; action?: { type: string; redirect?: { regexSubstitution?: string } } }[]>;
  updateDynamicRules(o: { removeRuleIds?: number[]; addRules?: DnrRule[] }): Promise<void>;
  getSessionRules(): Promise<{ id: number }[]>;
  updateSessionRules(o: { removeRuleIds?: number[]; addRules?: DnrRule[] }): Promise<void>;
}
interface Item<T> {
  getValue(): Promise<T>;
  setValue(v: T): Promise<void>;
}
/** The redirect token of the rules in place (and the one before, for a redirect still in flight). */
export interface GuardTokens {
  /** feed issuedAt and guard URL the rules were built for */
  sig: string;
  current: string;
  previous?: string;
  previousUntil?: number;
}

export const CONTINUE_MS = 7 * 24 * 3600 * 1000;
const TOKEN_GRACE_MS = 60_000;
const EMPTY: LookalikeIndex = { brands: [], listed: new Set(), phishing: new Map(), impersonators: [] };
const inRange = (first: number, last: number) => (r: { id: number }) => r.id >= first && r.id <= last;

export function guardKeeper(deps: {
  dnr: DnrApi | undefined;
  guardUrl: () => string;
  tokens: Item<GuardTokens | null>;
  /** hosts the user chose Continue for on the guard page: the only source of allow rules */
  continued: Item<Record<string, number>>;
  /** the subset continued to on a page that already said xmr.club lists the host as a copy */
  continuedListed: Item<Record<string, number>>;
  /** the in-page banner's dismiss record, written too so the loaded page shows no banner */
  dismissed: Item<Record<string, number>>;
  now: () => number;
  randomHex: () => string;
}) {
  const { dnr } = deps;
  type Built = { issuedAt: number; index: LookalikeIndex; rules: NameRule[]; typos: Map<string, Brand>; typoList: string[] };
  // the feed before the current one, so a redirect its rules made just before an update still gets a page
  let built: Built | null = null;
  let before: Built | null = null;
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(f: () => Promise<T>): Promise<T> => {
    const p = chain.then(f, f);
    chain = p.catch(() => {});
    return p;
  };
  const buildFor = (index: LookalikeIndex, issuedAt: number): Built => {
    if (built?.issuedAt !== issuedAt) {
      if (built) before = built;
      const typos = typoDomains(index);
      // the typo copies and xmr.club's confirmed impersonators share the exact-domain rules
      built = { issuedAt, index, rules: nameRules(index), typos, typoList: [...new Set([...typos.keys(), ...index.impersonators])].sort() };
    }
    return built;
  };
  const live = (r: Record<string, number>) => Object.fromEntries(Object.entries(r).filter(([, t]) => t > deps.now()));
  const liveContinued = async () => live(await deps.continued.getValue());
  /**
   * The hosts the user's Continue still lets through. A Continue made before xmr.club confirmed a host as a
   * copy no longer counts for it: only one made on the page that said so does (PLAN-IMPERSONATORS).
   */
  const under = (h: string, d: string) => h === d || h.endsWith(`.${d}`);
  /**
   * The user's Continue choices as the browser applies them: each host with its subdomains, except listed
   * copies the user did not continue to on their own page. One predicate for the rules and the after-load check.
   */
  const allowance = async (index: LookalikeIndex | null) => {
    const ix = index ?? EMPTY;
    const c = Object.keys(await liveContinued());
    const ok = live(await deps.continuedListed.getValue());
    const copy = (h: string) => lookalikeOf(ix, h)?.kind === 'listed-phishing' && !ok[h];
    const hosts = c.filter((h) => !copy(h)).sort();
    const except = (h: string) => [...ix.phishing.keys()].filter((k) => k !== h && under(k, h) && !ok[k]).sort();
    const covers = (host: string) => !copy(host) && hosts.some((h) => under(host, h));
    return { hosts, except, covers };
  };
  async function applyAllows(on: boolean, index: LookalikeIndex | null = null) {
    if (!dnr) return;
    const old = (await dnr.getSessionRules()).filter(inRange(ALLOW_RULE_FIRST, ALLOW_RULE_LAST)).map((r) => r.id);
    const a = on ? await allowance(index) : null;
    const addRules = a ? allowRules(a.hosts, a.except) : [];
    await dnr.updateSessionRules({ removeRuleIds: old, addRules });
  }

  /** Put the rules in place for this feed, or take every XMRadar rule away when warnings are off. */
  const apply = (on: boolean, feed: { index: LookalikeIndex; issuedAt: number } | null) =>
    serial(async () => {
      if (!dnr) return;
      const inPlace = (await dnr.getDynamicRules()).filter(inRange(NAME_RULE_FIRST, NAME_RULE_LAST));
      const all = inPlace.map((r) => r.id);
      const named = inPlace.filter((r) => r.id < TYPO_RULE_FIRST);
      const old = named.map((r) => r.id);
      const typoInPlace = inPlace.filter((r) => r.id >= TYPO_RULE_FIRST);
      const oldTypos = typoInPlace.map((r) => r.id);
      if (!on || !feed) {
        await dnr.updateDynamicRules({ removeRuleIds: all });
        await applyAllows(false);
        await deps.tokens.setValue(null);
        return;
      }
      const guardUrl = deps.guardUrl();
      const sig = `${feed.issuedAt}|${guardUrl}`;
      const kept = await deps.tokens.getValue();
      const b = buildFor(feed.index, feed.issuedAt);
      const rules = b.rules;
      // the token the browser actually redirects with, read back from the rules in place
      const tokenOf = (r: (typeof inPlace)[number] | undefined) => /#t=([0-9a-f]{32})&u=/.exec(r?.action?.redirect?.regexSubstitution ?? '')?.[1];
      const inUse = tokenOf(named[0]);
      const rewrite = kept?.sig !== sig || old.length !== rules.length || (rules.length > 0 && inUse !== kept?.current);
      if (rewrite) {
        const token = deps.randomHex();
        // stored before the rules change: a worker stopped in between leaves the old rules' token as `previous`
        const prev = inUse ?? kept?.current;
        await deps.tokens.setValue({ sig, current: token, ...(prev ? { previous: prev, previousUntil: deps.now() + TOKEN_GRACE_MS } : {}) });
        try {
          await dnr.updateDynamicRules({ removeRuleIds: old, addRules: guardRules(rules, guardUrl, token) });
        } catch (e) {
          // never leave rules behind that point at a guard page that no longer answers: fail open
          await dnr.updateDynamicRules({ removeRuleIds: all }).catch(() => {});
          await deps.tokens.setValue(null);
          throw e;
        }
      }
      // typo rules on their own: a browser that refuses them keeps the name rules (PLAN-PRELOAD2 §1)
      const token = (await deps.tokens.getValue())?.current;
      const typo = token ? typoRules(b.typoList, guardUrl, token) : [];
      // rewritten too when their own token is not the current one (a typo update that was stopped or refused)
      if (rewrite || oldTypos.length !== typo.length || (typo.length > 0 && tokenOf(typoInPlace[0]) !== token)) {
        try {
          await dnr.updateDynamicRules({ removeRuleIds: oldTypos, addRules: typo });
        } catch (e) {
          await dnr.updateDynamicRules({ removeRuleIds: oldTypos }).catch(() => {});
          console.warn('[XMRadar] typo rules refused', (e as Error).message);
        }
      }
      await applyAllows(true, feed.index);
    });

  async function tokens(): Promise<string[]> {
    const t = await deps.tokens.getValue();
    if (!t) return [];
    return t.previous && (t.previousUntil ?? 0) > deps.now() ? [t.current, t.previous] : [t.current];
  }

  /** What the guard page shows; adds nothing. */
  async function check(hash: string, on: boolean, feed: { index: LookalikeIndex; issuedAt: number } | null): Promise<GuardAnswer> {
    await chain;
    return checkNow(hash, on, feed);
  }
  async function checkNow(hash: string, on: boolean, feed: { index: LookalikeIndex; issuedAt: number } | null): Promise<GuardAnswer> {
    const t = await tokens();
    const b = feed ? buildFor(feed.index, feed.issuedAt) : null;
    const a = checkGuard({ hash, tokens: t, on, index: feed?.index ?? null, rules: b?.rules ?? [], typos: b?.typos });
    // a redirect made by the previous feed's rules, within the token's grace minute
    if (a.kind === 'invalid' && before && t.length > 1) return checkGuard({ hash, tokens: t.slice(1), on, index: before.index, rules: before.rules, typos: before.typos });
    return a;
  }

  /** The user clicked Continue: re-check everything, then let that one host through for 7 days. */
  // all in the serial chain, so an after-load decision either ran before this choice or sees it
  const cont = (hash: string, on: boolean, feed: { index: LookalikeIndex; issuedAt: number } | null): Promise<{ url: string }> =>
    serial(async () => {
      const a = await checkNow(hash, on, feed);
      if (a.kind !== 'red' && a.kind !== 'same-name' && a.kind !== 'name') throw new Error('Nothing to continue to');
      const until = deps.now() + CONTINUE_MS;
      const host = a.host.replace(/\.$/, '');
      // the allow is for the host as the browser requests it; the banner record is keyed as the content script keys it
      await deps.continued.setValue({ ...(await liveContinued()), [host]: until });
      if (a.kind === 'red' && a.why === 'listed-phishing') await deps.continuedListed.setValue({ ...live(await deps.continuedListed.getValue()), [host]: until });
      await deps.dismissed.setValue({ ...live(await deps.dismissed.getValue()), [normalizeHost(a.host)]: until });
      await applyAllows(true, feed?.index ?? null);
      return { url: a.url };
    });

  /**
   * Send a page that already started loading to the guard page (PLAN-PRELOAD2 §3): only for a red match on a
   * coin listing, with rules and a token in place, and not for a host the user continued to. `go` runs inside
   * the serial chain (a Continue can't slip in between) and must re-check that the tab is still on `url`.
   */
  const afterLoad = (url: string, on: boolean, feed: { index: LookalikeIndex; issuedAt: number } | null, go: (to: string) => Promise<void>) =>
    serial(async (): Promise<string | null> => {
      if (!dnr || !on || !feed) return null;
      let u: URL;
      try {
        u = new URL(url);
      } catch {
        return null;
      }
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
      const t = await deps.tokens.getValue();
      const inPlace = (await dnr.getDynamicRules()).filter(inRange(NAME_RULE_FIRST, TYPO_RULE_FIRST - 1));
      if (!t || !inPlace.length) return null;
      if (!shouldGuard(lookalikeOf(feed.index, u.hostname))) return null;
      if ((await allowance(feed.index)).covers(u.hostname.replace(/\.$/, ''))) return null;
      const to = `${deps.guardUrl()}#t=${t.current}&u=${u.href}`;
      await go(to);
      return to;
    });

  return { apply, check, continue: cont, afterLoad };
}
