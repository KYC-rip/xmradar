import { sendToBackground } from '../messaging';
import { LETTER_EXPORT_WARNING } from '../log/export';
import type { SavedLetter } from '../log/store';
import { EXPORT_WARNING } from '../receipts/export';
import type { SavedReceipt } from '../receipts/store';
import { lookupWaitMs } from '../receipts/witness';
import { swapRecordDaysOf } from '../receipts/cleanup';
import { logFetchOn, patchSettings, patchXmrSettings, receiptsOn, settingsItem, siteInfoOn, siteWarningsOn, swapRecordDaysItem, swapRecordsCleanedItem, xmrSettingsItem } from '../settings';
import { part, setStatus } from './dom';

/**
 * Options → Swap receipts (PLAN-NKIP01 §1.3, §12): the receipts saved in this browser, Export and
 * Delete, and the public-record check, which runs only on request and only an hour after the order.
 * Verified letters of guarantee (PLAN-LOG §5) are listed with them, tagged "Letter".
 */

const DELETE_CONFIRM_MS = 5_000;
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text = '', cls = '') => {
  const e = document.createElement(tag);
  if (text) e.textContent = text;
  if (cls) e.className = cls;
  return e;
};

function download(name: string, data: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function recordText(s: SavedReceipt, now: number): string {
  const p = s.publicRecord;
  if (p) {
    const when = new Date(p.checkedAt).toLocaleString();
    const box = p.saltBoxMissing ? ' The exchange didn’t add the salt box NKIP-0001 R17 requires: keep this receipt, it’s your only copy of the salt.' : '';
    return p.seen.length ? `Seen on ${p.seen.length} of ${p.asked.length} relays (${when}).${box}` : `Not found on ${p.asked.length} relays (${when}).`;
  }
  const wait = lookupWaitMs(s, now);
  return wait ? `Public record: can be checked in ${Math.ceil(wait / 60_000)} min (relays would see your IP asking about it).` : 'Public record: not checked.';
}

export async function mountReceiptsPanel(root: HTMLElement) {
  const toggle = part<HTMLInputElement>(root, 'receipts', 'check');
  const list = part<HTMLElement>(root, 'receipts', 'list');
  const status = part<HTMLElement>(root, 'receipts', 'status');
  const exportAll = part<HTMLButtonElement>(root, 'receipts', 'export-all');

  // letter fetches need receipt checks and site info (PLAN-LOG Round 3 switch matrix)
  const logFetch = part<HTMLInputElement>(root, 'receipts', 'log-fetch');
  const showChecks = async () => {
    const s = await settingsItem.getValue();
    toggle.checked = receiptsOn(s);
    logFetch.checked = logFetchOn(s);
    logFetch.disabled = !receiptsOn(s) || !siteInfoOn(await xmrSettingsItem.getValue());
  };
  await showChecks();
  settingsItem.watch(() => void showChecks());
  xmrSettingsItem.watch(() => void showChecks());
  toggle.addEventListener('change', () => void patchSettings({ receiptsCheck: toggle.checked }));
  logFetch.addEventListener('change', () => void patchSettings({ logFetch: logFetch.checked }));

  // site info from xmr.club; warnings need site info, so they follow it off
  const siteInfo = part<HTMLInputElement>(root, 'receipts', 'site-info');
  const siteWarnings = part<HTMLInputElement>(root, 'receipts', 'site-warnings');
  const showSite = (s: Awaited<ReturnType<typeof xmrSettingsItem.getValue>>) => {
    siteInfo.checked = siteInfoOn(s);
    siteWarnings.checked = siteWarningsOn(s);
    siteWarnings.disabled = !siteInfoOn(s);
  };
  showSite(await xmrSettingsItem.getValue());
  xmrSettingsItem.watch((s) => showSite(s));
  siteInfo.addEventListener('change', () => void patchXmrSettings({ siteInfo: siteInfo.checked }));
  siteWarnings.addEventListener('change', () => void patchXmrSettings({ siteWarnings: siteWarnings.checked }));

  // automatic deletion: the background cleans when this changes and at least daily; the list follows
  const keepDays = part<HTMLSelectElement>(root, 'receipts', 'keep-days');
  keepDays.value = String(swapRecordDaysOf(await swapRecordDaysItem.getValue()));
  swapRecordDaysItem.watch((d) => (keepDays.value = String(swapRecordDaysOf(d))));
  keepDays.addEventListener('change', () => void swapRecordDaysItem.setValue(swapRecordDaysOf(Number(keepDays.value))));
  swapRecordsCleanedItem.watch((c) => {
    if (!c) return;
    const n = c.receipts + c.letters;
    setStatus(status, `Deleted ${n} old ${n === 1 ? 'record' : 'letters and receipts'}.`, 'ok');
    void load();
  });

  let saved: SavedReceipt[] = [];
  let letters: SavedLetter[] = [];

  async function load() {
    try {
      [saved, letters] = await Promise.all([sendToBackground({ type: 'receipts-list' }), sendToBackground({ type: 'letters-list' })]);
    } catch (e) {
      return setStatus(status, (e as Error).message, 'error');
    }
    render();
  }

  function render() {
    const now = Date.now();
    exportAll.disabled = !saved.length && !letters.length;
    if (!saved.length && !letters.length) {
      list.replaceChildren(el('p', 'No receipts or letters saved yet. They appear here when you open an order page that carries one.', 'row-hint'));
      return;
    }
    const receiptCards = saved.map((s) => {
        const r = s.receipt;
        const card = el('div', '', 'card pad');
        const expired = r.expires_at * 1000 <= now;
        card.append(
          el('h2', `${r.order_id} · ${r.issuer}`),
          el('div', `${r.deposit_asset} → ${r.payout_asset} · ${new Date(s.savedAt).toLocaleString()}${expired ? ' · Expired' : ''}`, 'row-hint'),
          el('div', recordText(s, now), 'row-hint'),
        );
        const row = el('div', '', 'row');
        const exp = el('button', 'Export');
        exp.addEventListener('click', async () => {
          try {
            download(`receipt-${r.issuer}-${r.order_id}.json`, await sendToBackground({ type: 'receipt-export', commitment: s.commitment }));
            setStatus(status, EXPORT_WARNING, 'warn');
          } catch (e) {
            setStatus(status, (e as Error).message, 'error');
          }
        });
        const check = el('button', 'Check public record');
        check.disabled = lookupWaitMs(s, now) > 0;
        check.title = 'Asks up to 6 relays for this order’s attestation. They see your IP asking about it.';
        check.addEventListener('click', async () => {
          check.disabled = true;
          setStatus(status, 'Asking relays…');
          try {
            s.publicRecord = await sendToBackground({ type: 'receipt-record', commitment: s.commitment });
            setStatus(status, '');
          } catch (e) {
            setStatus(status, (e as Error).message, 'error');
          }
          render();
        });
        const del = deleteButton(() => sendToBackground({ type: 'receipt-delete', commitment: s.commitment }));
        row.append(exp, check, del);
        card.append(row);
        return card;
      });
    const letterCards = letters.map((l) => {
      const card = el('div', '', 'card pad');
      const title = el('h2', `${l.orderId} · ${l.siteName} `);
      title.append(el('span', 'Letter', 'tag'));
      card.append(
        title,
        el('div', `${l.format === 'mistproof' ? 'MistProof' : 'PGP letter of guarantee'} · ${new Date(l.savedAt).toLocaleString()}`, 'row-hint'),
        el('div', l.page, 'row-hint'),
      );
      const row = el('div', '', 'row');
      const exp = el('button', 'Export');
      exp.addEventListener('click', async () => {
        try {
          download(`letter-${l.siteId}-${l.orderId}.json`, await sendToBackground({ type: 'letter-export', id: l.id }));
          setStatus(status, LETTER_EXPORT_WARNING, 'warn');
        } catch (e) {
          setStatus(status, (e as Error).message, 'error');
        }
      });
      row.append(exp, deleteButton(() => sendToBackground({ type: 'letter-delete', id: l.id })));
      card.append(row);
      return card;
    });
    // newest first, receipts and letters together
    const at = new Map<HTMLElement, number>([...receiptCards.map((c, i) => [c, saved[i]!.savedAt] as const), ...letterCards.map((c, i) => [c, letters[i]!.savedAt] as const)]);
    list.replaceChildren(...[...at.keys()].sort((a, b) => at.get(b)! - at.get(a)!));
  }

  /** Delete in two steps, like Burn: Firefox options pages have no window.confirm in every context. */
  function deleteButton(remove: () => Promise<unknown>) {
    const del = el('button', 'Delete');
    let armed: ReturnType<typeof setTimeout> | null = null;
    del.addEventListener('click', async () => {
      if (!armed) {
        del.textContent = 'Confirm delete';
        armed = setTimeout(() => ((armed = null), (del.textContent = 'Delete')), DELETE_CONFIRM_MS);
        return;
      }
      clearTimeout(armed);
      await remove().catch((e) => setStatus(status, (e as Error).message, 'error'));
      await load();
    });
    return del;
  }

  exportAll.addEventListener('click', async () => {
    try {
      const all = await Promise.all(saved.map((s) => sendToBackground({ type: 'receipt-export', commitment: s.commitment })));
      const allLetters = await Promise.all(letters.map((l) => sendToBackground({ type: 'letter-export', id: l.id })));
      download('xmradar-receipts.json', [...all, ...allLetters]);
      setStatus(status, allLetters.length ? `${EXPORT_WARNING} ${LETTER_EXPORT_WARNING}` : EXPORT_WARNING, 'warn');
    } catch (e) {
      setStatus(status, (e as Error).message, 'error');
    }
  });

  await load();
}
