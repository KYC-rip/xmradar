/**
 * Xap amounts (NKIP-0002): decimal XMR strings with at most 12 fractional digits, handled as
 * BigInt piconero so nothing is ever rounded through a float.
 */

export const PICO_PER_XMR = 10n ** 12n;
const AMOUNT_RE = /^(\d{1,9})(?:\.(\d{1,12}))?$/;
export const UNIQUE_MAX = 999_999n;

/** Piconero from a decimal XMR string, or null unless it is a well-formed amount above zero. */
export function parseXmr(s: string): bigint | null {
  const m = typeof s === 'string' ? AMOUNT_RE.exec(s) : null;
  if (!m) return null;
  const pico = BigInt(m[1]!) * PICO_PER_XMR + BigInt((m[2] ?? '').padEnd(12, '0'));
  return pico > 0n ? pico : null;
}

/** Exact decimal XMR, trailing zeros trimmed ("0.01", "1", "0.010000437215"). */
export function formatXmr(pico: bigint): string {
  const whole = pico / PICO_PER_XMR;
  const frac = (pico % PICO_PER_XMR).toString().padStart(12, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
}

/** A short figure for counters: at most 4 decimals, rounded down; "<0.0001" below that. */
export function shortXmr(pico: bigint): string {
  const step = PICO_PER_XMR / 10_000n;
  if (pico > 0n && pico < step) return '<0.0001';
  return formatXmr(pico - (pico % step));
}

/** 1 to 999,999 piconero, uniform, from the platform's CSPRNG. */
export function randomPico(rand: (buf: Uint32Array<ArrayBuffer>) => Uint32Array = (b) => crypto.getRandomValues(b)): bigint {
  // rejection sampling keeps it uniform: 4,294 whole ranges of 999,999 fit in 2^32
  const limit = 2 ** 32 - (2 ** 32 % 999_999);
  const buf = new Uint32Array(1);
  for (;;) {
    const v = rand(buf)[0]!;
    if (v < limit) return BigInt(v % 999_999) + 1n;
  }
}

/** The amount the user chose plus the random piconero that mark this Xap (R13). */
export const uniqueAmount = (base: bigint, extra: bigint) => {
  if (extra < 1n || extra > UNIQUE_MAX) throw new Error('Bad unique part');
  return base + extra;
};
