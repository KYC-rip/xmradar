import { TokenBucket } from '../identity/bucket';
import { EntryCache } from '../identity/cache';
import { HANDLE_RE, normalizeHandle } from '../identity/envelope';
import { verifyTwitterProof, type ProofResult, type QueryFn } from '../identity/nostr';
import { mergeBadge, resolveHandles, withoutNostr, withoutSelf, type Badge, type BadgeEntry } from '../identity/resolve';
import { resolveXmrbio, type SeenEntries } from '../identity/xmrbio';
import { selfEntries, type XClaimEntry } from '../identity/xclaims';
import type { ResolveHandlesResult, XapPostTotalsResult, XapTotals, XapTotalsResult, XmrbioResult } from '../messaging';
import { DEFAULT_RELAYS, INDEX_RELAYS, xClaimsOn, type XmrSettings } from '../settings';
import type { XapQuery } from '../xap/fetch';
import { fetchXmrUsd, PRICE_RETRY_MS, PRICE_TTL_MS } from '../xap/price';
import { parsePostKey, postKey } from '../xap/post';
import { FreshTotals, countFor, countPosts, validPosts, type PostRef, type XapDeps } from '../xap/service';
import { xapTtl } from '../xap/ttl';

/**
 * The lookups behind X's badges, tip popups and xap counts — one implementation for the extension's
 * background and for Ripley (PLAN in ripley-os plans/x-app-xmradar.md, R13–R17). Everything outside is
 * injected: storage, HTTP, relay reads, settings, which relays, and who "me" is. Nothing here opens a
 * connection of its own: relay reads go only through `query` / `xapQuery`, HTTP only through `fetch`.
 */

const BADGE_TTL_MS = 6 * 3600_000;
// a "no badge" answer may come from relays that were briefly down, so it is rechecked sooner
const NO_BADGE_TTL_MS = 3600_000;
const PROOF_OK_TTL_MS = 7 * 86400_000;
const PROOF_FAIL_TTL_MS = 86400_000;
const MAX_HANDLES_PER_CALL = 200;
export const MAX_XAP_RECIPIENTS = 50;

type CacheEntries<V> = [string, { v: V; at: number }][];

export interface Kv<T> {
  getValue(): Promise<T>;
  setValue(v: T): Promise<void>;
}

/** Requests a page may send, answered by `handle` (anything else is refused). */
export const REQUEST_TYPES = ['resolve-handles', 'xap-totals', 'xap-post-totals', 'xmrbio-resolve', 'xmr-price'] as const;
export type RequestType = (typeof REQUEST_TYPES)[number];

/** The bucket a caller's relay lookups are counted in: the extension's tab id, Ripley's one X view. */
export type RateKey = number | string;

export interface XLookupsDeps {
  items: {
    badgeCache: Kv<CacheEntries<Badge>>;
    proofCache: Kv<CacheEntries<ProofResult>>;
    xapCache: Kv<CacheEntries<XapTotals>>;
    xmrUsd: Kv<{ usd: number; at: number } | null>;
    xmrbioSeen: Kv<SeenEntries>;
  };
  /** every HTTP request: xmr.bio, the price, the proof-tweet check */
  fetch: typeof fetch;
  /** every relay read for badges (claims, payto) */
  query: QueryFn;
  /** every relay read for xap totals */
  xapQuery: XapQuery;
  settings: () => Promise<XmrSettings>;
  /** the user's own relays for badge discovery; the defaults and index relays are added here */
  badgeRelays: () => Promise<string[]>;
  /** the user's own relays for xap lookups; the defaults and index relays are added here */
  xapRelays: () => Promise<string[]>;
  me: XapDeps['me'];
  /** the held xmr.bio directory (source A) */
  directory: () => Promise<(handle: string) => BadgeEntry[]>;
  /** what profiles showed about themselves; only read while X claims are on */
  selfClaims: () => Promise<(handle: string) => XClaimEntry | undefined>;
  now?: () => number;
}

export type XLookups = ReturnType<typeof xLookups>;

export function xLookups(deps: XLookupsDeps) {
  // R15: no default transport — a missing one would fall back to a connection of the library's own
  if (typeof deps.query !== 'function' || typeof deps.xapQuery !== 'function' || typeof deps.fetch !== 'function') throw new Error('xLookups: query, xapQuery and fetch are required');
  const now = deps.now ?? Date.now;
  const uniq = (a: string[]) => [...new Set(a)];

  let caches: Promise<{ badges: EntryCache<Badge>; proofs: EntryCache<ProofResult> }> | null = null;
  let persistTimer: ReturnType<typeof setTimeout> | undefined;
  let xapCache: Promise<EntryCache<XapTotals>> | null = null;
  let xapPersistTimer: ReturnType<typeof setTimeout> | undefined;
  // RATE-2: only relay (source B) lookups are throttled; burst 50, refill 2/s, per rate key
  const buckets = new Map<RateKey, TokenBucket>();
  const xapBuckets = new Map<RateKey, TokenBucket>();
  const bucketFor = (m: Map<RateKey, TokenBucket>, k: RateKey) => {
    let b = m.get(k);
    if (!b) m.set(k, (b = new TokenBucket(50, 2)));
    return b;
  };

  function loadCaches() {
    caches ??= Promise.all([deps.items.badgeCache.getValue(), deps.items.proofCache.getValue()]).then(([b, p]) => ({
      badges: new EntryCache(b),
      proofs: new EntryCache(p),
    }));
    return caches;
  }

  function persistCaches() {
    clearTimeout(persistTimer);
    persistTimer = setTimeout(async () => {
      const { badges, proofs } = await loadCaches();
      await Promise.all([deps.items.badgeCache.setValue(badges.entries()), deps.items.proofCache.setValue(proofs.entries())]);
    }, 1000);
  }

  async function verify(handle: string, tweetId: string, pubkey: string): Promise<ProofResult> {
    const { proofs } = await loadCaches();
    const key = `${handle}:${tweetId}:${pubkey}`;
    const ttl = (r: ProofResult) => (r.status === 'verified' ? PROOF_OK_TTL_MS : PROOF_FAIL_TTL_MS);
    const hit = proofs.get(key, now(), ttl);
    if (hit) return hit;
    const result = await verifyTwitterProof(handle, tweetId, pubkey, deps.fetch);
    // network errors aren't cached, so the next sighting tries again
    if (result.status !== 'error') proofs.set(key, result, now());
    return result;
  }

  async function badges(handles: string[], rateKey: RateKey): Promise<ResolveHandlesResult> {
    const settings = await deps.settings();
    const { badgesX: enabled, nostrDiscovery } = settings;
    if (!enabled) return { badges: [], pending: [] };
    const claimsOn = xClaimsOn(settings);
    const valid = [...new Set((Array.isArray(handles) ? handles : []).filter((h) => typeof h === 'string' && HANDLE_RE.test(h)))].slice(0, MAX_HANDLES_PER_CALL);
    const { badges: cache } = await loadCaches();
    const out: [string, Badge][] = [];
    const misses: string[] = [];
    for (const h of valid) {
      const hit = cache.get(normalizeHandle(h), now(), (b) => (b.primary ? BADGE_TTL_MS : NO_BADGE_TTL_MS));
      if (!hit) misses.push(h);
      // with discovery or claims off, entries cached earlier from them must not come back
      else {
        const b = nostrDiscovery ? hit : withoutNostr(hit);
        out.push([hit.handle, claimsOn ? b : withoutSelf(b)]);
      }
    }
    if (!misses.length) return { badges: out, pending: [] };
    // the local directory costs nothing and tells no one anything, so it is never throttled (RATE-2)
    const lookup = await deps.directory();
    // with claims off, none are read — not even ones held from before
    const selfClaims = claimsOn ? await deps.selfClaims() : () => undefined;
    if (!nostrDiscovery) {
      // not cached: the directory and claims are already local, and a change applies at once
      for (const h of misses) {
        const key = normalizeHandle(h);
        out.push([key, mergeBadge(key, [...lookup(key), ...selfEntries(selfClaims(key), lookup)])]);
      }
      return { badges: out, pending: [] };
    }
    const granted = bucketFor(buckets, rateKey).take(misses.length);
    const batch = misses.slice(0, granted);
    if (batch.length) {
      const relays = uniq([...DEFAULT_RELAYS, ...INDEX_RELAYS, ...(await deps.badgeRelays())]);
      const found = await resolveHandles(batch, { discovery: true, relays, query: deps.query, verify, directory: lookup, selfClaims });
      for (const [key, badge] of found) {
        cache.set(key, badge, now());
        out.push([key, claimsOn ? badge : withoutSelf(badge)]);
      }
      persistCaches();
    }
    return { badges: out, pending: misses.slice(granted) };
  }

  const xapDeps: XapDeps = {
    query: deps.xapQuery,
    lookupRelays: async () => uniq([...DEFAULT_RELAYS, ...INDEX_RELAYS, ...(await deps.xapRelays())]),
    me: deps.me,
    now,
  };

  function loadXapCache() {
    xapCache ??= deps.items.xapCache.getValue().then((e) => new EntryCache(e, 1000));
    return xapCache;
  }

  function persistXapCache() {
    clearTimeout(xapPersistTimer);
    xapPersistTimer = setTimeout(async () => deps.items.xapCache.setValue((await loadXapCache()).entries()), 1000);
  }

  const freshTotals = new FreshTotals(async (pk) => {
    const t = (await countFor([pk], xapDeps)).get(pk)!;
    (await loadXapCache()).set(pk, t, now());
    persistXapCache();
    return t;
  });
  // post figures share the cache under postKey(pubkey, id), which never looks like a bare pubkey
  const freshPostTotals = new FreshTotals(async (key) => {
    const t = (await countPosts([parsePostKey(key)], xapDeps)).get(key)!;
    (await loadXapCache()).set(key, t, now());
    persistXapCache();
    return t;
  });

  /**
   * Cached totals feed the action-bar counts (verified only, which doesn't depend on the current
   * address). A popup asks `fresh`: one recipient, from the relays or a fetch under 15 s old.
   */
  async function xapTotals(recipients: string[], fresh: boolean, rateKey: RateKey): Promise<XapTotalsResult> {
    const valid = [...new Set(Array.isArray(recipients) ? recipients.filter((r) => typeof r === 'string' && /^[0-9a-f]{64}$/.test(r)) : [])].slice(0, MAX_XAP_RECIPIENTS);
    if (fresh) {
      if (valid.length !== 1) throw new Error('One recipient at a time');
      return { totals: [[valid[0]!, await freshTotals.get(valid[0]!)]], pending: [] };
    }
    const { badgesX, nostrDiscovery } = await deps.settings();
    // without discovery, relays only hear about a recipient when the user opens their popup
    if (!badgesX || !nostrDiscovery) return { totals: [], pending: [] };
    const cache = await loadXapCache();
    const out: [string, XapTotals][] = [];
    const misses: string[] = [];
    for (const pk of valid) {
      const hit = cache.get(pk, now(), xapTtl);
      if (hit) out.push([pk, hit]);
      else misses.push(pk);
    }
    if (!misses.length) return { totals: out, pending: [] };
    const granted = bucketFor(xapBuckets, rateKey).take(misses.length);
    const batch = misses.slice(0, granted);
    if (batch.length) {
      for (const [pk, t] of await countFor(batch, xapDeps)) {
        cache.set(pk, t, now());
        out.push([pk, t]);
      }
      persistXapCache();
    }
    return { totals: out, pending: misses.slice(granted) };
  }

  /**
   * Post figures (NKIP-0002 external post tips) for the action bar, or `fresh` for one post's popup.
   * Same gates, cache and bucket as profile totals; each post costs one token.
   */
  async function xapPostTotals(posts: unknown, fresh: boolean, rateKey: RateKey): Promise<XapPostTotalsResult> {
    const valid = validPosts(posts, MAX_XAP_RECIPIENTS);
    if (fresh) {
      if (valid.length !== 1) throw new Error('One post at a time');
      const key = postKey(valid[0]!.pubkey, valid[0]!.id);
      return { totals: [[key, await freshPostTotals.get(key)]], pending: [] };
    }
    const { badgesX, nostrDiscovery } = await deps.settings();
    if (!badgesX || !nostrDiscovery) return { totals: [], pending: [] };
    const cache = await loadXapCache();
    const out: [string, XapTotals][] = [];
    const misses: PostRef[] = [];
    for (const p of valid) {
      const key = postKey(p.pubkey, p.id);
      const hit = cache.get(key, now(), xapTtl);
      if (hit) out.push([key, hit]);
      else misses.push(p);
    }
    if (!misses.length) return { totals: out, pending: [] };
    const granted = bucketFor(xapBuckets, rateKey).take(misses.length);
    const batch = misses.slice(0, granted);
    if (batch.length) {
      for (const [key, t] of await countPosts(batch, xapDeps)) {
        cache.set(key, t, now());
        out.push([key, t]);
      }
      persistXapCache();
    }
    return { totals: out, pending: misses.slice(granted) };
  }

  /** A receipt went out: the next ask for this recipient (and post), popup or action bar, goes to the relays. */
  async function forgetXap(recipient: string, post?: string) {
    freshTotals.forget(recipient);
    const cache = await loadXapCache();
    cache.delete(recipient);
    if (post) {
      const key = postKey(recipient, post);
      freshPostTotals.forget(key);
      cache.delete(key);
    }
    persistXapCache();
  }

  let xmrUsdInFlight: Promise<number> | null = null;
  let xmrUsdFailedAt = 0;
  /** USD per XMR, at most one fetch every 5 min (1 min after a failure), shared by every popup asking meanwhile. */
  async function xmrUsd(): Promise<number> {
    const cached = await deps.items.xmrUsd.getValue();
    if (cached && now() - cached.at < PRICE_TTL_MS) return cached.usd;
    if (now() - xmrUsdFailedAt < PRICE_RETRY_MS) throw new Error('Price unavailable');
    xmrUsdInFlight ??= fetchXmrUsd(deps.fetch)
      .then(
        async (usd) => {
          await deps.items.xmrUsd.setValue({ usd, at: now() }).catch(() => {});
          return usd;
        },
        (e) => {
          xmrUsdFailedAt = now();
          throw e;
        },
      )
      .finally(() => (xmrUsdInFlight = null));
    return xmrUsdInFlight;
  }

  // resolves run one at a time so concurrent lookups can't overwrite each other's replay guard entry
  let resolveQueue: Promise<unknown> = Promise.resolve();
  /** One xmr.bio /resolve at a time, so the freshness guard sees responses in order. */
  function xmrbioResolve(handle: string): Promise<XmrbioResult> {
    const run = resolveQueue.then(async () => {
      const stored = await deps.items.xmrbioSeen.getValue();
      const { result, seen } = await resolveXmrbio(handle, Array.isArray(stored) ? stored : [], { fetch: deps.fetch });
      await deps.items.xmrbioSeen.setValue(seen);
      return result;
    });
    resolveQueue = run.catch(() => {});
    return run;
  }

  /** A page's request, by type; anything outside REQUEST_TYPES is refused. */
  function handle(type: string, body: Record<string, unknown>, rateKey: RateKey): Promise<unknown> {
    switch (type as RequestType) {
      case 'resolve-handles':
        return badges(body.handles as string[], rateKey);
      case 'xap-totals':
        return xapTotals(body.recipients as string[], !!body.fresh, rateKey);
      case 'xap-post-totals':
        return xapPostTotals(body.posts, !!body.fresh, rateKey);
      case 'xmrbio-resolve':
        return xmrbioResolve(String(body.handle));
      case 'xmr-price':
        return xmrUsd().then((usd) => ({ usd }));
      default:
        return Promise.reject(new Error('unsupported'));
    }
  }

  return {
    handle,
    resolveHandles: badges,
    xapTotals,
    xapPostTotals,
    forgetXap,
    xmrUsd,
    xmrbioResolve,
    verify,
    /** cached badges are out of date (a new directory build, or the directory dropped) */
    async clearBadges() {
      (await loadCaches()).badges.clear();
      persistCaches();
    },
    async dropBadge(handle: string) {
      (await loadCaches()).badges.delete(handle);
      persistCaches();
    },
    /** a tab closed: its buckets go */
    dropRateKey(key: RateKey) {
      buckets.delete(key);
      xapBuckets.delete(key);
    },
    /** pending cache writes are dropped — at most the last second's (Ripley: the X window closed) */
    stop() {
      clearTimeout(persistTimer);
      clearTimeout(xapPersistTimer);
    },
  };
}
