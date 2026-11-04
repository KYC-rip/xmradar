import type { SignerMode } from '../settings';

/** The signer page found no NIP-07 signer at all: not a refusal, not an error of the signer's. */
export class NoSignerError extends Error {}

/**
 * Which key does it (PLAN-MANAGEDID): `managed` the XMRadar identity; `signer` only the user's signer;
 * `auto` the signer, and the XMRadar identity only when there's no signer at all (`fallback` makes it and
 * switches the mode). A refusal or any other signer error is never papered over.
 */
export async function bySignerMode<T>(mode: SignerMode, viaSigner: () => Promise<T>, viaManaged: () => Promise<T>, fallback: () => Promise<void>): Promise<T> {
  if (mode === 'managed') return viaManaged();
  try {
    return await viaSigner();
  } catch (e) {
    if (!(e instanceof NoSignerError) || mode === 'signer') throw e;
    await fallback();
    return viaManaged();
  }
}
