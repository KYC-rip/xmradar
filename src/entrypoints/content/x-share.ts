import { ownStatusId } from '../../extractors/x';

/**
 * "Copy to Nostr" in X's share menu (PLAN-SHAREMENU). The target is fixed by a trusted click on a
 * tweet's share button and identified by its status ID; the menu is accepted only while that button
 * is the one expanded. A page can fake the menu container, but not pick a different tweet: that
 * needs the user's own click, and the user still reviews the composer before anything is signed.
 */

const TWEET = 'article[data-testid="tweet"]';
const SHARE_BUTTON = 'button[aria-haspopup="menu"]:not([data-testid])';
const ITEM_ATTR = 'data-xmradar';
const MENU_WINDOW_MS = 2000;
const ACTION_WINDOW_MS = 10_000;
const SVG_NS = 'http://www.w3.org/2000/svg';

/** The share button a click landed on: the last button of a tweet's action bar, menu-type, untagged. */
export function shareButtonOf(target: EventTarget | null): HTMLButtonElement | null {
  const btn = target instanceof Element ? target.closest('button') : null;
  if (!btn?.matches(SHARE_BUTTON)) return null;
  const bar = btn.closest(`${TWEET} [role="group"]`);
  const buttons = bar?.querySelectorAll('button');
  return buttons && buttons[buttons.length - 1] === btn ? btn : null;
}

/** The tweet with this status ID, preferring the one around `near` (X recycles tweet nodes). */
export function findTweet(doc: Document, id: string, near?: Element | null): Element | null {
  const own = near?.closest(TWEET);
  if (own && ownStatusId(own) === id) return own;
  return [...doc.querySelectorAll(TWEET)].find((a) => ownStatusId(a) === id) ?? null;
}

/** The radar mark: a dot and two arcs. `like` lends X's size and colour classes. */
export function radarIcon(doc: Document, like: Element | null): SVGSVGElement {
  const svg = doc.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  // X's own size and colour classes
  if (like?.getAttribute('class')) svg.setAttribute('class', like.getAttribute('class')!);
  const dot = doc.createElementNS(SVG_NS, 'circle');
  dot.setAttribute('cx', '6');
  dot.setAttribute('cy', '18');
  dot.setAttribute('r', '2.25');
  dot.setAttribute('fill', 'currentColor');
  svg.append(dot);
  for (const d of ['M4 11.5a8.5 8.5 0 0 1 8.5 8.5', 'M4 5a15 15 0 0 1 15 15']) {
    const arc = doc.createElementNS(SVG_NS, 'path');
    arc.setAttribute('d', d);
    arc.setAttribute('fill', 'none');
    arc.setAttribute('stroke', 'currentColor');
    arc.setAttribute('stroke-width', '2.25');
    arc.setAttribute('stroke-linecap', 'round');
    svg.append(arc);
  }
  return svg;
}

/** A light tint on a light page, a soft white one on X's dim and dark themes. */
export function hoverTint(doc: Document): string {
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(doc.defaultView?.getComputedStyle(doc.body).backgroundColor ?? '');
  const light = !m || Number(m[1]) * 0.299 + Number(m[2]) * 0.587 + Number(m[3]) * 0.114 > 128;
  return light ? 'rgba(15, 20, 25, 0.03)' : 'rgba(231, 233, 234, 0.03)';
}

export interface ShareMenu {
  /** capture-phase click handler for the document; `trusted` is overridable for tests only */
  onClick(e: Event, trusted?: boolean): void;
  /** the tweet to copy, once; null if it's gone, stale, or a different tweet now */
  takeTarget(): Element | null;
  stop(): void;
}

export function shareMenu(doc: Document, request: () => Promise<unknown>, now = () => Date.now()): ShareMenu {
  let pending: { button: HTMLButtonElement; tweetId: string; at: number } | null = null;
  let target: { article: Element; tweetId: string; at: number } | null = null;
  let observer: MutationObserver | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const stopWatching = () => {
    observer?.disconnect();
    observer = null;
    clearTimeout(timer);
  };

  /** X's share menu, if it's open for the pending share button and shaped like the one we know. */
  function openMenu(): Element | null {
    if (!pending || now() - pending.at > MENU_WINDOW_MS) return null;
    const { button } = pending;
    if (!button.isConnected || button.getAttribute('aria-expanded') !== 'true') return null;
    // the caret or repost menu open instead (or as well): not ours to touch
    if ([...doc.querySelectorAll('[aria-haspopup="menu"][aria-expanded="true"]')].some((b) => b !== button)) return null;
    // the newest menu: an old one X left behind in #layers must not take the item
    const lists = doc.querySelectorAll('[role="menu"] [data-testid="Dropdown"]');
    const list = lists[lists.length - 1];
    const items = list ? [...list.querySelectorAll(':scope > [role="menuitem"]')] : [];
    if (items.length < 2 || !items.every((i) => i.querySelector('svg') && i.querySelector('span'))) return null;
    return list ?? null;
  }

  function addItem(list: Element) {
    if (list.querySelector(`[${ITEM_ATTR}]`)) return;
    const items = list.querySelectorAll(':scope > [role="menuitem"]');
    const last = items[items.length - 1]!;
    const item = last.cloneNode(true) as HTMLElement;
    item.setAttribute(ITEM_ATTR, 'copy-to-nostr');
    item.setAttribute('tabindex', '0');
    const oldSvg = item.querySelector('svg');
    oldSvg?.replaceWith(radarIcon(doc, oldSvg));
    const span = item.querySelector('span');
    if (span) span.textContent = 'Copy to Nostr';
    // X's own items get their hover from React handlers a copy doesn't have: tint like X does, on the
    // page's own background (light, dim or dark)
    const tint = (on: boolean) => (item.style.backgroundColor = on ? hoverTint(doc) : '');
    item.addEventListener('pointerenter', () => tint(true));
    item.addEventListener('pointerleave', () => tint(doc.activeElement === item));
    item.addEventListener('focus', () => tint(true));
    item.addEventListener('blur', () => tint(false));
    item.addEventListener('click', (e) => activate(e));
    item.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') activate(e);
    });
    list.append(item);
  }

  function activate(e: Event, trusted = e.isTrusted) {
    e.preventDefault();
    e.stopPropagation();
    if (!trusted || !pending) return;
    const { button, tweetId } = pending;
    // however long the user took, the menu still open for that button proves it's the same share
    const open = button.isConnected && button.getAttribute('aria-expanded') === 'true';
    if (!open && now() - pending.at > ACTION_WINDOW_MS) return;
    const article = findTweet(doc, tweetId, button);
    if (!article) {
      console.warn('[XMRadar] share menu: that post is no longer on the page');
      return;
    }
    // a synthetic Escape doesn't close X's menu; its own button toggles it
    if (open) button.click();
    pending = null;
    stopWatching();
    target = { article, tweetId, at: now() };
    request().catch((err) => {
      target = null;
      console.warn('[XMRadar] share menu', err);
    });
  }

  return {
    onClick(e, trusted = e.isTrusted) {
      if (!trusted) return;
      const button = shareButtonOf(e.target);
      if (!button) return;
      // a new share click restarts everything
      stopWatching();
      const tweetId = ownStatusId(button.closest(TWEET)!);
      pending = tweetId ? { button, tweetId, at: now() } : null;
      if (!pending) return;
      observer = new MutationObserver(() => {
        const list = openMenu();
        if (!list) return;
        addItem(list);
        stopWatching();
      });
      observer.observe(doc.getElementById('layers') ?? doc.body, { childList: true, subtree: true });
      // X may add the menu before it marks the button expanded: the attribute flip is a cue too
      observer.observe(button, { attributes: true, attributeFilter: ['aria-expanded'] });
      timer = setTimeout(stopWatching, MENU_WINDOW_MS);
    },
    takeTarget() {
      const t = target;
      target = null;
      if (!t || now() - t.at > ACTION_WINDOW_MS) return null;
      // the node may have been reused for another tweet since
      return t.article.isConnected && ownStatusId(t.article) === t.tweetId ? t.article : findTweet(doc, t.tweetId);
    },
    stop() {
      stopWatching();
      pending = null;
      target = null;
    },
  };
}
