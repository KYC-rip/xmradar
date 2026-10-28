import type { BadgeEntry } from '../../identity/resolve';
import { sendToBackground, type XapTotals } from '../../messaging';
import { formatXmr, parseXmr, randomPico, uniqueAmount } from '../../xap/amount';
import { moneroUri } from '../../xmr/address';
import { h } from './dom';
import { fiatChips } from './fiat-chips';
import { qrSvg } from './qr-svg';
import { picoToUsd } from '../../xap/price';
import { findMark, markFor, withMark } from '../../xap/marks';
import { xapMarksItem } from '../../settings';

/**
 * The Xap part of the tip popup (PLAN-XAP, NKIP-0002): totals in three separate states, the unique
 * amount, and a receipt published only after the user says they sent it and agrees to make it public.
 */

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

/** The popup's totals: verified, verifying and claimed stay separate figures, never summed (R5, counting rule 7). */
export function totalsLines(t: XapTotals | null, cached: XapTotals | null, handle: string): string[] {
  const shown = t ?? cached;
  const lines: string[] = [];
  const verified = shown ? parseXmr(shown.verified) : null;
  if (verified) lines.push(`ɱ ${shown!.verified} ✓ verified (${plural(shown!.verifiedTippers, 'tipper')})`);
  if (!t) {
    // the claimed figure depends on the current address, so a cached one is never shown (R10)
    lines.push(shown ? 'Claimed: updating…' : 'Loading Xaps…');
    return lines;
  }
  if (parseXmr(t.verifying)) lines.push(`ɱ ${t.verifying} verifying (yours, usually about 20 min)`);
  if (parseXmr(t.claimed)) lines.push(`+ɱ ${t.claimed} claimed (${plural(t.claimedTippers, 'tipper')}, not yet confirmed by @${handle})`);
  if (!lines.length) lines.push('No Xaps yet');
  return lines;
}

export function mineLine(t: XapTotals, handle: string): string | null {
  const m = t.mine[0];
  if (!m) return null;
  const what = `Your last Xap, ɱ ${m.amount}: `;
  if (m.state === 'verified') return `${what}verified by @${handle}`;
  if (m.state === 'verifying') return `${what}verifying (usually about 20 min)`;
  if (m.state === 'claimed') return `${what}claimed, waiting for @${handle} to confirm${m.recorded ? '' : '. Sent from another device or before this record: shown as claimed until confirmed'}`;
  return `${what}not in the claimed total (another of your receipts counts, or @${handle} has changed address)`;
}

export const confirmText = (handle: string, amount: string, post?: string) =>
  post
    ? `Publish a public Xap receipt? It shows your Nostr key, @${handle}'s Nostr key, ${amount} XMR and the post you tipped (x.com/i/status/${post}). It never contains your transaction id.`
    : `Publish a public Xap receipt? It shows your Nostr key, @${handle}'s Nostr key and ${amount} XMR. It never contains your transaction id.`;

/** The person's total under a post's figures: its own line, never added to the post's (counting step 8). */
export function profileLine(t: XapTotals, handle: string): string {
  const parts = [
    parseXmr(t.verified) ? `ɱ ${t.verified} ✓ verified` : '',
    parseXmr(t.verifying) ? `ɱ ${t.verifying} verifying (yours)` : '',
    parseXmr(t.claimed) ? `+ɱ ${t.claimed} claimed` : '',
  ].filter(Boolean);
  return `All Xaps to @${handle}: ${parts.length ? parts.join(', ') : 'none yet'}`;
}

const errorText = (message: string, handle: string) =>
  message === 'ADDRESS_CHANGED'
    ? `@${handle}'s address changed; close this, check it and try again.`
    : message === 'RATE_LIMITED'
      ? 'Wait a few seconds and try again.'
      : message;

export interface XapOptions {
  handle: string;
  entry: BadgeEntry & { pubkey: string };
  cached?: XapTotals;
  /** "Ask to publish a Xap receipt after a tip" */
  receipts: boolean;
  /** X status id: this Xap tips that post, and the figures above are the post's */
  post?: string;
  /** a receipt was published */
  onPublished?: () => void;
  /** fresh figures for this post (or person), so the button can show them too */
  onTotals?: (t: XapTotals) => void;
  /** a post popup's fresh person total, so the page's badge tooltip shows it too */
  onProfileTotals?: (t: XapTotals) => void;
  isClosed: () => boolean;
}

export function renderXap(o: XapOptions): HTMLElement {
  const { handle, entry } = o;
  const address = entry.address;
  const wrap = h('div', { class: 'tip xap' });
  const totalsBox = h('div', { class: 'xap-totals', attrs: { role: 'status', 'aria-live': 'polite' } });
  const mineBox = h('div', { class: 'small' });
  const profileBox = h('div', { class: 'small' });
  const addrWarn = h('div', { class: 'warn hidden' });
  let fresh: XapTotals | null = null;
  // set when relays now name another address: nothing may still point at the old one
  let stale = false;
  const showTotals = () => {
    const lines = totalsLines(fresh, o.cached ?? null, handle);
    if (o.post) lines[0] = `This post: ${lines[0]}`;
    totalsBox.replaceChildren(...lines.map((l) => h('div', { textContent: l })));
    mineBox.textContent = fresh ? (mineLine(fresh, handle) ?? '') : '';
  };
  // a post popup also shows the person's total, on its own line
  const refreshProfile = async () => {
    if (!o.post) return;
    try {
      const res = await sendToBackground({ type: 'xap-totals', recipients: [entry.pubkey], fresh: true });
      const t = res.totals[0]?.[1];
      if (t) o.onProfileTotals?.(t);
      if (!o.isClosed() && t) profileBox.textContent = profileLine(t, handle);
    } catch {
      // the post's own figures are what this popup is for
    }
  };
  const refresh = async () => {
    void refreshProfile();
    try {
      const res = o.post
        ? await sendToBackground({ type: 'xap-post-totals', posts: [{ id: o.post, pubkey: entry.pubkey }], fresh: true })
        : await sendToBackground({ type: 'xap-totals', recipients: [entry.pubkey], fresh: true });
      if (o.isClosed()) return;
      fresh = res.totals[0]?.[1] ?? null;
      if (fresh) o.onTotals?.(fresh);
      if (fresh && fresh.address !== address) {
        addrWarn.textContent = fresh.address
          ? `@${handle} now lists a different address. Don't send to the one below; close this and open it again.`
          : `Couldn't confirm @${handle}'s current address on relays. Don't send yet; close this and try again in a moment.`;
        addrWarn.classList.remove('hidden');
        stale = true;
        update();
      }
      showTotals();
    } catch (e) {
      if (!o.isClosed()) totalsBox.replaceChildren(h('div', { class: 'error', textContent: `Couldn't load Xaps: ${(e as Error).message}` }));
    }
  };
  showTotals();
  void refresh();

  const qrBox = h('div', { class: 'qr-box' });
  const addrBox = h('code', { class: 'addr', textContent: address });
  const copyAddr = h('button', { textContent: 'Copy address' });
  copyAddr.addEventListener('click', () => copy(address, copyAddr, addrBox));
  const amount = h('input', { type: 'text', placeholder: o.receipts ? 'Amount (XMR)' : 'Amount (XMR, optional)', attrs: { inputmode: 'decimal', 'aria-label': 'Amount in XMR' } });
  const amountErr = h('div', { class: 'status error' });
  let usd: number | null = null;
  const fiat = fiatChips(amount, {
    isClosed: o.isClosed,
    onPrice: (p) => {
      usd = p;
      update();
    },
  });
  const uniqueLine = h('div', { class: 'small' });
  const walletLink = h('a', { class: 'button primary', textContent: 'Open in wallet' });
  const copyAmount = h('button', { textContent: 'Copy amount' });
  const sentBtn = h('button', { textContent: 'I sent it' });
  const actions = h('div', { class: 'row' }, walletLink, copyAmount, o.receipts ? sentBtn : '');

  // drawn once, so the amount stays the same through retries (R13); replaced below by the
  // recipient's kept mark, so a popup reopened after paying gives the same amount
  let extra = randomPico();
  // "I sent it" waits for the kept mark, so a locked amount can't miss one already paid
  let markReady = !o.receipts;
  let unique: string | null = null;
  function update() {
    const base = parseXmr(amount.value.trim());
    const total = base ? uniqueAmount(base, extra) : null;
    unique = total ? formatXmr(total) : null;
    amountErr.textContent = amount.value.trim() && !base ? 'Amount must be a number above 0, like 0.05 (up to 12 decimals).' : '';
    const uri = moneroUri(address, { amount: unique ?? undefined });
    if (stale) {
      qrBox.replaceChildren();
      addrBox.classList.add('hidden');
      copyAddr.disabled = copyAmount.disabled = sentBtn.disabled = amount.disabled = true;
      fiat.classList.add('stale');
      uniqueLine.textContent = '';
      walletLink.removeAttribute('href');
      walletLink.setAttribute('aria-disabled', 'true');
      return;
    }
    if (unique && !markReady) {
      // the kept mark may replace the drawn one: nothing payable until it's settled (a storage read)
      qrBox.replaceChildren();
      uniqueLine.textContent = 'Preparing the amount…';
      walletLink.removeAttribute('href');
      walletLink.setAttribute('aria-disabled', 'true');
      copyAmount.disabled = sentBtn.disabled = true;
      return;
    }
    qrBox.replaceChildren(qrSvg(uri));
    // without receipts this is a plain tip, and the amount is optional
    uniqueLine.textContent = unique ? `You'll send ${unique} XMR${usd && total ? ` (≈ ${picoToUsd(total, usd)})` : ''}; the last digits mark this Xap.` : o.receipts ? 'A Xap needs an amount.' : '';
    if (unique || !o.receipts) {
      walletLink.href = uri;
      walletLink.removeAttribute('aria-disabled');
    } else {
      walletLink.removeAttribute('href');
      walletLink.setAttribute('aria-disabled', 'true');
    }
    copyAmount.disabled = !unique;
    sentBtn.disabled = !unique || !markReady;
  }
  amount.addEventListener('input', update);
  // only receipts need a kept mark; keyed by recipient and address, so a new address gets a new one
  const markKey = markFor(entry.pubkey, address, o.post);
  if (o.receipts)
    void (async () => {
      const now = Date.now();
      const marks = await xapMarksItem.getValue();
      const kept = findMark(marks, markKey, now);
      if (o.isClosed()) return;
      if (kept == null) await xapMarksItem.setValue(withMark(marks, markKey, extra, now));
      else if (!amount.readOnly) extra = kept;
    })()
      .catch(() => {})
      .finally(() => {
        markReady = true;
        update();
      });
  copyAmount.addEventListener('click', () => unique && copy(unique, copyAmount, uniqueLine));
  update();

  // R8: an explicit "I sent it", then an explicit yes to a public receipt
  const confirm = h('div', { class: 'xap-confirm hidden' });
  const publishStatus = h('div', { class: 'status', attrs: { role: 'status', 'aria-live': 'polite' } });
  const results = h('ul', { class: 'results' });
  sentBtn.addEventListener('click', () => {
    if (!unique) return;
    amount.readOnly = true;
    sentBtn.disabled = true;
    const sent = unique;
    const publish = h('button', { class: 'primary', textContent: 'Publish receipt' });
    const skip = h('button', { textContent: "Don't publish" });
    let busy = false;
    publish.addEventListener('click', async (e) => {
      if (!e.isTrusted || busy) return;
      busy = true;
      publish.disabled = skip.disabled = true;
      publish.textContent = 'Waiting for signer…';
      publishStatus.className = 'status';
      publishStatus.textContent = 'Approve the receipt in your signer; then it is published.';
      results.replaceChildren();
      try {
        const res = await sendToBackground({ type: 'xap-publish', recipient: entry.pubkey, address, amount: sent, ...(o.post ? { post: o.post } : {}) });
        if (o.isClosed()) return;
        const ok = res.results.filter((r) => r.ok).length;
        results.replaceChildren(...res.results.map((r) => h('li', { textContent: `${r.ok ? '✓' : '✗'} ${r.relay}${r.ok ? '' : `: ${r.message}`}` })));
        if (!ok) throw new Error('Not published; try again.');
        publishStatus.className = 'status ok';
        publishStatus.textContent = `Published to ${ok} of ${res.results.length} relays. Your Xap shows as verifying, then claimed until @${handle} confirms it.`;
        publish.remove();
        skip.textContent = 'Done';
        skip.disabled = false;
        o.onPublished?.();
        void refresh();
      } catch (err) {
        if (o.isClosed()) return;
        publishStatus.className = 'status error';
        publishStatus.textContent = errorText((err as Error).message, handle);
        publish.textContent = 'Try again';
        publish.disabled = skip.disabled = false;
      } finally {
        busy = false;
      }
    });
    skip.addEventListener('click', () => {
      confirm.classList.add('hidden');
      publishStatus.textContent = '';
    });
    confirm.replaceChildren(h('div', { textContent: confirmText(handle, sent, o.post) }), h('div', { class: 'row' }, publish, skip));
    confirm.classList.remove('hidden');
    publish.focus();
  });

  wrap.append(
    totalsBox,
    mineBox,
    profileBox,
    addrWarn,
    qrBox,
    addrBox,
    h('div', { class: 'row' }, copyAddr, amount),
    fiat,
    amountErr,
    uniqueLine,
    actions,
    confirm,
    publishStatus,
    results,
    o.receipts ? '' : h('div', { class: 'small' }, 'Xap receipts are off in XMRadar’s options, so this tip is not recorded.'),
  );
  return wrap;
}

function copy(text: string, btn: HTMLButtonElement, fallback: HTMLElement) {
  const label = btn.textContent;
  navigator.clipboard.writeText(text).then(
    () => {
      btn.textContent = 'Copied';
      setTimeout(() => (btn.textContent = label), 1500);
    },
    () => {
      // clipboard can be blocked; select the text so it can be copied by hand
      getSelection()?.selectAllChildren(fallback);
      btn.textContent = 'Press Ctrl/⌘+C';
    },
  );
}
