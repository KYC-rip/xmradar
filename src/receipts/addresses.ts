import { sha256 } from '@noble/hashes/sha2.js';
import { bech32, bech32m, createBase58check } from '@scure/base';
import { validateMoneroAddress } from '../xmr/address';

/**
 * Address families for the receipt card's page and copy checks (PLAN-NKIP01 §4.3): an address on the
 * page counts only if it is valid for the receipt's deposit or payout asset. XMR and BTC (mainnet) are
 * checked; any other asset isn't matched, and the card says so.
 */

export type Family = 'XMR' | 'BTC';

const base58check = createBase58check(sha256);

function btcValid(a: string): boolean {
  if (/^bc1/i.test(a)) {
    // one case only; bech32 for witness v0, bech32m for v1 and later (BIP 350)
    if (a !== a.toLowerCase() && a !== a.toUpperCase()) return false;
    const s = a.toLowerCase() as `${string}1${string}`;
    for (const codec of [bech32, bech32m]) {
      try {
        const { prefix, words } = codec.decode(s, 90);
        if (prefix !== 'bc' || !words.length) continue;
        const version = words[0]!;
        const program = codec.fromWords(words.slice(1));
        if (version === 0 && codec === bech32 && (program.length === 20 || program.length === 32)) return true;
        if (version >= 1 && version <= 16 && codec === bech32m && program.length >= 2 && program.length <= 40) return true;
      } catch {
        // not this encoding
      }
    }
    return false;
  }
  if (!/^[13]/.test(a)) return false;
  try {
    const raw = base58check.decode(a);
    // P2PKH (0x00) or P2SH (0x05), 20-byte hash
    return raw.length === 21 && (raw[0] === 0x00 || raw[0] === 0x05);
  } catch {
    return false;
  }
}

export const familyOf = (asset: string): Family | null => {
  const a = asset.trim().toUpperCase();
  return a === 'XMR' || a === 'BTC' ? a : null;
};

export function validFor(family: Family, address: string): boolean {
  if (family === 'BTC') return btcValid(address);
  const c = validateMoneroAddress(address);
  return c.ok;
}

// address-shaped tokens: Monero (95 or 106 base58 chars), BTC base58 (25–34) and bech32 (bc1…)
const TOKEN_RE = /\b(?:[1-9A-HJ-NP-Za-km-z]{95}|[1-9A-HJ-NP-Za-km-z]{106}|[13][1-9A-HJ-NP-Za-km-z]{24,33}|bc1[02-9ac-hj-np-z]{6,87}|BC1[02-9AC-HJ-NP-Z]{6,87})\b/g;

/** Every valid address of these families in the text, in order, without duplicates. */
export function findAddresses(text: string, families: ReadonlySet<Family>): { family: Family; address: string }[] {
  // keyed so a bech32 address shown in both cases counts once
  const key = (t: string) => (/^bc1/i.test(t) ? t.toLowerCase() : t);
  const out = new Map<string, { family: Family; address: string }>();
  for (const m of text.matchAll(TOKEN_RE)) {
    const t = m[0];
    if (out.has(key(t))) continue;
    for (const f of families) if (validFor(f, t)) out.set(key(t), { address: t, family: f });
  }
  return [...out.values()];
}

/** BTC bech32 addresses compare case-insensitively; base58 ones and Monero exactly. */
export const sameAddress = (a: string, b: string) => (/^bc1/i.test(a) && /^bc1/i.test(b) ? a.toLowerCase() === b.toLowerCase() : a === b);
