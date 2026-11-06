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
 * Anything of that shape (an object with `event_id` and no `sig`) is page metadata, never a receipt, even
 * when its id is unusable: nkips.org's own example, rendered as a real script, has `"event_id":"<64 hex>"`.
 */
function pointerOf(text: string): { id?: string } | null {
  try {
    const v: unknown = JSON.parse(text);
    if (!v || typeof v !== 'object' || Array.isArray(v) || 'sig' in v || !('event_id' in v)) return null;
    const id = (v as { event_id?: unknown }).event_id;
    return typeof id === 'string' && /^[0-9a-f]{64}$/.test(id) ? { id } : {};
  } catch {
    return null;
  }
}
const eventPointer = (text: string) => pointerOf(text)?.id;

export const receiptTexts = (doc: Document) => scriptTexts(doc).filter((t) => !pointerOf(t)).slice(0, MAX_RECEIPTS_PER_PAGE);

export type Role = 'deposit' | 'payout' | null;
const DEPOSIT_LABEL = /\b(deposit|send (?:exactly )?(?:to|the)|pay to|payment address|send)\b/i;
const PAYOUT_LABEL = /\b(payout|receive|receiver|recipient|destination|you get|receiving)\b/i;
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

const QR_HINT = /qr/i;
const QR_ATTRS = ['class', 'id', 'alt', 'aria-label', 'title', 'data-testid'];
const QR_MIN_PX = 96;
/**
 * Could this page be showing a QR code? A hint in an attribute of the picture or its parent, or a square
 * canvas, picture or many-part drawing of QR size. It guesses yes freely: a yes keeps the caution. A miss
 * matters only on a letter page whose own status headline says the deposit is behind (pastDepositStatus),
 * where the line turns neutral but still names the signed address. QR drawings are often aria-hidden: only a
 * really hidden one doesn't count.
 */
export function pageHasQr(doc: Document): boolean {
  for (const el of (doc.body ?? doc.documentElement).querySelectorAll('img, svg, canvas, picture, [class*="qr" i], [id*="qr" i]')) {
    if (el.closest('template, noscript, [hidden]') || el.parentElement?.closest('svg')) continue;
    const v = (el as Element & { checkVisibility?: (o?: object) => boolean }).checkVisibility;
    if (typeof v === 'function' && !v.call(el, { visibilityProperty: true, opacityProperty: true })) continue;
    if ([el, el.parentElement].some((e) => e && QR_ATTRS.some((a) => QR_HINT.test(e.getAttribute(a) ?? '')))) return true;
    const { width: w, height: h } = el.getBoundingClientRect();
    if (Math.min(w, h) < QR_MIN_PX || Math.abs(w - h) > Math.max(w, h) * 0.1) continue;
    if (el.tagName !== 'svg' && el.tagName !== 'SVG') return true;
    // a spinner or an icon has a few parts; a QR code drawn as an SVG has many, or one long path
    if (el.getAttribute('shape-rendering') === 'crispEdges' || el.querySelectorAll('rect, path').length >= 50 || [...el.querySelectorAll('path')].some((p) => (p.getAttribute('d') ?? '').length > 2000)) return true;
  }
  return false;
}

/**
 * A page's live status headline that says the order is past the deposit (Mistex while sending: an h2
 * "Sending to your wallet"; done: "Exchange completed!"). Only a heading or status element whose whole text is
 * that status, not in a list, nav, footer, aside or details: progress bars, menus and FAQs list the same words
 * from the start. Returns the headline, to quote.
 */
const PAST_DEPOSIT_STATUS =
  /^(?:(?:your )?(?:exchange|swap|order|transaction) (?:is |has been )?(?:successfully )?(?:completed?|finished|processed)|sending(?: funds)? to your (?:wallet|address)|funds are on the way|transfer in progress|(?:deposit|payment) (?:received|confirmed)|we(?:'|’)?ve received your (?:deposit|payment)|we have received your (?:deposit|payment))[.!]?$/i;
export function pastDepositStatus(doc: Document): string | null {
  for (const el of (doc.body ?? doc.documentElement).querySelectorAll('h1, h2, h3, h4, [role="status"], [aria-live]')) {
    if (el.closest('li, ol, ul, nav, footer, aside, details') || !shown(el)) continue;
    const t = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (t.length <= 80 && PAST_DEPOSIT_STATUS.test(t)) return t;
  }
  return null;
}

/**
 * The line for a deposit address the page doesn't show as text: neutral only with `past`, the page's own
 * status headline saying the deposit is behind (the caller checked nothing on the page may hold the address);
 * otherwise the caution, since XMRadar can't see every way a page shows an address.
 */
export function depositNotShown(address: string, past: string | null): Line {
  return past
    ? { level: 'off', text: `This page says “${past}”, so the order is past the deposit step and no longer shows the deposit address. If you still have to send, the signed one is ${address}.` }
    : {
        level: 'caution',
        text: `XMRadar couldn't find the deposit address as text on this page (it may be in a QR code, copy button or payment link). The signed one is ${address}: check that your wallet sends to it.`,
      };
}

const LEVEL_CHARS = 400;
const LEVEL_NODES = 2_000;

/**
 * An element's shown text with a space between text nodes (textContent runs neighbouring blocks together),
 * capped (characters and nodes walked). Hidden subtrees are skipped: text the user can't see neither labels a box nor stops the climb.
 */
function spacedText(el: Element): string {
  const walker = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.nodeType === 1 && !shown(n as Element) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  let out = '';
  let nodes = 0;
  for (let n = walker.nextNode(); n && out.length < LEVEL_CHARS && nodes++ < LEVEL_NODES; n = walker.nextNode()) if (n.nodeType === 3) out += ` ${n.textContent ?? ''}`;
  return out.slice(0, LEVEL_CHARS);
}

/**
 * The label text at each level around an element: itself, then up to 3 ancestors, with the element. Never the
 * page itself (`body`, `html`): a label anywhere on the page says nothing about this element's box.
 */
function* labelLevels(el: Element): Generator<{ at: Element; text: string }> {
  let at: Element | null = el;
  for (let i = 0; i < 4 && at && at.localName !== 'body' && at.localName !== 'html'; i++, at = at.parentElement) yield { at, text: `${at.getAttribute('aria-label') ?? ''} ${spacedText(at)}` };
}

const labelOf = (el: Element) => [...labelLevels(el)].map((l) => l.text).join(' ');

const ALL_FAMILIES: ReadonlySet<Family> = new Set(['XMR', 'BTC']);

/**
 * The role `address` is shown in: the issuer's `data-nkip01` markup, else the closest level whose text
 * names exactly one role. The climb stops at a level naming both, or holding another address
 * (`holdsOther`, by default an XMR or BTC one): a label there may belong to that one.
 */
export function roleOf(el: Element, address: string, holdsOther = (text: string) => findAddresses(text, ALL_FAMILIES).some((a) => !sameAddress(a.address, address))): Role {
  return roleAt(el, holdsOther).role;
}

/**
 * `roleOf`, and the element whose label decided it (`box`): two things in one labelled box share it. A page
 * may add its own deposit wording (`depositLabel`), e.g. BitcoinVN's "Single-use address" on letter pages.
 */
export function roleAt(
  el: Element,
  holdsOther: (text: string) => boolean,
  depositLabel: RegExp = DEPOSIT_LABEL,
  /** where a flat label run ends: a sibling showing any other address (a copy target's climb ignores signed ones; its run must not) */
  runStop: (text: string) => boolean = holdsOther,
): { role: Role; box: Element | null } {
  const marked = el.closest('[data-nkip01]');
  const m = marked?.getAttribute('data-nkip01');
  if (m === 'deposit_address') return { role: 'deposit', box: marked! };
  if (m === 'payout_address') return { role: 'payout', box: marked! };
  let below: Element | null = null;
  for (const { at, text } of labelLevels(el)) {
    if (holdsOther(text)) {
      // a flat layout (DEX.fo: "Receiver", its address, "Send … to:", the deposit address, all siblings): the
      // labels right before the level below this one, back to a sibling showing another address, are its own
      const run = below ? labelRun(below, runStop) : '';
      const d = depositLabel.test(run);
      const p = PAYOUT_LABEL.test(run);
      return d !== p ? { role: d ? 'deposit' : 'payout', box: below } : { role: null, box: null };
    }
    const d = depositLabel.test(text);
    const p = PAYOUT_LABEL.test(text);
    if (d !== p) return { role: d ? 'deposit' : 'payout', box: at };
    if (d && p) {
      // both kinds of label here: in a flat layout the labels just before the level below say which is ours
      // (a copy button whose climb passes signed addresses gets here, not to the branch above)
      const run = below ? labelRun(below, runStop) : '';
      const rd = depositLabel.test(run);
      const rp = PAYOUT_LABEL.test(run);
      return rd !== rp ? { role: rd ? 'deposit' : 'payout', box: below } : { role: null, box: null };
    }
    below = at;
  }
  return { role: null, box: null };
}

const RUN_SIBLINGS = 3;

/**
 * Up to 3 shown siblings right before `el`, nearest first, stopping at one that shows another address: the
 * label run of a flat label/value list ("Send 0.001 BTC to:" just above the address). Labels only before the
 * value are read; a page that puts its label after the value gets no role here (a caution, never an ok).
 */
function labelRun(el: Element, stop: (text: string) => boolean): string {
  const parts: string[] = [];
  for (let sib = el.previousElementSibling, i = 0; sib && i < RUN_SIBLINGS; sib = sib.previousElementSibling) {
    if (!shown(sib)) continue;
    const t = `${sib.getAttribute('aria-label') ?? ''} ${spacedText(sib)}`;
    if (stop(t)) break;
    parts.push(t);
    i++;
  }
  return parts.join(' ');
}

/** The deposit wording `roleOf` reads, for pages that add their own. */
export const DEPOSIT_WORDS = DEPOSIT_LABEL;

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
  } else if (!depositAs.size) lines.push(depositNotShown(r.deposit_address, null));
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
