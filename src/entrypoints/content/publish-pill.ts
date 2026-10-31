import type { RelayResult } from '../../messaging';
import { retryable } from '../../nostr/retry';
import { h } from './dom';
import { radarIcon } from './x-share';

/**
 * Copy to Nostr's minimised form (PLAN-MINIPILL): a small pill in the corner that shows the publish
 * steps, so the page stays usable. Several copies at once (PLAN-PARALLEL): one expanded, the rest as pills.
 */

export type PillState =
  | { kind: 'draft' }
  | { kind: 'uploading'; index: number; count: number }
  | { kind: 'signing' }
  | { kind: 'publishing' }
  | { kind: 'retrying'; count: number }
  | { kind: 'published'; results: RelayResult[]; link: { href: string; label: string }; ref: string; copyLabel: string }
  | { kind: 'rejected'; results: RelayResult[] }
  | { kind: 'error'; message: string };

export interface PillView {
  text: string;
  tone: 'info' | 'ok' | 'error';
  /** failed relays worth trying again; 0 = no Retry button */
  retry: number;
  view?: { href: string; label: string };
  copy?: { ref: string; label: string };
}

const relays = (n: number) => `${n} ${n === 1 ? 'relay' : 'relays'}`;

export function pillView(state: PillState, what: 'note' | 'article'): PillView {
  switch (state.kind) {
    case 'draft':
      return { text: 'Draft not published', tone: 'info', retry: 0 };
    case 'uploading':
      return { text: state.count > 1 ? `Uploading image ${state.index} of ${state.count}…` : 'Uploading image…', tone: 'info', retry: 0 };
    case 'signing':
      return { text: 'Waiting for signer…', tone: 'info', retry: 0 };
    case 'publishing':
      return { text: 'Publishing…', tone: 'info', retry: 0 };
    case 'retrying':
      return { text: `Retrying ${relays(state.count)}…`, tone: 'info', retry: 0 };
    case 'published': {
      const ok = state.results.filter((r) => r.ok).length;
      const all = state.results.length;
      return {
        text: ok === all ? `Published to ${relays(all)}` : `Published to ${ok} of ${relays(all)}`,
        tone: 'ok',
        retry: state.results.filter(retryable).length,
        view: state.link,
        copy: { ref: state.ref, label: state.copyLabel },
      };
    }
    case 'rejected':
      return { text: `No relay accepted the ${what}`, tone: 'error', retry: state.results.filter(retryable).length };
    case 'error':
      return { text: state.message, tone: 'error', retry: 0 };
  }
}

/** Published with no failed relay worth retrying: the pill closes itself shortly after (PLAN-PARALLEL). */
export const autoCloses = (state: PillState) => state.kind === 'published' && !state.results.some(retryable);

/**
 * The auto-close timer of one composer: `arm(state)` whenever its pill shows a state (re)starts it for an
 * auto-closing state and stops it otherwise; when it fires, `closeIfIdle` decides (still a pill, finished).
 */
export function autoCloser(ms: number, closeIfIdle: () => void) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => clearTimeout(timer);
  return {
    arm(state: PillState) {
      cancel();
      if (autoCloses(state)) timer = setTimeout(closeIfIdle, ms);
    },
    cancel,
  };
}

export interface PillHandlers {
  retry(): void;
  open(): void;
  dismiss(): void;
}

export interface Pill {
  el: HTMLElement;
  update(view: PillView): void;
  /** a short message over the status, then the status again */
  notice(text: string, ms?: number): void;
}

export function createPill(handlers: PillHandlers): Pill {
  const text = h('span', { class: 'pill-text', attrs: { role: 'status', 'aria-live': 'polite' } });
  const actions = h('span', { class: 'pill-actions' });
  const el = h('div', { class: 'pill', attrs: { role: 'region', 'aria-label': 'Copy to Nostr' } }, radarIcon(document, null), text, actions);
  let last: PillView = { text: '', tone: 'info', retry: 0 };
  let noticeTimer: ReturnType<typeof setTimeout> | undefined;

  const button = (label: string, onclick: () => void, attrs: Record<string, string> = {}) => h('button', { class: 'link', textContent: label, onclick, attrs });

  function render(view: PillView) {
    el.dataset.tone = view.tone;
    text.textContent = view.text;
    actions.replaceChildren(
      ...(view.retry ? [button(`Retry ${view.retry}`, handlers.retry, { title: `Try the failed ${relays(view.retry)} again` })] : []),
      ...(view.view ? [h('a', { href: view.view.href, target: '_blank', rel: 'noopener', textContent: 'View', title: view.view.label })] : []),
      ...(view.copy ? [button('Copy', () => void navigator.clipboard.writeText(view.copy!.ref), { title: view.copy.label })] : []),
      button('Open', handlers.open, { title: 'Show the composer' }),
      h('button', { class: 'pill-x', textContent: '×', onclick: handlers.dismiss, attrs: { 'aria-label': 'Dismiss', title: 'Dismiss' } }),
    );
  }

  return {
    el,
    update(view) {
      last = view;
      clearTimeout(noticeTimer);
      render(view);
    },
    notice(message, ms = 3000) {
      clearTimeout(noticeTimer);
      el.dataset.tone = 'info';
      text.textContent = message;
      noticeTimer = setTimeout(() => render(last), ms);
    },
  };
}

/** A composer, as the dock sees it. */
export interface ComposerInstance {
  /** uploading, signing, publishing or retrying */
  busy(): boolean;
  /** published, with no failed relay left worth retrying */
  finished(): boolean;
  expanded(): boolean;
  expand(): void;
  /** back to its pill, the draft kept */
  minimise(): void;
  /** closes it, as × does when not busy */
  close(): void;
  notice(text: string): void;
  /** its place in the stack of pills, 0 at the bottom */
  stack(index: number): void;
}

export type ClaimResult = 'open' | 'refuse';

/** How many copies a page holds at once (mounting ones included). */
export const MAX_COMPOSERS = 5;

/**
 * The page's composers (PLAN-PARALLEL): several copies at once, one expanded, the rest as stacked pills.
 * Each claim is a reservation keyed by the post (`composerKey`), so a double click or the same post copied
 * again never opens a second composer for it.
 */
export function composerDock() {
  type Entry = { key: string; instance: ComposerInstance | null };
  const entries: Entry[] = [];
  const drop = (e: Entry) => {
    const i = entries.indexOf(e);
    if (i >= 0) entries.splice(i, 1);
  };
  // only pills take a place: an expanded composer leaves no gap below the others
  const layout = () => entries.filter((e) => e.instance && !e.instance.expanded()).forEach((e, i) => e.instance!.stack(i));
  /** before one comes up: any other expanded composer goes back to its pill */
  const minimiseOthers = (keep: ComposerInstance | null) => {
    for (const e of entries) if (e.instance && e.instance !== keep && e.instance.expanded()) e.instance.minimise();
  };
  const closeEntry = (e: Entry) => {
    drop(e);
    e.instance?.close();
  };
  return {
    claim(key: string): ClaimResult {
      const same = entries.find((e) => e.key === key);
      if (same && !same.instance) return 'refuse';
      if (same?.instance) {
        if (same.instance.finished()) closeEntry(same);
        else {
          minimiseOthers(same.instance);
          same.instance.expand();
          same.instance.notice('Already open');
          return 'refuse';
        }
      }
      // finished ones make room, oldest first
      for (const e of [...entries]) {
        if (entries.length < MAX_COMPOSERS) break;
        if (e.instance?.finished()) closeEntry(e);
      }
      if (entries.length >= MAX_COMPOSERS) {
        [...entries].reverse().find((e) => e.instance)?.instance!.notice('Up to 5 at a time: finish or close one');
        return 'refuse';
      }
      minimiseOthers(null);
      entries.push({ key, instance: null });
      layout();
      return 'open';
    },
    /** the claimed composer is up, or failed to mount (null): its place is freed */
    mounted(key: string, instance: ComposerInstance | null) {
      const e = entries.find((x) => x.key === key && !x.instance);
      if (!e) return;
      if (instance) e.instance = instance;
      else drop(e);
      layout();
    },
    /** the instance went (closed, or hidden for good while it finishes); a repeat changes nothing */
    release(instance: ComposerInstance) {
      const e = entries.find((x) => x.instance === instance);
      if (!e) return;
      drop(e);
      layout();
    },
    /** a pill's Open: the others minimise first */
    focus(instance: ComposerInstance) {
      minimiseOthers(instance);
    },
    /** a composer was expanded or minimised: the pills close up */
    relayout() {
      layout();
    },
    get size() {
      return entries.length;
    },
  };
}
