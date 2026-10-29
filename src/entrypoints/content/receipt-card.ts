import { MONERO_OUTER, MONERO_PARTS, MONERO_VIEWBOX } from '../../identity/badge-look';
import type { Line } from '../../receipts/check';
import type { Receipt } from '../../receipts/verify';
import { h } from './dom';

/**
 * The receipt indicator (PLAN-NKIP01 §1.1), in its own closed shadow root, top right under the
 * toolbar: a short toast says the site speaks NKIP-0001 and the receipt was checked and saved, then it
 * shrinks to a small chip. The chip opens the details, can be dragged anywhere, and × hides it for the
 * page. A warning never shrinks: it stays open and red, and comes back if a new one appears.
 */

export interface CardEntry {
  receipt?: Receipt;
  lines: Line[];
  saved: boolean;
  saveError?: string;
}

type Phase = 'toast' | 'chip' | 'open' | 'hidden';

const MARK: Record<Line['level'], string> = { ok: '✓', caution: '△', warn: '⚠', off: '○' };
// a line that only says what wasn't checked (○) never outranks a ✓
const RANK: Record<Line['level'], number> = { warn: 3, caution: 2, ok: 1, off: 0 };
export const TOAST_MS = 4000;

const CSS = `
:host { all: initial; }
.box { position: fixed; top: 72px; right: 16px; z-index: 2147483646; max-width: min(400px, calc(100vw - 32px)); max-height: 70vh; overflow: auto;
  font: 13px/1.45 system-ui, -apple-system, sans-serif; color: #1d1b26; background: #fff; border: 1px solid #d9d6e3; border-radius: 12px;
  box-shadow: 0 6px 24px rgba(0,0,0,.18); opacity: 1; transform: none; transition: opacity .25s ease, transform .25s ease, border-radius .25s ease; }
.box.enter { opacity: 0; transform: translateY(-10px) scale(.98); }
.box.chip { border-radius: 999px; overflow: hidden; }
.box.warn { border-color: #d93025; }
.box.dragging { transition: none; cursor: grabbing; user-select: none; }
.head { display: flex; gap: 8px; align-items: center; padding: 8px 10px 8px 12px; cursor: grab; }
.chip .head { padding: 4px 6px 4px 8px; }
.icon { width: 18px; height: 18px; flex: none; }
.title { font-weight: 600; }
.title.warn { color: #d93025; } .title.caution { color: #b26a00; } .title.ok { color: #1e7d34; }
.msg { flex: 1; min-width: 0; }
.head button { font: inherit; border: 1px solid #d9d6e3; background: transparent; border-radius: 8px; padding: 2px 8px; cursor: pointer; color: inherit; }
.head .x { border: 0; padding: 0 4px; font-size: 16px; line-height: 1; color: #6b6880; }
.chip .label { border: 0; padding: 0 2px; font-weight: 600; }
.body { padding: 0 12px 10px; }
ul { margin: 0; padding: 0; list-style: none; }
li { display: flex; gap: 6px; margin: 4px 0; }
li .m { flex: none; width: 1em; text-align: center; }
li.warn .m { color: #d93025; } li.caution .m { color: #b26a00; } li.ok .m { color: #1e7d34; } li.off .m { color: #777; }
dl { display: grid; grid-template-columns: auto 1fr; gap: 2px 10px; margin: 8px 0 0; font-size: 12px; }
dt { color: #6b6880; } dd { margin: 0; word-break: break-all; font-family: ui-monospace, Menlo, monospace; }
dd button { font: 11px system-ui, sans-serif; border: 1px solid #d9d6e3; background: transparent; border-radius: 6px; padding: 0 6px; cursor: pointer; color: inherit; }
.note { font-size: 12px; color: #6b6880; margin-top: 8px; }
.sep { border-top: 1px solid #eee; margin: 8px 0; }
@media (prefers-color-scheme: dark) {
  .box { color: #ececf1; background: #1f1e26; border-color: #45434f; }
  .head button, dd button { border-color: #45434f; }
  dt, .note, .head .x { color: #a9a6b8; } .sep { border-color: #333; }
}
@media (prefers-reduced-motion: reduce) { .box, .box.enter { transition: none; transform: none; } }`;

/** Base units shown as XMR (12 decimals) or BTC (8); other assets stay raw, labelled. */
export function amount(base: string, asset: string): string {
  const a = asset.toUpperCase();
  const decimals = a === 'XMR' ? 12 : a === 'BTC' ? 8 : null;
  if (decimals === null) return `${base} base units ${asset}`;
  const s = base.padStart(decimals + 1, '0');
  const frac = s.slice(-decimals).replace(/0+$/, '');
  return `${s.slice(0, -decimals)}${frac ? `.${frac}` : ''} ${a}`;
}

export const worstOf = (lines: Line[]) => lines.reduce<Line['level']>((w, l) => (RANK[l.level] > RANK[w] ? l.level : w), 'off');

const lineList = (lines: Line[]) => h('ul', {}, ...lines.map((l) => h('li', { class: l.level }, h('span', { class: 'm', textContent: MARK[l.level] }), h('span', { textContent: l.text }))));

function moneroIcon(doc: Document): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = doc.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', MONERO_VIEWBOX);
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  const outer = doc.createElementNS(ns, 'g');
  outer.setAttribute('transform', MONERO_OUTER);
  for (const [transform, d, fill] of MONERO_PARTS) {
    const g = doc.createElementNS(ns, 'g');
    g.setAttribute('transform', transform);
    const path = doc.createElementNS(ns, 'path');
    path.setAttribute('d', d);
    path.setAttribute('fill', fill);
    g.append(path);
    outer.append(g);
  }
  svg.append(outer);
  return svg;
}

function details(entries: CardEntry[], extra: Line[]): HTMLElement {
  const body = h('div', { class: 'body' });
  for (const [i, e] of entries.entries()) {
    if (i) body.append(h('div', { class: 'sep' }));
    body.append(lineList(e.lines));
    const r = e.receipt;
    if (!r) continue;
    const row = (k: string, v: string) => [h('dt', { textContent: k }), h('dd', { textContent: v })];
    // the signed addresses, with Copy, so the one you paste is the one the exchange signed
    const addressRow = (k: string, v: string) => {
      const copy = h('button', { textContent: 'Copy', attrs: { 'aria-label': `Copy the signed ${k === 'To' ? 'deposit' : 'payout'} address` } });
      copy.addEventListener('click', () => void navigator.clipboard.writeText(v).then(() => (copy.textContent = 'Copied'), () => (copy.textContent = 'Select it')));
      return [h('dt', { textContent: k }), h('dd', {}, v, ' ', copy)];
    };
    body.append(
      h(
        'dl',
        {},
        ...row('Order', `${r.order_id} at ${r.issuer}`),
        ...row('You send', amount(r.deposit_amount, r.deposit_asset)),
        ...addressRow('To', r.deposit_address),
        ...row(r.rate_type === 'float' ? 'You get at least' : 'You get', amount(r.payout_amount, r.payout_asset)),
        ...addressRow('At', r.payout_address),
        ...(r.refund_address ? row('Refund to', r.refund_address) : []),
      ),
      h('div', { class: 'note', textContent: e.saved ? 'Saved in this browser only ✓ (Options → Swap receipts)' : (e.saveError ?? 'Not saved.') }),
    );
  }
  if (extra.length) body.append(lineList(extra));
  body.append(h('div', { class: 'note', textContent: 'XMRadar can’t see a page script or other software that changes your clipboard: compare the address in your wallet with the one above.' }));
  return body;
}

/** The toast's one line: the site speaks NKIP-0001 and the receipt is saved, or the worst problem. */
export function toastText(entries: CardEntry[], extra: Line[]): string {
  const all = [...entries.flatMap((e) => e.lines), ...extra];
  const worst = worstOf(all);
  const issuer = entries.find((e) => e.receipt)?.receipt?.issuer;
  if (worst === 'warn' || worst === 'caution') return all.find((l) => l.level === worst)!.text;
  if (!issuer) return all[0]?.text ?? 'Checking the receipt…';
  return `${issuer} supports NKIP-0001 · Receipt checked${entries.some((e) => e.saved) ? ' and saved' : ''} ✓`;
}

export interface ReceiptCard {
  render(entries: CardEntry[], extra: Line[]): void;
  remove(): void;
}

export function mountReceiptCard(doc: Document, opts: { toastMs?: number } = {}): ReceiptCard {
  const host = doc.createElement('xmradar-receipt');
  const root = host.attachShadow({ mode: 'closed' });
  const style = doc.createElement('style');
  style.textContent = CSS;
  const box = h('div', { class: 'box enter', attrs: { role: 'region', 'aria-label': 'XMRadar receipt check' } });
  const live = h('div', { attrs: { 'aria-live': 'assertive', style: 'position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)' } });
  root.append(style, box, live);
  doc.documentElement.append(host);
  // the next frame, so the slide-in has a start state
  setTimeout(() => box.classList.remove('enter'), 16);

  let phase: Phase = 'toast';
  let dismissedWarning = '';
  let lastAnnounced = '';
  let last: [CardEntry[], Line[]] = [[], []];
  let shrink: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
    shrink = undefined;
    if (phase === 'toast') phase = 'chip';
    render(...last);
  }, opts.toastMs ?? TOAST_MS);

  // dragging by the head, anywhere in the window; a drag isn't also a click
  let dragged = false;
  box.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !(e.target instanceof Element) || !e.target.closest('.head')) return;
    const start = box.getBoundingClientRect();
    const [dx, dy] = [e.clientX - start.left, e.clientY - start.top];
    dragged = false;
    const move = (m: PointerEvent) => {
      if (!dragged && Math.hypot(m.clientX - e.clientX, m.clientY - e.clientY) < 4) return;
      const view = doc.defaultView!;
      const x = Math.min(Math.max(0, m.clientX - dx), view.innerWidth - box.offsetWidth);
      const y = Math.min(Math.max(0, m.clientY - dy), view.innerHeight - box.offsetHeight);
      dragged = true;
      box.classList.add('dragging');
      Object.assign(box.style, { left: `${x}px`, top: `${y}px`, right: 'auto' });
    };
    const up = () => {
      box.classList.remove('dragging');
      doc.removeEventListener('pointermove', move);
      doc.removeEventListener('pointerup', up);
    };
    doc.addEventListener('pointermove', move);
    doc.addEventListener('pointerup', up);
  });
  const onClick = (fn: () => void) => () => {
    if (dragged) return void (dragged = false);
    fn();
  };

  function render(entries: CardEntry[], extra: Line[]) {
    last = [entries, extra];
    const all = [...entries.flatMap((e) => e.lines), ...extra];
    const worst = worstOf(all);
    const warnings = all.filter((l) => l.level === 'warn').map((l) => l.text);
    const warning = warnings.join('\n');
    // a warning keeps it open; × hides it until the warnings change
    if (warning && warning !== dismissedWarning) phase = 'open';
    // a new warning is announced once
    const fresh = warnings.find((w) => !lastAnnounced.split('\n').includes(w));
    if (fresh) live.textContent = fresh;
    lastAnnounced = warning;
    host.hidden = phase === 'hidden';
    if (phase === 'hidden') return;

    box.className = `box ${phase === 'chip' ? 'chip' : ''} ${worst === 'warn' ? 'warn' : ''}`;
    const close = h('button', { class: 'x', textContent: '×', attrs: { 'aria-label': 'Hide for this page' } });
    close.addEventListener(
      'click',
      onClick(() => {
        dismissedWarning = warning;
        phase = 'hidden';
        render(entries, extra);
      }),
    );
    const icon = moneroIcon(doc);
    if (phase === 'chip') {
      const label = h('button', { class: `label title ${worst}`, textContent: `Receipt ${MARK[worst]}`, attrs: { 'aria-expanded': 'false', title: toastText(entries, extra) } });
      label.addEventListener(
        'click',
        onClick(() => {
          phase = 'open';
          render(entries, extra);
        }),
      );
      box.replaceChildren(h('div', { class: 'head' }, icon, label, close));
      return;
    }
    if (phase === 'toast') {
      const more = h('button', { textContent: 'Details' });
      more.addEventListener(
        'click',
        onClick(() => {
          clearTimeout(shrink);
          phase = 'open';
          render(entries, extra);
        }),
      );
      box.replaceChildren(h('div', { class: 'head' }, icon, h('span', { class: `msg title ${worst}`, textContent: toastText(entries, extra) }), more, close));
      return;
    }
    const head: Node[] = [icon, h('span', { class: `msg title ${worst}`, textContent: `XMRadar · Receipt ${MARK[worst]}` })];
    // with a warning there's nothing to shrink to: × is the only way out
    if (worst !== 'warn') {
      const hide = h('button', { textContent: 'Hide', attrs: { 'aria-expanded': 'true' } });
      hide.addEventListener(
        'click',
        onClick(() => {
          phase = 'chip';
          render(entries, extra);
        }),
      );
      head.push(hide);
    }
    box.replaceChildren(h('div', { class: 'head' }, ...head, close), details(entries, extra));
  }

  return {
    render,
    remove: () => {
      clearTimeout(shrink);
      host.remove();
    },
  };
}
