import { sendToBackground } from '../../messaging';
import { formatXmr } from '../../xap/amount';
import { isPlausibleUsd, USD_SHORTCUTS, usdToPico } from '../../xap/price';
import { h } from './dom';

/**
 * $1 / $5 / $10 / $20 under a tip amount: a click fills the input with that many dollars in XMR.
 * Hidden until the price loads, and stays hidden if it can't.
 */
export function fiatChips(amount: HTMLInputElement, opts: { isClosed?: () => boolean; onPrice?: (usd: number) => void } = {}): HTMLElement {
  const row = h('div', { class: 'row fiat hidden', attrs: { role: 'group', 'aria-label': 'Amount in dollars' } });
  void sendToBackground({ type: 'xmr-price' }).then(
    (res) => {
      const usd = res?.usd;
      // the popup was closed meanwhile, or the answer isn't a price
      if ((opts.isClosed?.() ?? !row.isConnected) || !isPlausibleUsd(usd)) return;
      row.replaceChildren(
        ...USD_SHORTCUTS.map((d) => {
          const xmr = formatXmr(usdToPico(d, usd));
          const chip = h('button', { class: 'chip', textContent: `$${d}`, title: `${xmr} XMR at $${usd.toFixed(2)}` });
          chip.type = 'button';
          chip.addEventListener('click', () => {
            if (amount.readOnly || amount.disabled) return;
            amount.value = xmr;
            amount.dispatchEvent(new Event('input'));
          });
          return chip;
        }),
        h('span', { class: 'small', textContent: `1 XMR ≈ $${usd.toFixed(2)}` }),
      );
      row.classList.remove('hidden');
      opts.onPrice?.(usd);
    },
    () => {},
  );
  return row;
}
