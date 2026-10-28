import type { Event } from 'nostr-tools/pure';
import { validEvent } from '../identity/nostr';
import { KIND_CONFIRMATION, KIND_DELETION, KIND_RECEIPT, parseConfirmation, parseReceipt, type Confirmation, type Receipt } from './events';
import { postOf } from './post';

/** "verifying" lasts this long after the user's own receipt: about 10 confirmations (~20 min) plus slack. */
export const VERIFYING_SECS = 30 * 60;

export type XapState = 'verified' | 'verifying' | 'claimed' | 'uncounted';

export interface Counted {
  /** piconero */
  verified: bigint;
  verifiedTippers: number;
  /** the user's own receipts still waiting for confirmations; never shown to anyone else */
  verifying: bigint;
  claimed: bigint;
  claimedTippers: number;
  /** the user's own receipts, newest first */
  mine: { id: string; amount: bigint; state: XapState; createdAt: number; recorded: boolean }[];
}

export interface CountInput {
  recipient: string;
  /** receipts, confirmations and deletions as fetched; signatures are checked here */
  events: Event[];
  /** the recipient's current address(es): NIP-A3, or kind 0 when there's no NIP-A3 one (R10) */
  current: string[];
  /** the user's pubkey and the ids of receipts this device published */
  me?: { pubkey: string | null; sent: ReadonlySet<string> };
  /** seconds */
  now: number;
  /** count one external post only: its canonical `i` value (receipts for other posts or the profile are left out) */
  post?: string;
}

/** Profile totals (every tip without `e`, post tips included) or one post's, by the NKIP-0002 counting rules. */
export function countXaps(input: CountInput): Counted {
  const { recipient } = input;
  const seen = new Set<string>();
  const receipts = new Map<string, Receipt>();
  const confirmations: Confirmation[] = [];
  const deleted = new Set<string>();
  // receipts any confirmation event points at, valid or not: those are never "verifying" (only the tipper sees that state)
  const referenced = new Set<string>();

  for (const ev of input.events) {
    if (seen.has(ev.id) || !validEvent(ev)) continue;
    seen.add(ev.id);
    if (ev.kind === KIND_RECEIPT) {
      const r = parseReceipt(ev);
      // 1: tips without `e` to this recipient only, never self-tips; for a post, only receipts naming it
      if (r && r.recipient === recipient && r.note === null && r.tipper !== recipient && (input.post === undefined || postOf(ev) === input.post)) receipts.set(r.id, r);
    } else if (ev.kind === KIND_CONFIRMATION) {
      for (const t of ev.tags) if (t[0] === 'e' && t[1]) referenced.add(t[1]);
      const c = parseConfirmation(ev);
      if (c) confirmations.push(c);
    } else if (ev.pubkey === recipient && ev.kind === KIND_DELETION) {
      for (const t of ev.tags) if (t[0] === 'e' && t[1]) deleted.add(t[1]);
    }
  }

  // 2: signed by the receipt's p key, naming its tipper, not withdrawn; legacy receipts only by tx-proof (R13)
  const applies = confirmations.filter((c) => {
    const r = receipts.get(c.receipt);
    return r && c.signer === r.recipient && c.tipper === r.tipper && !deleted.has(c.id) && (!r.legacy || c.method === 'tx-proof');
  });
  // 3: one transfer confirms one receipt: per (signer, t), the lowest receipt id wins
  const byTransfer = new Map<string, Confirmation>();
  for (const c of applies) {
    const key = `${c.signer}:${c.t}`;
    const prev = byTransfer.get(key);
    if (!prev || c.receipt < prev.receipt) byTransfer.set(key, c);
  }
  // a receipt confirmed for two transfers counts once, at the smaller (more conservative) amount
  const confirmedAmount = new Map<string, bigint>();
  for (const c of byTransfer.values()) {
    const prev = confirmedAmount.get(c.receipt);
    if (prev === undefined || c.amount < prev) confirmedAmount.set(c.receipt, c.amount);
  }

  const out: Counted = { verified: 0n, verifiedTippers: 0, verifying: 0n, claimed: 0n, claimedTippers: 0, mine: [] };
  const verifiedTippers = new Set<string>();
  const current = new Set(input.current);
  // 5: per tipper, only the smallest claimed receipt counts
  const smallestClaim = new Map<string, Receipt>();
  const state = new Map<string, XapState>();
  const me = input.me;
  for (const r of receipts.values()) {
    const confirmed = confirmedAmount.get(r.id);
    if (confirmed !== undefined) {
      // 2 and 4: the lower amount, whatever address the recipient publishes now
      out.verified += confirmed < r.amount ? confirmed : r.amount;
      verifiedTippers.add(r.tipper);
      state.set(r.id, 'verified');
    } else if (me?.pubkey === r.tipper && me.sent.has(r.id) && input.now - r.createdAt < VERIFYING_SECS && !referenced.has(r.id)) {
      out.verifying += r.amount;
      state.set(r.id, 'verifying');
    } else if (current.has(r.address)) {
      const prev = smallestClaim.get(r.tipper);
      if (!prev || r.amount < prev.amount || (r.amount === prev.amount && r.id < prev.id)) smallestClaim.set(r.tipper, r);
    }
  }
  for (const r of smallestClaim.values()) {
    out.claimed += r.amount;
    state.set(r.id, 'claimed');
  }
  out.claimedTippers = smallestClaim.size;
  out.verifiedTippers = verifiedTippers.size;
  if (me?.pubkey) {
    out.mine = [...receipts.values()]
      .filter((r) => r.tipper === me.pubkey)
      .sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? -1 : 1))
      .map((r) => ({ id: r.id, amount: r.amount, state: state.get(r.id) ?? 'uncounted', createdAt: r.createdAt, recorded: me.sent.has(r.id) }));
  }
  return out;
}
