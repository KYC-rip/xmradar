import { sha256 } from '@noble/hashes/sha2.js';
import { base58, createBase58check } from '@scure/base';

/**
 * How many decimals a receipt amount has (NKIP-0001 amounts are base units). A receipt names the asset
 * but not its network, and a token's decimals differ by network (USDT: 6 on TRON and Ethereum, 18 on
 * BNB Chain), so a token's network is read from its signed address, and an amount whose decimals
 * that address can't settle stays in base units.
 */

const COINS: Record<string, number> = { XMR: 12, BTC: 8, LTC: 8, ETH: 18, SOL: 9 };
const STABLES = new Set(['USDT', 'USDC']);

const base58check = createBase58check(sha256);

function tron(a: string): boolean {
  if (!/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(a)) return false;
  try {
    const raw = base58check.decode(a);
    return raw.length === 21 && raw[0] === 0x41;
  } catch {
    return false;
  }
}

function solana(a: string): boolean {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a)) return false;
  try {
    return base58.decode(a).length === 32;
  } catch {
    return false;
  }
}

/** The asset's decimals and, for a token, the network its address is on; null when it can't be told. */
export function unitsOf(asset: string, address: string): { decimals: number; network?: string } | null {
  const a = asset.trim().toUpperCase();
  if (a in COINS) return { decimals: COINS[a]! };
  if (!STABLES.has(a)) return null;
  // both USDT and USDC have 6 decimals on TRON and Solana; an 0x address could be BNB Chain (18)
  if (tron(address)) return { decimals: 6, network: 'TRON' };
  if (solana(address)) return { decimals: 6, network: 'Solana' };
  return null;
}

/** Base units shown in coins when the decimals are known (for a token, from its address's network); otherwise raw, labelled. */
export function amount(base: string, asset: string, address: string): string {
  const units = unitsOf(asset, address);
  if (!units) return `${base} base units of ${asset} (the network sets the decimals)`;
  const { decimals, network } = units;
  const s = base.padStart(decimals + 1, '0');
  const frac = s.slice(-decimals).replace(/0+$/, '');
  return `${s.slice(0, -decimals)}${frac ? `.${frac}` : ''} ${asset.trim().toUpperCase()}${network ? ` on ${network}` : ''}`;
}
