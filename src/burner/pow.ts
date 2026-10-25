import { sha256 } from '@noble/hashes/sha2.js';

/** GhostMail's free tier wants sha256("seed:nonce") to start with this many zero bits. */
export const POW_BITS = 20;
const SEED_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

export function leadingZeroBits(hash: Uint8Array): number {
  let bits = 0;
  for (const byte of hash) {
    if (byte === 0) {
      bits += 8;
      continue;
    }
    return bits + Math.clz32(byte) - 24;
  }
  return bits;
}

export function randomSeed(length = 16): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (b) => SEED_CHARS[b % SEED_CHARS.length]).join('');
}

export function checkPow(seed: string, nonce: string, bits = POW_BITS): boolean {
  return leadingZeroBits(sha256(new TextEncoder().encode(`${seed}:${nonce}`))) >= bits;
}

export interface PowOptions {
  bits?: number;
  /** hashes between yields; each yield is also a progress report */
  chunk?: number;
  deadlineMs?: number;
  onProgress?: (hashes: number) => void;
  now?: () => number;
}

/**
 * About 1M hashes on average at 20 bits (0.1–2.5 s on a laptop). Runs in chunks
 * with a yield between them, so the service worker can answer messages and the
 * caller's port stays busy (PLAN-BURNER B1).
 */
export async function solvePow(seed: string, opts: PowOptions = {}): Promise<string> {
  const { bits = POW_BITS, chunk = 50_000, deadlineMs = 45_000, onProgress, now = Date.now } = opts;
  const prefix = new TextEncoder().encode(`${seed}:`);
  // prefix + up to 16 ASCII digits, rewritten in place for each nonce
  const buf = new Uint8Array(prefix.length + 16);
  buf.set(prefix);
  const deadline = now() + deadlineMs;
  for (let nonce = 0; ; ) {
    const end = nonce + chunk;
    for (; nonce < end; nonce++) {
      let len = prefix.length;
      let n = nonce;
      const start = len;
      do {
        buf[len++] = 48 + (n % 10);
        n = Math.floor(n / 10);
      } while (n > 0);
      buf.subarray(start, len).reverse();
      if (leadingZeroBits(sha256(buf.subarray(0, len))) >= bits) return String(nonce);
    }
    onProgress?.(nonce);
    if (now() > deadline) throw new Error('Proof of work took too long on this device. Try again.');
    await new Promise((r) => setTimeout(r, 0));
  }
}
