import type { Event, EventTemplate } from 'nostr-tools/pure';
import { safeRelay } from '../receipts/guards';
import { postOf, POST_K, statusIdOf, xPostId } from '../xap/post';

/**
 * xo, a Monero like on an X post (PLAN-MONEROLIKE): a NIP-25 kind-17 reaction to external content, the
 * post named the way Xaps name it (NIP-73 `i` = https://x.com/i/status/<id>, `k` = web), its author's
 * key in `p` so the author's XMRadar finds it.
 */

export const KIND_XO = 17;
export const XO_CONTENT = 'ɱ❤';
const FUTURE_SLACK_SECS = 10 * 60;

export function xoTemplate(statusId: string, author: string, nowSecs: number): EventTemplate {
  return { kind: KIND_XO, created_at: nowSecs, content: XO_CONTENT, tags: [['k', POST_K], ['i', xPostId(statusId)], ['p', author]] };
}

/** An xo's post and author, or null: Xap's strict post rule, the xo content, exactly one `p`, not from the future. */
export function xoOf(ev: Pick<Event, 'kind' | 'tags' | 'content' | 'created_at'>, nowSecs: number): { statusId: string; author: string } | null {
  if (ev.kind !== KIND_XO || ev.content !== XO_CONTENT || ev.created_at > nowSecs + FUTURE_SLACK_SECS) return null;
  const i = postOf(ev);
  const p = ev.tags.filter((t) => t[0] === 'p').map((t) => t[1] ?? '');
  if (!i || p.length !== 1 || !/^[0-9a-f]{64}$/.test(p[0]!)) return null;
  const statusId = statusIdOf(i);
  return statusId ? { statusId, author: p[0]! } : null;
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
