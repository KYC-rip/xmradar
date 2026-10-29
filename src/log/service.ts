import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { Line } from '../receipts/check';
import type { SiteFeed } from '../sites/feed';
import { checkLetter, type LetterAddress, type LetterDeps } from './check';
import { matchOrderPage } from './order';
import { saveLetter, type LetterStore } from './store';

/**
 * The background half of letter checks (PLAN-LOG §2–§5): which order this tab's page is, and checking
 * and saving a letter the content script found there. The page URL is always the tab's, from the
 * browser; a message only names the listing (`siteId`) among those that URL matches.
 */

/** What a page learns about its order: never the feed's `log`, `orderUrl` or any key (step 2 note). */
export interface LogPage {
  siteId: string;
  name: string;
  format: 'pgp' | 'mistproof' | 'nkip01';
  orderId: string;
  letterUrl: string | null;
}

/** What a page learns about a letter it sent: the check, without the key. */
export interface LetterReply {
  verified: boolean;
  lines: Line[];
  addresses: LetterAddress[];
  signedText: string;
  saved: boolean;
  saveError?: string;
}

export function logPages(feed: SiteFeed | null, pageUrl: string): LogPage[] {
  if (!feed) return [];
  return matchOrderPage(feed.sites, pageUrl).map((m) => ({ siteId: m.site.id, name: m.site.name, format: m.log.format, orderId: m.orderId, letterUrl: m.letterUrl }));
}

export interface FoundDeps extends LetterDeps {
  store: LetterStore;
  now: () => number;
  /** asked again right before saving: checks switched off while this one ran save nothing */
  mayStore?: () => Promise<boolean>;
}

/** origin and path: what is kept of the page */
const pageOf = (u: string) => {
  const p = new URL(u);
  return `${p.origin}${p.pathname}`;
};

/** Checks a letter for the listing `siteId` on this page; saves it only if it verified. */
export async function checkFoundLetter(feed: SiteFeed | null, pageUrl: string, siteId: string, text: string, deps: FoundDeps): Promise<LetterReply> {
  const m = feed && matchOrderPage(feed.sites, pageUrl).find((x) => x.site.id === siteId);
  if (!feed || !m || m.log.format === 'nkip01') throw new Error('Not an order page with a letter');
  const c = await checkLetter(text, { siteName: m.site.name, log: m.log, orderId: m.orderId }, deps, new Date(deps.now()));
  const reply: LetterReply = { verified: c.verified, lines: c.lines, addresses: c.addresses, signedText: c.signedText, saved: false };
  if (!c.verified) return reply;
  if (deps.mayStore && !(await deps.mayStore())) {
    reply.saveError = 'Not saved: letter checks were switched off';
    return reply;
  }
  const log = m.log;
  try {
    await saveLetter(deps.store, {
      id: bytesToHex(sha256(new TextEncoder().encode(text))),
      siteId: m.site.id,
      siteName: m.site.name,
      format: log.format,
      orderId: m.orderId,
      page: pageOf(pageUrl),
      text,
      ...(log.format === 'pgp' ? { fingerprint: log.fingerprint, key: log.publicKey! } : { key: log.ed25519Key }),
      feedIssuedAt: feed.issuedAt,
      ...(c.signedAt ? { signedAt: c.signedAt } : {}),
      savedAt: deps.now(),
    });
    reply.saved = true;
  } catch (e) {
    reply.saveError = `Not saved: ${(e as Error).message}`;
  }
  return reply;
}

/** The parts of a message sender these requests look at. */
export interface PageSender {
  id?: string;
  frameId?: number;
  tab?: { id?: number; url?: string };
}

export interface RequestDeps extends Omit<FoundDeps, 'mayStore'> {
  runtimeId: string;
  /** receipt checks and site info both on (PLAN-LOG Round 3 switch matrix) */
  checksOn: () => Promise<boolean>;
  feed: () => Promise<SiteFeed | null>;
  /** false once this tab has used up its checks for the minute */
  budget: (tabId: number) => boolean;
}

/** The top frame of a tab in this extension, with the tab's URL from the browser (never the message). */
function topFrame(sender: PageSender, runtimeId: string): { tabId: number; pageUrl: string } {
  const tabId = sender.tab?.id;
  const pageUrl = sender.tab?.url;
  if (sender.id !== runtimeId || tabId == null || sender.frameId !== 0 || !pageUrl) throw new Error('Not allowed');
  return { tabId, pageUrl };
}

/** The background's `log-page` and `log-found` handlers. */
export function letterRequests(deps: RequestDeps) {
  return {
    async logPage(sender: PageSender): Promise<LogPage[]> {
      const { pageUrl } = topFrame(sender, deps.runtimeId);
      if (!(await deps.checksOn())) return [];
      return logPages(await deps.feed(), pageUrl);
    },
    async logFound(msg: { siteId?: unknown; text?: unknown }, sender: PageSender): Promise<LetterReply> {
      const { tabId, pageUrl } = topFrame(sender, deps.runtimeId);
      if (!(await deps.checksOn())) throw new Error('Letter checks are off');
      if (typeof msg.siteId !== 'string' || typeof msg.text !== 'string') throw new Error('Bad letter');
      // the same budget as receipts: a page can't make the worker verify without end
      if (!deps.budget(tabId)) throw new Error('Too many checks on this page');
      return checkFoundLetter(await deps.feed(), pageUrl, msg.siteId, msg.text, { ...deps, mayStore: deps.checksOn });
    },
  };
}
