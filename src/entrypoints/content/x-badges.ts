import type { ContentScriptContext } from 'wxt/utils/content-script-context';
import { badgeLook, mountBadge, type BadgeLook } from '../../identity/badge-look';
import { PendingQueue } from '../../identity/bucket';
import { normalizeHandle } from '../../identity/envelope';
import type { Badge } from '../../identity/resolve';
import { profileSlot, tweetSlot, type BadgeSlot } from '../../identity/x-handle';
import { sendToBackground } from '../../messaging';
import { xmrSettingsItem } from '../../settings';
import { openTip } from './tip';

const HOST_TAG = 'xmradar-badge';
const BATCH_DELAY_MS = 750;
const PENDING_RETRY_MS = 1500;
const MAX_PER_CALL = 200;
// same TTLs as the background cache, so long-open tabs pick up changes
const BADGE_TTL_MS = 6 * 3600_000;
const NO_BADGE_TTL_MS = 3600_000;
const SCROLL_RESCAN_MS = 500;

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
  const removeAll = () => {
    for (const host of document.querySelectorAll(HOST_TAG)) host.remove();
  };

  const isOurs = (n: Node) => n instanceof Element && n.localName === HOST_TAG;

  function insert(slot: BadgeSlot, badge: Badge) {
    const host = document.createElement(HOST_TAG);
    host.dataset.key = slot.key;
    const btn = mountBadge(host, look, slot.handle);
    btn.addEventListener('click', (e) => {
      // the tweet itself is a link; don't let X navigate
      e.preventDefault();
      e.stopPropagation();
      void openTip(ctx, slot.handle, lookup(slot.handle) ?? badge);
    });
    slot.anchor.append(host);
  }

  function apply(slot: BadgeSlot) {
    const existing = slot.anchor.querySelector<HTMLElement>(`:scope > ${HOST_TAG}`);
    if (existing?.dataset.key === slot.key) return;
    existing?.remove();
    const badge = lookup(slot.handle);
    if (badge) {
      if (badge.primary) insert(slot, badge);
      return;
    }
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
    // the profile header only needs a document-wide lookup when it could have changed
    if (root === document || (root instanceof Element && root.querySelector('[data-testid="UserName"]'))) {
      const profile = profileSlot(document, location);
      if (profile) apply(profile);
    }
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
      for (const r of records) {
        for (const n of r.addedNodes) {
          if (n instanceof Element && !isOurs(n)) scan(n);
        }
      }
    });
    // body survives X's client-side navigation, so one observer covers every page
    observer.observe(document.body, { childList: true, subtree: true });
    scan(document);
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
  ctx.addEventListener(window, 'wxt:locationchange', () => scan(document));

  void xmrSettingsItem.getValue().then((s) => {
    look = badgeLook(s);
    setEnabled(s.badgesX);
  });
  const unwatch = xmrSettingsItem.watch((s, old) => {
    if (s.nostrDiscovery !== old?.nostrDiscovery) {
      // answers depend on the sources in use
      results.clear();
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
  ctx.onInvalidated(() => {
    unwatch();
    setEnabled(false);
  });
}
