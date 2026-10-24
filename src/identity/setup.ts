import type { Event, EventTemplate } from 'nostr-tools/pure';
import { validateMoneroAddress } from '../xmr/address';
import { HANDLE_RE, normalizeHandle } from './envelope';
import { KIND_IDENTITIES, KIND_PAYTO, validEvent } from './nostr';

export type SetupAction =
  | { type: 'add-address'; address: string }
  | { type: 'remove-address' }
  | { type: 'link-x'; handle: string; tweetId: string }
  | { type: 'unlink-x'; handle: string };

export const kindFor = (a: SetupAction) => (a.type === 'add-address' || a.type === 'remove-address' ? KIND_PAYTO : KIND_IDENTITIES);

/** The tag an action replaces: the monero payto (10133), or the `i` tag for this X handle (10011; other handles are kept). */
export function isTarget(kind: number, tag: string[], handle?: string): boolean {
  if (kind === KIND_PAYTO) return tag[0] === 'payto' && tag[1]?.toLowerCase() === 'monero';
  if (kind === KIND_IDENTITIES && handle) {
    const v = tag[1]?.toLowerCase() ?? '';
    return tag[0] === 'i' && v.startsWith('twitter:') && normalizeHandle(v.slice('twitter:'.length)) === normalizeHandle(handle);
  }
  return false;
}

/** The newest validly signed `kind` event by `pubkey`. */
export function newestOwn(events: Event[], kind: number, pubkey: string): Event | null {
  let best: Event | null = null;
  for (const e of events) {
    if (e.kind !== kind || e.pubkey !== pubkey || !validEvent(e)) continue;
    if (!best || e.created_at > best.created_at || (e.created_at === best.created_at && e.id < best.id)) best = e;
  }
  return best;
}

export const tweetUrl = (handle: string, tweetId: string) => `https://x.com/${normalizeHandle(handle)}/status/${tweetId}`;

/**
 * The new replaceable event: every other tag of the current one kept in order, the target
 * tag replaced or removed, content kept, and created_at strictly after the current event.
 */
export function buildMerged(current: Event | null, action: SetupAction, now = Math.floor(Date.now() / 1000)): EventTemplate {
  const kind = kindFor(action);
  const handle = 'handle' in action ? normalizeHandle(action.handle) : undefined;
  if (handle !== undefined && !HANDLE_RE.test(handle)) throw new Error('Not a valid X handle');
  if (action.type === 'add-address' && !validateMoneroAddress(action.address).ok) throw new Error('Not a valid Monero mainnet address');
  if (action.type === 'link-x' && !/^\d{1,20}$/.test(action.tweetId)) throw new Error('Not a valid tweet ID');
  const tags = (current?.tags ?? []).filter((t) => !isTarget(kind, t, handle));
  if (action.type === 'add-address') tags.push(['payto', 'monero', action.address]);
  if (action.type === 'link-x') tags.push(['i', `twitter:${handle}`, tweetUrl(handle!, action.tweetId)]);
  return { kind, content: current?.content ?? '', tags, created_at: Math.max(now, (current?.created_at ?? 0) + 1) };
}

export type DiffLine = { op: '+' | '-' | ' '; tag: string[] };

/** Tag-level diff for the confirmation screen: removed tags first, then the new list in order. Duplicates count separately. */
export function tagDiff(before: string[][] | null, after: string[][]): DiffLine[] {
  const key = (t: string[]) => JSON.stringify(t);
  const counts = (tags: string[][]) => {
    const m = new Map<string, number>();
    for (const t of tags) m.set(key(t), (m.get(key(t)) ?? 0) + 1);
    return m;
  };
  const left = counts(after);
  const removed = (before ?? []).filter((t) => {
    const n = left.get(key(t)) ?? 0;
    if (n > 0) left.set(key(t), n - 1);
    return n === 0;
  });
  const kept = counts(before ?? []);
  return [
    ...removed.map((tag) => ({ op: '-' as const, tag })),
    ...after.map((tag) => {
      const n = kept.get(key(tag)) ?? 0;
      if (n > 0) kept.set(key(tag), n - 1);
      return { op: n > 0 ? (' ' as const) : ('+' as const), tag };
    }),
  ];
}
