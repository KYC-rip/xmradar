import type { Event, EventTemplate } from 'nostr-tools/pure';
import { validateMoneroAddress } from '../xmr/address';
import { parseXmr } from './amount';

/** NKIP-0002 (Verifiable Monero Tips on Nostr). "Xap" is only our name for it in the UI. */
export const KIND_RECEIPT = 9042;
export const KIND_CONFIRMATION = 9044;
export const KIND_DELETION = 5;
export const NKIP02_V = 'nkip02/1';
export const CLIENT = 'XMRadar';

const HEX64 = /^[0-9a-f]{64}$/;
// R1: never published; ignored on receipts, fatal on confirmations
const SECRET_TAGS = new Set(['txid', 'tx', 'tx_key', 'txkey', 'proof']);

export interface Receipt {
  id: string;
  tipper: string;
  recipient: string;
  /** piconero */
  amount: bigint;
  address: string;
  /** no `v` tag: published before NKIP-0002, confirmed only by tx-proof */
  legacy: boolean;
  /** the note id of a note tip; null for a profile tip */
  note: string | null;
  createdAt: number;
}

export interface Confirmation {
  id: string;
  signer: string;
  receipt: string;
  tipper: string;
  amount: bigint;
  method: 'tx-proof' | 'wallet-match';
  /** transfer tag */
  t: string;
}

const values = (ev: Event, name: string) => ev.tags.filter((t) => t[0] === name).map((t) => t[1]);

/** The one value of a tag, or undefined when it's missing or repeated. */
const only = (ev: Event, name: string) => {
  const v = values(ev, name);
  return v.length === 1 ? v[0] : undefined;
};

/** A receipt that passes the NKIP-0002 receipt rules (signature checked by the caller), else null. */
export function parseReceipt(ev: Event): Receipt | null {
  if (ev.kind !== KIND_RECEIPT) return null;
  const p = values(ev, 'p');
  const e = values(ev, 'e');
  if (p.length !== 1 || !HEX64.test(p[0] ?? '') || e.length > 1 || (e.length && !HEX64.test(e[0] ?? ''))) return null;
  const v = values(ev, 'v');
  if (v.length > 1 || (v.length && v[0] !== NKIP02_V)) return null;
  const legacy = v.length === 0;
  const units = values(ev, 'unit');
  // the unit is required from nkip02/1 on; legacy receipts may lack it
  if (units.length > 1 || (units.length ? units[0]?.toLowerCase() !== 'xmr' : !legacy)) return null;
  // legacy receipts may carry text, which readers ignore
  if (!legacy && ev.content !== '') return null;
  const amountStr = only(ev, 'amount');
  const amount = amountStr === undefined ? null : parseXmr(amountStr);
  const address = only(ev, 'address');
  if (amount === null || !address) return null;
  const check = validateMoneroAddress(address);
  if (!check.ok || check.type === 'integrated') return null;
  return { id: ev.id, tipper: ev.pubkey, recipient: p[0]!, amount, address, legacy, note: e[0] ?? null, createdAt: ev.created_at };
}

/** A confirmation that passes the NKIP-0002 confirmation rules, else null. Whether it applies to a receipt is decided when counting. */
export function parseConfirmation(ev: Event): Confirmation | null {
  if (ev.kind !== KIND_CONFIRMATION || ev.content !== '') return null;
  if (ev.tags.some((t) => SECRET_TAGS.has(t[0] ?? ''))) return null;
  const receipt = only(ev, 'e');
  const tipper = only(ev, 'p');
  const method = only(ev, 'method');
  const t = only(ev, 't');
  const amountStr = only(ev, 'amount');
  const amount = amountStr === undefined ? null : parseXmr(amountStr);
  if (!receipt || !HEX64.test(receipt) || !tipper || !HEX64.test(tipper) || !t || !HEX64.test(t)) return null;
  if (method !== 'tx-proof' && method !== 'wallet-match') return null;
  if (only(ev, 'v') !== NKIP02_V || amount === null) return null;
  return { id: ev.id, signer: ev.pubkey, receipt, tipper, amount, method, t };
}

/** The profile-tip receipt XMRadar publishes: no `e` (an X post has no Nostr id), no txid or proof (R1). */
export function receiptTemplate(opts: { recipient: string; amount: string; address: string; now?: number }): EventTemplate {
  if (!HEX64.test(opts.recipient)) throw new Error('Bad recipient key');
  if (parseXmr(opts.amount) === null) throw new Error('Bad amount');
  const check = validateMoneroAddress(opts.address);
  if (!check.ok || check.type === 'integrated') throw new Error('Not a standard address or subaddress');
  return {
    kind: KIND_RECEIPT,
    created_at: opts.now ?? Math.floor(Date.now() / 1000),
    content: '',
    tags: [
      ['p', opts.recipient],
      ['amount', opts.amount],
      ['unit', 'xmr'],
      ['address', opts.address],
      ['client', CLIENT],
      ['v', NKIP02_V],
    ],
  };
}

export const isHex64 = (s: unknown): s is string => typeof s === 'string' && HEX64.test(s);
