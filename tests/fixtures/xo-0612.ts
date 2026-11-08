// A frozen copy of XMRadar 0.6.12's xo parsing (src/xo/event.ts xoOf and the inbox's acceptance test), so
// PLAN-XOREACH's new xos are checked against what released clients do with them. Don't update it.
import type { Event } from 'nostr-tools/pure';
import { postOf, statusIdOf } from '../../src/xap/post';

export function xoOf0612(ev: Pick<Event, 'kind' | 'tags' | 'content' | 'created_at'>, nowSecs: number): { statusId: string; author: string } | null {
  if (ev.kind !== 17 || ev.content !== 'ɱ❤' || ev.created_at > nowSecs + 600) return null;
  const i = postOf(ev);
  const p = ev.tags.filter((t) => t[0] === 'p').map((t) => t[1] ?? '');
  if (!i || p.length !== 1 || !/^[0-9a-f]{64}$/.test(p[0]!)) return null;
  const statusId = statusIdOf(i);
  return statusId ? { statusId, author: p[0]! } : null;
}

/** 0.6.12's inbox took an xo when it parsed, named the user's key and wasn't the user's own. */
export const accepted0612 = (ev: Event, me: string, nowSecs: number) => {
  const x = xoOf0612(ev, nowSecs);
  return !!x && x.author === me && ev.pubkey !== me;
};
