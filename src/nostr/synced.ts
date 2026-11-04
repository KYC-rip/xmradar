/**
 * Posts on X copied to Nostr (PLAN-SYNCEDMARK): the X status id with the note's reference, kept in this
 * browser so the post can carry a small mark. Only what the mark needs; no text.
 */

export interface SyncedPost {
  /** nevent (note) or naddr (article) */
  ref: string;
  kind: 'note' | 'article';
  /** ms */
  at: number;
}
export type SyncedPosts = Record<string, SyncedPost>;

export const MAX_SYNCED = 1000;
const STATUS_ID = /^\d{1,20}$/;
const REF = /^(nevent|naddr)1[02-9ac-hj-np-z]{6,}$/;

/** The map with `id` set to `entry`; the oldest entries go past `max`. */
export function recordSynced(map: SyncedPosts, id: string, entry: SyncedPost, max = MAX_SYNCED): SyncedPosts {
  if (!STATUS_ID.test(id)) return map;
  const next: SyncedPosts = { ...map, [id]: entry };
  const ids = Object.keys(next);
  if (ids.length <= max) return next;
  ids.sort((a, b) => next[a]!.at - next[b]!.at);
  for (const old of ids.slice(0, ids.length - max)) delete next[old];
  return next;
}

/** Where the mark opens the copy, as after publishing: notes on ros.rip, articles on njump; null for a bad ref. */
export function syncedLink(e: SyncedPost): string | null {
  const m = REF.exec(e.ref);
  if (!m || (e.kind === 'note') !== (m[1] === 'nevent')) return null;
  return e.kind === 'note' ? `https://app.ros.rip/nostr/note/${e.ref}` : `https://njump.me/${e.ref}`;
}
