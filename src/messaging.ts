import type { Event } from 'nostr-tools/pure';
import type { ResolvedIdentity } from './identity/envelope';
import type { Badge } from './identity/resolve';
import type { ProofResult } from './identity/nostr';
import type { AddressCheck } from './xmr/address';

/** background → content */
export interface OpenComposerMsg {
  type: 'open-composer';
  sessionId: string;
  selection?: string;
  srcUrl?: string;
  /** true when triggered by keyboard command rather than a right-click */
  fromCommand?: boolean;
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
}

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
  | { type: 'check-duplicate'; sessionId: string; sourceUrl: string; text: string }
  | { type: 'close-session'; sessionId: string }
  | { type: 'load-nip65'; pubkey: string }
  | { type: 'test-signer' }
  | { type: 'xmrbio-resolve'; handle: string }
  | { type: 'resolve-handles'; handles: string[] }
  | { type: 'setup-status' }
  | { type: 'setup-prepare'; action: SetupRequest }
  | { type: 'setup-sign'; id: string }
  | { type: 'setup-retry'; id: string }
  | { type: 'setup-cancel' };

export type BgResponse<T extends BgRequest['type']> = T extends 'fetch-image'
  ? ImageInfo
  : T extends 'upload-image'
    ? { url: string }
    : T extends 'publish'
      ? { results: RelayResult[]; nevent: string; naddr?: string }
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
                        : T extends 'setup-cancel'
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
