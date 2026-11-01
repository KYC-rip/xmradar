// @vitest-environment happy-dom
import { base58, base64urlnopad } from '@scure/base';
import { describe, expect, it } from 'vitest';
import { letterAddresses, type LetterAddress } from '../src/log/check';
import { letterAddressLines, MAX_TARGETS, uriRecipient } from '../src/log/page';

// made-up addresses (PLAN-COPYTARGET); the USDC mint and USDT jetton are public token ids
const sol = (seed: number) => base58.encode(Uint8Array.from({ length: 32 }, (_, i) => (seed * 31 + i * 7) % 256 || 1));
const crc16 = (b: Uint8Array) => {
  let c = 0;
  for (const x of b) {
    c ^= x << 8;
    for (let i = 0; i < 8; i++) c = c & 0x8000 ? ((c << 1) ^ 0x1021) & 0xffff : (c << 1) & 0xffff;
  }
  return c;
};
const ton = (seed: number) => {
  const b = new Uint8Array(36);
  b[0] = 0x51;
  for (let i = 0; i < 32; i++) b[2 + i] = (seed * 13 + i * 5) % 256;
  const c = crc16(b.subarray(0, 34));
  b[34] = c >> 8;
  b[35] = c & 0xff;
  return base64urlnopad.encode(b);
};
const DEPOSIT = sol(1);
const PAYOUT = ton(2);
const OTHER_SOL = sol(5);
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDT_JETTON = 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs';
const BTC = 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq';
const TRON_TOKEN = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const LETTER = `format_version: 1
service: "BitcoinVN"
network_name: "Solana"
token_identifier: "${USDC_MINT}"
deposit_destination: {"address":"${DEPOSIT}"}
payout_network_name: "Ton Network"
payout_token_identifier: "${USDT_JETTON}"
payout_destination: {"address":"${PAYOUT}","memo":null}
`;
const signed: LetterAddress[] = letterAddresses(LETTER);
const page = (html: string) => {
  document.body.innerHTML = html;
  return document;
};
const shortSpans = (a: string) => `<span>${a.slice(0, 12)}</span><span hidden>…</span><span>${a.slice(-8)}</span>`;
const depositBox = (inner: string) => `<div class="box"><p>Single-use address</p><div>${shortSpans(DEPOSIT)}${inner}</div></div>`;
const payoutBox = `<div class="box"><p>You receive at</p><div>${shortSpans(PAYOUT)}<button data-clipboard-text="${PAYOUT}">Copy</button></div></div>`;
const levels = (html: string) => letterAddressLines(page(html), signed).map((l) => l.level);
const textOf = (html: string) => letterAddressLines(page(html), signed).map((l) => l.text).join(' | ');

describe('payment URIs', () => {
  it('reads one recipient, never other parameters', () => {
    expect(uriRecipient(`solana:${DEPOSIT}?spl-token=${USDC_MINT}&amount=10`)).toBe(DEPOSIT);
    expect(uriRecipient(`BITCOIN:${BTC}?amount=1`)).toBe(BTC);
    expect(uriRecipient(`bitcoin:${BTC}#frag`)).toBe(BTC);
    expect(uriRecipient('ethereum:0xToken@1/transfer?address=0xRecipient&uint256=1')).toBe('0xRecipient');
    expect(uriRecipient(`ton://transfer/${PAYOUT}?amount=1`)).toBe(PAYOUT);
    expect(uriRecipient(`ton:${PAYOUT}`)).toBe(PAYOUT);
    expect(uriRecipient(`solana:${encodeURIComponent(DEPOSIT)}`)).toBe(DEPOSIT);
  });
  it('EIP-681 names its recipient in address= only: to= or recipient= is unreadable', () => {
    expect(uriRecipient('ethereum:0xToken@1/transfer?to=0xRecipient')).toBe('unreadable');
    expect(uriRecipient('ethereum:0xToken@1/transfer?recipient=0xRecipient&uint256=1')).toBe('unreadable');
  });
  it('unreadable when two recipients are named; not a payment URI otherwise', () => {
    expect(uriRecipient('ethereum:0xT@1/transfer?address=0xA&address=0xB')).toBe('unreadable');
    expect(uriRecipient(`bitcoin:${BTC}?address=bc1other`)).toBe('unreadable');
    expect(uriRecipient('ton://pay/x')).toBe('unreadable');
    expect(uriRecipient('litecoin:Labc')).toBeNull();
    expect(uriRecipient('https://solscan.io/account/x')).toBeNull();
  });
});

describe('the shortened deposit with its copy button (BitcoinVN)', () => {
  it('copy button and solana: link in the deposit box hold the signed deposit: ok, naming the QR as unchecked', () => {
    const html = depositBox(`<button data-clipboard-text="${DEPOSIT}">Copy</button><a href="solana:${DEPOSIT}?spl-token=${USDC_MINT}">Open wallet</a>`) + payoutBox;
    const lines = letterAddressLines(page(html), signed);
    expect(lines).toEqual([{ level: 'ok', text: expect.stringContaining("The QR code isn't checked") }]);
  });
  it('a copy attribute holding a solana: URI counts too', () => {
    expect(levels(depositBox(`<button data-copy="solana:${DEPOSIT}?amount=1">Copy</button>`))).toEqual(['ok']);
  });
  it('without a copy target: today’s shortened caution', () => {
    expect(textOf(depositBox(''))).toContain('shortened. It fits');
  });
  it('the signed deposit only in a copy button, no text: still "not found as text"', () => {
    expect(textOf(`<div><p>Single-use address</p><button data-clipboard-text="${DEPOSIT}">Copy</button></div>`)).toContain('not found as text');
  });
  it('the copy button with the signed deposit in another box: no upgrade', () => {
    const html = `<div><p>Single-use address</p><div>${shortSpans(DEPOSIT)}</div></div><div><p>Help</p><div><button data-clipboard-text="${DEPOSIT}">Copy</button></div></div>`;
    expect(levels(html)).toEqual(['caution']);
  });
  it('decoy: the deposit box shows another shortened address, the signed one is in a button elsewhere: no ok', () => {
    const html = `<div><p>Single-use address</p><div>${shortSpans(OTHER_SOL)}</div></div><div><p>Help</p><div><button data-clipboard-text="${DEPOSIT}">Copy</button></div></div>`;
    expect(levels(html)).not.toContain('ok');
  });
});

describe('copy targets that warn or block', () => {
  it('a second copy button in the deposit box with another address: warn', () => {
    const html = depositBox(`<button data-clipboard-text="${DEPOSIT}">Copy</button><button data-clipboard-text="${OTHER_SOL}">Copy</button>`);
    const lines = letterAddressLines(page(html), signed);
    expect(lines[0]).toMatchObject({ level: 'warn', text: expect.stringContaining('copy button or payment link in the deposit box') });
    expect(lines.some((l) => l.level === 'ok')).toBe(false);
  });
  it('an unsigned BTC address in a deposit-box copy button: warn', () => {
    expect(textOf(depositBox(`<button data-clipboard-text="${BTC}">Copy</button>`))).toContain("Don't send");
  });
  it('a donation BTC button and a Tron token contract outside the send boxes: nothing', () => {
    const html = depositBox(`<button data-clipboard-text="${DEPOSIT}">Copy</button>`) + `<footer><p>Donate</p><div><button data-clipboard-text="${BTC}">Copy</button></div></footer><aside><p>Token contract</p><div><button data-copy="${TRON_TOKEN}">c</button></div></aside>`;
    expect(levels(html)).toEqual(['ok']);
  });
  it('an unsigned Solana account in a copy button outside the send boxes: no warning, but no upgrade', () => {
    const html = depositBox(`<button data-clipboard-text="${DEPOSIT}">Copy</button>`) + `<aside><p>Program</p><div><button data-clipboard-text="${OTHER_SOL}">c</button></div></aside>`;
    expect(levels(html)).toEqual(['caution']);
  });
  it('a hidden copy button with another address is ignored', () => {
    expect(levels(depositBox(`<button data-clipboard-text="${DEPOSIT}">Copy</button><button hidden data-clipboard-text="${BTC}">x</button>`))).toEqual(['ok']);
  });
  it('an unreadable payment link in the deposit box: caution, no ok', () => {
    const lines = letterAddressLines(page(depositBox(`<button data-clipboard-text="${DEPOSIT}">Copy</button><a href="ethereum:0xT@1/transfer?address=0xA&address=0xB">pay</a>`)), signed);
    expect(lines.some((l) => l.level === 'ok')).toBe(false);
    expect(lines.map((l) => l.text).join(' ')).toContain("can't be read for sure");
  });
  it(`more than ${MAX_TARGETS} copy buttons: no upgrade, and the full-text ok is blocked too`, () => {
    const many = Array.from({ length: MAX_TARGETS + 1 }, () => `<button data-copy="x">c</button>`).join('');
    expect(levels(depositBox(`<button data-clipboard-text="${DEPOSIT}">Copy</button>`) + many)).not.toContain('ok');
    const full = letterAddressLines(page(`<p>Deposit address: ${DEPOSIT}</p>` + many), signed);
    expect(full.some((l) => l.level === 'ok')).toBe(false);
    expect(full.map((l) => l.text).join(' ')).toContain('more copy buttons and payment links');
  });
});

describe('round-2 review cases', () => {
  it('the signed payout in a copy button in the deposit box: warn, no ok (full text or shortened)', () => {
    const full = letterAddressLines(page(`<div><p>Deposit address: ${DEPOSIT}</p><div><button data-clipboard-text="${PAYOUT}">Copy</button></div></div>`), signed);
    expect(full[0]).toMatchObject({ level: 'warn', text: expect.stringContaining("isn't the deposit") });
    expect(full.some((l) => l.level === 'ok')).toBe(false);
    expect(levels(depositBox(`<button data-clipboard-text="${DEPOSIT}">Copy</button><button data-copy="${USDC_MINT}">mint</button>`))).toContain('warn');
  });
  it('hidden text in the box neither hides the signed payout copy button nor labels a box', () => {
    const masked = `<div><p>Deposit address: ${DEPOSIT}</p><span hidden>${OTHER_SOL}</span><div><button data-clipboard-text="${PAYOUT}">Copy</button></div></div>`;
    expect(textOf(masked)).toContain("isn't the deposit");
    expect(levels(masked)).not.toContain('ok');
    expect(levels(`<div><p hidden>Deposit address</p><p>${DEPOSIT}</p></div>`)).not.toContain('ok');
  });
  it('hidden copy buttons do not count toward the cap', () => {
    const hidden = Array.from({ length: MAX_TARGETS + 1 }, () => '<button hidden data-copy="x">c</button>').join('');
    expect(levels(`<p>Deposit address: ${DEPOSIT}</p>` + hidden)).toEqual(['ok']);
  });
  it('a large label box stays quick', () => {
    const filler = '<i></i>'.repeat(20_000);
    const t = performance.now();
    const lines = letterAddressLines(page(`<div>${filler}<p>Deposit address: ${DEPOSIT}</p><button data-copy="${DEPOSIT}">c</button></div>`), signed);
    expect(performance.now() - t).toBeLessThan(5_000);
    expect(lines.length).toBeGreaterThan(0);
  });
  it('"Single-use address" is the deposit label for text too: the full signed deposit there is ok', () => {
    expect(levels(`<div><p>Single-use address</p><p>${DEPOSIT}</p></div>`)).toEqual(['ok']);
  });
  it('an unsigned Solana account shown as text under "Single-use address": warn', () => {
    const lines = letterAddressLines(page(`<div><p>Single-use address</p><p>${OTHER_SOL}</p></div>`), signed);
    expect(lines[0]).toMatchObject({ level: 'warn' });
  });
  it('a comment inside the shortened deposit box does not break the card', () => {
    const html = `<div class="box"><p>Single-use address</p><div><!-- addr --><span>${DEPOSIT.slice(0, 12)}</span><!-- … --><span>${DEPOSIT.slice(-8)}</span><button data-clipboard-text="${DEPOSIT}">Copy</button></div></div>`;
    expect(levels(html)).toEqual(['ok']);
  });
  it('a large page: the shortened-deposit search gives up rather than run long (no ok)', () => {
    const filler = Array.from({ length: 6_000 }, (_, i) => `<p>line ${i}</p>`).join('');
    const started = performance.now();
    const lv = levels(depositBox(`<button data-clipboard-text="${DEPOSIT}">Copy</button>`) + filler);
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(lv).not.toContain('ok');
  });
});
