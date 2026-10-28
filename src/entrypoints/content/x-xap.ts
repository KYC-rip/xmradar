import { MONERO_OUTER, MONERO_PARTS, MONERO_VIEWBOX } from '../../identity/badge-look';
import type { XapTotals } from '../../messaging';
import { parseXmr, shortXmr } from '../../xap/amount';

/**
 * The Xap button in a tweet's action bar (PLAN-XAP): a clone of X's reply button, so it gets X's
 * size, spacing and hover circle, cleaned of X's ids and labels, with the one-colour Monero symbol.
 */

export const XAP_ATTR = 'data-xmradar';
export const XAP_SELECTOR = `[${XAP_ATTR}="xap"]`;
const ORANGE = '#f26822';
const ORANGE_BACKDROP = 'rgba(242, 104, 34, 0.1)';
const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * The post's own action bars: groups with X's reply button and the share button last. Most tweets have
 * one; an X Article on its own page has two (under the title and at the end), and each gets a Xap button.
 */
export function actionBars(article: Element): Element[] {
  // on a tweet's page, X nests the article body (and its top bar) in an article of its own inside the
  // tweet, so a bar belongs to its nearest tweet; on the article reading page there is no tweet around it
  const owner = (g: Element) => g.closest('article[data-testid="tweet"]') ?? g.closest('article');
  return [...article.querySelectorAll('[role="group"]')].filter(
    (g) => owner(g) === article && !!g.querySelector('[data-testid="reply"]') && !!g.lastElementChild?.querySelector('button[aria-haspopup="menu"]:not([data-testid])'),
  );
}

export const actionBar = (article: Element): Element | null => actionBars(article).at(-1) ?? null;

function moneroIcon(like: Element | null): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', MONERO_VIEWBOX);
  svg.setAttribute('aria-hidden', 'true');
  if (like?.getAttribute('class')) svg.setAttribute('class', like.getAttribute('class')!);
  const outer = document.createElementNS(SVG_NS, 'g');
  outer.setAttribute('transform', MONERO_OUTER);
  for (const [transform, d] of MONERO_PARTS) {
    const g = document.createElementNS(SVG_NS, 'g');
    g.setAttribute('transform', transform);
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    g.append(path);
    outer.append(g);
  }
  svg.append(outer);
  paintIcon(svg, false);
  return svg;
}

/**
 * Plain: the symbol without its white disc, in X's icon colour, like X's other buttons. Coloured: the
 * real Monero logo, so tipped tweets stand out in a timeline.
 */
function paintIcon(svg: SVGSVGElement, coloured: boolean) {
  svg.querySelectorAll('path').forEach((path, i) => {
    const [, , fill] = MONERO_PARTS[i]!;
    if (i === 0) path.style.display = coloured ? '' : 'none';
    path.setAttribute('fill', coloured ? fill : 'currentColor');
  });
}

// posts and people whose logo already flipped on this page: a coin flip is a hello, not a loop on every scroll
const flipped = new Set<string>();
const calm = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** What the button's counter shows: the verified total, else the claimed one marked "~", else nothing. Never both summed. */
function shownTotal(totals?: XapTotals | null, post = false): { text: string; label: string } | null {
  if (!totals) return null;
  const on = post ? ' on this post' : '';
  const v = parseXmr(totals.verified);
  if (v) return { text: shortXmr(v), label: `ɱ ${totals.verified} verified${on}` };
  const c = parseXmr(totals.claimed);
  if (c) return { text: `~${shortXmr(c)}`, label: `~ɱ ${totals.claimed} claimed by ${totals.claimedTippers} tipper${totals.claimedTippers === 1 ? '' : 's'}${on}, not confirmed` };
  return null;
}

/** The profile badge's tooltip line: verified and claimed as separate figures, or nothing yet. */
export function xapSummary(handle: string, totals?: XapTotals | null): string {
  if (!totals) return '';
  const tippers = (n: number) => `${n} tipper${n === 1 ? '' : 's'}`;
  const parts = [
    parseXmr(totals.verified) ? `ɱ ${shortXmr(parseXmr(totals.verified)!)} verified (${tippers(totals.verifiedTippers)})` : '',
    parseXmr(totals.claimed) ? `~ɱ ${shortXmr(parseXmr(totals.claimed)!)} claimed (${tippers(totals.claimedTippers)}, not confirmed by @${handle})` : '',
  ].filter(Boolean);
  return parts.length ? `Xaps: ${parts.join(' · ')}` : 'No Xaps yet';
}

export const xapLabel = (handle: string, totals?: XapTotals | null, post = false) => {
  const shown = shownTotal(totals, post);
  return `Xap ${post ? 'this post by ' : ''}@${handle} (Monero tip)${shown ? `, ${shown.label}` : ''}`;
};

/** This post's own Xap buttons, one per action bar, never one in another tweet's bar. */
export const ownXaps = (article: Element) => actionBars(article).flatMap((bar) => [...bar.querySelectorAll<HTMLElement>(`:scope > ${XAP_SELECTOR}`)]);
export const ownXap = (article: Element) => ownXaps(article)[0] ?? null;

/** Shows the verified total, else the claimed one as a rough "~" figure, or nothing; `post`: the figure is that post's. */
export function setXapCount(wrap: Element, handle: string, totals?: XapTotals | null, post = false) {
  const btn = wrap.querySelector('button');
  const count = wrap.querySelector(`[${XAP_ATTR}="xap-count"]`);
  const shown = shownTotal(totals, post);
  if (count) count.textContent = shown?.text ?? '';
  // any Xaps: the coloured logo, and the first time on this page, one coin flip
  const svg = wrap.querySelector<SVGSVGElement>(`[${XAP_ATTR}="xap-icon"]`);
  if (svg) {
    paintIcon(svg, !!shown);
    const key = (wrap as HTMLElement).dataset?.post ?? (wrap as HTMLElement).dataset?.pubkey ?? '';
    if (shown && key && !flipped.has(key)) {
      flipped.add(key);
      // bounded: on a very long timeline the oldest posts may flip again, which is harmless
      if (flipped.size > 1000) flipped.delete(flipped.values().next().value!);
      if (!calm()) svg.animate?.([{ transform: 'rotateY(0deg)' }, { transform: 'rotateY(360deg)' }], { duration: 700, easing: 'ease-out' });
    }
  }
  btn?.setAttribute('aria-label', xapLabel(handle, totals, post));
  if (btn) btn.title = xapLabel(handle, totals, post);
}

export interface XapOpts {
  handle: string;
  key: string;
  pubkey?: string;
  post?: string;
  onClick: () => void;
}

/** Puts a Xap button before the share button in each of the post's bars without one; returns the first, or null. */
export function insertXap(article: Element, opts: XapOpts): HTMLElement | null {
  const added = actionBars(article)
    .filter((bar) => !bar.querySelector(`:scope > ${XAP_SELECTOR}`))
    .map((bar) => insertInBar(bar, opts))
    .filter((el): el is HTMLElement => !!el);
  return added[0] ?? ownXap(article);
}

function insertInBar(bar: Element, opts: XapOpts): HTMLElement | null {
  const reply = bar.querySelector('[data-testid="reply"]');
  const template = reply?.parentElement;
  if (!reply || !template || template.parentElement !== bar || !bar.lastElementChild) return null;
  const wrap = template.cloneNode(true) as HTMLElement;
  // none of X's ids or data attributes, so nothing of X's treats it as a reply button
  for (const el of [wrap, ...wrap.querySelectorAll('*')]) {
    for (const a of [...el.attributes]) if (a.name === 'id' || a.name.startsWith('data-')) el.removeAttribute(a.name);
  }
  wrap.setAttribute(XAP_ATTR, 'xap');
  wrap.dataset.key = opts.key;
  wrap.dataset.handle = opts.handle;
  if (opts.pubkey) wrap.dataset.pubkey = opts.pubkey;
  if (opts.post) wrap.dataset.post = opts.post;
  const btn = wrap.querySelector('button')!;
  for (const a of ['id', 'aria-pressed', 'aria-haspopup', 'aria-expanded', 'aria-label', 'title']) btn.removeAttribute(a);
  btn.type = 'button';
  const svg = btn.querySelector('svg');
  const icon = moneroIcon(svg);
  icon.setAttribute(XAP_ATTR, 'xap-icon');
  svg?.replaceWith(icon);
  // X's counter span keeps its classes; its contents become ours
  const counter = btn.querySelector('span');
  if (counter) {
    counter.replaceChildren();
    counter.setAttribute(XAP_ATTR, 'xap-count');
  }
  // X sets the icon colour inline on the button's first div, and hovers by colouring it and the
  // round backdrop behind the icon; a clone gets none of X's hover handling, so do the same here
  const tone = btn.firstElementChild instanceof HTMLElement ? btn.firstElementChild : btn;
  const backdrop = btn.querySelector('svg')?.previousElementSibling;
  const rest = tone.style.color;
  const restBackdrop = backdrop instanceof HTMLElement ? backdrop.style.backgroundColor : '';
  const tint = (on: boolean) => {
    tone.style.color = on ? ORANGE : rest;
    if (backdrop instanceof HTMLElement) backdrop.style.backgroundColor = on ? ORANGE_BACKDROP : restBackdrop;
  };
  btn.addEventListener('pointerenter', () => tint(true));
  btn.addEventListener('pointerleave', () => tint(document.activeElement === btn));
  btn.addEventListener('focus', () => tint(true));
  btn.addEventListener('blur', () => tint(false));
  btn.addEventListener('click', (e) => {
    // the tweet itself is a link; don't let X navigate
    e.preventDefault();
    e.stopPropagation();
    opts.onClick();
  });
  setXapCount(wrap, opts.handle, null, !!opts.post);
  bar.insertBefore(wrap, bar.lastElementChild);
  return wrap;
}
