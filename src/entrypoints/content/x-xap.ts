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

/** The tweet's own action bar: the group with X's reply button and the share button last. */
export function actionBar(article: Element): Element | null {
  const groups = [...article.querySelectorAll('[role="group"]')].filter((g) => g.closest('article[data-testid="tweet"]') === article);
  for (const g of groups.reverse()) {
    const share = g.lastElementChild?.querySelector('button[aria-haspopup="menu"]:not([data-testid])');
    if (share && g.querySelector('[data-testid="reply"]')) return g;
  }
  return null;
}

function moneroIcon(like: Element | null): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', MONERO_VIEWBOX);
  svg.setAttribute('aria-hidden', 'true');
  if (like?.getAttribute('class')) svg.setAttribute('class', like.getAttribute('class')!);
  const outer = document.createElementNS(SVG_NS, 'g');
  outer.setAttribute('transform', MONERO_OUTER);
  // the symbol without its white disc, in X's icon colour
  for (const [transform, d] of MONERO_PARTS.slice(1)) {
    const g = document.createElementNS(SVG_NS, 'g');
    g.setAttribute('transform', transform);
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    path.setAttribute('fill', 'currentColor');
    g.append(path);
    outer.append(g);
  }
  svg.append(outer);
  return svg;
}

/** What the button's counter shows: the verified total, else the claimed one marked "~", else nothing. Never both summed. */
function shownTotal(totals?: XapTotals | null): { text: string; label: string } | null {
  if (!totals) return null;
  const v = parseXmr(totals.verified);
  if (v) return { text: shortXmr(v), label: `ɱ ${totals.verified} verified` };
  const c = parseXmr(totals.claimed);
  if (c) return { text: `~${shortXmr(c)}`, label: `~ɱ ${totals.claimed} claimed by ${totals.claimedTippers} tipper${totals.claimedTippers === 1 ? '' : 's'}, not confirmed` };
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

export const xapLabel = (handle: string, totals?: XapTotals | null) => {
  const shown = shownTotal(totals);
  return `Xap @${handle} (Monero tip)${shown ? `, ${shown.label}` : ''}`;
};

/** This tweet's own Xap button, never one in another tweet's bar. */
export const ownXap = (article: Element) => actionBar(article)?.querySelector<HTMLElement>(`:scope > ${XAP_SELECTOR}`) ?? null;

/** Shows the verified total, else the claimed one as a rough "~" figure, or nothing. */
export function setXapCount(wrap: Element, handle: string, totals?: XapTotals | null) {
  const btn = wrap.querySelector('button');
  const count = wrap.querySelector(`[${XAP_ATTR}="xap-count"]`);
  if (count) count.textContent = shownTotal(totals)?.text ?? '';
  btn?.setAttribute('aria-label', xapLabel(handle, totals));
  if (btn) btn.title = xapLabel(handle, totals);
}

/** Puts a Xap button before the share button; null if the bar isn't shaped as expected. */
export function insertXap(article: Element, opts: { handle: string; key: string; pubkey?: string; onClick: () => void }): HTMLElement | null {
  const bar = actionBar(article);
  const reply = bar?.querySelector('[data-testid="reply"]');
  const template = reply?.parentElement;
  if (!bar || !reply || !template || template.parentElement !== bar || !bar.lastElementChild) return null;
  const wrap = template.cloneNode(true) as HTMLElement;
  // none of X's ids or data attributes, so nothing of X's treats it as a reply button
  for (const el of [wrap, ...wrap.querySelectorAll('*')]) {
    for (const a of [...el.attributes]) if (a.name === 'id' || a.name.startsWith('data-')) el.removeAttribute(a.name);
  }
  wrap.setAttribute(XAP_ATTR, 'xap');
  wrap.dataset.key = opts.key;
  if (opts.pubkey) wrap.dataset.pubkey = opts.pubkey;
  const btn = wrap.querySelector('button')!;
  for (const a of ['id', 'aria-pressed', 'aria-haspopup', 'aria-expanded', 'aria-label', 'title']) btn.removeAttribute(a);
  btn.type = 'button';
  const svg = btn.querySelector('svg');
  svg?.replaceWith(moneroIcon(svg));
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
  setXapCount(wrap, opts.handle);
  bar.insertBefore(wrap, bar.lastElementChild);
  return wrap;
}
