import type { Line } from '../receipts/check';
import { roleOf, shown, visibleTexts, type Role } from '../receipts/page';
import type { LetterAddress } from './check';
import { findLetterAddresses, sameLetterAddress, type LetterFamily } from './families';

/**
 * The order page compared with a verified letter (PLAN-LOG §4.3, Round 2 item 4), in the content
 * script, as the receipt card does: ok only when the signed deposit address is shown as the deposit,
 * nothing unsigned (XMR, BTC, Tron or EVM) is shown, no other signed address sits in the deposit slot, no
 * shortened address fits nothing signed, and the whole page was read. A shortened deposit (`bc1q...gtx9`)
 * that fits is only a caution, with the full signed address shown; a signed address in the other's
 * role, or an unsigned one, is a warning.
 */

// every family XMRadar reads, whatever the letter names: a Tron or EVM address on a BTC order page is as suspect as a BTC one
const FAMILIES: ReadonlySet<LetterFamily> = new Set(['XMR', 'BTC', 'TRON', 'EVM']);
const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT']);
// a shortened address: 4–64 characters, an ellipsis, 4–64 characters; anchored at both ends, so a long
// run of letters is tried once, not from every position in it
const SHORT_RE = /(?<![A-Za-z0-9])([A-Za-z0-9]{4,64})\s?(?:…|\.{2,3})\s?([A-Za-z0-9]{4,64})(?![A-Za-z0-9])/g;
// the same with the ellipsis drawn by CSS or hidden from text (BitcoinVN: `TDmAwaqvQms5 ejYY1ara`), at every
// position; only matched against the signed deposit, so it can only ever give the "shortened" caution
const SPLIT_RE = /(?<![A-Za-z0-9])(?=([A-Za-z0-9]{6,64})\s+([A-Za-z0-9]{6,64})(?![A-Za-z0-9]))/g;
// how an address of each family starts, for shortened tokens that fit nothing signed
const ADDRESS_START = /^(bc1|[13489]|T[1-9A-HJ-NP-Za-km-z]|0x)/i;
export const PAGE_CHARS = 200_000;

/** The page's visible text, node by node with spaces between, and input values; capped, and whether it was cut. */
export function visiblePageText(doc: Document): { text: string; cut: boolean } {
  const parts: string[] = [];
  let len = 0;
  const walker = doc.createTreeWalker(doc.body ?? doc.documentElement, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const el = n.parentElement;
    const t = n.textContent?.trim();
    if (!el || !t || SKIP_TAGS.has(el.tagName) || !shown(el)) continue;
    parts.push(t);
    len += t.length + 1;
    if (len > PAGE_CHARS) return { text: parts.join(' ').slice(0, PAGE_CHARS), cut: true };
  }
  for (const el of doc.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea')) if (el.value && shown(el)) parts.push(el.value);
  const text = parts.join(' ');
  return { text: text.slice(0, PAGE_CHARS), cut: text.length > PAGE_CHARS };
}

const lower = (a: string) => (/^(bc1|0x)/i.test(a) ? a.toLowerCase() : a);
const fits = (a: string, prefix: string, suffix: string) => {
  const [x, p, s] = /^(bc1|0x)/i.test(prefix) ? [lower(a), prefix.toLowerCase(), suffix.toLowerCase()] : [a, prefix, suffix];
  return x.length > p.length + s.length && x.startsWith(p) && x.endsWith(s);
};
const short = (a: string) => `${a.slice(0, 8)}…${a.slice(-8)}`;
const signedHas = (addresses: LetterAddress[], a: string) => addresses.some((s) => sameLetterAddress(s.address, a));
/** The address lines for a verified letter on this page. */
export function letterAddressLines(doc: Document, addresses: LetterAddress[]): Line[] {
  const families = FAMILIES;
  const { text, cut } = visiblePageText(doc);
  const lines: Line[] = [];

  const unsigned = new Set<string>();
  // the page roles each signed address is shown in
  const shownAs = new Map<string, Set<Role>>();
  for (const { el, text: t } of visibleTexts(doc)) {
    const found = findLetterAddresses(t, families);
    for (const { address } of found) {
      const s = addresses.find((a) => sameLetterAddress(a.address, address));
      if (!s) {
        unsigned.add(address);
        continue;
      }
      const role = roleOf(el, address, (lt) => findLetterAddresses(lt, families).some((o) => !sameLetterAddress(o.address, address)));
      shownAs.set(s.address, (shownAs.get(s.address) ?? new Set()).add(role));
    }
  }
  const asRole = (a: LetterAddress) => shownAs.get(a.address) ?? new Set<Role>();

  if (unsigned.size) {
    lines.push({ level: 'warn', text: `This page shows ${unsigned.size > 1 ? 'addresses' : 'an address'} the signed letter doesn't name: ${[...unsigned].map(short).join(', ')}. Don't send.` });
  }
  const deposits = addresses.filter((a) => a.role === 'deposit');
  // anything signed that isn't the deposit: payout, refund, or an address the letter names without a role (BitcoinVN's token contract)
  const others = addresses.filter((a) => a.role !== 'deposit');
  if (others.some((a) => asRole(a).has('deposit'))) lines.push({ level: 'warn', text: "The page shows a signed address that isn't the deposit (payout, refund or other) where the deposit address should be. Don't send." });
  if (deposits.some((a) => asRole(a).has('payout'))) lines.push({ level: 'warn', text: 'The page shows the signed deposit address where your payout address should be. Check the order before sending.' });

  const shortened = [...text.matchAll(SHORT_RE)].map((m) => ({ prefix: m[1]!, suffix: m[2]! }));
  const split = [...text.matchAll(SPLIT_RE)].map((m) => ({ prefix: m[1]!, suffix: m[2]! }));
  // shortened tokens that look like the start of an address but fit nothing signed
  const strayShort = shortened.filter(({ prefix, suffix }) => ADDRESS_START.test(prefix) && !addresses.some((a) => fits(a.address, prefix, suffix)));
  if (strayShort.length && !unsigned.size) {
    lines.push({ level: 'caution', text: `The page shows a shortened address that doesn't fit the signed letter (${strayShort[0]!.prefix}…${strayShort[0]!.suffix}). Use only the address in the letter.` });
  }
  if (cut) lines.push({ level: 'caution', text: 'This page is too long to check every address on it. Compare the address in your wallet with the letter yourself.' });

  if (!deposits.length) {
    lines.push({ level: 'caution', text: 'The signed letter names no deposit address. Compare the address in your wallet with the letter yourself.' });
    return lines;
  }
  const blocked = lines.length > 0;
  for (const d of deposits) {
    const as = asRole(d);
    if (as.has('deposit')) {
      if (!blocked) lines.push({ level: 'ok', text: 'The deposit address on this page is the one in the signed letter.' });
    } else if (as.size) {
      if (!as.has('payout')) lines.push({ level: 'caution', text: `The signed deposit address is on the page, but not labelled as the deposit. Check that your wallet sends to ${d.address}.` });
    } else if ([...shortened, ...split].some(({ prefix, suffix }) => fits(d.address, prefix, suffix))) {
      lines.push({ level: 'caution', text: `The page shows the deposit address shortened. It fits the signed letter's: ${d.address}. Check that your wallet sends to exactly this address.` });
    } else {
      lines.push({ level: 'caution', text: `Deposit address not found as text (QR only?). The signed letter's is ${d.address}: check that your wallet sends to it.` });
    }
  }
  return lines;
}

/** The copy check: a copied address (XMR, BTC, Tron or EVM) that the letter doesn't name. */
export function letterCopyWarning(copied: string, addresses: LetterAddress[]): string | null {
  const bad = findLetterAddresses(copied.trim(), FAMILIES).find(({ address }) => !signedHas(addresses, address));
  return bad ? `You copied an address the signed letter doesn't name (${short(bad.address)}). Don't send to it.` : null;
}
