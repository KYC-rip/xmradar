import type { Line } from '../receipts/check';
import type { SiteLog } from '../sites/feed';
import { findLetterAddresses, type LetterFamily } from './families';
import { verifyMistProof } from './mistproof';
import type { verifyLetter as VerifyLetter } from './pgp';

/**
 * A letter of guarantee checked against the feed's key and this order (PLAN-LOG §4.3, Round 2 item 4),
 * in the background. What the page shows is compared in the content script (`./page.ts`), from the
 * addresses returned here. Amounts and rates are never read as guarantees: the card shows the signed
 * text as it is.
 */

export type AddressRole = 'deposit' | 'payout' | 'refund' | null;
export interface LetterAddress {
  address: string;
  /** from a labelled line (or MistProof's fields); null if the label names no role */
  role: AddressRole;
}

export interface LetterCheck {
  format: 'pgp' | 'mistproof';
  /** signed with the feed's key, and for this order */
  verified: boolean;
  lines: Line[];
  /** the signed addresses, only when the signature verified */
  addresses: LetterAddress[];
  /** the signed text (PGP) or payload (MistProof), only when the signature verified */
  signedText: string;
  /** ms, PGP: the latest block's signature time */
  signedAt?: number;
}

export interface LetterOrder {
  siteName: string;
  log: SiteLog;
  orderId: string;
}

export interface LetterDeps {
  verifyLetter: typeof VerifyLetter;
}

// a `Label: value` line, as every operator's letter writes its fields
const FIELD_RE = /^\s*([A-Za-z][A-Za-z _-]{1,40}):\s*(.*)$/;
const FAMILIES: ReadonlySet<LetterFamily> = new Set(['XMR', 'BTC', 'TRON', 'EVM']);

function roleOfLabel(label: string): AddressRole {
  const l = label.toLowerCase();
  if (/refund/.test(l)) return 'refund';
  if (/deposit|to our|send to|pay to/.test(l)) return 'deposit';
  if (/payout|destination|to your|receiv|recipient/.test(l)) return 'payout';
  return null;
}

/**
 * The valid addresses (XMR, BTC, Tron, EVM) a signed letter names, without duplicates: with the role its
 * `Label:` names, else null. A role-labelled line wins over an earlier unlabelled mention.
 */
export function letterAddresses(text: string): LetterAddress[] {
  const out = new Map<string, LetterAddress>();
  // bech32 and EVM hex are the same address in either case
  const key = (a: string) => (/^(bc1|0x)/i.test(a) ? a.toLowerCase() : a);
  for (const line of text.split(/\r?\n/)) {
    const m = FIELD_RE.exec(line);
    const role = m ? roleOfLabel(m[1]!) : null;
    for (const { address } of findLetterAddresses(m ? m[2]! : line, FAMILIES)) if (!out.get(key(address))?.role) out.set(key(address), { address, role });
  }
  return [...out.values()];
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Does the text name this order id as a whole token (not inside a longer id)? */
export const namesOrder = (text: string, orderId: string) => new RegExp(`(?<![A-Za-z0-9_-])${escapeRe(orderId)}(?![A-Za-z0-9_-])`).test(text);

const tail = (fp: string) => `…${fp.slice(-8)}`;

/** Checks `raw` (the letter file's text, or MistProof JSON) for this order with the feed's key. */
export async function checkLetter(raw: string, o: LetterOrder, deps: LetterDeps, now = new Date()): Promise<LetterCheck> {
  const { log, siteName, orderId } = o;
  if (log.format === 'nkip01') throw new Error('NKIP-0001 sites are checked through their receipt');
  const fail = (lines: Line[]): LetterCheck => ({ format: log.format as 'pgp' | 'mistproof', verified: false, lines, addresses: [], signedText: '' });

  if (log.format === 'mistproof') {
    const r = verifyMistProof(raw, log.ed25519Key);
    if (!r.ok) {
      if (r.reason === 'format') return fail([{ level: 'off', text: 'MistProof not available yet.' }]);
      if (r.reason === 'key') return fail([{ level: 'warn', text: `This MistProof isn't signed for ${siteName}'s key in the xmr.club list. Don't rely on it.` }]);
      return fail([{ level: 'warn', text: `This MistProof doesn't verify with ${siteName}'s key from xmr.club. Don't rely on it.` }]);
    }
    const p = r.proof;
    if (p.order !== orderId) return fail([{ level: 'warn', text: `The signed MistProof is for order ${p.order}, not this one (${orderId}). Don't rely on it.` }]);
    return {
      format: 'mistproof',
      verified: true,
      lines: [{ level: 'ok', text: `MistProof signed by ${siteName}'s key (from xmr.club), for this order.` }],
      addresses: [
        { address: p.send.depositAddress, role: 'deposit' },
        { address: p.receive.address, role: 'payout' },
      ],
      signedText: p.payload,
    };
  }

  if (!log.publicKey) return fail([{ level: 'caution', text: `Couldn't check the letter: no key for ${siteName} in the xmr.club list.` }]);
  const r = await deps.verifyLetter(raw, log.publicKey, log.fingerprint, now);
  if (!r.ok) {
    if (r.reason === 'format') return fail([{ level: 'off', text: 'Letter of guarantee not available yet.' }]);
    if (r.reason === 'key') return fail([{ level: 'caution', text: `Couldn't check the letter: the key in the xmr.club list for ${siteName} doesn't match its fingerprint.` }]);
    return fail([{ level: 'warn', text: `This letter doesn't verify with ${siteName}'s key from xmr.club (${r.detail}). Don't rely on it.` }]);
  }
  // every block (Bitania adds one per step) must be for this order
  if (!r.blocks.every((b) => namesOrder(b.text, orderId))) return fail([{ level: 'warn', text: `The signed letter is for a different order than this page (${orderId}). Don't rely on it.` }]);
  const signedText = r.blocks.map((b) => b.text).join('\n\n');
  return {
    format: 'pgp',
    verified: true,
    lines: [{ level: 'ok', text: `Letter of guarantee signed by ${siteName}'s key (${tail(log.fingerprint)}, from xmr.club), for this order.` }],
    addresses: letterAddresses(signedText),
    signedText,
    signedAt: Math.max(...r.blocks.map((b) => b.signedAt)),
  };
}
