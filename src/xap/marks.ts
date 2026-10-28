import { UNIQUE_MAX } from './amount';

/**
 * The random piconero that mark a Xap, kept per recipient (R13): reopening the popup after paying
 * gives the same amount again, so the receipt can still be published. A mark is dropped once its
 * receipt is published, or after a day.
 */

export const MARK_TTL_MS = 24 * 60 * 60_000;
const MAX_MARKS = 200;

/** The key a mark is kept under: recipient and the address paid, so a new address gets a new mark. */
export const markFor = (recipient: string, address: string) => `${recipient}:${address}`;

/** [markFor key, mark in piconero as a decimal string, drawn at ms] */
export type Marks = [string, string, number][];

const valid = (m: string) => /^\d{1,6}$/.test(m) && BigInt(m) >= 1n && BigInt(m) <= UNIQUE_MAX;

/** The recipient's live mark, or null. */
export function findMark(marks: Marks, recipient: string, now: number): bigint | null {
  const hit = marks.find(([pk, m, at]) => pk === recipient && valid(m) && now - at >= 0 && now - at < MARK_TTL_MS);
  return hit ? BigInt(hit[1]) : null;
}

/** The list with this recipient's mark set (or removed, with null), expired ones dropped. */
export function withMark(marks: Marks, recipient: string, mark: bigint | null, now: number): Marks {
  const kept = marks.filter(([pk, , at]) => pk !== recipient && now - at >= 0 && now - at < MARK_TTL_MS);
  return (mark == null ? kept : [...kept, [recipient, mark.toString(), now] as [string, string, number]]).slice(-MAX_MARKS);
}
