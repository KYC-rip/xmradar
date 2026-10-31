import type { Event } from 'nostr-tools/pure';
import type { ResolvedIdentity } from './identity/envelope';
import type { Badge } from './identity/resolve';
import type { ProofResult } from './identity/nostr';
import type { ClaimPlace, ClaimValues } from './identity/xclaims';
import type { LetterExport } from './log/export';
import type { LetterReply, LogPage } from './log/service';
import type { SavedLetter } from './log/store';
import type { PageCheck } from './receipts/check';
import type { ReceiptExport } from './receipts/export';
import type { PublicRecord, SavedReceipt } from './receipts/store';
import type { SiteEntry } from './sites/feed';
import type { Lookalike } from './sites/lookalike-text';
import type { AddressCheck } from './xmr/address';

/** background → content */
export interface OpenComposerMsg {
  type: 'open-composer';
  sessionId: string;
  selection?: string;
  srcUrl?: string;
  /** true when triggered by keyboard command rather than a right-click */
  fromCommand?: boolean;
  /** true when the user picked "Copy to Nostr" in X's share menu */
  fromShareMenu?: boolean;
}

/** background → content: open the Monero tip popup */
export interface OpenTipMsg {
  type: 'open-tip';
}

export type XmrbioResult = { found: false } | { found: true; identity: ResolvedIdentity; check: AddressCheck };

export interface ResolveHandlesResult {
  /** [normalized handle, badge]; handles without a source map to a badge with no primary */
  badges: [string, Badge][];
  /** handles over the rate limit, to ask about again later */
  pending: string[];
}

/** Xap totals for one recipient, amounts as decimal XMR so no BigInt crosses messaging. */
export interface XapTotals {
  verified: string;
  verifiedTippers: number;
  /** the user's own receipts still waiting for confirmations */
  verifying: string;
  claimed: string;
  claimedTippers: number;
  /** the recipient's current address the claimed figure was counted against */
  address: string | null;
  /** the user's own receipts to this recipient, newest first */
  mine: { amount: string; state: 'verified' | 'verifying' | 'claimed' | 'uncounted'; recorded: boolean }[];
  /** when it was counted (ms) */
  at: number;
}

export interface XapTotalsResult {
  totals: [string, XapTotals][];
  /** recipients over the rate limit, to ask about again later */
  pending: string[];
}

/** Post figures keyed by `<bound pubkey>:<status id>` (src/xap/post.ts postKey); `pending` were rate limited. */
export interface XapPostTotalsResult {
  totals: [string, XapTotals][];
  pending: { id: string; pubkey: string }[];
}

/** The xmr.club listings for a tab's host (PLAN-SITEFEED); `outOfDate` once the kept feed has expired. */
export interface SiteInfo {
  sites: SiteEntry[];
  /** the host poses as a listed service (PLAN-LOOKALIKE), even with no listing of its own */
  lookalike?: Lookalike | null;
  outOfDate: boolean;
  /** unix seconds */
  issuedAt: number | null;
}

export interface XapPublishResult {
  results: RelayResult[];
  id: string;
}

/** What the options page asks to change; the background validates and fills in the rest. */
export type SetupRequest =
  | { type: 'add-address'; address: string }
  | { type: 'remove-address' }
  | { type: 'link-x'; tweetUrl: string }
  | { type: 'unlink-x' };

export interface SetupStatus {
  pubkey: string;
  relays: string[];
  unreadable: string[];
  /** monero payto in the current kind 10133 */
  address: { address: string; check: AddressCheck } | null;
  /** twitter claim for the confirmed handle in the current kind 10011 */
  link: { handle: string; tweetUrl: string; proof: ProofResult } | null;
  /** the confirmed handle on xmr.bio; null when no handle is confirmed */
  xmrbio: XmrbioStatus | null;
}

export type XmrbioStatus =
  | { found: false }
  | { found: true; address: string; check: AddressCheck; /** xmr.bio holds a nostr proof for this pubkey */ linked: boolean }
  | { found: 'error'; reason: string };

export interface PreparedSetup {
  id: string;
  kind: number;
  pubkey: string;
  before: string[][] | null;
  after: string[][];
  /** relays that were read and will be published to */
  relays: string[];
  /** relays that couldn't be read; skipped for this change, and tags only stored there may be lost */
  unreadable: string[];
}

export interface ImageInfo {
  sha256: string;
  mime: string;
  size: number;
  dim?: string;
}

export interface RelayResult {
  relay: string;
  ok: boolean;
  message: string;
}

/** content/options → background */
export type BgRequest =
  | { type: 'fetch-image'; sessionId: string; url: string }
  | { type: 'upload-image'; sessionId: string; url: string; sha256: string; auth: string }
  | { type: 'publish'; sessionId: string; event: Event; sourceUrl: string; text: string }
  | { type: 'republish'; sessionId: string; event: Event; relays: string[] }
  | { type: 'check-duplicate'; sessionId: string; sourceUrl: string; text: string }
  | { type: 'close-session'; sessionId: string }
  | { type: 'load-nip65'; pubkey: string }
  | { type: 'test-signer' }
  | { type: 'xmrbio-resolve'; handle: string }
  | { type: 'resolve-handles'; handles: string[] }
  /** what a profile page shows in one place (PLAN-XCLAIMS); null claim = seen without one */
  | { type: 'x-claims-seen'; handle: string; place: ClaimPlace; claim: ClaimValues | null; tweetId?: string }
  | { type: 'setup-status' }
  | { type: 'setup-prepare'; action: SetupRequest }
  | { type: 'setup-sign'; id: string }
  | { type: 'setup-retry'; id: string }
  | { type: 'setup-cancel' }
  | { type: 'burner-import'; email: string; token: string }
  | { type: 'burner-burn' }
  | { type: 'burner-forget' }
  | { type: 'share-menu-copy' }
  | { type: 'xap-totals'; recipients: string[]; fresh?: boolean }
  | { type: 'xap-post-totals'; posts: { id: string; pubkey: string }[]; fresh?: boolean }
  | { type: 'xap-publish'; recipient: string; address: string; amount: string; post?: string }
  | { type: 'xmr-price' }
  | { type: 'receipt-found'; text: string; eventId?: string }
  | { type: 'receipt-badge'; level: 'ok' | 'caution' | 'warn' | 'none' }
  | { type: 'site-info'; host: string }
  | { type: 'site-tab'; tabId: number }
  | { type: 'receipts-list' }
  | { type: 'receipt-delete'; commitment: string }
  | { type: 'receipt-export'; commitment: string }
  | { type: 'receipt-record'; commitment: string }
  | { type: 'log-page' }
  | { type: 'log-found'; siteId: string; text: string }
  | { type: 'letters-list' }
  | { type: 'letter-delete'; id: string }
  | { type: 'letter-export'; id: string };

/** Port name for creating a free burner inbox; the open port keeps the worker busy during the proof of work. */
export const BURNER_CREATE_PORT = 'burner-create';

/** background → options, on the burner-create port */
export type BurnerCreateEvent = { type: 'progress'; hashes: number } | { type: 'done'; email: string } | { type: 'error'; message: string };

export type BgResponse<T extends BgRequest['type']> = T extends 'fetch-image'
  ? ImageInfo
  : T extends 'upload-image'
    ? { url: string }
    : T extends 'publish'
      ? { results: RelayResult[]; nevent: string; naddr?: string }
      : T extends 'republish'
        ? { results: RelayResult[] }
      : T extends 'check-duplicate'
        ? { duplicate: boolean }
        : T extends 'load-nip65'
          ? { relays: string[] }
          : T extends 'test-signer'
            ? { pubkey: string }
            : T extends 'close-session'
              ? null
              : T extends 'xmrbio-resolve'
                ? XmrbioResult
                : T extends 'resolve-handles'
                  ? ResolveHandlesResult
                  : T extends 'setup-status'
                    ? SetupStatus
                    : T extends 'setup-prepare'
                      ? PreparedSetup
                      : T extends 'setup-sign' | 'setup-retry'
                        ? { results: RelayResult[] }
                        : T extends 'setup-cancel' | 'burner-forget'
                          ? null
                          : T extends 'burner-import'
                            ? { email: string }
                            : T extends 'burner-burn'
                              ? { burned: boolean }
                              : T extends 'share-menu-copy'
                                ? null
                                : T extends 'xap-totals'
                                  ? XapTotalsResult
                                  : T extends 'xap-post-totals'
                                    ? XapPostTotalsResult
                                  : T extends 'xap-publish'
                                    ? XapPublishResult
                                    : T extends 'xmr-price'
                                      ? { usd: number }
                                      : T extends 'x-claims-seen'
                                        ? { changed: boolean }
                                      : T extends 'receipt-found'
                                        ? PageCheck
                                        : T extends 'receipt-badge'
                                          ? null
                                          : T extends 'site-info' | 'site-tab'
                                            ? SiteInfo
                                        : T extends 'receipts-list'
                                          ? SavedReceipt[]
                                          : T extends 'receipt-delete'
                                            ? null
                                            : T extends 'receipt-export'
                                              ? ReceiptExport
                                              : T extends 'receipt-record'
                                                ? PublicRecord
                                                : T extends 'log-page'
                                                  ? LogPage[]
                                                  : T extends 'log-found'
                                                    ? LetterReply
                                                    : T extends 'letters-list'
                                                      ? SavedLetter[]
                                                      : T extends 'letter-delete'
                                                        ? null
                                                        : T extends 'letter-export'
                                                          ? LetterExport
                                                          : never;

/** Every response is wrapped so errors survive the message boundary. */
export type Wrapped<T> = { ok: true; data: T } | { ok: false; error: string };

export async function sendToBackground<R extends BgRequest>(req: R): Promise<BgResponse<R['type']>> {
  const res = (await browser.runtime.sendMessage(req)) as Wrapped<BgResponse<R['type']>> | undefined;
  if (!res) throw new Error('No response from background');
  if (!res.ok) throw new Error(res.error);
  return res.data;
}
