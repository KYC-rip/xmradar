import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex } from '@noble/hashes/utils.js';

export type AddressType = 'standard' | 'subaddress' | 'integrated';

export type AddressCheck = { ok: true; type: AddressType; paymentId?: string } | { ok: false; reason: string };

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
// Monero base58 encodes 8-byte blocks; a block of n bytes becomes ENCODED_SIZES[n] chars
const ENCODED_SIZES = [0, 2, 3, 5, 6, 7, 9, 10, 11];
const FULL_BLOCK = 8;
const FULL_ENCODED = 11;

const MAINNET: Record<number, { type: AddressType; length: number }> = {
  18: { type: 'standard', length: 95 },
  42: { type: 'subaddress', length: 95 },
  19: { type: 'integrated', length: 106 },
};
const OTHER_NETS: Record<number, string> = {
  53: 'testnet', 63: 'testnet', 54: 'testnet',
  24: 'stagenet', 36: 'stagenet', 25: 'stagenet',
};

function decodeBlock(chunk: string, out: Uint8Array, offset: number) {
  const size = ENCODED_SIZES.indexOf(chunk.length);
  if (size <= 0) throw new Error('bad block length');
  let n = 0n;
  for (const c of chunk) {
    const d = ALPHABET.indexOf(c);
    if (d < 0) throw new Error('bad character');
    n = n * 58n + BigInt(d);
  }
  if (n >> BigInt(size * 8)) throw new Error('block overflow');
  for (let i = size - 1; i >= 0; i--) {
    out[offset + i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return size;
}

export function base58Decode(s: string): Uint8Array {
  const full = Math.floor(s.length / FULL_ENCODED);
  const rest = s.length % FULL_ENCODED;
  const restSize = ENCODED_SIZES.indexOf(rest);
  if (restSize < 0) throw new Error('bad length');
  const out = new Uint8Array(full * FULL_BLOCK + restSize);
  for (let i = 0; i < full; i++) decodeBlock(s.slice(i * FULL_ENCODED, (i + 1) * FULL_ENCODED), out, i * FULL_BLOCK);
  if (rest) decodeBlock(s.slice(full * FULL_ENCODED), out, full * FULL_BLOCK);
  return out;
}

export function base58Encode(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += FULL_BLOCK) {
    const block = bytes.subarray(i, i + FULL_BLOCK);
    let n = 0n;
    for (const b of block) n = (n << 8n) | BigInt(b);
    let chunk = '';
    for (let j = 0; j < ENCODED_SIZES[block.length]!; j++) {
      chunk = ALPHABET[Number(n % 58n)] + chunk;
      n /= 58n;
    }
    s += chunk;
  }
  return s;
}

/** Mainnet only. Checks length, base58, network prefix and the Keccak-256 checksum. */
export function validateMoneroAddress(addr: string): AddressCheck {
  if (typeof addr !== 'string' || (addr.length !== 95 && addr.length !== 106)) return { ok: false, reason: 'wrong length' };
  let bytes: Uint8Array;
  try {
    bytes = base58Decode(addr);
  } catch (e) {
    return { ok: false, reason: `not base58 (${(e as Error).message})` };
  }
  // every mainnet/testnet/stagenet prefix is below 0x80, so the varint is one byte
  const prefix = bytes[0]!;
  const net = MAINNET[prefix];
  if (!net) return { ok: false, reason: OTHER_NETS[prefix] ? `${OTHER_NETS[prefix]} address` : 'unknown network prefix' };
  if (addr.length !== net.length) return { ok: false, reason: 'wrong length for type' };
  const body = bytes.subarray(0, bytes.length - 4);
  const sum = keccak_256(body).subarray(0, 4);
  if (bytesToHex(sum) !== bytesToHex(bytes.subarray(bytes.length - 4))) return { ok: false, reason: 'bad checksum' };
  if (net.type === 'integrated') return { ok: true, type: net.type, paymentId: bytesToHex(bytes.subarray(65, 73)) };
  return { ok: true, type: net.type };
}

const AMOUNT_RE = /^\d{1,9}(\.\d{1,12})?$/;

export const isValidAmount = (amount: string) => AMOUNT_RE.test(amount);

/** Build a `monero:` URI. Throws on an invalid address or amount. */
export function moneroUri(addr: string, opts: { amount?: string; description?: string } = {}): string {
  if (!validateMoneroAddress(addr).ok) throw new Error('Invalid Monero address');
  const params: string[] = [];
  if (opts.amount) {
    if (!isValidAmount(opts.amount)) throw new Error('Invalid amount');
    params.push(`tx_amount=${opts.amount}`);
  }
  if (opts.description) params.push(`tx_description=${encodeURIComponent(opts.description)}`);
  return `monero:${addr}${params.length ? `?${params.join('&')}` : ''}`;
}
