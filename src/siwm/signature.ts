import { ed25519 } from '@noble/curves/ed25519.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { base58Decode } from '../xmr/address';

/**
 * A Monero message signature checked the way `monero-wallet-rpc verify` does (PLAN-SIWM), spend mode
 * only: NKIP-0003 refuses a signature made with the view key. Only public keys are involved.
 */

const L = 2n ** 252n + 27742317777372353535851937790883648493n;
const PREFIX_STANDARD = 18;
const PREFIX_SUBADDRESS = 42;
const DOMAIN = new TextEncoder().encode('MoneroMessageSignature\0');

const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};
const littleEndian = (b: Uint8Array) => b.reduceRight((n, x) => (n << 8n) | BigInt(x), 0n);
const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

function varint(n: number): Uint8Array {
  const out: number[] = [];
  do {
    const b = n & 0x7f;
    n = Math.floor(n / 128);
    out.push(n ? b | 0x80 : b);
  } while (n);
  return Uint8Array.from(out);
}

/** The public spend and view keys of a mainnet standard address or subaddress; null for anything else. */
export function addressKeys(address: string): { spend: Uint8Array; view: Uint8Array } | null {
  let raw: Uint8Array;
  try {
    raw = base58Decode(address);
  } catch {
    return null;
  }
  if (raw.length !== 69 || (raw[0] !== PREFIX_STANDARD && raw[0] !== PREFIX_SUBADDRESS)) return null;
  if (!sameBytes(keccak_256(raw.subarray(0, 65)).subarray(0, 4), raw.subarray(65))) return null;
  return { spend: raw.slice(1, 33), view: raw.slice(33, 65) };
}

/** Monero's `check_signature`: c == H_s(hash ‖ P ‖ r·G + c·P) with c, r < ℓ and P a sound point. */
function checkSignature(hash: Uint8Array, pub: Uint8Array, c: bigint, r: bigint): boolean {
  let P;
  try {
    P = ed25519.Point.fromBytes(pub);
  } catch {
    return false;
  }
  if (P.isSmallOrder()) return false;
  const comm = ed25519.Point.BASE.multiplyUnsafe(r).add(P.multiplyUnsafe(c));
  return littleEndian(keccak_256(concat(hash, pub, comm.toBytes()))) % L === c;
}

/**
 * True only for a spend-key signature of `message` by `address`: SigV1 (keccak of the message) or SigV2
 * (domain-separated, bound to the address's keys, mode 0 = spend).
 */
export function verifySpendSignature(message: string, address: string, signature: string): boolean {
  const keys = addressKeys(address);
  const version = signature.slice(0, 5);
  if (!keys || (version !== 'SigV1' && version !== 'SigV2')) return false;
  let raw: Uint8Array;
  try {
    raw = base58Decode(signature.slice(5));
  } catch {
    return false;
  }
  if (raw.length !== 64) return false;
  const c = littleEndian(raw.subarray(0, 32));
  const r = littleEndian(raw.subarray(32));
  if (c >= L || r >= L) return false;
  const data = new TextEncoder().encode(message);
  const hash = version === 'SigV1' ? keccak_256(data) : keccak_256(concat(DOMAIN, keys.spend, keys.view, Uint8Array.of(0), varint(data.length), data));
  return checkSignature(hash, keys.spend, c, r);
}
