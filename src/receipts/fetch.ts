import { parseStrict } from './jcs';
import { parseManifest, policyMatches, type Manifest } from './verify';

/**
 * The only two requests the order-page check makes (PLAN-NKIP01 §4.2, §5): the issuer's manifest and
 * the policy text, both from the issuer's own host, which is the page the user has open. No cookies,
 * no referrer, no redirects, no HTTP cache, at most 256 KB, 10 s.
 */

export const MAX_BYTES = 256 * 1024;
const TIMEOUT_MS = 10_000;

const init = (): RequestInit => ({
  credentials: 'omit',
  referrerPolicy: 'no-referrer',
  redirect: 'error',
  cache: 'no-store',
  signal: AbortSignal.timeout(TIMEOUT_MS),
});

/** The body, refused past MAX_BYTES while it's still arriving. */
async function boundedBytes(res: Response): Promise<Uint8Array> {
  const declared = Number(res.headers.get('content-length'));
  if (declared > MAX_BYTES) throw new Error('Response too large');
  if (!res.body) {
    const all = new Uint8Array(await res.arrayBuffer());
    if (all.length > MAX_BYTES) throw new Error('Response too large');
    return all;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_BYTES) {
      await reader.cancel();
      throw new Error('Response too large');
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

const mediaType = (res: Response) => (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();

/** `https://<issuer>/.well-known/nkip01.json`, checked against the schema and the issuer it was asked for. */
export async function fetchManifest(issuer: string, f: typeof fetch = fetch): Promise<Manifest> {
  const res = await f(`https://${issuer}/.well-known/nkip01.json`, init());
  if (!res.ok) throw new Error(`Manifest unavailable (${res.status})`);
  if (mediaType(res) !== 'application/json') throw new Error('Manifest is not JSON');
  const m = parseManifest(parseStrict(new TextDecoder('utf-8', { fatal: true }).decode(await boundedBytes(res))));
  if ('error' in m) throw new Error(`Bad manifest: ${m.error}`);
  if (m.manifest.issuer !== issuer) throw new Error('Manifest is for another issuer');
  return m.manifest;
}

/**
 * The policy the receipt names: its URL comes from the manifest and must be on the issuer's own host;
 * the hash is over the raw bytes (§11), which are kept as they are for the archive.
 */
export async function fetchPolicy(m: Manifest, policyHash: string, f: typeof fetch = fetch): Promise<{ url: string; bytes: Uint8Array; matches: boolean }> {
  const entry = m.policies.find((p) => p.policy_hash === policyHash);
  if (!entry) throw new Error('The manifest lists no policy with this hash');
  const url = new URL(entry.url);
  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== m.issuer || url.port || url.username || url.password) throw new Error('Policy is not on the issuer’s host');
  const res = await f(url.href, init());
  if (!res.ok) throw new Error(`Policy unavailable (${res.status})`);
  if (!mediaType(res).startsWith('text/')) throw new Error('Policy is not text');
  const bytes = await boundedBytes(res);
  return { url: url.href, bytes, matches: policyMatches(bytes, policyHash) };
}
