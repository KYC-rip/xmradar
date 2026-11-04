import type { ContentScriptContext } from 'wxt/utils/content-script-context';
import { ownStatusId } from '../../extractors/x';
import { syncedLink, type SyncedPosts } from '../../nostr/synced';
import { settingsItem, syncedMarkOn, syncedPostsItem } from '../../settings';

/**
 * A small "Nostr ✓" on posts copied to Nostr (PLAN-SYNCEDMARK), top right of the post, in front of
 * Grok's button (or X's "More" when there's no Grok). Its own open shadow root, so X's styles stay out
 * and quote pictures can hide it (OVERLAYS). Nothing is fetched; the map is local.
 */

export const SYNCED_TAG = 'xmradar-synced';
const TWEET = 'article[data-testid="tweet"]';
const STYLE =
  ':host{all:initial;display:inline-flex;align-items:center;margin-right:4px}' +
  'a{font:600 12px/1 system-ui,-apple-system,sans-serif;color:#8e5cf7;background:rgba(142,92,247,.12);' +
  'border-radius:999px;padding:4px 8px;text-decoration:none;white-space:nowrap}a:hover{background:rgba(142,92,247,.22)}';

/**
 * The row holding the post's own Grok and "More" buttons: the first box up from "More" that holds
 * something besides it (X wraps each button on its own). Null for a quoted post, or with no "More".
 */
export function topRightRow(article: Element): Element | null {
  const caret = [...article.querySelectorAll('[data-testid="caret"]')].find((c) => c.closest(TWEET) === article);
  let box = caret?.parentElement ?? null;
  while (box && box !== article && box.childElementCount < 2) box = box.parentElement;
  return box && box !== article ? box : null;
}

export function makeMark(doc: Document, id: string, href: string, at: number): HTMLElement {
  const host = doc.createElement(SYNCED_TAG);
  host.dataset.status = id;
  host.dataset.href = href;
  host.dataset.at = String(at);
  const root = host.attachShadow({ mode: 'open' });
  const style = doc.createElement('style');
  style.textContent = STYLE;
  const a = doc.createElement('a');
  a.textContent = 'Nostr ✓';
  Object.assign(a, { href, target: '_blank', rel: 'noopener noreferrer' });
  a.title = `Copied to Nostr ${new Date(at).toLocaleString()}. Opens the copy.`;
  // X opens the post on any click inside it; this one is only for the link
  a.addEventListener('click', (e) => e.stopPropagation());
  root.append(style, a);
  return host;
}

/** Puts marks on the copied posts in `doc` and takes them off the others. */
export function markPosts(doc: Document, synced: SyncedPosts) {
  for (const article of doc.querySelectorAll(TWEET)) {
    const id = ownStatusId(article);
    const entry = id ? synced[id] : undefined;
    const href = entry ? syncedLink(entry) : null;
    const row = topRightRow(article);
    // the one mark this post should have: in its row, for this copy (a post copied again gets the new one)
    const current = (m: HTMLElement) => !!href && m.parentElement === row && m.dataset.status === id && m.dataset.href === href && m.dataset.at === String(entry!.at);
    let kept = false;
    for (const m of article.querySelectorAll<HTMLElement>(SYNCED_TAG)) {
      if (m.closest(TWEET) !== article) continue;
      if (!kept && current(m)) kept = true;
      else m.remove();
    }
    if (href && row && !kept) row.prepend(makeMark(doc, id!, href, entry!.at));
  }
}

const clearMarks = (doc: Document) => doc.querySelectorAll(SYNCED_TAG).forEach((m) => m.remove());

export function startSyncedMarks(ctx: ContentScriptContext, doc = document) {
  let on = false;
  let synced: SyncedPosts = {};
  let observer: MutationObserver | null = null;
  let queued = false;
  const run = () => {
    queued = false;
    if (on && ctx.isValid) markPosts(doc, synced);
  };
  const schedule = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(run);
  };
  const ours = (n: Node) => n instanceof Element && n.localName === SYNCED_TAG;
  const apply = () => {
    if (on && !observer) {
      observer = new MutationObserver((records) => {
        // our own insertions don't need another pass; a mark X took away does
        if (records.every((r) => r.removedNodes.length === 0 && [...r.addedNodes].every(ours))) return;
        schedule();
      });
      observer.observe(doc.body, { childList: true, subtree: true });
    } else if (!on && observer) {
      observer.disconnect();
      observer = null;
    }
    if (on) schedule();
    else clearMarks(doc);
  };
  void Promise.all([settingsItem.getValue(), syncedPostsItem.getValue()]).then(([s, m]) => {
    on = syncedMarkOn(s);
    synced = m ?? {};
    apply();
  });
  const unwatchSettings = settingsItem.watch((s) => {
    on = syncedMarkOn(s);
    apply();
  });
  const unwatchSynced = syncedPostsItem.watch((m) => {
    synced = m ?? {};
    if (on) schedule();
  });
  ctx.onInvalidated(() => {
    unwatchSettings();
    unwatchSynced();
    observer?.disconnect();
    clearMarks(doc);
  });
}
