import { decode as nip19Decode } from 'nostr-tools/nip19';
import { familyOf, findAddresses, sameAddress, type Family } from './addresses';
import type { Line } from './check';
import { KIND_ATTESTATION, type Receipt } from './verify';

/**
 * What the order page itself shows (PLAN-NKIP01 §1.1, §4.3, §11, §12.1), read in the content script:
 * the machine-readable receipts (R4), the attestation event id next to the address, and which
 * addresses the page shows in which role, compared with the signed receipt.
 */

export const RECEIPT_SELECTOR = 'script[type="application/nkip01+json"]';
export const MAX_RECEIPTS_PER_PAGE = 5;

const scriptTexts = (doc: Document) => [...doc.querySelectorAll(RECEIPT_SELECTOR)].map((s) => s.textContent ?? '');

/**
 * kyc.rip also puts an unsigned pointer to its witness event ({event_id, commitment, …}, no `sig`) in a
 * receipt script. It isn't a receipt: its event id is read like one the page shows, and checked the same way.
 */
function eventPointer(text: string): string | undefined {
  try {
    const v: unknown = JSON.parse(text);
    if (!v || typeof v !== 'object' || 'sig' in v) return undefined;
    const id = (v as { event_id?: unknown }).event_id;
    return typeof id === 'string' && /^[0-9a-f]{64}$/.test(id) ? id : undefined;
  } catch {
    return undefined;
  }
}

export const receiptTexts = (doc: Document) => scriptTexts(doc).filter((t) => !eventPointer(t)).slice(0, MAX_RECEIPTS_PER_PAGE);

export type Role = 'deposit' | 'payout' | null;
const DEPOSIT_LABEL = /\b(deposit|send (?:exactly )?(?:to|the)|pay to|payment address|send)\b/i;
const PAYOUT_LABEL = /\b(payout|receive|recipient|destination|you get|receiving)\b/i;
const EVENT_LABEL = /\b(event|attestation|witness|record)\b/i;
const SKIP = 'script, style, template, noscript, [hidden], [aria-hidden="true"]';

/** Is this element rendered: not in a skipped subtree, not a hidden input, and with a box. */
export function shown(el: Element): boolean {
  if (el.closest(SKIP)) return false;
  if (el instanceof HTMLInputElement && el.type === 'hidden') return false;
  const v = (el as Element & { checkVisibility?: (o?: object) => boolean }).checkVisibility;
  if (typeof v === 'function') return v.call(el, { visibilityProperty: true, opacityProperty: true });
  return true;
}

const LEVEL_CHARS = 400;

/** An element's text with a space between text nodes (textContent runs neighbouring blocks together), capped. */
function spacedText(el: Element): string {
  const walker = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let out = '';
  for (let n = walker.nextNode(); n && out.length < LEVEL_CHARS; n = walker.nextNode()) out += ` ${n.textContent ?? ''}`;
  return out.slice(0, LEVEL_CHARS);
}

/** The label text at each level around an element: itself, then up to 3 ancestors. */
function* labelLevels(el: Element): Generator<string> {
  let at: Element | null = el;
  for (let i = 0; i < 4 && at; i++, at = at.parentElement) yield `${at.getAttribute('aria-label') ?? ''} ${spacedText(at)}`;
}

const labelOf = (el: Element) => [...labelLevels(el)].join(' ');

const ALL_FAMILIES: ReadonlySet<Family> = new Set(['XMR', 'BTC']);

/**
 * The role `address` is shown in: the issuer's `data-nkip01` markup, else the closest level whose text
 * names exactly one role. The climb stops at a level naming both, or holding another address
 * (`holdsOther`, by default an XMR or BTC one): a label there may belong to that one.
 */
export function roleOf(el: Element, address: string, holdsOther = (text: string) => findAddresses(text, ALL_FAMILIES).some((a) => !sameAddress(a.address, address))): Role {
  const marked = el.closest('[data-nkip01]')?.getAttribute('data-nkip01');
  if (marked === 'deposit_address') return 'deposit';
  if (marked === 'payout_address') return 'payout';
  for (const text of labelLevels(el)) {
    if (holdsOther(text)) return null;
    const d = DEPOSIT_LABEL.test(text);
    const p = PAYOUT_LABEL.test(text);
    if (d !== p) return d ? 'deposit' : 'payout';
    if (d && p) return null;
  }
  return null;
}

/** Every visible text holder: text nodes' parents and input/textarea values. */
export function* visibleTexts(doc: Document): Generator<{ el: Element; text: string }> {
  const walker = doc.createTreeWalker(doc.body ?? doc.documentElement, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const el = n.parentElement;
    if (el && n.textContent && n.textContent.trim().length >= 25 && shown(el)) yield { el, text: n.textContent };
  }
  for (const el of doc.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea')) if (el.value && shown(el)) yield { el, text: el.value };
}

/** The attestation event id the page shows next to a label (§12.1): 64 hex or a kind 3711 nevent. */
export function pageEventId(doc: Document): string | undefined {
  for (const t of scriptTexts(doc)) {
    const id = eventPointer(t);
    if (id) return id;
  }
  for (const { el, text } of visibleTexts(doc)) {
    if (!EVENT_LABEL.test(labelOf(el))) continue;
    const hex = /\b[0-9a-f]{64}\b/.exec(text)?.[0];
    if (hex) return hex;
    const nevent = /\bnevent1[02-9ac-hj-np-z]{20,}\b/.exec(text)?.[0];
    if (nevent) {
      try {
        const d = nip19Decode(nevent);
        if (d.type === 'nevent' && (d.data.kind === undefined || d.data.kind === KIND_ATTESTATION)) return d.data.id;
      } catch {
        // not a valid nevent
      }
    }
  }
  return undefined;
}

const short = (a: string) => `${a.slice(0, 8)}…${a.slice(-8)}`;
const signedOf = (r: Receipt) => [r.deposit_address, r.payout_address, ...(r.refund_address ? [r.refund_address] : [])];

/** The Addresses lines (§1.1, §4.3, §11): the signed deposit address in its role, and nothing unsigned. */
export function addressLines(doc: Document, r: Receipt): Line[] {
  const depositFamily = familyOf(r.deposit_asset);
  const payoutFamily = familyOf(r.payout_asset);
  const families = new Set<Family>([depositFamily, payoutFamily].filter((f): f is Family => !!f));
  const lines: Line[] = [];
  if (!depositFamily) lines.push({ level: 'off', text: `Deposit address not checked for ${r.deposit_asset}: check that your wallet sends to ${short(r.deposit_address)}.` });
  if (!families.size) return lines;

  const signed = signedOf(r);
  const unsigned = new Set<string>();
  // the roles each signed address is shown in (null: no recognisable label)
  const depositAs = new Set<Role>();
  const payoutAs = new Set<Role>();
  for (const { el, text } of visibleTexts(doc)) {
    for (const { address } of findAddresses(text, families)) {
      if (!signed.some((s) => sameAddress(s, address))) unsigned.add(address);
      else if (sameAddress(address, r.deposit_address)) depositAs.add(roleOf(el, address));
      else if (sameAddress(address, r.payout_address)) payoutAs.add(roleOf(el, address));
    }
  }

  if (unsigned.size) {
    const list = [...unsigned].map(short).join(', ');
    lines.push({ level: 'warn', text: `This page shows ${unsigned.size > 1 ? 'addresses' : 'an address'} the exchange didn't sign: ${list}. Don't send.` });
  }
  if (payoutAs.has('deposit')) lines.push({ level: 'warn', text: 'The page shows the payout address where the deposit address should be. Don’t send.' });
  else if (depositAs.has('payout')) lines.push({ level: 'warn', text: 'The page shows the deposit address where your payout address should be. Check the order before sending.' });
  // only the payout address can be checked: say what was seen of it, not a deposit verdict
  else if (!depositFamily) {
    if (payoutAs.has('payout')) lines.push({ level: 'ok', text: 'The payout address on this page is the one the exchange signed.' });
    else if (payoutAs.size) lines.push({ level: 'ok', text: 'The payout address on this page is the one the exchange signed, but it isn’t labelled as yours.' });
  } else if (!depositAs.size) lines.push({ level: 'caution', text: `Deposit address not found as text (QR only?): check that your wallet shows ${short(r.deposit_address)}.` });
  else if (depositAs.has('deposit') && !unsigned.size)
    lines.push({
      level: 'ok',
      text: !payoutAs.size
        ? 'Deposit address matches; payout address not shown on this page.'
        : payoutAs.has('payout')
          ? 'The deposit and payout addresses on this page are the ones the exchange signed.'
          : 'Deposit address matches; the payout address is shown, but not labelled as yours.',
    });
  else if (!depositAs.has('deposit')) lines.push({ level: 'caution', text: `Addresses present; roles not confirmed. Check that your wallet sends to ${short(r.deposit_address)}.` });
  return lines;
}

/** The copy check (§1.2): a copied address of the receipt's families that the exchange didn't sign. */
export function copyWarning(copied: string, r: Receipt): string | null {
  const families = new Set([familyOf(r.deposit_asset), familyOf(r.payout_asset)].filter((f): f is Family => !!f));
  const found = findAddresses(copied.trim(), families);
  const bad = found.find(({ address }) => !signedOf(r).some((s) => sameAddress(s, address)));
  return bad ? `You copied an address the exchange didn't sign (${short(bad.address)}). Don't send to it.` : null;
}

/** Is a deposit-labelled address of these families visible (the missing-receipt timer starts then, §11)? */
export function depositShown(doc: Document, families: ReadonlySet<Family> = new Set(['XMR', 'BTC'])): boolean {
  for (const { el, text } of visibleTexts(doc)) if (findAddresses(text, families).some((a) => roleOf(el, a.address) === 'deposit')) return true;
  return false;
}
