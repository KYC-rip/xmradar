import { sendToBackground } from '../../messaging';
import { ownStatusId } from '../../extractors/x';
import { XAP_ATTR, XAP_SELECTOR, actionBar, actionBars } from './x-xap';
import { noteXoSent } from './x-setup-card';

/**
 * The xo button (PLAN-MONEROLIKE): a Monero like, right after the Xap button on X posts. With the author's
 * key known it goes to the key; without one (PLAN-XOREACH) to their X handle, and waits there until they set up. Playful to send (Echo Bloom: squash, bloom into Monero orange, a ghost outline and a burst of
 * dots), joyful to receive (on the user's own posts, new xos float up as small hearts once). Web
 * Animations only, transform and opacity; with reduced motion the state just changes.
 */

export const XO_SELECTOR = `[${XAP_ATTR}="xo"]`;
const ORANGE = '#f26822';
const ORANGE_BACKDROP = 'rgba(242, 104, 34, 0.1)';
const SVG_NS = 'http://www.w3.org/2000/svg';
const HEART = 'M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z';
const MONERO_M = 'M7.6 13.4V9.2l4.4 4.4 4.4-4.4v4.2';

const calm = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
/** An animation where the browser has them; a temporary element goes when it ends, or at once without. */
function anim(el: Element, frames: Keyframe[], opts: KeyframeAnimationOptions, done?: () => void) {
  const a = typeof el.animate === 'function' ? el.animate(frames, opts) : null;
  if (!done) return;
  if (a) void a.finished.then(done, done);
  else done();
}

function xoIcon(like: Element | null): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  if (like?.getAttribute('class')) svg.setAttribute('class', like.getAttribute('class')!);
  const heart = document.createElementNS(SVG_NS, 'path');
  heart.setAttribute('d', HEART);
  heart.setAttribute('stroke-width', '1.8');
  heart.setAttribute('stroke-linejoin', 'round');
  const m = document.createElementNS(SVG_NS, 'path');
  m.setAttribute('d', MONERO_M);
  m.setAttribute('fill', 'none');
  m.setAttribute('stroke-width', '1.8');
  m.setAttribute('stroke-linecap', 'round');
  m.setAttribute('stroke-linejoin', 'round');
  svg.append(heart, m);
  paint(svg, false);
  return svg;
}

/** Outline in X's icon colour; sent: a Monero-orange heart with a white ɱ. */
function paint(svg: SVGSVGElement, sent: boolean) {
  const [heart, m] = svg.querySelectorAll('path');
  heart?.setAttribute('fill', sent ? ORANGE : 'none');
  heart?.setAttribute('stroke', sent ? ORANGE : 'currentColor');
  m?.setAttribute('stroke', sent ? '#ffffff' : 'currentColor');
}

/** Send: squash, bloom, a ghost outline growing away, six dots bursting out. */
export function bloom(svg: SVGSVGElement, big = false) {
  if (calm()) return;
  anim(
    svg,
    [
      { transform: 'scale(1)', easing: 'cubic-bezier(0.3, 0, 0.8, 0.15)' },
      { transform: 'scale(1.15, 0.82)', offset: 0.2, easing: 'cubic-bezier(0.34, 1.56, 0.64, 1)' },
      { transform: `scale(${big ? 1.4 : 1.26})`, offset: 0.55 },
      { transform: 'scale(1)' },
    ],
    { duration: 600 },
  );
  const box = svg.parentElement;
  if (!box) return;
  if (getComputedStyle(box).position === 'static') box.style.position = 'relative';
  const r = svg.getBoundingClientRect();
  const b = box.getBoundingClientRect();
  const cx = r.left - b.left + r.width / 2;
  const cy = r.top - b.top + r.height / 2;
  const ghost = svg.cloneNode(true) as SVGSVGElement;
  Object.assign(ghost.style, { position: 'absolute', left: `${r.left - b.left}px`, top: `${r.top - b.top}px`, width: `${r.width}px`, height: `${r.height}px`, pointerEvents: 'none' });
  box.append(ghost);
  anim(ghost, [{ transform: 'scale(1)', opacity: 0.75 }, { transform: 'scale(1.55)', opacity: 0 }], { duration: 330, delay: 120, easing: 'ease-out', fill: 'both' }, () => ghost.remove());
  const dots = big ? 8 : 6;
  for (let i = 0; i < dots; i++) {
    const dot = document.createElement('span');
    Object.assign(dot.style, { position: 'absolute', left: `${cx - 1.5}px`, top: `${cy - 1.5}px`, width: '3px', height: '3px', borderRadius: '50%', background: ORANGE, pointerEvents: 'none' });
    box.append(dot);
    const a = (Math.PI * 2 * i) / dots - Math.PI / 2;
    const d = r.width / 2 + (big ? 20 : 15);
    anim(
      dot,
      [{ transform: 'translate(0, 0) scale(1)', opacity: 1 }, { transform: `translate(${Math.cos(a) * d}px, ${Math.sin(a) * d}px) scale(0.4)`, opacity: 0 }],
      { duration: 420, delay: 140, easing: 'cubic-bezier(0, 0, 0.2, 1)', fill: 'both' },
      () => dot.remove(),
    );
  }
}

/** Take back: a quick drop and settle. */
const unbloom = (svg: SVGSVGElement) => !calm() && anim(svg, [{ transform: 'scaleY(0.7)' }, { transform: 'scaleY(1)' }], { duration: 250, easing: 'cubic-bezier(0.2, 0, 0, 1)' });

/** Receive: small hearts float up from the button and fade, and the count pops. */
export function celebrate(svg: SVGSVGElement, count: Element | null, hearts = 5) {
  if (calm()) return;
  if (count) anim(count, [{ transform: 'scale(1)' }, { transform: 'scale(1.35)' }, { transform: 'scale(1)' }], { duration: 450, easing: 'cubic-bezier(0.34, 1.56, 0.64, 1)' });
  const box = svg.parentElement;
  if (!box) return;
  if (getComputedStyle(box).position === 'static') box.style.position = 'relative';
  const r = svg.getBoundingClientRect();
  const b = box.getBoundingClientRect();
  for (let i = 0; i < hearts; i++) {
    const h = document.createElementNS(SVG_NS, 'svg');
    h.setAttribute('viewBox', '0 0 24 24');
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', HEART);
    p.setAttribute('fill', ORANGE);
    h.append(p);
    const size = 7 + (i % 3) * 2;
    Object.assign(h.style, { position: 'absolute', left: `${r.left - b.left + r.width / 2 - size / 2}px`, top: `${r.top - b.top}px`, width: `${size}px`, height: `${size}px`, pointerEvents: 'none' });
    box.append(h);
    const drift = (i - (hearts - 1) / 2) * 7;
    anim(
      h,
      [
        { transform: 'translate(0, 0) scale(0.4) rotate(0deg)', opacity: 0 },
        { transform: `translate(${drift * 0.4}px, -10px) scale(1) rotate(${drift}deg)`, opacity: 1, offset: 0.3 },
        { transform: `translate(${drift}px, -30px) scale(0.8) rotate(${drift * 1.5}deg)`, opacity: 0 },
      ],
      { duration: 900 + i * 60, delay: i * 90, easing: 'cubic-bezier(0.22, 1, 0.36, 1)', fill: 'both' },
      () => h.remove(),
    );
  }
}

export interface XoOpts {
  post: string;
  /** the author's key; null: none known, so the xo is addressed to their handle (PLAN-XOREACH) */
  /** a plain click also likes the post on X (opt-in); a hold always does */
  alsoLike?: boolean;
  author: string | null;
  handle: string;
  /** the user's own post: the button shows its count (others' xos plus the user's own); it can send one too, as on X */
  own: boolean;
  sent: boolean;
  count?: number;
}

export const ownXos = (article: Element) => actionBars(article).flatMap((bar) => [...bar.querySelectorAll<HTMLElement>(`:scope > ${XO_SELECTOR}`)]);

const label = (o: Pick<XoOpts, 'own' | 'sent' | 'handle' | 'author'>, shown: number) => {
  if (!o.own && !o.author)
    return o.sent ? `You sent an xo. It waits for @${o.handle} to set up XMRadar. Click to take it back.` : `@${o.handle} hasn’t set up XMRadar yet. Your xo waits for them, and counts once they do. Click: xo · Hold: xo + like on X`;
  if (!o.own) return o.sent ? 'You sent an xo. Click to take it back.' : `Send @${o.handle} an xo (a Monero like, over Nostr). Click: xo · Hold: xo + like on X`;
  const counted = shown ? `xo: ${shown}${o.sent ? ', yours included' : ' from Monero people'}` : 'xo: none yet';
  return `${counted}. ${o.sent ? 'Click to take yours back.' : 'Click: xo · Hold: xo + like on X'}`;
};

/**
 * The count shows on the user's own posts only: others' xos (from the inbox) plus one for the user's own, which
 * the sent record knows at once. Others' posts show none.
 */
export function setXoState(wrap: HTMLElement, o: Pick<XoOpts, 'own' | 'sent' | 'handle' | 'author'>, count?: number) {
  const shown = o.own ? (count ?? 0) + (o.sent ? 1 : 0) : 0;
  const svg = wrap.querySelector<SVGSVGElement>(`[${XAP_ATTR}="xo-icon"]`);
  if (svg) paint(svg, o.sent || shown > 0);
  const c = wrap.querySelector(`[${XAP_ATTR}="xo-count"]`);
  if (c) c.textContent = shown ? String(shown) : '';
  const btn = wrap.querySelector('button');
  btn?.setAttribute('aria-label', label(o, shown));
  btn?.setAttribute('aria-pressed', String(o.sent));
  if (btn) btn.title = label(o, shown);
  wrap.dataset.sent = String(o.sent);
  // the others' count, so a click can redraw with it
  wrap.dataset.count = String(count ?? 0);
}

/** Puts the xo button right after this post's Xap button in each bar; returns them. */
export function insertXo(article: Element, opts: XoOpts): HTMLElement[] {
  for (const bar of actionBars(article)) {
    const xap = bar.querySelector<HTMLElement>(`:scope > ${XAP_SELECTOR}`);
    const have = bar.querySelector<HTMLElement>(`:scope > ${XO_SELECTOR}`);
    // same post and same key: keep it (a key learned later redraws it)
    if (have?.dataset.post === opts.post && (have.dataset.author ?? '') === (opts.author ?? '')) continue;
    have?.remove();
    if (!xap) continue;
    const wrap = xap.cloneNode(true) as HTMLElement;
    for (const el of [wrap, ...wrap.querySelectorAll('*')]) for (const a of [...el.attributes]) if (a.name === 'id' || a.name.startsWith('data-')) el.removeAttribute(a.name);
    wrap.setAttribute(XAP_ATTR, 'xo');
    wrap.dataset.post = opts.post;
    wrap.dataset.author = opts.author ?? '';
    const btn = wrap.querySelector('button')!;
    const old = btn.querySelector('svg');
    const icon = xoIcon(old);
    icon.setAttribute(XAP_ATTR, 'xo-icon');
    old?.replaceWith(icon);
    const counter = btn.querySelector('span');
    if (counter) {
      counter.replaceChildren();
      counter.setAttribute(XAP_ATTR, 'xo-count');
    }
    // the clone has none of X's (or the Xap's) hover handling
    const tone = btn.firstElementChild instanceof HTMLElement ? btn.firstElementChild : btn;
    const backdrop = icon.previousElementSibling;
    const rest = tone.style.color;
    const tint = (on: boolean) => {
      tone.style.color = on ? ORANGE : rest;
      if (backdrop instanceof HTMLElement) backdrop.style.backgroundColor = on ? ORANGE_BACKDROP : '';
    };
    btn.addEventListener('pointerenter', () => tint(true));
    btn.addEventListener('pointerleave', () => tint(document.activeElement === btn));
    btn.addEventListener('focus', () => tint(true));
    btn.addEventListener('blur', () => tint(false));
    // click: xo (and like on X when switched on); hold 0.5 s or Shift+Enter: xo and like on X
    let hold: { timer: ReturnType<typeof setTimeout>; x: number; y: number; ring: HTMLElement | null } | null = null;
    let charged = false;
    const endHold = () => {
      if (!hold) return;
      clearTimeout(hold.timer);
      hold.ring?.remove();
      hold = null;
    };
    btn.addEventListener('pointerdown', (e) => {
      if (!e.isTrusted || e.button !== 0 || wrap.dataset.sent === 'true' || wrap.dataset.busy === 'true') return;
      charged = false;
      const ring = chargeRing(icon);
      hold = {
        x: e.clientX,
        y: e.clientY,
        ring,
        timer: setTimeout(() => {
          hold?.ring?.remove();
          hold = null;
          // the click that ends this hold, however long it lasts, is skipped (see pointerup below)
          charged = true;
          void toggle(wrap, icon, opts, true);
        }, HOLD_MS),
      };
    });
    btn.addEventListener('pointermove', (e) => {
      // a scroll or drag that started on the button isn't a hold
      if (hold && Math.hypot(e.clientX - hold.x, e.clientY - hold.y) > 6) endHold();
    });
    for (const ev of ['pointerup', 'pointerleave', 'pointercancel'])
      btn.addEventListener(ev, () => {
        endHold();
        // the release's click (if any) comes right after this event; anything later is a new click
        if (charged) setTimeout(() => (charged = false), 0);
      });
    btn.addEventListener('click', (e) => {
      // the tweet itself is a link; don't let X navigate
      e.preventDefault();
      e.stopPropagation();
      if (!e.isTrusted) return;
      // the click that ends a charged hold was already handled
      if (charged) {
        charged = false;
        return;
      }
      void toggle(wrap, icon, opts, wrap.dataset.alsoLike === 'true');
    });
    btn.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || !e.shiftKey || !e.isTrusted || wrap.dataset.sent === 'true') return;
      e.preventDefault();
      e.stopPropagation();
      void toggle(wrap, icon, opts, true);
    });
    setXoState(wrap, opts, opts.count);
    wrap.dataset.alsoLike = String(!!opts.alsoLike);
    // the Xap's own counter ends right where this starts; a little air between them
    wrap.style.marginLeft = '10px';
    xap.after(wrap);
  }
  return ownXos(article);
}

const HOLD_MS = 500;

/** The hold: an orange ring around the heart grows into place over HOLD_MS; none with reduced motion. */
function chargeRing(icon: SVGSVGElement): HTMLElement | null {
  const box = icon.parentElement;
  if (!box || calm()) return null;
  if (getComputedStyle(box).position === 'static') box.style.position = 'relative';
  const r = icon.getBoundingClientRect();
  const b = box.getBoundingClientRect();
  const size = Math.max(r.width, r.height) + 10;
  const ring = document.createElement('span');
  Object.assign(ring.style, {
    position: 'absolute',
    left: `${r.left - b.left + r.width / 2 - size / 2}px`,
    top: `${r.top - b.top + r.height / 2 - size / 2}px`,
    width: `${size}px`,
    height: `${size}px`,
    borderRadius: '50%',
    border: `2px solid ${ORANGE}`,
    pointerEvents: 'none',
  });
  box.append(ring);
  anim(ring, [{ transform: 'scale(0.4)', opacity: 0 }, { transform: 'scale(1)', opacity: 1 }], { duration: HOLD_MS, easing: 'linear', fill: 'both' });
  return ring;
}

/** The post's own like button on X, found again by its status id (X recycles post nodes while a send is out). */
export function likeButtonFor(post: string, doc: Document = document): HTMLElement | null | 'liked' {
  const article = [...doc.querySelectorAll('article[data-testid="tweet"]')].find((a) => ownStatusId(a) === post);
  const bar = article ? actionBar(article) : null;
  if (!bar) return null;
  if (bar.querySelector('[data-testid="unlike"]')) return 'liked';
  return bar.querySelector<HTMLElement>('[data-testid="like"]');
}

/** Presses X's own like on the post, as the user's click would; says whether it took. */
export async function likeOnX(post: string, doc: Document = document): Promise<boolean> {
  const btn = likeButtonFor(post, doc);
  if (btn === 'liked') return true;
  if (!btn) return false;
  btn.click();
  for (let i = 0; i < 10; i++) {
    if (likeButtonFor(post, doc) === 'liked') return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return likeButtonFor(post, doc) === 'liked';
}

async function toggle(wrap: HTMLElement, icon: SVGSVGElement, opts: XoOpts, alsoLike = false) {
  if (wrap.dataset.busy === 'true') return;
  wrap.dataset.busy = 'true';
  const was = wrap.dataset.sent === 'true';
  const others = Number(wrap.dataset.count) || 0;
  // the change shows at once; a refusal puts it back
  setXoState(wrap, { ...opts, sent: !was }, others);
  if (was) unbloom(icon);
  else bloom(icon, alsoLike);
  // X's like goes together with the bloom, not after the signer and relays: the user asked for both now
  const liked = !was && alsoLike ? likeOnX(opts.post) : null;
  try {
    const res = await sendToBackground(was ? { type: 'xo-undo', post: opts.post } : { type: 'xo-send', post: opts.post, author: opts.author, handle: opts.handle });
    if (!res.ok) throw new Error(res.error ?? 'Not sent');
    if (!was) noteXoSent();
    // taking an xo back never un-likes
    if (liked && !(await liked)) {
      const btn = wrap.querySelector('button');
      if (btn) btn.title = 'xo sent, but X’s like couldn’t be pressed on this post.';
    }
  } catch (e) {
    setXoState(wrap, { ...opts, sent: was }, others);
    const btn = wrap.querySelector('button');
    const msg = (e as Error).message === 'RATE_LIMITED' ? 'One at a time' : (e as Error).message;
    if (btn) btn.title = `${was ? 'Couldn’t take it back' : 'Not sent'}: ${msg}`;
    if (!calm()) anim(icon, [{ transform: 'translateX(0)' }, { transform: 'translateX(-3px)' }, { transform: 'translateX(3px)' }, { transform: 'translateX(0)' }], { duration: 240 });
  } finally {
    delete wrap.dataset.busy;
  }
}

export interface XoState {
  on: boolean;
  /** a plain click also likes on X */
  alsoLike?: boolean;
  me: { handle: string; proven: boolean } | null;
  sent: Record<string, unknown>;
  counts: Record<string, number>;
  /** counts the user has already seen celebrated, per post */
  seen: Record<string, number>;
}

/**
 * Keeps every xo button in step with the stored state, and celebrates new xos on the user's own posts once,
 * when the post comes into view. `save` keeps the seen counts so a reload doesn't celebrate again.
 */
export function xoManager(initial: XoState, save: (seen: Record<string, number>) => void) {
  let state = initial;
  const isOwn = (handle: string) => !!state.me?.proven && state.me.handle.toLowerCase() === handle.toLowerCase();
  const optsFor = (post: string, author: string | null, handle: string): XoOpts => ({ post, author, handle, own: isOwn(handle), sent: !!state.sent[post], count: state.counts[post], alsoLike: !!state.alsoLike });
  const watching = new WeakSet<Element>();
  const io =
    typeof IntersectionObserver === 'function'
      ? new IntersectionObserver((entries) => {
          for (const en of entries) if (en.isIntersecting) maybeCelebrate(en.target as HTMLElement);
        }, { threshold: 0.6 })
      : null;

  function maybeCelebrate(wrap: HTMLElement) {
    const post = wrap.dataset.post ?? '';
    const n = state.counts[post] ?? 0;
    const was = state.seen[post] ?? 0;
    if (!n || n <= was || !isOwn(wrap.dataset.handle ?? '')) return;
    const icon = wrap.querySelector<SVGSVGElement>(`[${XAP_ATTR}="xo-icon"]`);
    if (icon) celebrate(icon, wrap.querySelector(`[${XAP_ATTR}="xo-count"]`), Math.min(7, Math.max(3, n - was + 2)));
    state = { ...state, seen: { ...state.seen, [post]: n } };
    save(state.seen);
  }

  function place(article: Element, post: string, author: string | null, handle: string) {
    if (!state.on) {
      for (const el of ownXos(article)) el.remove();
      return;
    }
    for (const wrap of insertXo(article, optsFor(post, author, handle))) {
      wrap.dataset.handle = handle;
      if (io && !watching.has(wrap)) {
        watching.add(wrap);
        io.observe(wrap);
      }
    }
  }

  /** The stored state changed: every button on the page follows. */
  function update(next: Partial<XoState>, doc: Document = document) {
    state = { ...state, ...next };
    for (const wrap of doc.querySelectorAll<HTMLElement>(XO_SELECTOR)) {
      if (!state.on) {
        wrap.remove();
        continue;
      }
      const o = optsFor(wrap.dataset.post ?? '', wrap.dataset.author || null, wrap.dataset.handle ?? '');
      if (wrap.dataset.busy !== 'true') setXoState(wrap, o, o.count);
      wrap.dataset.alsoLike = String(!!state.alsoLike);
      // a new xo while the post is on screen celebrates right away
      if (o.own && next.counts) {
        const r = wrap.getBoundingClientRect();
        if (r.bottom > 0 && r.top < (doc.defaultView?.innerHeight ?? 0)) maybeCelebrate(wrap);
      }
    }
  }

  return {
    place,
    update,
    stop: () => io?.disconnect(),
    get on() {
      return state.on;
    },
  };
}
