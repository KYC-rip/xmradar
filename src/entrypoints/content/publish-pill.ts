import type { RelayResult } from '../../messaging';
import { retryable } from '../../nostr/retry';
import { h } from './dom';
import { radarIcon } from './x-share';

/**
 * Copy to Nostr's minimised form (PLAN-MINIPILL): a small pill in the corner that shows the publish
 * steps, so the page stays usable. One composer per page, expanded or as its pill.
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

/** The page's one composer, as the slot sees it. */
export interface ComposerInstance {
  /** uploading, signing, publishing or retrying */
  busy(): boolean;
  /** published, with no failed relay left worth retrying */
  finished(): boolean;
  expanded(): boolean;
  expand(): void;
  /** closes it, as × does when not busy */
  close(): void;
  notice(text: string): void;
}

export type ClaimResult = 'open' | 'refuse';

/**
 * Who gets the page's one composer when Copy to Nostr is asked for again. A finished one makes way;
 * a draft, a failed one or one with relays still to retry is brought back instead of being lost; a
 * busy one is left to finish.
 */
export function composerSlot() {
  let current: ComposerInstance | null = null;
  let mounting = false;
  return {
    claim(): ClaimResult {
      if (mounting) return 'refuse';
      if (current?.expanded()) return 'refuse';
      if (current?.busy()) {
        current.notice('Still publishing the last post');
        return 'refuse';
      }
      if (current?.finished()) current.close();
      else if (current) {
        current.expand();
        current.notice('Finish or close this one first');
        return 'refuse';
      }
      mounting = true;
      return 'open';
    },
    /** the claimed composer is up (or failed to mount: null) */
    mounted(instance: ComposerInstance | null) {
      mounting = false;
      current = instance;
    },
    /** the instance went (closed, or hidden for good while it finishes) */
    release(instance: ComposerInstance) {
      if (current === instance) current = null;
    },
    get current() {
      return current;
    },
  };
}
