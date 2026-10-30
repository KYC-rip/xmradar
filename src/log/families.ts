import { sha256 } from '@noble/hashes/sha2.js';
import { base58, base64, base64urlnopad, createBase58check } from '@scure/base';
import { findAddresses, sameAddress } from '../receipts/addresses';

/**
 * The address families a letter of guarantee is read for: XMR and BTC as for receipts, plus Tron and
 * EVM, which operators also sign deposits in (BitcoinVN: USDT on Tron), and Solana and TON (BitcoinVN:
 * USDC on Solana in, USDT on TON out). A token counts as an address only if it is valid for one of them.
 * Solana has no checksum, so it is searched for on a page only when the letter signs a Solana address.
 */

export type LetterFamily = 'XMR' | 'BTC' | 'TRON' | 'EVM' | 'SOL' | 'TON';

const base58check = createBase58check(sha256);
const TRON_RE = /(?<![A-Za-z0-9])T[1-9A-HJ-NP-Za-km-z]{33}(?![A-Za-z0-9])/g;
const EVM_RE = /(?<![A-Za-z0-9])0x[0-9a-fA-F]{40}(?![A-Za-z0-9])/g;
const SOL_RE = /(?<![A-Za-z0-9])[1-9A-HJ-NP-Za-km-z]{32,44}(?![A-Za-z0-9])/g;
// user-friendly (48 chars, standard or url base64) or raw (`0:` / `-1:` and 64 hex)
const TON_RE = /(?<![A-Za-z0-9_+/-])(?:[A-Za-z0-9_+/-]{48}|-?[01]:[0-9a-fA-F]{64})(?![A-Za-z0-9_+/=-])/g;
const XMR_BTC = new Set(['XMR', 'BTC'] as const);

function tronValid(a: string): boolean {
  try {
    const raw = base58check.decode(a);
    return raw.length === 21 && raw[0] === 0x41;
  } catch {
    return false;
  }
}

function solValid(a: string): boolean {
  try {
    return base58.decode(a).length === 32;
  } catch {
    return false;
  }
}

// CRC16-XMODEM, as TON's user-friendly addresses use
function crc16(bytes: Uint8Array): number {
  let crc = 0;
  for (const b of bytes) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');

/** A TON account as `workchain:hash`, or null: mainnet user-friendly (bounceable or not) or raw. */
export function tonAccount(a: string): string | null {
  const raw = /^(-?[01]):([0-9a-fA-F]{64})$/.exec(a);
  if (raw) return raw[1] === '0' || raw[1] === '-1' ? `${raw[1]}:${raw[2]!.toLowerCase()}` : null;
  if (a.length !== 48) return null;
  let b: Uint8Array;
  try {
    b = /[-_]/.test(a) ? base64urlnopad.decode(a) : base64.decode(a);
  } catch {
    return null;
  }
  // flag: 0x11 bounceable, 0x51 non-bounceable; testnet (0x80 set) is not a swap's address
  if (b.length !== 36 || (b[0] !== 0x11 && b[0] !== 0x51) || (b[1] !== 0x00 && b[1] !== 0xff)) return null;
  if (crc16(b.subarray(0, 34)) !== ((b[34]! << 8) | b[35]!)) return null;
  return `${b[1] === 0xff ? -1 : 0}:${hex(b.subarray(2, 34))}`;
}

/** Every mainnet user-friendly form of a TON account (bounceable or not, url or standard base64); any other address as is. */
export function tonForms(a: string): string[] {
  const acc = tonAccount(a);
  if (!acc) return [a];
  const [wc, h] = acc.split(':') as [string, string];
  const out = new Set([a]);
  for (const flag of [0x11, 0x51]) {
    const b = new Uint8Array(36);
    b[0] = flag;
    b[1] = wc === '-1' ? 0xff : 0;
    for (let i = 0; i < 32; i++) b[2 + i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
    const c = crc16(b.subarray(0, 34));
    b[34] = c >> 8;
    b[35] = c & 0xff;
    out.add(base64urlnopad.encode(b)).add(base64.encode(b));
  }
  return [...out];
}

/** Every valid address of these families in the text, in order, without duplicates. */
export function findLetterAddresses(text: string, families: ReadonlySet<LetterFamily>): { family: LetterFamily; address: string }[] {
  const out: { family: LetterFamily; address: string }[] = findAddresses(text, new Set([...XMR_BTC].filter((f) => families.has(f))));
  const add = (family: LetterFamily, address: string) => {
    if (!out.some((o) => sameLetterAddress(o.address, address))) out.push({ family, address });
  };
  if (families.has('TRON')) for (const [t] of text.matchAll(TRON_RE)) if (tronValid(t)) add('TRON', t);
  if (families.has('EVM')) for (const [t] of text.matchAll(EVM_RE)) add('EVM', t);
  if (families.has('TON')) for (const [t] of text.matchAll(TON_RE)) if (tonAccount(t)) add('TON', t);
  // last: a base58 token that is a BTC or Tron address is that, not Solana
  if (families.has('SOL')) {
    for (const [t] of text.matchAll(SOL_RE)) if (solValid(t) && !findAddresses(t, XMR_BTC).length && !(/^T/.test(t) && t.length === 34 && tronValid(t))) add('SOL', t);
  }
  return out;
}

const ALL: ReadonlySet<LetterFamily> = new Set(['XMR', 'BTC', 'TRON', 'EVM', 'SOL', 'TON']);

/** The family of a single address, or null. */
export const letterFamily = (a: string): LetterFamily | null => {
  const [f] = findLetterAddresses(a, ALL);
  return f && f.address === a ? f.family : null;
};

/**
 * One address, however it is written: bech32 and EVM hex in either case (EIP-55 case is only a
 * checksum), and a TON account in any of its forms (bounceable or not, url or standard base64, raw).
 */
export function letterKey(a: string): string {
  if (/^(bc1|0x)/i.test(a)) return a.toLowerCase();
  const ton = tonAccount(a);
  return ton ? `ton:${ton}` : a;
}

export const sameLetterAddress = (a: string, b: string) => letterKey(a) === letterKey(b) || sameAddress(a, b);
