import type { ContentScriptContext } from 'wxt/utils/content-script-context';
import { badgeLook, mountBadge, type BadgeLook } from '../../identity/badge-look';
import { PendingQueue } from '../../identity/bucket';
import { normalizeHandle } from '../../identity/envelope';
import { xapEntry, xoCountOf, xoKey, xoPostsOf, type Badge } from '../../identity/resolve';
import { postAvatar, profileAvatar, removeRings, setRing } from './x-xo-ring';
import { articleViewSlot, hoverCardSlot, pinnedPost, profileClaimScope, profileHeader, profileSlot, tweetSlot, userCellSlot, type BadgeSlot } from '../../identity/x-handle';
import { emptyClaim, parseClaim, type ClaimPlace } from '../../identity/xclaims';
import { sendToBackground, type XapTotals } from '../../messaging';
import { directoryStatusItem, myHandleItem, pubkeyItem, xClaimsChangedItem, xClaimsOn, xmrSettingsItem, xoButtonOn, xoCountsItem, xoRingsOn, xoSentItem, xoSoundOn } from '../../settings';
import { storage } from 'wxt/utils/storage';
import { XO_SELECTOR, xoManager } from './x-xo';
import { openTip } from './tip';
import { XAP_SELECTOR, actionBars, insertXap, ownXaps, setXapCount, xapSummary } from './x-xap';
import { parsePostKey, postKey } from '../../xap/post';
import { xapTtl } from '../../xap/ttl';

const HOST_TAG = 'xmradar-badge';
const BATCH_DELAY_MS = 750;
const PENDING_RETRY_MS = 1500;
const MAX_PER_CALL = 200;
// same TTLs as the background cache, so long-open tabs pick up changes
const BADGE_TTL_MS = 6 * 3600_000;
const NO_BADGE_TTL_MS = 3600_000;
const SCROLL_RESCAN_MS = 500;
// a profile is read once it has settled; a pinned post must stay this long before it counts (X2)
const CLAIMS_DELAY_MS = 1000;
const PINNED_STAY_MS = 1000;
// a complete profile header with no post under it for this long has no pinned post (no posts, or protected)
const NO_POSTS_MS = 5000;

export function startBadges(ctx: ContentScriptContext) {
  const results = new Map<string, { badge: Badge; at: number }>();
  const lookup = (handle: string) => {
    const key = normalizeHandle(handle);
    const hit = results.get(key);
    if (hit && Date.now() - hit.at < (hit.badge.primary ? BADGE_TTL_MS : NO_BADGE_TTL_MS)) return hit.badge;
    results.delete(key);
    return undefined;
  };
  const queue = new PendingQueue(500);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inflight = false;
  let enabled = false;
  let observer: MutationObserver | null = null;
  let look: BadgeLook = badgeLook(null);
  let discovery = false;
  // xo rings and counts (PLAN-XORINGS): from the directory, on unless switched off
  let rings = true;
  const xoShown = (b: Badge | null | undefined) => (rings ? xoCountOf(b) : 0);
  // others' posts' counts from xmr.bio (PLAN-XOPOSTS): the same switch
  const xoPublic = (b: Badge | null | undefined, statusId: string) => (rings ? xoPostsOf(b, statusId) : []);
  const removeAll = () => {
    for (const host of document.querySelectorAll(`${HOST_TAG}, ${XAP_SELECTOR}, ${XO_SELECTOR}`)) host.remove();
    removeRings();
  };
  /** the ring on this slot's avatar: a post's author, or the profile header's own */
  const ringFor = (slot: BadgeSlot, badge: Badge | null | undefined) => {
    if (slot.article) {
      const av = postAvatar(slot.article);
      if (av) setRing(av, slot.key, badge?.primary ? xoShown(badge) : 0);
    } else if (slot.key.startsWith('profile:')) {
      const av = profileAvatar(document, slot.handle);
      if (av) setRing(av, slot.key, badge?.primary ? xoShown(badge) : 0);
    }
  };

  // xo (PLAN-MONEROLIKE): the buttons follow the switch, the user's sent xos and their own posts' counts
  const xoSeenItem = storage.defineItem<Record<string, number>>('local:xoSeen', { fallback: {} });
  const xo = xoManager({ on: false, me: null, sent: {}, counts: {}, seen: {} }, (seen) => void xoSeenItem.setValue(seen).catch(() => {}));
  const keyPrefix = (pk: string | null | undefined) => (pk && /^[0-9a-f]{64}$/.test(pk) ? pk.slice(0, 16) : undefined);
  void Promise.all([xmrSettingsItem.getValue(), myHandleItem.getValue(), xoSentItem.getValue(), xoCountsItem.getValue(), xoSeenItem.getValue(), pubkeyItem.getValue()]).then(([s, me, sent, counts, seen, pk]) =>
    xo.update({ on: xoButtonOn(s), alsoLike: s.xoAlsoLike === true, sound: xoSoundOn(s), me, sent, counts, seen, myKey: keyPrefix(pk) }),
  );
  const unwatchXo = [
    xmrSettingsItem.watch((s, old) => {
      xo.update({ on: xoButtonOn(s), alsoLike: s.xoAlsoLike === true, sound: xoSoundOn(s) });
      // switched back on: the posts already on screen get their buttons now, not at the next redraw
      if (xoButtonOn(s) && !xoButtonOn(old) && observer) scan(document);
    }),
    myHandleItem.watch((me) => xo.update({ me })),
    pubkeyItem.watch((pk) => xo.update({ myKey: keyPrefix(pk) })),
    xoSentItem.watch((sent) => xo.update({ sent: sent ?? {} })),
    xoCountsItem.watch((counts) => xo.update({ counts: counts ?? {} })),
  ];
  ctx.onInvalidated(() => {
    unwatchXo.forEach((u) => u());
    xo.stop();
  });
  /** one handle's badges and Xap buttons; slot keys end in `:<handle>` */
  const removeFor = (handle: string) => {
    for (const el of document.querySelectorAll<HTMLElement>(`${HOST_TAG}, ${XAP_SELECTOR}`)) if (el.dataset.key?.endsWith(`:${handle}`)) el.remove();
    for (const el of document.querySelectorAll<HTMLElement>(XO_SELECTOR)) if (el.dataset.handle?.toLowerCase() === handle.toLowerCase()) el.remove();
  };

  // X self-claims (PLAN-XCLAIMS): what the profile you're on shows in its bio, Website field and pinned
  // post, read from the page and handed to the background; only a change is sent again
  let claimsOn = false;
  const claimsSent = new Map<string, string>();
  let claimsTimer: ReturnType<typeof setTimeout> | undefined;
  let pinnedSeen: { el: Element; sig: string; at: number } | null = null;
  function scheduleClaims(ms = CLAIMS_DELAY_MS) {
    // at most one read a second, and only on what could be a profile
    if (!claimsOn || !enabled || claimsTimer || !/^\/[A-Za-z0-9_]{1,15}(?:\/|$)/.test(location.pathname)) return;
    claimsTimer = setTimeout(() => {
      claimsTimer = undefined;
      readClaims();
    }, ms);
  }
  function report(handle: string, place: ClaimPlace, text: string | null, tweetId?: string) {
    const parsed = text == null ? null : parseClaim(text, place);
    const claim = emptyClaim(parsed) ? null : parsed;
    const key = `${handle.toLowerCase()}:${place}`;
    const sig = JSON.stringify([claim, tweetId ?? null]);
    if (claimsSent.get(key) === sig) return;
    claimsSent.set(key, sig);
    // a lost message is sent again on the next look
    sendToBackground({ type: 'x-claims-seen', handle, place, claim, ...(tweetId ? { tweetId } : {}) }).catch(() => claimsSent.delete(key));
  }
  function readClaims() {
    if (!enabled || !claimsOn || document.hidden) return;
    const scope = profileClaimScope(document, location);
    if (!scope) return;
    // only a header rendered in full can say a bio or Website is gone
    if (scope.bio) report(scope.handle, 'bio', scope.bio.text);
    if (scope.url) report(scope.handle, 'url', scope.url.text);
    const pin = pinnedPost(document, location, scope.handle);
    if (!pin) {
      if (!scope.bio || !/^\/[A-Za-z0-9_]{1,15}\/?$/.test(location.pathname)) return;
      const none = `${scope.handle}:none`;
      if (pinnedSeen?.sig !== none) {
        pinnedSeen = { el: document.body, sig: none, at: Date.now() };
        scheduleClaims(NO_POSTS_MS + 100);
      } else if (Date.now() - pinnedSeen.at >= NO_POSTS_MS) report(scope.handle, 'pinned', null);
      return;
    }
    const sig = `${scope.handle}:${pin.tweetId ?? ''}:${pin.text ?? ''}`;
    if (pinnedSeen?.el !== pin.article || pinnedSeen.sig !== sig) {
      pinnedSeen = { el: pin.article, sig, at: Date.now() };
      scheduleClaims(PINNED_STAY_MS + 100);
    } else if (Date.now() - pinnedSeen.at >= PINNED_STAY_MS) report(scope.handle, 'pinned', pin.text, pin.tweetId);
  }

  const isOurs = (n: Node) => n instanceof Element && (n.localName === HOST_TAG || n.matches(XAP_SELECTOR) || n.matches(XO_SELECTOR));

  // Xap totals for the action-bar counts: asked for in batches, only with relay discovery on
  const totals = new Map<string, { t: XapTotals; at: number }>();
  const totalsQueue = new PendingQueue(500);
  const postQueue = new PendingQueue(500);
  let totalsTimer: ReturnType<typeof setTimeout> | undefined;
  const cachedTotals = (pk: string) => {
    const hit = totals.get(pk);
    // as long as the background keeps it; this only spares it repeated messages
    return hit && Date.now() - hit.at < xapTtl(hit.t) ? hit.t : undefined;
  };
  // a profile badge's button sits in a closed shadow root, so keep it by its host
  const pillButtons = new WeakMap<HTMLElement, HTMLElement>();
  // keys: a bare pubkey for a profile total, postKey(pubkey, id) for a post figure; buttons on a
  // post show only that post's figure, never the profile total (NKIP-0002 counting step 8)
  const showTotals = (key: string, t: XapTotals) => {
    for (const el of document.querySelectorAll<HTMLElement>(XAP_SELECTOR)) {
      const own = el.dataset.post && el.dataset.pubkey ? postKey(el.dataset.pubkey, el.dataset.post) : el.dataset.pubkey;
      if (own === key) setXapCount(el, el.dataset.handle ?? '', t, !!el.dataset.post);
    }
    for (const host of document.querySelectorAll<HTMLElement>(`${HOST_TAG}[data-pubkey]`)) {
      const btn = pillButtons.get(host);
      if (host.dataset.pubkey !== key || !btn) continue;
      const label = `Accepts Monero — tip @${host.dataset.handle}\n${xapSummary(host.dataset.handle ?? '', t)}`;
      btn.title = label;
      btn.setAttribute('aria-label', label.replace('\n', '. '));
    }
  };
  const keep = (key: string, t: XapTotals) => {
    totals.delete(key);
    totals.set(key, { t, at: Date.now() });
    // oldest first: keep a long timeline from growing it without bound
    if (totals.size > 1000) totals.delete(totals.keys().next().value!);
    showTotals(key, t);
  };
  /** a profile total (bare pubkey) or a post figure (postKey) */
  function wantTotals(key: string) {
    const hit = cachedTotals(key);
    if (hit) return showTotals(key, hit);
    if (!discovery) return;
    (key.includes(':') ? postQueue : totalsQueue).add([key]);
    totalsTimer ??= setTimeout(() => void flushTotals(), BATCH_DELAY_MS);
  }
  async function flushTotals() {
    totalsTimer = undefined;
    if (!enabled || !discovery || (!totalsQueue.size && !postQueue.size) || document.hidden) return;
    const recipients = totalsQueue.take(50);
    const posts = postQueue.take(50).map(parsePostKey);
    // both at once, so a slow profile batch doesn't hold up the post figures; counts are optional, and
    // a failed batch comes back with the next sighting
    await Promise.all([
      recipients.length &&
        sendToBackground({ type: 'xap-totals', recipients }).then((res) => {
          for (const [pk, t] of res.totals) keep(pk, t);
          if (res.pending.length) totalsQueue.add(res.pending);
        }, () => {}),
      posts.length &&
        sendToBackground({ type: 'xap-post-totals', posts }).then((res) => {
          for (const [key, t] of res.totals) keep(key, t);
          if (res.pending.length) postQueue.add(res.pending.map((p) => postKey(p.pubkey, p.id)));
        }, () => {}),
    ]);
    if (totalsQueue.size || postQueue.size) totalsTimer ??= setTimeout(() => void flushTotals(), PENDING_RETRY_MS);
  }

  /** The Xap button: in the action bar, for tweets by an author with a badge. */
  function applyXap(slot: BadgeSlot & { article: Element }, badge: Badge) {
    // every bar of the post has this post's button (an X Article page has two), or they're redrawn
    const entry = xapEntry(badge);
    const pk = entry?.pubkey;
    // a tweet with a status id gets a post Xap (R15), bound to its author's proven key (R14)
    const post = pk && slot.statusId ? slot.statusId : undefined;
    const existing = ownXaps(slot.article);
    if (existing.length && existing.length === actionBars(slot.article).length && existing.every((e) => e.dataset.key === slot.key)) {
      if (slot.statusId) xo.place(slot.article, slot.statusId, xoKey(badge), slot.handle, xoPublic(badge, slot.statusId));
      return;
    }
    for (const e of existing) e.remove();
    const key = pk ? (post ? postKey(pk, post) : pk) : undefined;
    const el = insertXap(slot.article, {
      handle: slot.handle,
      key: slot.key,
      pubkey: pk,
      post,
      onClick: () => {
        const now = lookup(slot.handle) ?? badge;
        void openTip(ctx, slot.handle, now, {
          xap: true,
          post,
          totals: key ? cachedTotals(key) : undefined,
          // the popup's fresh figures show on the button right away
          onTotals: (t) => key && keep(key, t),
          onProfileTotals: (t) => pk && keep(pk, t),
          onPublished: () => {
            // the next figure comes from the relays
            for (const k of new Set([key, pk])) {
              if (!k) continue;
              totals.delete(k);
              wantTotals(k);
            }
          },
        });
      },
    });
    if (!el) return;
    // the xo goes right after the Xap: to the author's key when one is known, else to their handle (PLAN-XOREACH)
    if (slot.statusId) xo.place(slot.article, slot.statusId, xoKey(badge), slot.handle, xoPublic(badge, slot.statusId));
    if (key) wantTotals(key);
  }

  function insert(slot: BadgeSlot, badge: Badge) {
    const host = document.createElement(HOST_TAG);
    host.dataset.key = slot.key;
    const btn = mountBadge(host, look, slot.handle, xoShown(badge));
    btn.addEventListener('click', (e) => {
      // the tweet itself is a link; don't let X navigate
      e.preventDefault();
      e.stopPropagation();
      void openTip(ctx, slot.handle, lookup(slot.handle) ?? badge);
    });
    slot.anchor.append(host);
    // the badge's tooltip carries the account's Xap totals
    const pk = xapEntry(badge)?.pubkey;
    if (!pk) return;
    host.dataset.pubkey = pk;
    host.dataset.handle = slot.handle;
    pillButtons.set(host, btn);
    wantTotals(pk);
  }

  function apply(slot: BadgeSlot) {
    const badge = lookup(slot.handle);
    if (badge !== undefined) ringFor(slot, badge);
    if (slot.article) {
      const pill = slot.pill ? slot.anchor.querySelector<HTMLElement>(`:scope > ${HOST_TAG}`) : null;
      // a recycled tweet node may still hold another author's button and pill
      if (!badge?.primary) {
        for (const e of [...ownXaps(slot.article), ...slot.article.querySelectorAll(XO_SELECTOR)]) e.remove();
        pill?.remove();
      } else {
        // the pill after the name, as X puts its check there; the Xap stays in the action bar
        if (slot.pill && pill?.dataset.key !== slot.key) {
          pill?.remove();
          insert(slot, badge);
        }
        return applyXap(slot as BadgeSlot & { article: Element }, badge);
      }
    } else {
      const existing = slot.anchor.querySelector<HTMLElement>(`:scope > ${HOST_TAG}`);
      if (existing?.dataset.key === slot.key) return;
      existing?.remove();
      if (badge?.primary) return insert(slot, badge);
    }
    if (badge) return;
    queue.add([slot.handle]);
    schedule(BATCH_DELAY_MS);
  }

  function scan(root: ParentNode) {
    if (!enabled) return;
    const articles = new Set<Element>();
    if (root instanceof Element) {
      const outer = root.closest('article[data-testid="tweet"]');
      if (outer) articles.add(outer);
    }
    for (const a of root.querySelectorAll('article[data-testid="tweet"]')) articles.add(a);
    for (const a of articles) {
      const slot = tweetSlot(a);
      if (slot) apply(slot);
    }
    // an X Article's reading page
    const view = root instanceof Element && root.closest('article[data-testid="twitterArticleReadView"]') ? root.closest('article[data-testid="twitterArticleReadView"]') : document.querySelector('article[data-testid="twitterArticleReadView"]');
    const viewSlot = view ? articleViewSlot(view, location) : null;
    if (viewSlot) apply(viewSlot);
    const cells = new Set<Element>(root.querySelectorAll('[data-testid="UserCell"]'));
    if (root instanceof Element) {
      const cell = root.closest('[data-testid="UserCell"]');
      if (cell) cells.add(cell);
    }
    for (const c of cells) {
      const slot = userCellSlot(c);
      if (slot) apply(slot);
    }
    const cards = new Set<Element>(root.querySelectorAll('[data-testid="HoverCard"]'));
    if (root instanceof Element) {
      const card = root.closest('[data-testid="HoverCard"]');
      if (card) cards.add(card);
    }
    for (const c of cards) {
      const slot = hoverCardSlot(c);
      if (slot) apply(slot);
    }
    // the profile header only needs a document-wide lookup when it could have changed
    if (root === document || (root instanceof Element && (root.querySelector('[data-testid="UserName"]') || root.closest('[data-testid="UserName"]')))) scanProfile();
    scheduleClaims();
  }

  /** The profile header's badge, or none while the header shows another profile than the page's. */
  function scanProfile() {
    const profile = profileSlot(document, location);
    // any badge elsewhere in the header (an older place for it, or another profile's) goes
    for (const e of profileHeader(document)?.querySelectorAll(HOST_TAG) ?? []) if (e.parentElement !== profile?.anchor) e.remove();
    if (profile) apply(profile);
  }

  function schedule(ms: number) {
    if (timer || inflight) return;
    timer = setTimeout(() => {
      timer = undefined;
      void flush();
    }, ms);
  }

  async function flush() {
    if (!enabled || !queue.size || document.hidden) return;
    inflight = true;
    const handles = queue.take(MAX_PER_CALL);
    let retryPending = false;
    try {
      const res = await sendToBackground({ type: 'resolve-handles', handles });
      for (const [key, badge] of res.badges) results.set(key, { badge, at: Date.now() });
      if (res.pending.length) {
        queue.add(res.pending);
        retryPending = true;
      }
      if (res.badges.some(([, b]) => b.primary)) scan(document);
    } catch {
      // background briefly unavailable: try these handles again later
      queue.add(handles);
      retryPending = true;
    } finally {
      inflight = false;
    }
    if (queue.size) schedule(retryPending ? PENDING_RETRY_MS : BATCH_DELAY_MS);
  }

  function connect() {
    if (observer || !enabled || document.hidden) return;
    observer = new MutationObserver((records) => {
      let header = false;
      for (const r of records) {
        for (const n of r.addedNodes) {
          if (n instanceof Element && !isOurs(n)) scan(n);
        }
        // X swaps the header's text in place when moving between profiles
        const el = r.target instanceof Element ? r.target : r.target.parentElement;
        if (!header && el && !isOurs(el) && el.closest('[data-testid="UserName"]')) header = true;
      }
      if (header) scanProfile();
      // a bio or pinned post can change in place, with no new element
      scheduleClaims();
    });
    // body survives X's client-side navigation, so one observer covers every page
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    scan(document);
    if (totalsQueue.size) totalsTimer ??= setTimeout(() => void flushTotals(), BATCH_DELAY_MS);
  }

  function disconnect() {
    observer?.disconnect();
    observer = null;
  }

  function setEnabled(on: boolean) {
    enabled = on;
    if (on) return connect();
    disconnect();
    clearTimeout(timer);
    timer = undefined;
    clearTimeout(totalsTimer);
    totalsTimer = undefined;
    clearTimeout(claimsTimer);
    claimsTimer = undefined;
    removeAll();
  }

  // X recycles tweet nodes while scrolling without adding new ones, so rescan what's on screen now and then
  let scrollTimer: ReturnType<typeof setTimeout> | undefined;
  ctx.addEventListener(
    window,
    'scroll',
    () => {
      if (scrollTimer || !observer) return;
      scrollTimer = setTimeout(() => {
        scrollTimer = undefined;
        scan(document);
      }, SCROLL_RESCAN_MS);
    },
    { passive: true },
  );
  ctx.addEventListener(document, 'visibilitychange', () => (document.hidden ? disconnect() : connect()));
  // profile headers change on client-side navigation without new tweet nodes
  ctx.addEventListener(window, 'wxt:locationchange', () => {
    // each visit to a profile confirms what it shows again
    claimsSent.clear();
    pinnedSeen = null;
    scan(document);
  });

  void xmrSettingsItem.getValue().then((s) => {
    rings = xoRingsOn(s);
    look = badgeLook(s);
    discovery = s.nostrDiscovery;
    claimsOn = xClaimsOn(s);
    setEnabled(s.badgesX);
  });
  const unwatch = xmrSettingsItem.watch((s, old) => {
    if (xClaimsOn(s) !== xClaimsOn(old)) {
      claimsOn = xClaimsOn(s);
      claimsSent.clear();
      // badges merged from claims come and go with the switch
      results.clear();
      removeAll();
    }
    if (s.nostrDiscovery !== old?.nostrDiscovery) {
      // answers depend on the sources in use
      results.clear();
      totals.clear();
      removeAll();
    }
    discovery = s.nostrDiscovery;
    if (xoRingsOn(s) !== rings) {
      // badges carry the count, so they're redrawn with the rings
      rings = xoRingsOn(s);
      removeAll();
    }
    const next = badgeLook(s);
    if (next.icon !== look.icon || next.label !== look.label) {
      // redrawn from the results below, no new lookups
      look = next;
      removeAll();
    }
    setEnabled(s.badgesX);
    if (s.badgesX) scan(document);
  });
  // a new xmr.bio directory, or none: badges on screen were looked up against the old one
  const unwatchDirectory = directoryStatusItem.watch((st, old) => {
    if (st?.generatedAt === old?.generatedAt) return;
    results.clear();
    removeAll();
    if (enabled) scan(document);
  });
  // a profile's claims changed (here or in another tab): its badge is looked up again
  const unwatchClaims = xClaimsChangedItem.watch((c) => {
    if (!c || typeof c.handle !== 'string') return;
    results.delete(c.handle);
    removeFor(c.handle);
    if (enabled) scan(document);
  });
  ctx.onInvalidated(() => {
    unwatch();
    unwatchDirectory();
    unwatchClaims();
    setEnabled(false);
  });
}
