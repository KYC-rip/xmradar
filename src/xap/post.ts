import type { Event } from 'nostr-tools/pure';

/**
 * External post tips (NKIP-0002 "External post tips", R14, R15): a Xap for an X post names it with
 * `["i", "https://x.com/i/status/<id>"]` and `["k", "web"]`, never `e`, which stays for Nostr notes.
 */

export const POST_K = 'web';
/** an X status id: decimal, no leading zeros */
export const STATUS_ID_RE = /^[1-9]\d{0,19}$/;
const POST_PREFIX = 'https://x.com/i/status/';

/** The canonical `i` value for an X status id; relays match `#i` exactly, so it's the only spelling used. */
export function xPostId(statusId: string): string {
  if (!STATUS_ID_RE.test(statusId)) throw new Error('Bad X status id');
  return POST_PREFIX + statusId;
}

/** The status id in a canonical `i` value, or null for any other spelling. */
export function statusIdOf(i: string): string | null {
  if (!i.startsWith(POST_PREFIX)) return null;
  const id = i.slice(POST_PREFIX.length);
  return STATUS_ID_RE.test(id) ? id : null;
}

/**
 * The canonical post a receipt tips, or null when it counts toward the profile only: it needs no `e`,
 * exactly one `i` and one `k`, `k` = `web`, and `i` in X's canonical form.
 */
export function postOf(ev: Pick<Event, 'tags'>): string | null {
  const values = (name: string) => ev.tags.filter((t) => t[0] === name).map((t) => t[1] ?? '');
  const i = values('i');
  const k = values('k');
  if (values('e').length || i.length !== 1 || k.length !== 1 || k[0] !== POST_K) return null;
  return statusIdOf(i[0]!) ? i[0]! : null;
}

/** A post figure is only valid for the key it was counted for (R14), so it's cached and sent under both. */
export const postKey = (pubkey: string, statusId: string) => `${pubkey}:${statusId}`;

/** The parts of a postKey; ids and pubkeys never contain ':'. */
export function parsePostKey(key: string): { pubkey: string; id: string } {
  const [pubkey = '', id = ''] = key.split(':');
  return { pubkey, id };
}
