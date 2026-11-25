import { getEventHash, type Event, type EventTemplate } from 'nostr-tools/pure';
import { NoSignerError } from '../identity/signer-mode';

/**
 * Bridge to the standalone Android GeckoView shell's NIP-55 native signer (`MainActivity` + `Nip55Bridge.kt`).
 *
 * On desktop Chrome/Firefox (`getPlatformInfo().os !== 'android'`) and AMO Firefox Android (no `nativeMessaging`
 * permission, so `sendNativeMessage` is absent), `probeAndroidSigner` caches `{ androidApp: false, nip55Available: false }`
 * immediately with zero native messaging calls or delays.
 *
 * Inside the standalone Android app (`rip.kyc.xmradar`), `androidApp` is true so `background.ts` NEVER opens
 * `https://xmradar.app/signer`. Transient probe errors on Android are never cached as non-Android.
 */

export const ANDROID_NATIVE_APP = 'xmradar_android';
export const COMPOSER_KINDS: ReadonlySet<number> = new Set([1, 24242, 30023]);

const HEX64_RE = /^[0-9a-f]{64}$/;
const HEX128_RE = /^[0-9a-f]{128}$/;
const PROBE_TIMEOUT_MS = 5_000;
const SIGNER_TIMEOUT_MS = 120_000;

export class BackgroundPermissionMissingError extends Error {}

export interface NativeRuntimeLike {
  sendNativeMessage?: (application: string, message: object) => Promise<unknown>;
  getPlatformInfo?: () => Promise<{ os?: string }>;
  getManifest?: () => { permissions?: string[] };
}

export interface AndroidSignerProbe {
  androidApp: boolean;
  nip55Available: boolean;
  signerPackage?: string | null;
}

// Only cache a definitive non-Android browser result (desktop OS, absent sendNativeMessage, or explicit
// `androidApp: false`). On Android, transient errors are never cached and `nip55Available` is probed live
// so installing or removing Amber takes effect without restarting the app.
let confirmedNonAndroid = false;

export function resetAndroidSignerProbeCache(): void {
  confirmedNonAndroid = false;
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string, onTimeout?: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout?.();
      reject(new Error(`${label} timed out`));
    }, ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

async function sendNative(
  runtime: NativeRuntimeLike | undefined,
  payload: object,
  timeoutMs: number,
  label: string,
  onTimeout?: () => void,
): Promise<Record<string, unknown>> {
  if (typeof runtime?.sendNativeMessage !== 'function') {
    throw new Error('Native messaging unavailable');
  }
  const raw = await withTimeout(runtime.sendNativeMessage(ANDROID_NATIVE_APP, payload), timeoutMs, label, onTimeout);
  let parsed: unknown = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`Invalid native signer JSON (${label})`);
    }
  }
  if (!parsed || typeof parsed !== 'object') throw new Error(`Invalid native signer response (${label})`);
  return parsed as Record<string, unknown>;
}

function cancelNativeSigner(runtime: NativeRuntimeLike | undefined): void {
  if (typeof runtime?.sendNativeMessage !== 'function') return;
  void Promise.resolve(runtime.sendNativeMessage(ANDROID_NATIVE_APP, { type: 'cancel_signer' })).catch(() => {});
}

export async function probeAndroidSigner(runtime: NativeRuntimeLike | undefined): Promise<AndroidSignerProbe> {
  if (confirmedNonAndroid) return { androidApp: false, nip55Available: false };

  // AMO Firefox Android and desktop builds omit `nativeMessaging` from manifest.json; short-circuit cleanly.
  if (typeof runtime?.getManifest === 'function') {
    try {
      const perms = runtime.getManifest()?.permissions;
      if (Array.isArray(perms) && !perms.includes('nativeMessaging')) {
        confirmedNonAndroid = true;
        return { androidApp: false, nip55Available: false };
      }
    } catch {
      // Fall through to platform/capability checks.
    }
  }

  // Short-circuit non-Android desktop browsers immediately without ever calling sendNativeMessage.
  let platformOs: string | undefined;
  if (typeof runtime?.getPlatformInfo === 'function') {
    try {
      const info = await runtime.getPlatformInfo();
      platformOs = info?.os;
      if (platformOs && platformOs !== 'android') {
        confirmedNonAndroid = true;
        return { androidApp: false, nip55Available: false };
      }
    } catch {
      // Fall through to sendNativeMessage capability check.
    }
  }

  if (typeof runtime?.sendNativeMessage !== 'function') {
    confirmedNonAndroid = true;
    return { androidApp: false, nip55Available: false };
  }

  try {
    const res = await sendNative(runtime, { type: 'probe' }, PROBE_TIMEOUT_MS, 'Android signer probe');
    if (res.androidApp === true) {
      return {
        androidApp: true,
        nip55Available: res.nip55Available === true,
        signerPackage: typeof res.signerPackage === 'string' ? res.signerPackage : null,
      };
    }
    if (res.androidApp === false) {
      confirmedNonAndroid = true;
      return { androidApp: false, nip55Available: false };
    }
    // Unexpected response shape on Android: never poison the cache or open xmradar.app/signer.
    if (platformOs === 'android') {
      throw new Error('Android signer bridge returned an unexpected probe response');
    }
    confirmedNonAndroid = true;
    return { androidApp: false, nip55Available: false };
  } catch (e) {
    // On Android with nativeMessaging present (standalone APK), NEVER cache a transient error as
    // non-Android — doing so would flip the worker into opening xmradar.app/signer.
    if (platformOs === 'android') {
      throw e instanceof Error ? e : new Error(String(e));
    }
    // Without platform info, still avoid permanently caching a timeout; only cache non-timeout absence.
    return { androidApp: false, nip55Available: false };
  }
}

export async function nativeGetPublicKey(runtime: NativeRuntimeLike | undefined): Promise<string> {
  const res = await sendNative(
    runtime,
    { type: 'get_public_key' },
    SIGNER_TIMEOUT_MS,
    'Android signer',
    () => cancelNativeSigner(runtime),
  );
  if (res.noSigner === true) {
    throw new NoSignerError(typeof res.error === 'string' ? res.error : 'No Android Nostr signer found (install Amber)');
  }
  if (typeof res.error === 'string' && res.error) {
    throw new Error(res.error);
  }
  const pubkey = typeof res.pubkey === 'string' ? res.pubkey.toLowerCase() : '';
  if (!HEX64_RE.test(pubkey)) {
    throw new Error('Android signer returned an invalid public key');
  }
  return pubkey;
}

export async function nativeSignEvent(
  runtime: NativeRuntimeLike | undefined,
  template: EventTemplate,
  pubkey: string,
  quiet = false,
): Promise<Event> {
  const cleanPubkey = pubkey.toLowerCase();
  if (!HEX64_RE.test(cleanPubkey)) throw new Error('Invalid signing pubkey');
  const cleanEvent: EventTemplate = {
    kind: template.kind,
    created_at: template.created_at,
    tags: template.tags,
    content: template.content,
  };
  const res = await sendNative(
    runtime,
    { type: 'sign_event', eventJson: JSON.stringify(cleanEvent), pubkey: cleanPubkey, quiet },
    SIGNER_TIMEOUT_MS,
    'Android signer',
    () => cancelNativeSigner(runtime),
  );
  if (res.noSigner === true) {
    throw new NoSignerError(typeof res.error === 'string' ? res.error : 'No Android Nostr signer found (install Amber)');
  }
  if (res.backgroundPermissionMissing === true) {
    throw new BackgroundPermissionMissingError(
      typeof res.error === 'string' ? res.error : 'Background signing permission not granted in signer app',
    );
  }
  if (typeof res.error === 'string' && res.error) {
    throw new Error(res.error);
  }
  if (res.event && typeof res.event === 'object') {
    return res.event as Event;
  }
  // NIP-55 fallback for signers that return only `result` (128-hex signature) without full `event` JSON.
  // Caller still runs `checkSigned(template, event, pubkey)` to verify the BIP-340 Schnorr signature.
  const sig = typeof res.sig === 'string' ? res.sig.toLowerCase() : '';
  if (HEX128_RE.test(sig)) {
    const unsigned = { ...cleanEvent, pubkey: cleanPubkey };
    return { ...unsigned, id: getEventHash(unsigned), sig };
  }
  throw new Error('Android signer did not return a signed event');
}

export async function nativeClearSigner(runtime: NativeRuntimeLike | undefined): Promise<void> {
  if (confirmedNonAndroid || typeof runtime?.sendNativeMessage !== 'function') return;
  await sendNative(runtime, { type: 'clear_signer' }, PROBE_TIMEOUT_MS, 'Clear Android signer').catch(() => {});
}
