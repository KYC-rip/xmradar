import { npubEncode } from 'nostr-tools/nip19';
import type { Filter } from 'nostr-tools/filter';
import type { Event } from 'nostr-tools/pure';
import { validEvent } from '../identity/nostr';
import type { ReadResult } from '../nostr/relays';
import { formatXmr, parseXmr } from './amount';
import { KIND_CONFIRMATION, KIND_DELETION, KIND_RECEIPT, parseConfirmation, parseReceipt } from './events';
import { fetchProfiles, type XapQuery } from './fetch';
import { postOf, statusIdOf } from './post';

/**
 * Xap notifications (PLAN-XAPINBOX): while switched on, every 30 minutes XMRadar asks the user's relays
 * for Xap receipts (NKIP-0002 kind 9042) to their key, and says so when new ones come in. A receipt is
 * the tipper's claim; nothing here can see the user's wallet.
 */

export const INBOX_ALARM = 'xap-inbox';
export const INBOX_MINUTES = 30;
export const INBOX_NOTICE_ID = 'xmradar-xap';
const DAY = 86_400;
/** relays can be slow to receive a receipt: each check looks back this far before the last good one */
export const SLACK_SECS = 2 * DAY;
export const BASELINE_SECS = 30 * DAY;
const FUTURE_SECS = 600;
export const PER_TIPPER = 20;
export const MAX_SEEN = 5000;
export const MAX_LEDGER = 2000;
const LEDGER_SECS = DAY;
export const MAX_ITEMS = 50;
export const MAX_RELAYS = 8;
const MAX_NAMES = 20;
const NAME_GRAPHEMES = 24;
const READ_MS = 4000;
const CHECK_NOW_GAP_MS = 60_000;

export type Target = { kind: 'post'; id: string } | { kind: 'note'; id: string } | { kind: 'profile' };

export interface InboxItem {
  id: string;
  tipper: string;
  name?: string;
  /** XMR, formatted */
  amount: string;
  target: Target;
  /** the receipt's created_at, unix seconds */
  at: number;
  state: 'verified' | 'claimed';
  /** published before NKIP-0002: verified by tx-proof only */
  legacy?: boolean;
}

export interface InboxState {
  pubkey: string;
  /** pending until a check with a relay answer and a known address: until then nothing notifies */
  baseline: 'pending' | 'done';
  /** the last successful check, ms */
  okAt: number | null;
  /** [receipt id, created_at], pruned only once outside the window */
  seen: [string, number][];
  /** [tipper, target key, unix seconds], kept 24 hours */
  notified: [string, string, number][];
  /** newest first */
  items: InboxItem[];
  unread: number;
  checkedAt: number | null;
  error?: string;
  /** the relays the last check asked */
  relays?: string[];
}

export const freshInbox = (pubkey: string): InboxState => ({ pubkey, baseline: 'pending', okAt: null, seen: [], notified: [], items: [], unread: 0, checkedAt: null });

const tagValues = (ev: Pick<Event, 'tags'>, name: string) => ev.tags.filter((t) => t[0] === name);

/**
 * What a receipt tips, or null when its tags don't name exactly one target: an X post (canonical `i`
 * with `k` = web and no `e`), a note (one `e` and no `i` or `k`), or the profile (none of them).
 */
export function targetOf(ev: Pick<Event, 'tags'>): Target | null {
  const e = tagValues(ev, 'e');
  const i = tagValues(ev, 'i');
  const k = tagValues(ev, 'k');
  if (i.length || k.length) {
    const post = postOf(ev);
    const id = post ? statusIdOf(post) : null;
    return id ? { kind: 'post', id } : null;
  }
  if (e.length === 1) return /^[0-9a-f]{64}$/.test(e[0]![1] ?? '') ? { kind: 'note', id: e[0]![1]! } : null;
  return e.length ? null : { kind: 'profile' };
}

export const targetKey = (t: Target) => (t.kind === 'profile' ? 'profile' : `${t.kind}:${t.id}`);

const JOINERS = new Set([0x200c, 0x200d].map((c) => String.fromCodePoint(c)));

/** A tipper's chosen name made safe to show: one line, no control or format characters, at most 24 graphemes. */
export function cleanName(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const s = raw
    .normalize('NFC')
    // invisible format characters (bidi, zero-width space) go, except the joiners emoji and some scripts
    // need; line breaks and other controls become spaces
    .replace(/\p{Cf}/gu, (c) => (JOINERS.has(c) ? c : ''))
    .replace(/[\p{Cc}\p{Zl}\p{Zp}\s]+/gu, ' ')
    .trim();
  if (!s) return undefined;
  const g = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(s)].map((x) => x.segment);
  return g.length > NAME_GRAPHEMES ? `${g.slice(0, NAME_GRAPHEMES).join('').trimEnd()}…` : s;
}

/** `npub1abcd…wxyz`, shown next to every name, since names are the tipper's choice */
export function shortNpub(pubkey: string): string {
  const n = npubEncode(pubkey);
  return `${n.slice(0, 9)}…${n.slice(-4)}`;
}

/** Names from the newest kind 0 of each author (display_name, else name), cleaned. */
export function namesFrom(events: Event[]): Map<string, string> {
  const newest = new Map<string, Event>();
  for (const ev of events) {
    if (ev.kind !== 0 || !validEvent(ev)) continue;
    const prev = newest.get(ev.pubkey);
    if (!prev || ev.created_at > prev.created_at) newest.set(ev.pubkey, ev);
  }
  const out = new Map<string, string>();
  for (const [pk, ev] of newest) {
    try {
      const o = JSON.parse(ev.content) as Record<string, unknown>;
      const name = cleanName(o.display_name) ?? cleanName(o.name);
      if (name) out.set(pk, name);
    } catch {
      // not JSON: no name
    }
  }
  return out;
}

const label = (it: Pick<InboxItem, 'tipper' | 'name'>) => (it.name ? `‘${it.name}’ (${shortNpub(it.tipper)})` : shortNpub(it.tipper));
const forWhat = (t: Target) => (t.kind === 'post' ? 'for an X post' : t.kind === 'note' ? 'for a Nostr note' : 'for your profile');

/** The notification text: never a URL, and "an X post", since a receipt can name any post. */
export function noticeText(items: InboxItem[]): string {
  if (items.length === 1) return `${label(items[0]!)} says they sent you ${items[0]!.amount} XMR ${forWhat(items[0]!.target)}.`;
  const total = formatXmr(items.reduce((sum, it) => sum + (parseXmr(it.amount) ?? 0n), 0n));
  const tippers = [...new Map(items.map((it) => [it.tipper, it])).values()];
  if (tippers.length === 1) return `${label(tippers[0]!)} says they sent you ${total} XMR in ${items.length} Xaps.`;
  const [a, b] = tippers.map(label);
  const who = tippers.length === 2 ? `${a} and ${b}` : `${a}, ${b} and ${tippers.length - 2} more`;
  return `${items.length} new Xaps: ${who} say they sent you ${total} XMR in total.`;
}

/** The `since` of a check: 30 days back for the baseline, else 2 days before the last good check. */
export const sinceOf = (state: InboxState, nowMs: number) =>
  state.baseline === 'pending' || state.okAt === null ? Math.floor(nowMs / 1000) - BASELINE_SECS : Math.floor(state.okAt / 1000) - SLACK_SECS;

export interface CheckInput {
  me: string;
  /** the user's current address: only receipts paying it count (R10) */
  current: string;
  /** receipts, the user's confirmations and their deletions */
  events: Event[];
  now: number;
}

/**
 * One successful check applied to the kept state: new receipts are listed, the ones to tell about are
 * returned. Pure; the caller has already made sure a relay answered and the address is known.
 */
export function applyCheck(state: InboxState, input: CheckInput): { state: InboxState; notify: InboxItem[] } {
  const nowS = Math.floor(input.now / 1000);
  const since = sinceOf(state, input.now);
  const baseline = state.baseline === 'pending';
  // only what can't come back: ids from before the window, ledger entries older than a day
  const seen = new Map(state.seen.filter(([, at]) => at >= since - DAY));
  const notified = state.notified.filter(([, , at]) => at > nowS - LEDGER_SECS);
  const ledger = new Set(notified.map(([tipper, key]) => `${tipper}|${key}`));

  const confirmations = input.events.filter((ev) => ev.kind === KIND_CONFIRMATION && ev.pubkey === input.me && validEvent(ev));
  const deleted = new Set(input.events.filter((ev) => ev.kind === KIND_DELETION && ev.pubkey === input.me && validEvent(ev)).flatMap((ev) => tagValues(ev, 'e').map((t) => t[1])));
  const receipts = new Map<string, { ev: Event; target: Target; legacy: boolean }>();
  for (const ev of input.events) {
    if (ev.kind !== KIND_RECEIPT || receipts.has(ev.id) || !validEvent(ev)) continue;
    const r = parseReceipt(ev);
    const target = targetOf(ev);
    if (!r || !target || r.recipient !== input.me || r.tipper === input.me || r.address !== input.current) continue;
    if (ev.created_at < since || ev.created_at > nowS + FUTURE_SECS) continue;
    receipts.set(ev.id, { ev, target, legacy: r.legacy });
  }
  // every receipt a confirmation may verify: this check's and the listed ones, which may be past the window
  const known = new Map<string, { tipper: string; legacy: boolean }>(state.items.map((it) => [it.id, { tipper: it.tipper, legacy: !!it.legacy }]));
  for (const [id, r] of receipts) known.set(id, { tipper: r.ev.pubkey, legacy: r.legacy });
  // verified by the counting rules: the user's own confirmation, naming the tipper, not withdrawn, legacy
  // receipts by tx-proof only, and one transfer confirming one receipt (the lowest id)
  const byTransfer = new Map<string, string>();
  for (const ev of confirmations) {
    const c = parseConfirmation(ev);
    const r = c && known.get(c.receipt);
    if (!c || !r || c.tipper !== r.tipper || deleted.has(c.id) || (r.legacy && c.method !== 'tx-proof')) continue;
    const prev = byTransfer.get(c.t);
    if (!prev || c.receipt < prev) byTransfer.set(c.t, c.receipt);
  }
  const verified = new Set(byTransfer.values());
  const stateOf = (id: string): InboxItem['state'] => (verified.has(id) ? 'verified' : 'claimed');

  const fresh: InboxItem[] = [];
  const notify: InboxItem[] = [];
  const perTipper = new Map<string, number>();
  const ordered = [...receipts.values()].sort((a, b) => a.ev.created_at - b.ev.created_at || (a.ev.id < b.ev.id ? -1 : 1));
  for (const { ev, target } of ordered) {
    if (seen.has(ev.id)) continue;
    // over a cap: deferred, not dropped; it comes back in a later check while it's in the window. The
    // baseline takes everything (one query's worth), so nothing from before it can notify later
    const n = perTipper.get(ev.pubkey) ?? 0;
    if (!baseline && (n >= PER_TIPPER || seen.size >= MAX_SEEN)) continue;
    const key = `${ev.pubkey}|${targetKey(target)}`;
    const tell = !baseline && !ledger.has(key);
    if (tell && notified.length >= MAX_LEDGER) continue;
    perTipper.set(ev.pubkey, n + 1);
    seen.set(ev.id, ev.created_at);
    const r = parseReceipt(ev)!;
    const item: InboxItem = { id: ev.id, tipper: ev.pubkey, amount: formatXmr(r.amount), target, at: ev.created_at, state: stateOf(ev.id), ...(r.legacy ? { legacy: true } : {}) };
    fresh.push(item);
    if (tell) {
      ledger.add(key);
      notified.push([ev.pubkey, targetKey(target), nowS]);
      notify.push(item);
    }
  }
  const ids = new Set(fresh.map((it) => it.id));
  // a confirmation that came later turns an earlier line verified
  const kept = state.items.filter((it) => !ids.has(it.id)).map((it) => (verified.has(it.id) ? { ...it, state: 'verified' as const } : it));
  const items = [...fresh.reverse(), ...kept].sort((a, b) => b.at - a.at || (a.id < b.id ? -1 : 1)).slice(0, MAX_ITEMS);
  return {
    state: {
      ...state,
      baseline: 'done',
      okAt: input.now,
      seen: [...seen],
      notified,
      items,
      // only lines the list can show count as unread
      unread: baseline ? 0 : state.unread + fresh.filter((it) => items.includes(it)).length,
      checkedAt: input.now,
      error: undefined,
    },
    notify,
  };
}

interface Item<T> {
  getValue(): Promise<T>;
  setValue(v: T): Promise<void>;
  removeValue(): Promise<void>;
}

export interface InboxDeps {
  held: Item<InboxState | null>;
  /** the switch in Options */
  enabled(): Promise<boolean>;
  /** the user's key, once XMRadar knows it */
  pubkey(): Promise<string | null>;
  /** the relays to ask: the user's own and the defaults, at most MAX_RELAYS */
  relays(pubkey: string): Promise<string[]>;
  /** each relay read on its own, so a check knows whether any answered */
  read(relays: string[], filter: Filter, timeoutMs: number): Promise<ReadResult>;
  query: XapQuery;
  alarms: {
    create(name: string, info: { periodInMinutes: number }): Promise<void> | void;
    clear(name: string): Promise<unknown> | void;
    get(name: string): Promise<{ periodInMinutes?: number } | undefined>;
  };
  notify(text: string): Promise<void>;
  clearNotice(): Promise<void>;
  now?: () => number;
}

/**
 * Keeps the inbox: runs while the switch is on and the key is known, checks every 30 minutes, and drops
 * everything when either goes. Every switch or key change starts a new generation; a check from an
 * older one writes and tells nothing.
 */
export function inboxKeeper(deps: InboxDeps) {
  const now = deps.now ?? Date.now;
  let generation = 0;
  let inFlight: { generation: number; done: Promise<void> } | null = null;

  const fail = async (gen: number, state: InboxState, error: string) => {
    if (gen === generation) await deps.held.setValue({ ...state, checkedAt: now(), error });
  };

  async function run(gen: number) {
    const pubkey = await deps.pubkey();
    if (!pubkey || !(await deps.enabled()) || gen !== generation) return;
    const held = await deps.held.getValue();
    const state = held?.pubkey === pubkey ? held : freshInbox(pubkey);
    const relays = (await deps.relays(pubkey)).slice(0, MAX_RELAYS);
    const profiles = await fetchProfiles([pubkey], relays, deps.query).catch(() => null);
    if (gen !== generation) return;
    const current = profiles?.addresses.get(pubkey) ?? null;
    if (!current) return fail(gen, { ...state, relays }, 'no-address');
    const filter: Filter = { kinds: [KIND_RECEIPT], '#p': [pubkey], since: sinceOf(state, now()), limit: 200 };
    const read = await deps.read(relays, filter, READ_MS);
    if (gen !== generation) return;
    if (!read.readable.length) return fail(gen, { ...state, relays }, 'No relay answered');
    // the user's confirmations and their deletions, for the receipts found and the ones listed
    const ids = [...new Set([...read.events.map((e) => e.id), ...state.items.map((it) => it.id)])].slice(0, 500);
    const confirmations = ids.length ? await deps.query(relays, { kinds: [KIND_CONFIRMATION], authors: [pubkey], '#e': ids }).catch(() => []) : [];
    const deletions = confirmations.length ? await deps.query(relays, { kinds: [KIND_DELETION], authors: [pubkey], '#e': confirmations.map((c) => c.id) }).catch(() => []) : [];
    if (gen !== generation) return;
    const { state: next, notify } = applyCheck(state, { me: pubkey, current, events: [...read.events, ...confirmations, ...deletions], now: now() });
    // names for the lines that have none yet
    const unnamed = [...new Set([...notify, ...next.items].filter((it) => !it.name).map((it) => it.tipper))].slice(0, MAX_NAMES);
    const names = unnamed.length ? namesFrom(await deps.query(relays, { kinds: [0], authors: unnamed }).catch(() => [])) : new Map<string, string>();
    if (gen !== generation) return;
    const named = (it: InboxItem) => (it.name || !names.has(it.tipper) ? it : { ...it, name: names.get(it.tipper) });
    await deps.held.setValue({ ...next, items: next.items.map(named), relays });
    if (notify.length && gen === generation) await deps.notify(noticeText(notify.map(named)));
  }

  /** Check now, unless a check of this generation is already running. */
  function check(): Promise<void> {
    if (inFlight?.generation === generation) return inFlight.done;
    const gen = generation;
    const done = run(gen)
      .catch((e) => console.warn('[XMRadar] xap inbox', (e as Error).message))
      .finally(() => {
        if (inFlight?.done === done) inFlight = null;
      });
    inFlight = { generation: gen, done };
    return done;
  }

  /** The switch or the key changed (or the worker started). */
  async function apply() {
    generation++;
    inFlight = null;
    const [on, pubkey] = await Promise.all([deps.enabled(), deps.pubkey()]);
    if (!on || !pubkey) {
      await Promise.all([deps.alarms.clear(INBOX_ALARM), deps.held.removeValue(), deps.clearNotice()]);
      return;
    }
    const held = await deps.held.getValue();
    // another key: its Xaps are someone else's, and its baseline starts over
    if (held && held.pubkey !== pubkey) await Promise.all([deps.held.setValue(freshInbox(pubkey)), deps.clearNotice()]);
    // made again only when missing or at another period, since making it restarts its countdown
    if ((await deps.alarms.get(INBOX_ALARM))?.periodInMinutes !== INBOX_MINUTES) await deps.alarms.create(INBOX_ALARM, { periodInMinutes: INBOX_MINUTES });
    const last = held?.pubkey === pubkey ? held.checkedAt : null;
    if (last === null || now() - last >= INBOX_MINUTES * 60_000) await check();
  }

  /** "Check now" in Options: at most once a minute. */
  async function checkNow() {
    const held = await deps.held.getValue();
    if (held?.checkedAt != null && now() - held.checkedAt < CHECK_NOW_GAP_MS) return;
    await check();
  }

  /** The list was seen: no unread, no notification. */
  async function markRead() {
    const held = await deps.held.getValue();
    if (held?.unread) await deps.held.setValue({ ...held, unread: 0 });
    await deps.clearNotice();
  }

  const onAlarm = (name: string) => (name === INBOX_ALARM ? check() : undefined);

  return { apply, check, checkNow, markRead, onAlarm };
}
