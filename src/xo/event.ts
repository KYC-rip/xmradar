import type { Event, EventTemplate } from 'nostr-tools/pure';
import { safeRelay } from '../receipts/guards';
import { postOf, POST_K, statusIdOf, xPostId } from '../xap/post';

/**
 * xo, a Monero like on an X post (PLAN-MONEROLIKE): a NIP-25 kind-17 reaction to external content, the
 * post named the way Xaps name it (NIP-73 `i` = https://x.com/i/status/<id>, `k` = web), its author's
 * key in `p` when it's known, and (PLAN-XOREACH) the author's X handle in `X` = twitter:<handle>, so an xo
 * to someone without a key waits on relays until they set up. Relays index single-letter tags; `X` has no
 * NIP meaning, and a second `i` would break the strict one-`i` post rule older clients use.
 */

export const KIND_XO = 17;
export const XO_CONTENT = 'ɱ❤';
const FUTURE_SLACK_SECS = 10 * 60;

export const XO_HANDLE_TAG = 'X';
const HANDLE_TAG_RE = /^twitter:[a-z0-9_]{1,15}$/i;

/** The `X` value for an X handle: lowercased, as relays match `#X` exactly. */
export function xoHandleValue(handle: string): string {
  const v = `twitter:${handle.replace(/^@/, '').toLowerCase()}`;
  if (!HANDLE_TAG_RE.test(v)) throw new Error('Bad X handle');
  return v;
}

export function xoTemplate(statusId: string, author: string | null, handle: string, nowSecs: number): EventTemplate {
  const tags = [['k', POST_K], ['i', xPostId(statusId)], [XO_HANDLE_TAG, xoHandleValue(handle)]];
  if (author) tags.push(['p', author]);
  return { kind: KIND_XO, created_at: nowSecs, content: XO_CONTENT, tags };
}

export interface XoTarget {
  statusId: string;
  /** the author's key, when the sender knew it */
  author: string | null;
  /** the author's X handle, lowercased, when the xo names it */
  handle: string | null;
}

/**
 * An xo's post and author, or null: Xap's strict post rule, the xo content, not from the future, at most one
 * `p` (a key) and at most one `X` (twitter:<handle>), and at least one of them.
 */
export function xoOf(ev: Pick<Event, 'kind' | 'tags' | 'content' | 'created_at'>, nowSecs: number): XoTarget | null {
  if (ev.kind !== KIND_XO || ev.content !== XO_CONTENT || ev.created_at > nowSecs + FUTURE_SLACK_SECS) return null;
  const i = postOf(ev);
  const p = ev.tags.filter((t) => t[0] === 'p').map((t) => t[1] ?? '');
  const x = ev.tags.filter((t) => t[0] === XO_HANDLE_TAG).map((t) => t[1] ?? '');
  if (!i || p.length > 1 || x.length > 1 || p.length + x.length === 0) return null;
  if (p.length && !/^[0-9a-f]{64}$/.test(p[0]!)) return null;
  if (x.length && !HANDLE_TAG_RE.test(x[0]!)) return null;
  const statusId = statusIdOf(i);
  // X handles are case-insensitive: compared lowercased, as XMRadar writes them
  return statusId ? { statusId, author: p[0] ?? null, handle: x.length ? x[0]!.slice('twitter:'.length).toLowerCase() : null } : null;
}

/** An un-xo: NIP-09 deletion of the xo. */
export function undoTemplate(xoId: string, nowSecs: number): EventTemplate {
  return { kind: 5, created_at: nowSecs, content: '', tags: [['e', xoId], ['k', String(KIND_XO)]] };
}

/**
 * A NIP-65 list's read relays: `read` and unmarked tags; `write`-only ones aren't where its owner reads. Only
 * public wss relays (`safeRelay`): someone's list must not make this browser connect to localhost or the LAN.
 */
export function readRelaysFrom(list: Pick<Event, 'tags'> | null): string[] {
  if (!list) return [];
  const out = new Set<string>();
  for (const t of list.tags) if (t[0] === 'r' && t[1] && safeRelay(t[1]) && (!t[2] || t[2] === 'read')) out.add(t[1].replace(/\/+$/, ''));
  return [...out];
}

/**
 * Where an xo goes, in the order kept when cut to `max`: the author's read relays, then the defaults (the
 * floor both sides share), then the sender's own relays.
 */
export const xoRelayOrder = (authorRead: string[], defaults: string[], mine: string[], max = 10) => [...new Set([...authorRead, ...defaults, ...mine])].slice(0, max);
