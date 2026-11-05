import type { PostRelays, PostRelaySource } from './nostr/post-relays';
import type { Event } from 'nostr-tools/pure';
import type { ResolvedIdentity } from './identity/envelope';
import type { Badge } from './identity/resolve';
import type { ProofResult } from './identity/nostr';
import type { ClaimPlace, ClaimValues } from './identity/xclaims';
import type { LetterExport } from './log/export';
import type { LetterReply, LogPage } from './log/service';
import type { SavedLetter } from './log/store';
import type { Line, PageCheck } from './receipts/check';
import type { ReceiptExport } from './receipts/export';
import type { PublicRecord, SavedReceipt } from './receipts/store';
import type { SiteEntry } from './sites/feed';
import type { GuardAnswer } from './sites/guard-rules';
import type { ReportStatus } from './sites/report';
import type { Lookalike } from './sites/lookalike-text';
import type { AddressCheck } from './xmr/address';
import type { SiwmView, SubmitResult } from './siwm/service';

/** Order pages for saved records (PLAN-RECORDVIEW), by receipt commitment and by letter id. */
export interface RecordLinks {
  receipts: Record<string, string>;
  letters: Record<string, string>;
}

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
  /** the last "list me on xmr.bio" try for this handle, key and address (PLAN-XMRBIOLIST) */
  listing?: { status: 'listed' | 'exists' | 'exists-unlisted' | 'failed'; at: number; error?: string } | null;
}

export type XmrbioStatus =
  | { found: false }
  | {
      found: true;
      address: string;
      check: AddressCheck;
      /** xmr.bio holds a nostr proof for this pubkey */
      linked: boolean;
      /** in XMRadar's copy of the signed directory; absent when no copy is held (/resolve doesn't say) */
      listed?: boolean;
    }
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

import type { SuggestResult } from './ai/tags';
import type { AiSource } from './settings';

/** content/options → background */
export type BgRequest =
  | { type: 'fetch-image'; sessionId: string; url: string }
  | { type: 'upload-image'; sessionId: string; url: string; sha256: string; auth: string }
  | { type: 'publish'; sessionId: string; event: Event; sourceUrl: string; text: string }
  /** `sourceUrl`: the post copied, so a retry that is the first to succeed still marks it (PLAN-SYNCEDMARK) */
  | { type: 'republish'; sessionId: string; event: Event; relays: string[]; sourceUrl?: string }
  | { type: 'check-duplicate'; sessionId: string; sourceUrl: string; text: string }
  | { type: 'close-session'; sessionId: string }
  /** AI tag suggestions (PLAN-TAGS): whether Suggest can show, and one request on a trusted click */
  | { type: 'ai-tags-ready'; sessionId: string }
  | { type: 'suggest-tags'; sessionId: string; text: string; have?: string[]; source?: AiSource }
  /** the composer's Auto switch: `auto` only, for the source the composer was opened with */
  | { type: 'set-ai-auto'; sessionId: string; on: boolean; source: AiSource }
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
  /** xo (PLAN-MONEROLIKE): send or take back the user's xo on an X post */
  | { type: 'xo-send'; post: string; author: string | null; handle: string }
  | { type: 'xo-undo'; post: string }
  /** the setup card on X (PLAN-XOREACH): is setup done for this key; open setup.html; a proof tweet seen */
  | { type: 'setup-card-state' }
  | { type: 'open-setup'; handleHint?: string }
  | { type: 'proof-tweet-seen'; handle: string; statusId: string }
  /** the identity card in Options (PLAN-MANAGEDID) */
  | { type: 'identity-state' }
  /** "List me on xmr.bio" pressed (PLAN-XMRBIOLIST) */
  | { type: 'xmrbio-list' }
  | { type: 'identity-mode'; mode: 'auto' | 'signer' | 'managed' }
  | { type: 'identity-export' }
  | { type: 'identity-delete' }
  | { type: 'xap-post-totals'; posts: { id: string; pubkey: string }[]; fresh?: boolean }
  | { type: 'xap-publish'; recipient: string; address: string; amount: string; post?: string }
  | { type: 'xmr-price' }
  | { type: 'receipt-found'; text: string; eventId?: string }
  | { type: 'receipt-badge'; level: 'ok' | 'caution' | 'warn' | 'none' }
  | { type: 'site-info'; host: string }
  | { type: 'site-tab'; tabId: number }
  | { type: 'guard-check'; hash: string }
  | { type: 'guard-continue'; hash: string }
  | { type: 'guard-report'; hash: string }
  | { type: 'receipts-list' }
  | { type: 'receipt-delete'; commitment: string }
  | { type: 'receipt-export'; commitment: string }
  | { type: 'receipt-record'; commitment: string }
  | { type: 'record-links' }
  | { type: 'receipt-signature'; commitment: string }
  | { type: 'log-page' }
  | { type: 'log-found'; siteId: string; text: string }
  | { type: 'letters-list' }
  | { type: 'letter-delete'; id: string }
  | { type: 'letter-export'; id: string }
  | { type: 'capture-quote'; sessionId: string; rect: { x: number; y: number; width: number; height: number }; view: { width: number; height: number }; client?: { width: number; height: number } }
  | { type: 'xap-inbox-check' }
  | { type: 'xap-inbox-read' }
  | { type: 'update-check-now' }
  | { type: 'relays-in-use' }
  | { type: 'siwm-open'; uri: string }
  | { type: 'siwm-get'; id: string }
  | { type: 'siwm-submit'; id: string; signature: string }
  | { type: 'siwm-close'; id: string };

/** Port name for creating a free burner inbox; the open port keeps the worker busy during the proof of work. */
export const BURNER_CREATE_PORT = 'burner-create';

/** background → options, on the burner-create port */
export type BurnerCreateEvent = { type: 'progress'; hashes: number } | { type: 'done'; email: string } | { type: 'error'; message: string };

export type BgResponse<T extends BgRequest['type']> = T extends 'fetch-image'
  ? ImageInfo
  : T extends 'upload-image'
    ? { url: string }
    : T extends 'publish'
      ? { results: RelayResult[]; nevent: string; naddr?: string; skipped: string[]; overridden: boolean; source: PostRelaySource }
      : T extends 'republish'
        ? { results: RelayResult[] }
      : T extends 'check-duplicate'
        ? { duplicate: boolean }
      : T extends 'ai-tags-ready'
        ? { ready: boolean; local: boolean; source: AiSource; auto: boolean; autoAdd: boolean }
      : T extends 'set-ai-auto'
        ? { ok: true }
      : T extends 'suggest-tags'
        ? SuggestResult
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
                                  : T extends 'xmrbio-list'
                                    ? SetupStatus
                                  : T extends 'identity-state'
                                    ? { mode: 'auto' | 'signer' | 'managed'; managed: string | null; current: string | null }
                                  : T extends 'identity-mode' | 'identity-delete'
                                    ? null
                                  : T extends 'identity-export'
                                    ? { nsec: string | null }
                                  : T extends 'xo-send' | 'xo-undo'
                                    ? { ok: boolean; id?: string; error?: string }
                                  : T extends 'setup-card-state'
                                    ? { complete: boolean }
                                  : T extends 'open-setup' | 'proof-tweet-seen'
                                    ? null
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
                                        : T extends 'guard-check'
                                          ? GuardAnswer
                                        : T extends 'guard-continue'
                                          ? { url: string }
                                        : T extends 'guard-report'
                                          ? { status: ReportStatus }
                                        : T extends 'receipts-list'
                                          ? SavedReceipt[]
                                          : T extends 'receipt-delete'
                                            ? null
                                            : T extends 'receipt-export'
                                              ? ReceiptExport
                                              : T extends 'receipt-record'
                                                ? PublicRecord
                                              : T extends 'record-links'
                                                ? RecordLinks
                                              : T extends 'receipt-signature'
                                                ? Line
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
                                                          : T extends 'capture-quote'
                                                            ? { dataUrl: string }
                                                          : T extends 'xap-inbox-check' | 'xap-inbox-read'
                                                            ? null
                                                          : T extends 'update-check-now'
                                                            ? { latest: string | null; error?: string }
                                                          : T extends 'relays-in-use'
                                                            ? PostRelays & { hasPubkey: boolean }
                                                            : T extends 'siwm-open'
                                                              ? { id: string } | null
                                                              : T extends 'siwm-get'
                                                                ? SiwmView | null
                                                                : T extends 'siwm-submit'
                                                                  ? SubmitResult
                                                                  : T extends 'siwm-close'
                                                                    ? null
                                                                    : never;

/** Every response is wrapped so errors survive the message boundary. */
export type Wrapped<T> = { ok: true; data: T } | { ok: false; error: string };

export async function sendToBackground<R extends BgRequest>(req: R): Promise<BgResponse<R['type']>> {
  const res = (await browser.runtime.sendMessage(req)) as Wrapped<BgResponse<R['type']>> | undefined;
  if (!res) throw new Error('No response from background');
  if (!res.ok) throw new Error(res.error);
  return res.data;
}
