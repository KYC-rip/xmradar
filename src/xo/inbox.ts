import type { Event } from 'nostr-tools/pure';
import type { Filter } from 'nostr-tools/filter';
import { validEvent } from '../identity/nostr';
import { KIND_XO, xoOf } from './event';
import type { Liker } from './verify';

/**
 * Received xos (PLAN-MONEROLIKE): xos to the user's key, counted only from verified Monero people, one per
 * person per post, minus their deletions. Its own ledger, apart from the Xap inbox. Likes whose sender
 * can't be checked yet wait in `pending`; each check looks back two days past the last one, since relays
 * can receive an event late, and ids already counted or told keep that overlap from counting twice.
 */

export const XO_ALARM = 'xo-inbox';
export const XO_MINUTES = 30;
export const XO_NOTICE_ID = 'xmradar-xo';
export const OVERLAP_SECS = 2 * 86_400;
export const BASELINE_SECS = 30 * 86_400;
export const PENDING_DAYS = 7;
export const MAX_PENDING = 500;
export const MAX_POSTS = 2000;
export const MAX_NOTIFIED = 5000;
export const MAX_ITEMS = 50;
export const VERIFY_PER_RUN = 10;

export interface XoItem {
  id: string;
  statusId: string;
  liker: string;
  /** the sender's verified X handle */
  handle: string;
  at: number;
}

export interface XoInbox {
  pubkey: string;
  baseline: 'pending' | 'done';
  /** created_at (s) of the newest xo seen */
  sinceAt: number | null;
  /** statusId → sender → xo id */
  likes: Record<string, Record<string, string>>;
  pending: { ev: Event; firstAt: number }[];
  notified: string[];
  items: XoItem[];
  unread: number;
  checkedAt: number | null;
  error?: string;
}

export const freshXoInbox = (pubkey: string): XoInbox => ({ pubkey, baseline: 'pending', sinceAt: null, likes: {}, pending: [], notified: [], items: [], unread: 0, checkedAt: null });

export const xoSince = (s: XoInbox, nowMs: number) => (s.sinceAt === null ? Math.floor(nowMs / 1000) - BASELINE_SECS : s.sinceAt - OVERLAP_SECS);

/** xos per post, for the counts on the user's own posts. */
export const xoCounts = (s: XoInbox): Record<string, number> => Object.fromEntries(Object.entries(s.likes).map(([id, by]) => [id, Object.keys(by).length]).filter(([, n]) => (n as number) > 0));

/** The ids of everything this check must look at: new xos, and the ones waiting. */
export function candidates(s: XoInbox, events: Event[], nowMs: number): Event[] {
  const nowSecs = Math.floor(nowMs / 1000);
  const counted = new Set(Object.values(s.likes).flatMap((by) => Object.values(by)));
  const told = new Set(s.notified);
  const out = new Map<string, Event>();
  for (const e of [...s.pending.map((p) => p.ev), ...events]) {
    // only events their key really signed: relays aren't trusted to check
    if (e.kind !== KIND_XO || counted.has(e.id) || told.has(e.id) || out.has(e.id) || !validEvent(e)) continue;
    const x = xoOf(e, nowSecs);
    if (x && x.author === s.pubkey && e.pubkey !== s.pubkey) out.set(e.id, e);
  }
  return [...out.values()];
}

export interface XoInput {
  /** new and pending xos (from `candidates`) */
  xos: Event[];
  /** kind 5 events by their senders */
  deletions: Event[];
  /** the verdict on a sender, or null: not known yet, try again next check */
  likerOf(pubkey: string): Liker | null;
  now: number;
}

export function applyXo(state: XoInbox, input: XoInput): { state: XoInbox; notify: XoItem[] } {
  const nowSecs = Math.floor(input.now / 1000);
  const baseline = state.baseline === 'pending';
  const likes: XoInbox['likes'] = Object.fromEntries(Object.entries(state.likes).map(([k, v]) => [k, { ...v }]));
  const firstSeen = new Map(state.pending.map((p) => [p.ev.id, p.firstAt]));
  const pending: XoInbox['pending'] = [];
  const fresh: XoItem[] = [];
  let sinceAt = state.sinceAt;
  // a sender's deletions: only their own, of their own xos
  // a signed kind 5 by the xo's own sender (the key is part of the match below)
  const deleted = new Set(input.deletions.filter((d) => d.kind === 5 && validEvent(d)).flatMap((d) => d.tags.filter((t) => t[0] === 'e' && t[1]).map((t) => `${d.pubkey}:${t[1]}`)));
  for (const e of [...input.xos].sort((a, b) => a.created_at - b.created_at)) {
    const x = xoOf(e, nowSecs);
    if (!x) continue;
    sinceAt = Math.max(sinceAt ?? 0, e.created_at);
    if (deleted.has(`${e.pubkey}:${e.id}`)) continue;
    const liker = input.likerOf(e.pubkey);
    if (!liker) {
      const at = firstSeen.get(e.id) ?? input.now;
      if (input.now - at < PENDING_DAYS * 86_400_000) pending.push({ ev: e, firstAt: at });
      continue;
    }
    if (!liker.ok) continue;
    const by = (likes[x.statusId] ??= {});
    if (by[e.pubkey]) continue;
    by[e.pubkey] = e.id;
    fresh.push({ id: e.id, statusId: x.statusId, liker: e.pubkey, handle: liker.handle, at: e.created_at });
  }
  // xos counted earlier that their sender took back
  for (const [post, by] of Object.entries(likes)) {
    for (const [liker, id] of Object.entries(by)) if (deleted.has(`${liker}:${id}`)) delete by[liker];
    if (!Object.keys(by).length) delete likes[post];
  }
  const posts = Object.keys(likes);
  if (posts.length > MAX_POSTS) {
    // the posts whose newest xo is oldest go first
    const newest = (p: string) => Math.max(...Object.values(likes[p]!).map((id) => state.items.find((it) => it.id === id)?.at ?? 0));
    for (const p of posts.sort((a, b) => newest(a) - newest(b)).slice(0, posts.length - MAX_POSTS)) delete likes[p];
  }
  const live = new Set(Object.values(likes).flatMap((by) => Object.values(by)));
  const notify = baseline ? [] : fresh;
  const items = [...fresh, ...state.items].filter((it) => live.has(it.id)).sort((a, b) => b.at - a.at).slice(0, MAX_ITEMS);
  return {
    state: {
      ...state,
      baseline: 'done',
      sinceAt,
      likes,
      pending: pending.slice(-MAX_PENDING),
      notified: [...state.notified, ...fresh.map((f) => f.id)].slice(-MAX_NOTIFIED),
      items,
      unread: baseline ? 0 : state.unread + notify.filter((it) => items.includes(it)).length,
      checkedAt: input.now,
      error: undefined,
    },
    notify,
  };
}

/** One notification per check, worded as the senders' own act. */
export function xoNotice(items: XoItem[]): string {
  const people = [...new Set(items.map((it) => `@${it.handle}`))];
  const posts = new Set(items.map((it) => it.statusId)).size;
  const who = people.length === 1 ? people[0]! : `${people[0]} and ${people.length - 1} other${people.length === 2 ? '' : 's'}`;
  return posts === 1 ? `${who} sent your post an xo` : `${who} sent your posts xos`;
}

interface Item<T> {
  getValue(): Promise<T>;
  setValue(v: T): Promise<void>;
  removeValue(): Promise<void>;
}

export interface XoDeps {
  held: Item<XoInbox | null>;
  counts: { setValue(v: Record<string, number>): Promise<void> };
  enabled(): Promise<boolean>;
  pubkey(): Promise<string | null>;
  /** the user's read relays and the defaults */
  relays(pubkey: string): Promise<string[]>;
  read(relays: string[], filter: Filter): Promise<{ events: Event[]; readable: string[] }>;
  query(relays: string[], filter: Filter): Promise<Event[]>;
  /** a cached verdict, or null */
  known(pubkey: string): Promise<Liker | null>;
  /** checks one sender and caches a definite answer; null when it couldn't */
  verify(pubkey: string): Promise<Liker | null>;
  alarms: {
    create(name: string, info: { periodInMinutes: number }): Promise<void> | void;
    clear(name: string): Promise<unknown> | void;
    get(name: string): Promise<{ periodInMinutes?: number } | undefined>;
  };
  notify(text: string): Promise<void>;
  clearNotice(): Promise<void>;
  now?: () => number;
}

/** Runs with the notifications switch and a known key, every 30 minutes; a switch or key change starts over. */
export function xoKeeper(deps: XoDeps) {
  const now = deps.now ?? Date.now;
  let generation = 0;
  let inFlight: { generation: number; done: Promise<void> } | null = null;

  async function run(gen: number) {
    const pubkey = await deps.pubkey();
    if (!pubkey || !(await deps.enabled()) || gen !== generation) return;
    const held = await deps.held.getValue();
    const state = held?.pubkey === pubkey ? held : freshXoInbox(pubkey);
    const relays = await deps.relays(pubkey);
    const read = await deps.read(relays, { kinds: [KIND_XO], '#p': [pubkey], since: xoSince(state, now()), limit: 200 });
    if (gen !== generation) return;
    if (!read.readable.length) {
      await deps.held.setValue({ ...state, checkedAt: now(), error: 'No relay answered' });
      return;
    }
    const xos = candidates(state, read.events, now());
    // verdicts: cached ones, then at most VERIFY_PER_RUN new senders; the rest wait for the next check
    const verdicts = new Map<string, Liker | null>();
    let asked = 0;
    for (const pk of new Set(xos.map((e) => e.pubkey))) {
      let v = await deps.known(pk);
      if (!v && asked < VERIFY_PER_RUN) {
        asked++;
        v = await deps.verify(pk).catch(() => null);
      }
      verdicts.set(pk, v);
    }
    if (gen !== generation) return;
    const counted = Object.entries(state.likes).flatMap(([, by]) => Object.entries(by));
    const senders = [...new Set([...xos.map((e) => e.pubkey), ...counted.map(([liker]) => liker)])].slice(0, 200);
    const ids = [...new Set([...xos.map((e) => e.id), ...counted.map(([, id]) => id)])].slice(0, 500);
    const deletions = ids.length ? await deps.query(relays, { kinds: [5], authors: senders, '#e': ids }).catch(() => []) : [];
    if (gen !== generation) return;
    const { state: next, notify } = applyXo(state, { xos, deletions, likerOf: (pk) => verdicts.get(pk) ?? null, now: now() });
    await deps.held.setValue(next);
    await deps.counts.setValue(xoCounts(next)).catch(() => {});
    if (notify.length && gen === generation) await deps.notify(xoNotice(notify));
  }

  function check(): Promise<void> {
    if (inFlight?.generation === generation) return inFlight.done;
    const gen = generation;
    const done = run(gen)
      .catch((e) => console.warn('[XMRadar] xo inbox', (e as Error).message))
      .finally(() => {
        if (inFlight?.done === done) inFlight = null;
      });
    inFlight = { generation: gen, done };
    return done;
  }

  async function apply() {
    generation++;
    inFlight = null;
    const [on, pubkey] = await Promise.all([deps.enabled(), deps.pubkey()]);
    if (!on || !pubkey) {
      await Promise.all([deps.alarms.clear(XO_ALARM), deps.held.removeValue(), deps.counts.setValue({}), deps.clearNotice()]);
      return;
    }
    const held = await deps.held.getValue();
    if (held && held.pubkey !== pubkey) await Promise.all([deps.held.setValue(freshXoInbox(pubkey)), deps.counts.setValue({}), deps.clearNotice()]);
    if ((await deps.alarms.get(XO_ALARM))?.periodInMinutes !== XO_MINUTES) await deps.alarms.create(XO_ALARM, { periodInMinutes: XO_MINUTES });
    const last = held?.pubkey === pubkey ? held.checkedAt : null;
    if (last === null || now() - last >= XO_MINUTES * 60_000) await check();
  }

  async function markRead() {
    const held = await deps.held.getValue();
    if (held?.unread) await deps.held.setValue({ ...held, unread: 0 });
    await deps.clearNotice();
  }

  const onAlarm = (name: string) => (name === XO_ALARM ? check() : undefined);
  return { apply, check, markRead, onAlarm };
}
