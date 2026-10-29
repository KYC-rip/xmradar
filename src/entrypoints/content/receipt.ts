import type { ContentScriptContext } from 'wxt/utils/content-script-context';
import { sendToBackground } from '../../messaging';
import type { Line, PageCheck } from '../../receipts/check';
import { adopterFor, missingReceiptText } from '../../receipts/issuers';
import { addressLines, copyWarning, depositShown, pageEventId, receiptTexts } from '../../receipts/page';
import { isXHost } from '../../sender';
import { receiptsOn, settingsItem } from '../../settings';
import { mountReceiptCard, worstOf, type ReceiptCard } from './receipt-card';

/**
 * Swap receipts on order pages (NKIP-0001, PLAN-NKIP01 §4.1): the top frame only, never on x.com.
 * A page carrying `<script type="application/nkip01+json">` gets the card; the receipt is checked and
 * saved by the background, and the page's addresses are compared with it here. Rescans while the page
 * changes, at most once every 2 s.
 */

const RESCAN_MS = 2000;
const MISSING_AFTER_MS = 10_000;

export function startReceipts(ctx: ContentScriptContext) {
  if (window !== window.top || isXHost(location.hostname)) return;
  let on = false;
  let card: ReceiptCard | null = null;
  const checks = new Map<string, PageCheck>();
  const extra = new Map<string, Line>();
  let observer: MutationObserver | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let depositSince = 0;
  // bumped by stop(): an answer that arrives for an earlier page state is dropped
  let generation = 0;

  const render = () => {
    const entries = [...checks.values()].map((c) => ({
      receipt: c.receipt,
      saved: c.saved,
      saveError: c.saveError,
      // the page's addresses against this receipt, and the public record as the page shows it (§12)
      lines: c.receipt ? [...c.lines, ...addressLines(document, c.receipt), eventLine()] : c.lines,
    }));
    if (!entries.length && !extra.size) {
      // the page took its receipts away: so does the card
      card?.remove();
      card = null;
      return badge('none');
    }
    card ??= mountReceiptCard(document);
    card.render(entries, [...extra.values()]);
    const worst = worstOf([...entries.flatMap((e) => e.lines), ...extra.values()]);
    // only ○ lines (still checking, nothing checkable): no ✓ yet
    badge(worst === 'off' ? 'none' : worst);
  };

  // the toolbar icon shows the state too, so a hidden card still leaves a trace; sent only on change
  let shownBadge: string = 'none';
  const badge = (level: 'ok' | 'caution' | 'warn' | 'none') => {
    if (level === shownBadge) return;
    shownBadge = level;
    void sendToBackground({ type: 'receipt-badge', level }).catch(() => {});
  };

  const eventLine = (): Line => {
    const id = pageEventId(document);
    return id
      ? { level: 'ok', text: `Event ${id.slice(0, 8)}…${id.slice(-8)} shown by the exchange; check it later in Options → Receipts.` }
      : { level: 'off', text: 'No event id shown on this page; check the public record later in Options → Receipts.' };
  };

  async function scan() {
    timer = undefined;
    if (!on) return;
    const gen = generation;
    const current = receiptTexts(document);
    // a receipt the page no longer carries goes from the card
    for (const t of [...checks.keys()]) if (!current.includes(t)) checks.delete(t);
    for (const text of current.filter((t) => !checks.has(t))) {
      checks.set(text, { lines: [{ level: 'off', text: 'Checking the receipt…' }], saved: false });
      let result: PageCheck;
      try {
        result = await sendToBackground({ type: 'receipt-found', text, eventId: pageEventId(document) });
      } catch (e) {
        result = { lines: [{ level: 'caution', text: `Receipt not checked: ${(e as Error).message}` }], saved: false };
      }
      if (gen !== generation) return;
      checks.set(text, result);
    }
    missingCheck(current.length);
    render();
  }

  // R12: an adopter's order page that shows a deposit address but no receipt for 10 s
  function missingCheck(receipts: number) {
    const adopter = adopterFor(new URL(location.href), Date.now() / 1000);
    if (!adopter || receipts || !depositShown(document)) {
      depositSince = 0;
      extra.delete('missing');
      return;
    }
    depositSince ||= Date.now();
    if (Date.now() - depositSince >= MISSING_AFTER_MS) extra.set('missing', { level: 'warn', text: missingReceiptText(adopter) });
    else schedule(MISSING_AFTER_MS);
  }

  const schedule = (ms = RESCAN_MS) => {
    timer ??= setTimeout(() => {
      const idle = (window as { requestIdleCallback?: (cb: () => void) => void }).requestIdleCallback;
      if (idle) idle(() => void scan());
      else void scan();
    }, ms);
  };

  const onCopy = () => {
    const copied = window.getSelection()?.toString() ?? '';
    const warning = [...checks.values()].map((c) => c.receipt && copyWarning(copied, c.receipt)).find(Boolean);
    // the latest copy decides: copying a signed address clears an earlier warning
    if (warning) extra.set('copy', { level: 'warn', text: warning });
    else if (!extra.delete('copy')) return;
    render();
  };

  function start() {
    if (observer) return;
    // a receipt can arrive late: the exchange releases it once the record is witnessed (R15)
    observer = new MutationObserver(() => schedule());
    observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    document.addEventListener('copy', onCopy, true);
    void scan();
  }

  function stop() {
    generation++;
    depositSince = 0;
    observer?.disconnect();
    observer = null;
    clearTimeout(timer);
    timer = undefined;
    document.removeEventListener('copy', onCopy, true);
    card?.remove();
    card = null;
    checks.clear();
    extra.clear();
    badge('none');
  }

  const apply = (next: boolean) => {
    on = next;
    if (on) start();
    else stop();
  };
  void settingsItem.getValue().then((s) => apply(receiptsOn(s)));
  const unwatch = settingsItem.watch((s) => apply(receiptsOn(s)));
  // a single-page app moving to another order: start over
  ctx.addEventListener(window, 'wxt:locationchange', () => {
    if (!on) return;
    stop();
    start();
  });
  ctx.onInvalidated(() => {
    unwatch();
    stop();
  });
}

