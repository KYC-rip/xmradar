import { storage } from 'wxt/utils/storage';
import { sendToBackground, type RecordLinks } from '../messaging';
import type { Line } from '../receipts/check';
import { amount } from '../receipts/units';
import type { SiteFeed } from '../sites/feed';
import { LETTER_EXPORT_WARNING } from '../log/export';
import type { SavedLetter } from '../log/store';
import { EXPORT_WARNING } from '../receipts/export';
import type { SavedReceipt } from '../receipts/store';
import { lookupWaitMs } from '../receipts/witness';
import { swapRecordDaysOf } from '../receipts/cleanup';
import { siteLogo } from './site-logo';
import type { LogoPack } from '../sites/logos';
import { copyReportsOn, logoPackItem, logFetchOn, patchSettings, patchXmrSettings, receiptsOn, settingsItem, siteInfoOn, siteWarningsOn, swapRecordDaysItem, swapRecordsCleanedItem, xmrSettingsItem } from '../settings';
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

/** watched only to refresh the Open order links; the links themselves come from the background */
const siteFeedItem = storage.defineItem<SiteFeed | null>('local:siteFeed', { fallback: null });

const when = (secs: number) => new Date(secs * 1000).toLocaleString();

/** What the receipt says, as signed (PLAN-RECORDVIEW); the salt is never shown. Text only. */
export function receiptView(s: SavedReceipt, sig: Line | null): HTMLElement {
  const r = s.receipt;
  const dl = el('dl', '', 'rec-view');
  const row = (k: string, v: string, cls = '') => dl.append(el('dt', k), el('dd', v, cls));
  row('Order', r.order_id, 'mono wrap');
  row('Issuer', r.issuer);
  row('You send', `${amount(r.deposit_amount, r.deposit_asset, r.deposit_address)}, to`);
  row('', r.deposit_address, 'mono wrap');
  row('You get', `${amount(r.payout_amount, r.payout_asset, r.payout_address)}, at`);
  row('', r.payout_address, 'mono wrap');
  if (r.refund_address) row('Refund address', r.refund_address, 'mono wrap');
  row('Rate', r.rate_type);
  row('Created', when(r.created_at));
  row('Expires', when(r.expires_at));
  row('Policy hash', r.policy_hash, 'mono wrap');
  row('Key id', r.key_id, 'mono wrap');
  row('Signature', r.sig, 'mono wrap');
  if (r.salt) row('Salt', 'Kept, not shown (Export includes it).');
  row('Signature check', sig ? sig.text : 'Checking…', sig ? `sig-${sig.level}` : '');
  return dl;
}

/** A MistProof letter's signed payload, laid out to read; null when it isn't one. */
export function mistproofPayload(text: string): string | null {
  try {
    const outer = JSON.parse(text) as { payload?: unknown };
    return typeof outer?.payload === 'string' ? JSON.stringify(JSON.parse(outer.payload), null, 2) : null;
  } catch {
    return null;
  }
}

/** A saved letter: PGP text as verified; a MistProof payload laid out (Export keeps the exact bytes). Text only. */
export function letterView(l: SavedLetter): HTMLElement {
  const box = el('div', '', 'rec-view');
  if (l.fingerprint) box.append(el('div', `Key fingerprint: ${l.fingerprint}`, 'row-hint mono wrap'));
  box.append(el('div', 'Verified with the key in xmr.club’s feed when it was saved.', 'row-hint'));
  const laid = l.format === 'mistproof' ? mistproofPayload(l.text) : null;
  if (laid) box.append(el('div', 'What was signed, laid out to read; Export keeps it exactly as signed.', 'row-hint'));
  box.append(el('pre', laid ?? l.text, 'letter-text'));
  return box;
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
  // the warning page's Report button needs the warning page
  const copyReports = part<HTMLInputElement>(root, 'receipts', 'copy-reports');
  const showSite = (s: Awaited<ReturnType<typeof xmrSettingsItem.getValue>>) => {
    siteInfo.checked = siteInfoOn(s);
    siteWarnings.checked = siteWarningsOn(s);
    siteWarnings.disabled = !siteInfoOn(s);
    copyReports.checked = copyReportsOn(s);
    copyReports.disabled = !siteWarningsOn(s);
  };
  showSite(await xmrSettingsItem.getValue());
  xmrSettingsItem.watch((s) => showSite(s));
  siteInfo.addEventListener('change', () => void patchXmrSettings({ siteInfo: siteInfo.checked }));
  siteWarnings.addEventListener('change', () => void patchXmrSettings({ siteWarnings: siteWarnings.checked }));
  copyReports.addEventListener('change', () => void patchXmrSettings({ copyReports: copyReports.checked }));

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
  let links: RecordLinks = { receipts: {}, letters: {} };
  // which cards show their View, kept across re-renders; signature lines asked once per receipt
  const viewing = new Set<string>();
  const sigs = new Map<string, Line>();
  // only the newest answer counts: a slow one from an older feed or setting never overwrites it
  let linkAsk = 0;
  const askLinks = async () => {
    const mine = ++linkAsk;
    const l = await sendToBackground({ type: 'record-links' }).catch(() => null);
    return { stale: mine !== linkAsk, links: { receipts: l?.receipts ?? {}, letters: l?.letters ?? {} } };
  };
  const refreshLinks = async () => {
    const a = await askLinks();
    if (a.stale) return;
    links = a.links;
    render();
  };
  siteFeedItem.watch(() => void refreshLinks());
  xmrSettingsItem.watch(() => void refreshLinks());
  let pack: LogoPack | null = null;
  // a pack that arrives or changes while the page is open; it wins over a read still in flight
  let packWatched = false;
  logoPackItem.watch((p) => {
    pack = p;
    packWatched = true;
    render();
  });

  async function load() {
    try {
      let read: LogoPack | null;
      let asked: Awaited<ReturnType<typeof askLinks>>;
      [saved, letters, read, asked] = await Promise.all([
        sendToBackground({ type: 'receipts-list' }),
        sendToBackground({ type: 'letters-list' }),
        logoPackItem.getValue(),
        askLinks(),
      ]);
      if (!packWatched) pack = read;
      if (!asked.stale) links = asked.links;
      // records may have been saved again with a newer manifest: check signatures again when viewed
      sigs.clear();
    } catch (e) {
      return setStatus(status, (e as Error).message, 'error');
    }
    render();
  }

  const titled = (logo: HTMLElement, title: HTMLElement) => {
    const row = el('div', '', 'rec-head');
    row.append(logo, title);
    return row;
  };

  const asking = new Set<string>();
  const askSig = async (commitment: string) => {
    if (asking.has(commitment)) return;
    asking.add(commitment);
    const line = await sendToBackground({ type: 'receipt-signature', commitment }).catch((e: Error): Line => ({ level: 'warn', text: e.message }));
    asking.delete(commitment);
    sigs.set(commitment, line);
    render();
  };

  /** Open order (when the feed gives the order page) and a View toggle for one card. */
  function extras(key: string, link: string | undefined, view: () => HTMLElement, onOpen?: () => void) {
    const out: HTMLElement[] = [];
    let host = '';
    try {
      if (link && new URL(link).protocol === 'https:') host = new URL(link).host;
    } catch {}
    if (host) {
      const a = el('a', 'Open order', 'button-link');
      Object.assign(a, { href: link, target: '_blank', rel: 'noopener noreferrer' });
      a.title = `Opens ${host}. The exchange sees you looking at this order.`;
      out.push(a);
    }
    const id = `view-${key.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
    const btn = el('button', viewing.has(key) ? 'Hide' : 'View');
    btn.setAttribute('aria-expanded', String(viewing.has(key)));
    btn.setAttribute('aria-controls', id);
    btn.addEventListener('click', () => {
      if (viewing.has(key)) viewing.delete(key);
      else {
        viewing.add(key);
        onOpen?.();
      }
      render();
    });
    out.unshift(btn);
    const panel = viewing.has(key) ? view() : null;
    if (panel) panel.id = id;
    return { buttons: out, panel };
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
          titled(siteLogo(pack, { host: r.issuer }, r.issuer), el('h2', `${r.order_id} · ${r.issuer}`)),
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
            // the check saved the exchange's manifest as it is now
            sigs.delete(s.commitment);
            if (viewing.has(`r:${s.commitment}`)) void askSig(s.commitment);
            setStatus(status, '');
          } catch (e) {
            setStatus(status, (e as Error).message, 'error');
          }
          render();
        });
        const del = deleteButton(() => sendToBackground({ type: 'receipt-delete', commitment: s.commitment }));
        // an open View whose check was cleared (list reloaded) asks again
        if (viewing.has(`r:${s.commitment}`) && !sigs.has(s.commitment)) void askSig(s.commitment);
        const x = extras(`r:${s.commitment}`, links.receipts[s.commitment], () => receiptView(s, sigs.get(s.commitment) ?? null), () => {
          if (!sigs.has(s.commitment)) void askSig(s.commitment);
        });
        row.append(...x.buttons, exp, check, del);
        card.append(row);
        if (x.panel) card.append(x.panel);
        return card;
      });
    const letterCards = letters.map((l) => {
      const card = el('div', '', 'card pad');
      const title = el('h2', `${l.orderId} · ${l.siteName} `);
      title.append(el('span', 'Letter', 'tag'));
      card.append(
        titled(siteLogo(pack, { siteId: l.siteId }, l.siteName), title),
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
      const x = extras(`l:${l.id}`, links.letters[l.id], () => letterView(l));
      row.append(...x.buttons, exp, deleteButton(() => sendToBackground({ type: 'letter-delete', id: l.id })));
      card.append(row);
      if (x.panel) card.append(x.panel);
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
