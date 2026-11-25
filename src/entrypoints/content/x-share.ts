import { ownStatusId } from '../../extractors/x';

/**
 * "Copy to Nostr" in X's share menu (PLAN-SHAREMENU). The target is fixed by a trusted click on a
 * tweet's share button and identified by its status ID.
 * - Desktop X opens `[role="menu"] [data-testid="Dropdown"]` and marks the share button `aria-expanded="true"`.
 * - Mobile X opens a bottom sheet (`[data-testid="sheetDialog"]` / `[role="dialog"]` in `#layers`) without
 *   necessarily setting `aria-expanded="true"`, so we accept only a newly added sheet appearing right after
 *   the trusted share click while no other menu button is expanded.
 */

const TWEET = 'article[data-testid="tweet"]';
const SHARE_BUTTON = 'button[aria-haspopup="menu"]:not([data-testid]), button[aria-label*="share" i]:not([data-testid])';
const SHEET_SELECTOR = '#layers [data-testid="sheetDialog"], #layers [role="dialog"]';
const ITEM_ATTR = 'data-xmradar';
const MENU_WINDOW_MS = 2000;
const SHEET_WINDOW_MS = 4000;
const ACTION_WINDOW_MS = 10_000;
const SVG_NS = 'http://www.w3.org/2000/svg';

/** The share button a click landed on: the last button of a tweet's action bar, untagged. */
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

interface MenuMatch {
  list: Element;
  items: Element[];
  sheet: Element | null;
}

/** Finds the action-row container inside a Mobile X bottom sheet (`sheetDialog` / `role="dialog"`). */
function sheetActionList(sheet: Element): { list: Element; items: Element[] } | null {
  // Never match compose, login, or search dialogs that contain form inputs.
  if (sheet.querySelector('input, textarea, [contenteditable="true"]')) return null;
  const menuItems = [...sheet.querySelectorAll('[role="menuitem"]')].filter((i) => i.querySelector('svg') && i.querySelector('span'));
  if (menuItems.length >= 2) {
    const parent = menuItems[0]!.parentElement;
    if (parent && menuItems.every((i) => i.parentElement === parent)) {
      return { list: parent, items: menuItems };
    }
  }
  // Mobile X sometimes uses `[role="button"]` or `<button>` action rows inside the sheet (excluding Cancel, which has no svg).
  const byParent = new Map<Element, Element[]>();
  for (const el of sheet.querySelectorAll('[role="button"], button')) {
    if (!el.querySelector('svg') || !el.querySelector('span')) continue;
    const p = el.parentElement;
    if (!p) continue;
    const group = byParent.get(p) ?? [];
    group.push(el);
    byParent.set(p, group);
  }
  for (const [list, items] of byParent) {
    if (items.length >= 2) return { list, items };
  }
  return null;
}

function dismissSheet(doc: Document, sheet: Element) {
  // Prefer X's Cancel button (a button inside the sheet without an icon), then backdrop / Escape.
  const cancel = [...sheet.querySelectorAll<HTMLElement>('button, [role="button"]')].find(
    (b) => !b.hasAttribute(ITEM_ATTR) && !b.querySelector('svg') && /cancel|close/i.test((b.textContent || b.getAttribute('aria-label') || '')),
  );
  if (cancel) {
    cancel.click();
    return;
  }
  const mask = doc.querySelector<HTMLElement>('#layers [data-testid="mask"]');
  if (mask) {
    mask.click();
    return;
  }
  doc.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
}

export function shareMenu(doc: Document, request: () => Promise<unknown>, now = () => Date.now()): ShareMenu {
  let pending: { button: HTMLButtonElement; tweetId: string; at: number; priorSheets: Set<Element>; sheet: Element | null } | null = null;
  let target: { article: Element; tweetId: string; at: number } | null = null;
  let observer: MutationObserver | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const stopWatching = () => {
    observer?.disconnect();
    observer = null;
    clearTimeout(timer);
  };

  /** X's share menu (desktop dropdown or mobile bottom sheet), if open for the pending share button. */
  function openMenu(): MenuMatch | null {
    if (!pending) return null;
    const elapsed = now() - pending.at;
    if (elapsed > SHEET_WINDOW_MS) return null;
    const { button, priorSheets } = pending;
    if (!button.isConnected) return null;
    // the caret or repost menu open instead (or as well): not ours to touch
    if ([...doc.querySelectorAll('[aria-haspopup="menu"][aria-expanded="true"]')].some((b) => b !== button)) return null;

    // 1. Desktop X dropdown: strictly requires `aria-expanded="true"` within MENU_WINDOW_MS (2s).
    const lists = doc.querySelectorAll('[role="menu"] [data-testid="Dropdown"]');
    const list = lists[lists.length - 1];
    if (list) {
      if (elapsed > MENU_WINDOW_MS || button.getAttribute('aria-expanded') !== 'true') return null;
      const items = [...list.querySelectorAll(':scope > [role="menuitem"]')];
      if (items.length < 2 || !items.every((i) => i.querySelector('svg') && i.querySelector('span'))) return null;
      return { list, items, sheet: null };
    }

    // 2. Mobile X bottom sheet: only a newly mounted sheet dialog in `#layers` (never an existing one).
    const sheets = [...doc.querySelectorAll(SHEET_SELECTOR)].filter((s) => !priorSheets.has(s));
    const sheet = sheets[sheets.length - 1];
    if (!sheet) return null;
    const found = sheetActionList(sheet);
    if (!found) return null;
    return { list: found.list, items: found.items, sheet };
  }

  function addItem(match: MenuMatch) {
    const { list, items, sheet } = match;
    if (list.querySelector(`[${ITEM_ATTR}]`)) return;
    const last = items[items.length - 1]!;
    const item = last.cloneNode(true) as HTMLElement;
    item.setAttribute(ITEM_ATTR, 'copy-to-nostr');
    item.setAttribute('tabindex', '0');
    const oldSvg = item.querySelector('svg');
    oldSvg?.replaceWith(radarIcon(doc, oldSvg));
    // Prefer the leaf text-bearing span so nested wrapper spans in mobile sheets stay intact.
    const spans = [...item.querySelectorAll('span')];
    const span = spans.find((s) => s.childElementCount === 0 && (s.textContent ?? '').trim().length > 0) ?? spans[0];
    if (span) span.textContent = 'Copy to Nostr';
    if (pending) pending.sheet = sheet;
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
    // Insert right after the last action row so Mobile X's Cancel button stays at the bottom.
    last.after(item);
  }

  function activate(e: Event, trusted = e.isTrusted) {
    e.preventDefault();
    e.stopPropagation();
    if (!trusted || !pending) return;
    const { button, tweetId, sheet } = pending;
    // however long the user took, the menu/sheet still open for that button proves it's the same share
    const desktopOpen = button.isConnected && button.getAttribute('aria-expanded') === 'true';
    const sheetOpen = !!sheet?.isConnected;
    if (!desktopOpen && !sheetOpen && now() - pending.at > ACTION_WINDOW_MS) return;
    const article = findTweet(doc, tweetId, button);
    if (!article) {
      console.warn('[XMRadar] share menu: that post is no longer on the page');
      return;
    }
    if (desktopOpen) button.click();
    else if (sheetOpen && sheet) dismissSheet(doc, sheet);
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
      const priorSheets = new Set(doc.querySelectorAll(SHEET_SELECTOR));
      pending = tweetId ? { button, tweetId, at: now(), priorSheets, sheet: null } : null;
      if (!pending) return;
      observer = new MutationObserver(() => {
        const match = openMenu();
        if (!match) return;
        addItem(match);
        stopWatching();
      });
      observer.observe(doc.getElementById('layers') ?? doc.body, { childList: true, subtree: true });
      // X may add the menu before it marks the button expanded: the attribute flip is a cue too
      observer.observe(button, { attributes: true, attributeFilter: ['aria-expanded'] });
      timer = setTimeout(stopWatching, SHEET_WINDOW_MS);
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
