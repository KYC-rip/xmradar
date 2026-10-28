import { PICO_PER_XMR } from './amount';

/**
 * The XMR/USD price for the tip popups' dollar shortcuts. Fetched only when a tip popup opens,
 * from our own price endpoint (Binance → CoinGecko → CryptoCompare behind it).
 */

export const PRICE_API = 'https://api.kyc.rip/v1/price/XMR';
export const PRICE_TTL_MS = 5 * 60_000;
/** after a failed fetch, popups opened within this time don't try again */
export const PRICE_RETRY_MS = 60_000;
/** the dollar shortcuts under the amount */
export const USD_SHORTCUTS = [1, 5, 10, 20] as const;

/** A finite price between $1 and $1,000,000 per XMR. */
export const isPlausibleUsd = (usd: unknown): usd is number => typeof usd === 'number' && Number.isFinite(usd) && usd >= 1 && usd <= 1e6;

/** USD per XMR, or an error unless the answer is a plausible price. */
export async function fetchXmrUsd(f: typeof fetch = fetch): Promise<number> {
  const res = await f(PRICE_API, { credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(8_000) });
  if (!res.ok) throw new Error(`Price unavailable (${res.status})`);
  const usd = ((await res.json()) as { usd?: unknown } | null)?.usd;
  if (!isPlausibleUsd(usd)) throw new Error('Price unavailable');
  return usd;
}

const STEPS_PER_XMR = 10_000;

/** Piconero worth at least `usd` dollars, rounded up to 0.0001 XMR. */
export function usdToPico(usd: number, price: number): bigint {
  const steps = Math.max(1, Math.ceil((usd / price) * STEPS_PER_XMR - 1e-9));
  return BigInt(steps) * (PICO_PER_XMR / BigInt(STEPS_PER_XMR));
}

/** "$5.02" for an amount in piconero. */
export const picoToUsd = (pico: bigint, price: number) => `$${((Number(pico) / Number(PICO_PER_XMR)) * price).toFixed(2)}`;
