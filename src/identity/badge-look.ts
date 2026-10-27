/**
 * The tip badge, shared by the X content script and the previews under Options → Badges on X (PLAN-BADGESTYLE).
 *
 * Monero symbol: copyright (c) 2014-2018 The Monero Project, from monero-project/monero-gui
 * images/monero-vector.svg at 5265e52b8bbbdf54f25ae0142e9fbf1f2d151634 (sha256 db8919d5…10e71),
 * BSD-3-Clause; the full notice is in public/THIRD_PARTY_NOTICES.txt. getmonero.org/legal also
 * licenses the logo CC BY-SA 4.0. Paths and transforms are copied unchanged; the clipPath is
 * dropped (it covers the whole canvas). The "mono" look recolours it white without the disc.
 * Monero and the Monero symbol are trademarks of their owners; XMRadar is not affiliated with
 * or endorsed by The Monero Project.
 */

export type BadgeIcon = 'mono' | 'color' | 'none';
export interface BadgeLook {
  icon: BadgeIcon;
  label: boolean;
}

const ICONS: readonly BadgeIcon[] = ['mono', 'color', 'none'];
export const isBadgeIcon = (v: unknown): v is BadgeIcon => ICONS.includes(v as BadgeIcon);

/** The look from stored settings of any age or shape; the badge is never empty. */
export function badgeLook(x: unknown): BadgeLook {
  const o = (x && typeof x === 'object' ? x : {}) as { badgeIcon?: unknown; badgeLabel?: unknown };
  const icon = isBadgeIcon(o.badgeIcon) ? o.badgeIcon : 'mono';
  const label = icon === 'none' || typeof o.badgeLabel !== 'boolean' ? true : o.badgeLabel;
  return { icon, label };
}

export const MONERO_VIEWBOX = '0 0 6000 6000';
export const MONERO_OUTER = 'matrix(1.3333 0 0 -1.3333 0 6e3)';
/** [translate, d, fill] in source order: white disc, orange top, grey bottom */
export const MONERO_PARTS = [
  [
    'translate(4128 2250.2)',
    'm0 0c0-1037.2-840.79-1878.1-1878.1-1878.1-1037.2 0-1878 840.88-1878 1878.1 0 1037.3 840.8 1878.1 1878 1878.1 1037.3 0 1878.1-840.79 1878.1-1878.1',
    '#fff',
  ],
  [
    'translate(2250 4128.2)',
    'm0 0c-1036.9 0-1879.1-842.06-1877.8-1878 0.262-207.26 33.308-406.63 95.342-593.12h561.88v1579.9l1220.6-1220.6 1220.6 1220.6v-1579.9h561.96c62.117 186.48 95.008 385.85 95.369 593.12 1.809 1037-840.89 1877.8-1877.9 1877.8z',
    '#f36e36',
  ],
  [
    'translate(1969.3 1735.8)',
    'm0 0-532.67 532.7v-994.14h-407.26l-384.29-0.07c329.63-540.8 925.35-902.56 1604.9-902.56 679.54 0 1275.3 361.85 1605 902.65l-384.44-0.013h-407.27v994.14l-813.3-813.31-280.62 280.61z',
    '#575757',
  ],
] as const;

const SVG_NS = 'http://www.w3.org/2000/svg';

export function moneroSymbol(doc: Document, variant: 'mono' | 'color'): SVGSVGElement {
  const svg = doc.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', MONERO_VIEWBOX);
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const outer = doc.createElementNS(SVG_NS, 'g');
  outer.setAttribute('transform', MONERO_OUTER);
  // mono: no disc, so the M cut-out shows the pill underneath
  for (const [i, [transform, d, fill]] of MONERO_PARTS.entries()) {
    if (variant === 'mono' && i === 0) continue;
    const g = doc.createElementNS(SVG_NS, 'g');
    g.setAttribute('transform', transform);
    const path = doc.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    path.setAttribute('fill', variant === 'mono' ? 'currentColor' : fill);
    g.append(path);
    outer.append(g);
  }
  svg.append(outer);
  return svg;
}

export const BADGE_CSS = `
:host { flex: none; }
.badge {
  all: unset;
  vertical-align: middle;
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  gap: 3px;
  margin-left: 4px;
  height: 16px;
  border-radius: 8px;
  background: #f26822;
  color: #fff;
  font: 700 10px/16px system-ui, -apple-system, sans-serif;
  letter-spacing: 0.04em;
  cursor: pointer;
}
.pill { padding: 0 6px; }
.pill.icon { padding-left: 1px; }
.round { width: 16px; justify-content: center; padding: 0; }
.round.color { background: transparent; }
.badge svg { width: 14px; height: 14px; flex: none; }
.round svg { width: 16px; height: 16px; }
.round.mono svg { width: 12px; height: 12px; } /* inset, so the orange ring frames the white symbol */
button.badge:hover { background: #d9571a; }
button.round.color:hover { background: transparent; filter: brightness(0.92); }
button.badge:focus-visible { outline: 2px solid #4c2a85; outline-offset: 1px; }
.preview { cursor: inherit; margin-left: 0; }
`;

let sheet: CSSStyleSheet | null | undefined;

function styleRoot(root: ShadowRoot) {
  // adoptedStyleSheets can fail across content-script worlds (Firefox Xrays); fall back to <style>
  try {
    if (sheet === undefined) {
      sheet = new CSSStyleSheet();
      sheet.replaceSync(BADGE_CSS);
    }
    if (sheet) {
      root.adoptedStyleSheets = [sheet];
      return;
    }
  } catch {
    sheet = null;
  }
  const style = root.ownerDocument.createElement('style');
  style.textContent = BADGE_CSS;
  root.append(style);
}

/** The badge element: a button on X, a plain span for previews (they sit inside a radio's label). */
export function buildBadge(doc: Document, look: BadgeLook, handle: string | null): HTMLElement {
  const { icon, label } = badgeLook({ badgeIcon: look.icon, badgeLabel: look.label });
  const el = doc.createElement(handle === null ? 'span' : 'button');
  el.className = ['badge', label ? 'pill' : 'round', icon !== 'none' ? `icon ${icon}` : '', handle === null ? 'preview' : ''].filter(Boolean).join(' ');
  if (icon !== 'none') el.append(moneroSymbol(doc, icon));
  if (label) el.append('XMR');
  if (handle === null) {
    el.setAttribute('aria-hidden', 'true');
  } else {
    (el as HTMLButtonElement).type = 'button';
    el.setAttribute('aria-label', `Accepts Monero — tip @${handle}`);
    el.title = `Accepts Monero — tip @${handle}`;
  }
  return el;
}

/** Puts the badge in a closed shadow root on `host`; returns the badge element. */
export function mountBadge(host: HTMLElement, look: BadgeLook, handle: string | null): HTMLElement {
  const root = host.attachShadow({ mode: 'closed' });
  styleRoot(root);
  const el = buildBadge(host.ownerDocument, look, handle);
  root.append(el);
  return el;
}
