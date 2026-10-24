import type { Event } from 'nostr-tools/pure';
import type { ResolvedIdentity } from './identity/envelope';
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
  | { type: 'xmrbio-resolve'; handle: string };

export type BgResponse<T extends BgRequest['type']> = T extends 'fetch-image'
  ? ImageInfo
  : T extends 'upload-image'
    ? { url: string }
    : T extends 'publish'
      ? { results: RelayResult[]; nevent: string }
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
                : never;

/** Every response is wrapped so errors survive the message boundary. */
export type Wrapped<T> = { ok: true; data: T } | { ok: false; error: string };

export async function sendToBackground<R extends BgRequest>(req: R): Promise<BgResponse<R['type']>> {
  const res = (await browser.runtime.sendMessage(req)) as Wrapped<BgResponse<R['type']>> | undefined;
  if (!res) throw new Error('No response from background');
  if (!res.ok) throw new Error(res.error);
  return res.data;
}
