import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { base64 } from '@scure/base';

/**
 * MistProof (Mistex): `{alg: "Ed25519", format: "mistex-receipt/1", key_id, payload, signature}`, an
 * Ed25519 signature over the exact UTF-8 bytes of the `payload` string, checked with the key from the
 * signed xmr.club feed (`log.ed25519_key`). `key_id` is the first 8 bytes of SHA-256 over that key, in
 * hex, and must match it. PLAN-LOG §0, Round 2 item 5.
 */

export const MAX_MISTPROOF_BYTES = 16 * 1024;

export interface MistProof {
  order: string;
  issuer: string;
  issuedAt: string;
  expiresAt: string;
  send: { coin: string; network: string; amount: string; depositAddress: string };
  receive: { coin: string; network: string; amountEstimate: string; address: string };
  rateType: string;
  /** the signed payload, exactly as signed, for the card and the export */
  payload: string;
}

export type MistProofResult = { ok: true; proof: MistProof } | { ok: false; reason: 'format' | 'key' | 'signature'; detail: string };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, max = 200): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;
const opt = (v: unknown) => (typeof v === 'string' ? v : '');

function decode64(s: unknown, len: number): Uint8Array | null {
  if (typeof s !== 'string') return null;
  try {
    const b = base64.decode(s);
    return b.length === len ? b : null;
  } catch {
    return null;
  }
}

export function verifyMistProof(json: string, keyB64: string): MistProofResult {
  if (new TextEncoder().encode(json).length > MAX_MISTPROOF_BYTES) return { ok: false, reason: 'format', detail: 'Too large' };
  const key = decode64(keyB64, 32);
  if (!key) return { ok: false, reason: 'key', detail: 'No usable Ed25519 key' };
  let r: unknown;
  try {
    r = JSON.parse(json);
  } catch {
    return { ok: false, reason: 'format', detail: 'Not JSON' };
  }
  if (!isObj(r) || r.alg !== 'Ed25519' || r.format !== 'mistex-receipt/1' || typeof r.payload !== 'string') return { ok: false, reason: 'format', detail: 'Not a MistProof' };
  if (r.key_id !== bytesToHex(sha256(key)).slice(0, 16)) return { ok: false, reason: 'key', detail: 'Signed for another key' };
  const sig = decode64(r.signature, 64);
  if (!sig) return { ok: false, reason: 'format', detail: 'Bad signature encoding' };
  let valid = false;
  try {
    valid = ed25519.verify(sig, new TextEncoder().encode(r.payload), key);
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, reason: 'signature', detail: "The signature doesn't match" };

  // only a verified payload is read
  let p: unknown;
  try {
    p = JSON.parse(r.payload);
  } catch {
    return { ok: false, reason: 'format', detail: 'Payload is not JSON' };
  }
  if (!isObj(p) || !str(p.order, 80) || !isObj(p.send) || !isObj(p.receive) || !str(p.send.deposit_address, 200) || !str(p.receive.address, 200)) {
    return { ok: false, reason: 'format', detail: 'Payload is missing the order or addresses' };
  }
  const s = p.send;
  const v = p.receive;
  return {
    ok: true,
    proof: {
      order: p.order,
      issuer: opt(p.issuer),
      issuedAt: opt(p.issued_at),
      expiresAt: opt(p.expires_at),
      send: { coin: opt(s.coin), network: opt(s.network), amount: opt(s.amount), depositAddress: s.deposit_address as string },
      receive: { coin: opt(v.coin), network: opt(v.network), amountEstimate: opt(v.amount_estimate), address: v.address as string },
      rateType: opt(p.rate_type),
      payload: r.payload,
    },
  };
}
