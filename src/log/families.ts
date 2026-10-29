import { sha256 } from '@noble/hashes/sha2.js';
import { createBase58check } from '@scure/base';
import { findAddresses, sameAddress } from '../receipts/addresses';

/**
 * The address families a letter of guarantee is read for: XMR and BTC as for receipts, plus Tron and
 * EVM, which operators also sign deposits in (BitcoinVN: USDT on Tron). A token counts as an address
 * only if it is valid for one of them.
 */

export type LetterFamily = 'XMR' | 'BTC' | 'TRON' | 'EVM';

const base58check = createBase58check(sha256);
const TRON_RE = /(?<![A-Za-z0-9])T[1-9A-HJ-NP-Za-km-z]{33}(?![A-Za-z0-9])/g;
const EVM_RE = /(?<![A-Za-z0-9])0x[0-9a-fA-F]{40}(?![A-Za-z0-9])/g;
const XMR_BTC = new Set(['XMR', 'BTC'] as const);

function tronValid(a: string): boolean {
  try {
    const raw = base58check.decode(a);
    return raw.length === 21 && raw[0] === 0x41;
  } catch {
    return false;
  }
}

/** Every valid address of these families in the text, in order, without duplicates. */
export function findLetterAddresses(text: string, families: ReadonlySet<LetterFamily>): { family: LetterFamily; address: string }[] {
  const out: { family: LetterFamily; address: string }[] = findAddresses(text, new Set([...XMR_BTC].filter((f) => families.has(f))));
  const add = (family: LetterFamily, address: string) => {
    if (!out.some((o) => sameLetterAddress(o.address, address))) out.push({ family, address });
  };
  if (families.has('TRON')) for (const [t] of text.matchAll(TRON_RE)) if (tronValid(t)) add('TRON', t);
  if (families.has('EVM')) for (const [t] of text.matchAll(EVM_RE)) add('EVM', t);
  return out;
}

const ALL: ReadonlySet<LetterFamily> = new Set(['XMR', 'BTC', 'TRON', 'EVM']);

/** The family of a single address, or null. */
export const letterFamily = (a: string): LetterFamily | null => {
  const [f] = findLetterAddresses(a, ALL);
  return f && f.address === a ? f.family : null;
};

/** As `sameAddress`, and EVM hex compares case-insensitively (EIP-55 case is only a checksum). */
export const sameLetterAddress = (a: string, b: string) => (/^0x/.test(a) && /^0x/.test(b) ? a.toLowerCase() === b.toLowerCase() : sameAddress(a, b));
