import { ed25519 } from '@noble/curves/ed25519.js';
import { hexToBytes } from '@noble/hashes/utils.js';

/** xmr.bio service keys (ed25519, hex). A set, so a key rotation can ship both keys. */
export const PINNED_XMRBIO_KEYS: ReadonlySet<string> = new Set(['fb9c9025822ed260821a09121fbf97a8e1bf6321749feb834d6740ce516dff94']);

export interface SignedEnvelope {
  payload: string;
  signature: string;
  public_key: string;
  alg: 'ed25519';
}

const HEX64 = /^[0-9a-f]{64}$/;
const HEX128 = /^[0-9a-f]{128}$/;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string';

/**
 * Verify the signature over the exact payload bytes with a pinned key, then parse it.
 * The payload is only parsed after the signature checks out; `data` is still `unknown`
 * and must go through a type-specific parser.
 */
export function verifySignedEnvelope(env: unknown, pinnedKeys: ReadonlySet<string>): { data: unknown; key: string } {
  if (!isObj(env) || !isStr(env.payload) || !isStr(env.signature) || !isStr(env.public_key)) throw new Error('Malformed signed response');
  if (env.alg !== 'ed25519') throw new Error('Unsupported signature algorithm');
  const key = env.public_key.toLowerCase();
  const sig = env.signature.toLowerCase();
  if (!HEX64.test(key) || !HEX128.test(sig)) throw new Error('Malformed signed response');
  if (!pinnedKeys.has(key)) throw new Error('Signed by an unknown key');
  let valid = false;
  try {
    valid = ed25519.verify(hexToBytes(sig), new TextEncoder().encode(env.payload), hexToBytes(key));
  } catch {
    valid = false;
  }
  if (!valid) throw new Error('Bad signature');
  try {
    return { data: JSON.parse(env.payload), key };
  } catch {
    throw new Error('Signed payload is not JSON');
  }
}

export interface IdentityProof {
  type: string;
  identifier: string;
  verifiedAt: string;
}

/** Payload of `GET /v1/bio/resolve/:handle` (v2). */
export interface ResolvedIdentity {
  handle: string;
  address: string;
  displayName: string;
  verifiedAt: string;
  proofs: IdentityProof[];
  resolvedAt: string;
  /** the pinned key that signed the response */
  signedBy: string;
}

export const normalizeHandle = (h: string) => h.trim().replace(/^@/, '').toLowerCase();

export const HANDLE_RE = /^[A-Za-z0-9_]{1,15}$/;

export const toTimestamp = (s: string) => {
  // xmr.bio mixes ISO and SQLite "YYYY-MM-DD HH:MM:SS" (UTC) timestamps
  const t = Date.parse(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(\.\d+)?$/.test(s) ? `${s.replace(' ', 'T')}Z` : s);
  return Number.isFinite(t) ? t : NaN;
};

export function parseResolvedIdentity(raw: unknown, signedBy: string): ResolvedIdentity {
  if (!isObj(raw)) throw new Error('Bad payload');
  if (raw.v !== 2 || raw.service !== 'xmr.bio') throw new Error('Unsupported payload version');
  const { handle, address, display_name, verified_at, proofs, resolved_at } = raw;
  if (!isStr(handle) || !HANDLE_RE.test(handle)) throw new Error('Bad handle in payload');
  if (!isStr(address) || !isStr(verified_at) || !isStr(resolved_at)) throw new Error('Bad payload fields');
  if (Number.isNaN(toTimestamp(resolved_at))) throw new Error('Bad resolved_at');
  if (!Array.isArray(proofs)) throw new Error('Bad proofs');
  return {
    handle,
    address,
    displayName: isStr(display_name) ? display_name.slice(0, 100) : handle,
    verifiedAt: verified_at,
    resolvedAt: resolved_at,
    signedBy,
    proofs: proofs.flatMap((p): IdentityProof[] =>
      isObj(p) && isStr(p.type) && isStr(p.identifier) && isStr(p.verified_at) ? [{ type: p.type, identifier: p.identifier, verifiedAt: p.verified_at }] : [],
    ),
  };
}

export const RESOLVE_MAX_AGE_MS = 10 * 60_000;

/**
 * RESOLVE-1: a resolve response must be for the handle we asked about, recent,
 * and not older than the last one we accepted for that handle.
 */
export function checkResolveFreshness(id: ResolvedIdentity, requested: string, lastAccepted: number | undefined, now = Date.now()) {
  if (normalizeHandle(id.handle) !== normalizeHandle(requested)) throw new Error('Response is for a different handle');
  const at = toTimestamp(id.resolvedAt);
  if (at < now - RESOLVE_MAX_AGE_MS) throw new Error('Response is too old');
  if (at > now + RESOLVE_MAX_AGE_MS) throw new Error('Response is from the future');
  if (lastAccepted != null && at < lastAccepted) throw new Error('Response is older than one already seen');
  return at;
}
