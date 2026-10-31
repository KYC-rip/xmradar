import type { ContentScriptContext } from 'wxt/utils/content-script-context';
import { MISTPROOF_MARK, PGP_BEGIN } from '../../log/fetch';
import { sendToBackground } from '../../messaging';
import type { Line, PageCheck } from '../../receipts/check';
import { missingReceiptText } from '../../receipts/issuers';
import { addressLines, copyWarning, depositShown, pageEventId, receiptTexts } from '../../receipts/page';
import { isXHost } from '../../sender';
import { logFetchOn, receiptsOn, settingsItem, siteInfoOn, xmrSettingsItem } from '../../settings';
import { letterWatch } from './letter';
import { mountReceiptCard, worstOf, type CardEntry, type ReceiptCard } from './receipt-card';

/**
 * Swap receipts on order pages (NKIP-0001, PLAN-NKIP01 §4.1): the top frame only, never on x.com.
 * A page carrying `<script type="application/nkip01+json">` gets the card; the receipt is checked and
 * saved by the background, and the page's addresses are compared with it here. Rescans while the page
 * changes, at most once every 2 s. Letters of guarantee (PLAN-LOG) share the card, the badge and the rescans.
 */

const RESCAN_MS = 2000;
const MISSING_AFTER_MS = 15_000;

/**
 * The page's visible text with its line breaks, form values, and a letter kept in a collapsed block
 * (NoxSwap puts it in a closed `<details>`, which `innerText` leaves out). Only text that holds a
 * letter's marker is taken from a hidden block; the letter is still checked against the feed's key.
 */
export function pageLetterText(doc: Document = document): string {
  const values = [...doc.querySelectorAll<HTMLTextAreaElement>('textarea')].map((t) => t.value);
  const kept = [...doc.querySelectorAll('details pre, details code')]
    .map((el) => el.textContent ?? '')
    .filter((t) => t.includes(PGP_BEGIN) || t.includes(MISTPROOF_MARK));
  return [doc.body?.innerText ?? '', ...values, ...kept].join('\n');
}

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
  // letters need the xmr.club feed too (PLAN-LOG Round 3 switch matrix)
  const letters = letterWatch({ onChange: () => render(), fetchOn: async () => logFetchOn(await settingsItem.getValue()) && siteInfoOn(await xmrSettingsItem.getValue()) });
  let siteInfo: boolean | null = null;
  // the copy warning came from a letter (it goes when site info does)
  let copyFromLetter = false;

  const render = () => {
    const entries: CardEntry[] = [...checks.values()].map((c) => ({
      receipt: c.receipt,
      saved: c.saved,
      saveError: c.saveError,
      // the page's addresses against this receipt, and the public record as the page shows it (§12)
      lines: c.receipt ? [...c.lines, ...addressLines(document, c.receipt), eventLine()] : c.lines,
    }));
    for (const l of letters.entries(document)) {
      entries.push({
        lines: l.lines,
        saved: !!l.reply?.saved,
        saveError: l.reply?.saveError,
        letter: { name: l.page.name, orderId: l.page.orderId, format: l.page.format, verified: !!l.reply?.verified, addresses: l.reply?.addresses ?? [], signedText: l.reply?.signedText ?? '', recheck: () => letters.recheck(l.page.siteId) },
      });
    }
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
    // a letter the page shows (Mistex: after "Show MistProof"); innerText keeps its line breaks
    if (letters.waiting) letters.capture(pageLetterText());
    missingCheck(current.length);
    render();
  }

  // R12: an order page xmr.club lists as carrying receipts that shows a deposit address but no receipt for 15 s
  function missingCheck(receipts: number) {
    const sites = letters.receiptSites;
    if (!sites.length || receipts || !depositShown(document)) {
      depositSince = 0;
      extra.delete('missing');
      return;
    }
    depositSince ||= Date.now();
    if (Date.now() - depositSince >= MISSING_AFTER_MS) extra.set('missing', { level: 'caution', text: missingReceiptText(sites) });
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
    letters.capture(copied);
    const receiptWarning = [...checks.values()].map((c) => c.receipt && copyWarning(copied, c.receipt)).find(Boolean);
    const warning = receiptWarning || letters.copyWarning(copied);
    copyFromLetter = !receiptWarning && !!warning;
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
    // the order-page match also says whether a receipt is expected here: check again once it's known
    startLetters();
  }

  // once the order page is known, look again at once: the missing-receipt clock starts there
  // (not after stop(): the page state it would look at is gone)
  const startLetters = () => {
    const gen = generation;
    void letters.start().then(() => {
      if (gen === generation) void scan();
    });
  };

  function stop() {
    generation++;
    letters.stop();
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
  // site info switched while the page is open: letters stop, or start, with it
  const unwatchSite = xmrSettingsItem.watch((x) => {
    const next = siteInfoOn(x);
    if (next === siteInfo) return;
    siteInfo = next;
    if (!on) return;
    letters.stop();
    // what the letters and the feed said goes with them
    depositSince = 0;
    extra.delete('missing');
    if (copyFromLetter) extra.delete('copy');
    copyFromLetter = false;
    if (next) startLetters();
    render();
  });
  void xmrSettingsItem.getValue().then((x) => (siteInfo ??= siteInfoOn(x)));
  // a single-page app moving to another order: start over
  ctx.addEventListener(window, 'wxt:locationchange', () => {
    if (!on) return;
    stop();
    start();
  });
  ctx.onInvalidated(() => {
    unwatch();
    unwatchSite();
    on = false;
    stop();
  });
}

