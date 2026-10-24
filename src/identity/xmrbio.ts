import type { XmrbioResult } from '../messaging';
import { validateMoneroAddress } from '../xmr/address';
import { checkResolveFreshness, HANDLE_RE, normalizeHandle, parseResolvedIdentity, PINNED_XMRBIO_KEYS, verifySignedEnvelope } from './envelope';

export const XMRBIO_API = 'https://api.kyc.rip/v1/bio';

/** [handle, resolved_at ms] of the newest response accepted per handle; entries, not an object, so "constructor" etc. are plain keys */
export type SeenEntries = [string, number][];

const MAX_SEEN = 500;

/**
 * On-demand, user-initiated lookup of one handle (never called passively).
 * Returns the updated seen map alongside the result so the caller can persist it.
 */
export async function resolveXmrbio(
  handle: string,
  seen: SeenEntries,
  opts: { fetch?: typeof fetch; now?: number; keys?: ReadonlySet<string> } = {},
): Promise<{ result: XmrbioResult; seen: SeenEntries }> {
  const h = normalizeHandle(handle);
  if (!HANDLE_RE.test(h)) throw new Error('Not a valid X handle');
  const res = await (opts.fetch ?? fetch)(`${XMRBIO_API}/resolve/${h}`, {
    credentials: 'omit',
    cache: 'no-store',
    signal: AbortSignal.timeout(10_000),
  });
  if (res.status === 404) return { result: { found: false }, seen };
  if (!res.ok) throw new Error(`xmr.bio lookup failed (${res.status})`);
  const { data, key } = verifySignedEnvelope(await res.json(), opts.keys ?? PINNED_XMRBIO_KEYS);
  const identity = parseResolvedIdentity(data, key);
  const at = checkResolveFreshness(identity, h, new Map(seen).get(h), opts.now);
  const next: SeenEntries = [...seen.filter(([k]) => k !== h), [h, at] as [string, number]].slice(-MAX_SEEN);
  return { result: { found: true, identity, check: validateMoneroAddress(identity.address) }, seen: next };
}
