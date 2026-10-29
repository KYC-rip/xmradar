import { sendToBackground } from '../../messaging';
import { namesOrder } from '../../log/check';
import { fetchLetter, letterInText } from '../../log/fetch';
import { letterAddressLines, letterCopyWarning } from '../../log/page';
import type { LetterReply, LogPage } from '../../log/service';
import type { Line } from '../../receipts/check';
import { siteInfoOn, xmrSettingsItem } from '../../settings';

/**
 * Letters of guarantee on an order page (PLAN-LOG §3), run inside the receipt watcher: the background
 * says which order this is; the letter comes from one same-origin fetch (when `logFetch` is on), else
 * from the page's text or a copy. The background verifies and saves; the page's addresses are compared
 * here. One fetch per page load, and "Check again".
 */

export interface LetterEntry {
  page: LogPage;
  reply?: LetterReply;
  lines: Line[];
}

interface State {
  page: LogPage;
  reply?: LetterReply;
  status: Line[];
  /** texts already sent for this order, so a re-render doesn't resend them */
  tried: Set<string>;
}

// Firefox: the page's own fetch carries its cookies; Chrome content scripts already fetch as the page
const pageFetch: typeof fetch = (() => {
  const c = (globalThis as { content?: { fetch?: typeof fetch } }).content;
  return c?.fetch ? (input, init) => c.fetch!(input, init) : (input, init) => fetch(input, init);
})();

const WAITING = (p: LogPage): Line => ({
  level: 'off',
  text: p.format === 'mistproof' ? 'Show the MistProof on the page, or copy it: XMRadar checks it then.' : 'Open or copy the letter of guarantee: XMRadar checks it then.',
});

export function letterWatch(opts: { onChange: () => void; fetchOn: () => Promise<boolean> }) {
  let states: State[] = [];
  // listings whose order pages carry an NKIP-0001 receipt (the missing-receipt warning)
  let receiptSites: string[] = [];
  let generation = 0;
  // stop() cancels a letter request still in flight (site info or receipt checks switched off)
  let aborter = new AbortController();

  async function send(s: State, text: string, gen: number) {
    if (s.tried.has(text) || s.reply?.verified) return;
    s.tried.add(text);
    let reply: LetterReply;
    try {
      reply = await sendToBackground({ type: 'log-found', siteId: s.page.siteId, text });
    } catch (e) {
      reply = { verified: false, lines: [{ level: 'caution', text: `Letter not checked: ${(e as Error).message}` }], addresses: [], signedText: '', saved: false };
    }
    if (gen !== generation) return;
    // a failed copy of something else doesn't replace a clearer earlier state
    if (reply.verified || !s.reply || reply.lines.some((l) => l.level !== 'off')) s.reply = reply;
    opts.onChange();
  }

  async function fetchFor(s: State, gen: number) {
    if (!s.page.letterUrl || !(await opts.fetchOn())) {
      s.status = [WAITING(s.page)];
      return opts.onChange();
    }
    s.status = [{ level: 'off', text: 'Getting the letter of guarantee from this site…' }];
    opts.onChange();
    const r = await fetchLetter(s.page.letterUrl, location.origin, pageFetch, aborter.signal);
    if (gen !== generation) return;
    if (!r.ok) {
      s.status = [{ level: 'off', text: `Letter of guarantee not available yet (${r.why}). Open the letter from the page; XMRadar checks it when you copy it.` }];
      return opts.onChange();
    }
    s.status = [{ level: 'off', text: 'Checking the letter of guarantee…' }];
    opts.onChange();
    await send(s, r.text, gen);
  }

  return {
    async start() {
      const gen = generation;
      // no feed without site info: nothing to ask (the background checks both switches again)
      if (!siteInfoOn(await xmrSettingsItem.getValue()) || gen !== generation) return;
      let pages: LogPage[];
      try {
        pages = await sendToBackground({ type: 'log-page' });
      } catch {
        return;
      }
      if (gen !== generation) return;
      // NKIP-0001 listings are checked through their receipt
      receiptSites = [...new Set(pages.filter((p) => p.format === 'nkip01').map((p) => p.name))];
      if (receiptSites.length) opts.onChange();
      states = pages.filter((p) => p.format !== 'nkip01').map((page) => ({ page, status: [], tried: new Set() }));
      for (const s of states) void fetchFor(s, gen);
    },

    /**
     * A letter the page shows (or the user copied) goes to the orders it names (the background checks
     * that strictly), so a page listing several orders doesn't get a wrong-order warning for the rest.
     */
    capture(text: string) {
      const letter = text && letterInText(text);
      if (!letter) return;
      for (const s of states) if (states.length === 1 || namesOrder(letter, s.page.orderId)) void send(s, letter, generation);
    },

    recheck(siteId: string) {
      const s = states.find((x) => x.page.siteId === siteId);
      if (!s) return;
      s.reply = undefined;
      s.tried.clear();
      void fetchFor(s, generation);
    },

    entries(doc: Document): LetterEntry[] {
      // every order id on this page may be shown shortened (0trace: 1c3571ba...0185); none is an address
      const orderIds = states.map((s) => s.page.orderId);
      return states.map((s) => ({
        page: s.page,
        reply: s.reply,
        lines: s.reply ? [...s.reply.lines, ...(s.reply.verified ? letterAddressLines(doc, s.reply.addresses, orderIds) : [])] : s.status,
      }));
    },

    /** a copied address that none of the verified letters on this page names */
    copyWarning(copied: string): string | null {
      const signed = states.flatMap((s) => (s.reply?.verified ? s.reply.addresses : []));
      return signed.length ? letterCopyWarning(copied, signed) : null;
    },

    /** an order on this page still has no verified letter: worth reading the page for one */
    get waiting() {
      return states.some((s) => !s.reply?.verified);
    },

    /** names of the listings that say this order page carries a receipt */
    get receiptSites() {
      return receiptSites;
    },

    stop() {
      generation++;
      aborter.abort();
      aborter = new AbortController();
      states = [];
      receiptSites = [];
    },
  };
}

export type LetterWatch = ReturnType<typeof letterWatch>;
