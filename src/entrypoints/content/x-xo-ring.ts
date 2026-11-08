/**
 * The xo ring (PLAN-XORINGS): a thin Monero-orange ring around the avatar of an account Monero people sent xos,
 * as xmr.bio's directory counts them. Decorative only (the total is in the badge's text and label), it never
 * restyles the avatar: it's a separate element on the nearest ancestor that doesn't clip, so other extensions'
 * avatar overlays (Ethos draws a pill under it) are left alone. Only avatars in the main column.
 */

export const RING_ATTR = 'data-xmradar-ring';
const ORANGE = '#f26822';
const GAP = 2;
const WIDTH = 2;

const clips = (el: Element) => {
  const s = getComputedStyle(el);
  return [s.overflow, s.overflowX, s.overflowY].some((v) => v && v !== 'visible');
};

/** The nearest ancestor (up to 4 levels above the avatar) that doesn't clip, or null. */
export function ringHost(avatar: Element): HTMLElement | null {
  let el: Element | null = avatar.parentElement;
  for (let i = 0; i < 4 && el; i++, el = el.parentElement) if (!clips(el)) return el as HTMLElement;
  return null;
}

/** The avatar's own corner radius: X draws organisations' avatars as rounded squares. */
function radiusOf(avatar: Element): string {
  for (const el of [avatar, ...avatar.querySelectorAll('*')].slice(0, 12)) {
    const r = getComputedStyle(el).borderTopLeftRadius;
    if (r && r !== '0px') return r.endsWith('%') ? r : `calc(${r} + ${GAP + WIDTH}px)`;
  }
  return '9999px';
}

/** The post's author avatar, inside X's main column. */
export function postAvatar(article: Element): HTMLElement | null {
  if (!article.closest('[data-testid="primaryColumn"]')) return null;
  return article.querySelector<HTMLElement>('[data-testid="Tweet-User-Avatar"]');
}

/**
 * The profile header's avatar for `handle`, inside X's main column: X names it `UserAvatar-Container-<handle>`
 * (beside the /photo link, not in it). Not one inside a post; the widest, since small avatars share the name.
 */
export function profileAvatar(doc: Document, handle: string): HTMLElement | null {
  const col = doc.querySelector('[data-testid="primaryColumn"]');
  if (!col || !/^[A-Za-z0-9_]{1,15}$/.test(handle)) return null;
  const want = `useravatar-container-${handle.toLowerCase()}`;
  let best: HTMLElement | null = null;
  let bestW = -1;
  for (const el of col.querySelectorAll<HTMLElement>('[data-testid^="UserAvatar-Container-"]')) {
    if (el.dataset.testid?.toLowerCase() !== want || el.closest('article')) continue;
    const w = el.getBoundingClientRect().width;
    if (w > bestW) [best, bestW] = [el, w];
  }
  return best;
}

/** Which avatar each ring is for: a ring on a shared ancestor is never taken for another avatar's. */
const owners = new WeakMap<Element, Element>();
/** Hosts this module made `position: relative`, put back when their ring goes. */
const RELATIVE_ATTR = 'data-xmradar-ring-relative';

/**
 * The ring already drawn for this avatar: a direct child of one of its 4 nearest ancestors, owned by it. A ring
 * whose avatar left the page is removed on the way. Cheap: no styles read.
 */
function ringOf(avatar: Element): HTMLElement | null {
  let el: Element | null = avatar.parentElement;
  for (let i = 0; i < 4 && el; i++, el = el.parentElement) {
    for (const r of el.querySelectorAll<HTMLElement>(`:scope > [${RING_ATTR}]`)) {
      const owner = owners.get(r);
      if (owner === avatar) return r;
      if (!owner?.isConnected) dropRing(r);
    }
  }
  return null;
}

function dropRing(ring: HTMLElement) {
  const host = ring.parentElement;
  ring.remove();
  if (host?.hasAttribute(RELATIVE_ATTR) && !host.querySelector(`:scope > [${RING_ATTR}]`)) {
    host.style.position = '';
    host.removeAttribute(RELATIVE_ATTR);
  }
}

/** The ring's box: the avatar's, 2 px gap and 2 px line outside, in the host's coordinates. */
function place(ring: HTMLElement, avatar: Element, host: Element): boolean {
  const a = avatar.getBoundingClientRect();
  const h = host.getBoundingClientRect();
  if (!a.width || !a.height) return false;
  const pad = GAP + WIDTH;
  const box = { left: `${a.left - h.left - pad}px`, top: `${a.top - h.top - pad}px`, width: `${a.width + pad * 2}px`, height: `${a.height + pad * 2}px` };
  for (const [k, v] of Object.entries(box)) if (ring.style.getPropertyValue(k) !== v) ring.style.setProperty(k, v);
  return true;
}

/**
 * Puts (or removes, for count 0) the ring for this avatar. `key` redraws it when X recycles the node; on every
 * badge pass an existing ring is put back over its avatar (layout shifts, late images), with no styles read.
 */
export function setRing(avatar: HTMLElement, key: string, count: number) {
  const existing = ringOf(avatar);
  if (count <= 0) return existing && dropRing(existing);
  if (existing?.getAttribute(RING_ATTR) === key) return void place(existing, avatar, existing.parentElement!);
  if (existing) dropRing(existing);
  const host = ringHost(avatar);
  if (!host) return;
  const ring = host.ownerDocument.createElement('span');
  ring.setAttribute(RING_ATTR, key);
  ring.setAttribute('aria-hidden', 'true');
  Object.assign(ring.style, {
    position: 'absolute',
    boxSizing: 'border-box',
    border: `${WIDTH}px solid ${ORANGE}`,
    borderRadius: radiusOf(avatar),
    pointerEvents: 'none',
    zIndex: '1',
  });
  const pos = getComputedStyle(host).position;
  if (!pos || pos === 'static') {
    host.style.position = 'relative';
    host.setAttribute(RELATIVE_ATTR, '');
  }
  if (!place(ring, avatar, host)) return;
  owners.set(ring, avatar);
  host.append(ring);
}

export const removeRings = (root: ParentNode = document) => {
  for (const r of root.querySelectorAll<HTMLElement>(`[${RING_ATTR}]`)) dropRing(r);
};
