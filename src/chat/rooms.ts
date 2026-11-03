import { sitesFor, type SiteFeed } from '../sites/feed';

/**
 * chat.xmr.club rooms for the side panel (PLAN-CHATPANEL): a lobby, X's room, and one per listed site.
 * XMRadar only frames the chat; nothing here talks to it.
 */

export const CHAT_ORIGIN = 'https://chat.xmr.club';
export const LOBBY = 'lobby';
/** what the chat itself accepts in `?room=` */
const ROOM = /^[a-z0-9_-]{1,20}$/;

export interface Room {
  slug: string;
  label: string;
}

export const LOBBY_ROOM: Room = { slug: LOBBY, label: 'Lobby' };
const X_ROOM: Room = { slug: 'x', label: 'X' };
const X_HOSTS = new Set(['x.com', 'twitter.com', 'mobile.x.com', 'mobile.twitter.com']);
const RESERVED = new Set([LOBBY, X_ROOM.slug]);

export const validSlug = (s: unknown): s is string => typeof s === 'string' && ROOM.test(s);

/** The chat's address for a room; `embed` is the layout made for frames. Anything odd is the lobby. */
export function chatUrl(slug: string, embed = true): string {
  const url = new URL('/', CHAT_ORIGIN);
  if (embed) url.searchParams.set('embed', '1');
  url.searchParams.set('room', validSlug(slug) ? slug : LOBBY);
  return url.href;
}

/** 32-bit FNV-1a, as 6 hex digits (the low 24 bits) */
function fnv6(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return ((h >>> 0) & 0xffffff).toString(16).padStart(6, '0');
}

/**
 * A listing's room. Its id when that's already a room name (no `_`, not lobby or x); otherwise the first
 * 13 characters, `_` and a hash of the whole id. Kept names never hold `_` and made ones always do, so
 * the two can't meet.
 */
export function roomSlug(id: string): string {
  if (/^[a-z0-9-]{1,20}$/.test(id) && !RESERVED.has(id)) return id;
  return `${id.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 13)}_${fnv6(id)}`;
}

/** The room the page at `url` belongs to, or null: X, else the listing for this exact host (smallest id). */
export function roomFor(url: string | undefined, feed: SiteFeed | null): Room | null {
  let u: URL;
  try {
    u = new URL(url ?? '');
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const host = u.hostname.toLowerCase().replace(/\.$/, '').replace(/^www\./, '');
  if (X_HOSTS.has(host)) return X_ROOM;
  if (!feed) return null;
  const [site] = sitesFor(feed, host).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return site ? { slug: roomSlug(site.id), label: site.name } : null;
}
