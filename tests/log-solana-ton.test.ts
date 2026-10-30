// @vitest-environment happy-dom
import { base58, base64, base64urlnopad } from '@scure/base';
import { describe, expect, it } from 'vitest';
import { showsSendNote, letterDetails, type CardEntry, type CardLetter } from '../src/entrypoints/content/receipt-card';
import { letterAddresses, unreadDeposit, type LetterAddress } from '../src/log/check';
import { findLetterAddresses, letterKey, sameLetterAddress, tonAccount } from '../src/log/families';
import { letterAddressLines, letterCopyWarning, pageFamilies } from '../src/log/page';

// made-up addresses, so no real order's are in the repo; the two token ids are public (USDC mint, USDT jetton)
const sol = (seed: number) => base58.encode(Uint8Array.from({ length: 32 }, (_, i) => (seed * 31 + i * 7) % 256 || 1));
const crc16 = (b: Uint8Array) => {
  let c = 0;
  for (const x of b) {
    c ^= x << 8;
    for (let i = 0; i < 8; i++) c = c & 0x8000 ? ((c << 1) ^ 0x1021) & 0xffff : (c << 1) & 0xffff;
  }
  return c;
};
const tonBytes = (flag: number, wc: number, seed: number) => {
  const b = new Uint8Array(36);
  b[0] = flag;
  b[1] = wc;
  for (let i = 0; i < 32; i++) b[2 + i] = (seed * 13 + i * 5) % 256;
  const c = crc16(b.subarray(0, 34));
  b[34] = c >> 8;
  b[35] = c & 0xff;
  return b;
};
const ton = (seed: number, flag = 0x51, url = true) => (url ? base64urlnopad : base64).encode(tonBytes(flag, 0, seed));
const tonRaw = (seed: number) => `0:${[...tonBytes(0x11, 0, seed).subarray(2, 34)].map((x) => x.toString(16).padStart(2, '0')).join('')}`;

const DEPOSIT = sol(1);
const PAYOUT = ton(2);
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDT_JETTON = 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs';
const ALL = new Set(['XMR', 'BTC', 'TRON', 'EVM', 'SOL', 'TON'] as const);

// BitcoinVN's format_version 1 letter body, as signed
const LETTER = `Letter of guarantee

format_version: 1
service: "BitcoinVN"
order_short_id: "BVTEST01"
signing_fingerprint: "58585DB0F0C377F2A3CD7DE8F15B48DF3D11EF7A"
asset: "USDC"
network: "sol"
network_name: "Solana"
token_identifier: "${USDC_MINT}"
deposit_destination: {"address":"${DEPOSIT}"}
payout_asset: "USDT"
payout_network_name: "Ton Network"
payout_token_identifier: "${USDT_JETTON}"
payout_destination: {"address":"${PAYOUT}","memo":null}
refund_destination: {"address":null}
referral_code: "0000000000000000"
`;

describe('Solana and TON addresses', () => {
  it('Solana: 32 bytes of base58; other sizes, BTC and Tron are not Solana', () => {
    expect(findLetterAddresses(`a ${DEPOSIT} b`, ALL)).toEqual([{ family: 'SOL', address: DEPOSIT }]);
    expect(findLetterAddresses(base58.encode(new Uint8Array(31).fill(9)), ALL)).toEqual([]);
    expect(findLetterAddresses(base58.encode(new Uint8Array(33).fill(9)), ALL)).toEqual([]);
    expect(findLetterAddresses('1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2', ALL)).toEqual([{ family: 'BTC', address: '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2' }]);
    expect(findLetterAddresses('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', ALL)).toEqual([{ family: 'TRON', address: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t' }]);
  });

  it('TON: every form of one account is one address', () => {
    const forms = [ton(2, 0x51), ton(2, 0x11), ton(2, 0x51, false), tonRaw(2)];
    expect(new Set(forms.map(letterKey)).size).toBe(1);
    expect(sameLetterAddress(forms[0]!, forms[3]!)).toBe(true);
    expect(tonAccount(USDT_JETTON)).toMatch(/^0:[0-9a-f]{64}$/);
    expect(letterAddresses(`payout_destination: ${forms[0]}\npayout address: ${forms[1]}`)).toHaveLength(1);
  });

  it('TON: testnet, a bad workchain or a bad checksum is not an address', () => {
    expect(tonAccount(ton(2, 0xd1))).toBeNull();
    const badWc = tonBytes(0x11, 0x05, 2);
    expect(tonAccount(base64urlnopad.encode(badWc))).toBeNull();
    const badCrc = tonBytes(0x11, 0, 2);
    badCrc[35] = badCrc[35]! ^ 1;
    expect(tonAccount(base64urlnopad.encode(badCrc))).toBeNull();
  });
});

describe("BitcoinVN's Solana → TON letter", () => {
  it('reads the deposit, the payout, and the two token ids as tokens', () => {
    expect(letterAddresses(LETTER)).toEqual([
      { address: USDC_MINT, role: 'token' },
      { address: DEPOSIT, role: 'deposit' },
      { address: USDT_JETTON, role: 'token' },
      { address: PAYOUT, role: 'payout' },
    ]);
    expect(unreadDeposit(LETTER, letterAddresses(LETTER))).toBeUndefined();
  });

  it('a Solana-looking token on an unlabelled line is not read', () => {
    expect(letterAddresses(`Thank you ${sol(9)}`)).toEqual([]);
  });

  it('a token label wins over refund, deposit and payout', () => {
    expect(letterAddresses(`refund_token_identifier: "${USDC_MINT}"`)).toEqual([{ address: USDC_MINT, role: 'token' }]);
  });

  it('Solana and TON on any address-holding label, not on network, asset or id fields', () => {
    expect(letterAddresses(`Solana address: ${DEPOSIT}`)).toEqual([{ address: DEPOSIT, role: null }]);
    expect(letterAddresses(`Address: ${DEPOSIT}`)).toEqual([{ address: DEPOSIT, role: null }]);
    expect(letterAddresses(`network_name: ${DEPOSIT}\norder_id: ${sol(4)}\nreferral_code: ${sol(6)}`)).toEqual([]);
  });

  it('an unread deposit under "Deposit:" or "Send to:" is named; a null network is no network', () => {
    const ln = 'lnbc1500n1pj9zq4pp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypq';
    expect(unreadDeposit(`Deposit: ${ln}`, [])).toEqual({ network: null });
    expect(unreadDeposit(`Send to: ${ln}\nnetwork: "lightning"`, [])).toEqual({ network: 'lightning' });
    expect(unreadDeposit(`network_name: null\nnetwork: "sol"\nDeposit: ${ln}`, [])).toEqual({ network: 'sol' });
    expect(unreadDeposit(`network: "sol"\nnetwork_name: null\nDeposit: ${ln}`, [])).toEqual({ network: 'sol' });
    expect(unreadDeposit(`network_name: "Lightning"\nnetwork: "ln"\nDeposit: ${ln}`, [])).toEqual({ network: 'Lightning' });
  });

  it('a deposit on a network XMRadar does not read: named, with the network', () => {
    const ln = 'network_name: "Lightning"\ndeposit_destination: {"address":"lnbc1500n1pj9zq4pp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypq"}\n';
    expect(unreadDeposit(ln, letterAddresses(ln))).toEqual({ network: 'Lightning' });
    const bare = 'Deposit address: r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59\n';
    expect(unreadDeposit(bare, letterAddresses(bare))).toEqual({ network: null });
    // a deposit line that holds no address (Bitania's "Deposit window") is not one
    expect(unreadDeposit('Deposit window: until 2026-10-29 11:04:38 UTC\nRequired deposit amount: 0.1 BTC', [])).toBeUndefined();
    expect(unreadDeposit('refund_destination: {"address":null}', [])).toBeUndefined();
  });
});

describe('the page against a Solana → TON letter', () => {
  const signed = letterAddresses(LETTER);
  const page = (html: string) => {
    document.body.innerHTML = html;
    return document;
  };
  const OTHER_SOL = sol(5);

  it('reads Solana and TON on the page only for a letter that signs a send address there', () => {
    expect([...pageFamilies(signed)].sort()).toEqual(['BTC', 'EVM', 'SOL', 'TON', 'TRON', 'XMR']);
    expect(pageFamilies([{ address: USDC_MINT, role: 'token' }]).has('SOL')).toBe(false);
  });

  it('ok when the full Solana deposit is shown as the deposit', () => {
    expect(letterAddressLines(page(`<p>Deposit address: ${DEPOSIT}</p>`), signed)).toMatchObject([{ level: 'ok' }]);
  });

  it('shortened as BitcoinVN shows it: the deposit fits, and the TON payout raises nothing', () => {
    const html = `<p>Single-use address</p><span>${DEPOSIT.slice(0, 12)}</span><span hidden>…</span><span>${DEPOSIT.slice(-8)}</span><p>Address</p><span>${PAYOUT.slice(0, 12)}</span><span>…</span><span>${PAYOUT.slice(-8)}</span>`;
    const lines = letterAddressLines(page(html), signed);
    expect(lines).toMatchObject([{ level: 'caution', text: expect.stringContaining('shortened. It fits') }]);
  });

  it('a full TON payout shown as the payout: no warning', () => {
    expect(letterAddressLines(page(`<p>Deposit address: ${DEPOSIT}</p><p>You receive at: ${PAYOUT}</p>`), signed)).toMatchObject([{ level: 'ok' }]);
  });

  it('mints, programs, other accounts and jettons outside the send slots raise nothing', () => {
    const html = `<p>Deposit address: ${DEPOSIT}</p><p>Token mint: ${USDC_MINT}</p><p>Program ${OTHER_SOL} explorer</p><p>Jetton ${ton(7)} contract</p>`;
    expect(letterAddressLines(page(html), signed)).toMatchObject([{ level: 'ok' }]);
  });

  it('an unsigned Solana address in the deposit or payout slot: Don’t send', () => {
    expect(letterAddressLines(page(`<p>Deposit address: ${OTHER_SOL}</p>`), signed)[0]).toMatchObject({ level: 'warn', text: expect.stringContaining("Don't send") });
    expect(letterAddressLines(page(`<p>Deposit address: ${DEPOSIT}</p><p>Payout address: ${ton(8)}</p>`), signed)[0]).toMatchObject({ level: 'warn' });
  });

  it('an unsigned Solana address set beside the signed deposit, in the same box: Don’t send', () => {
    const html = `<div><p>Deposit address</p><p>${DEPOSIT} or ${OTHER_SOL}</p></div>`;
    expect(letterAddressLines(page(html), signed)[0]).toMatchObject({ level: 'warn', text: expect.stringContaining(OTHER_SOL.slice(0, 8)) });
  });

  it('a shortened Solana or TON address that fits nothing signed: the shortened caution', () => {
    expect(letterAddressLines(page(`<p>Deposit address: ${DEPOSIT}</p><p>${OTHER_SOL.slice(0, 6)}…${OTHER_SOL.slice(-6)}</p>`), signed)).toMatchObject([{ level: 'caution', text: expect.stringContaining("doesn't fit") }]);
    const t = ton(9);
    expect(letterAddressLines(page(`<p>Deposit address: ${DEPOSIT}</p><p>${t.slice(0, 6)}…${t.slice(-6)}</p>`), signed)).toMatchObject([{ level: 'caution', text: expect.stringContaining("doesn't fit") }]);
  });

  it('a signed token in the same box as the deposit does not take its label', () => {
    const html = `<div><p>Deposit address</p><p>${DEPOSIT}</p><p>${USDC_MINT}</p></div>`;
    expect(letterAddressLines(page(html), signed)).toMatchObject([{ level: 'ok' }]);
    // and an unsigned one in that box is still caught
    const bad = `<div><p>Deposit address</p><p>${OTHER_SOL}</p><p>${USDC_MINT}</p></div>`;
    expect(letterAddressLines(page(bad), signed)[0]).toMatchObject({ level: 'warn' });
  });

  it('a TON payout shortened in another form of the same account fits; standard base64 too', () => {
    const forms = [ton(2, 0x11), ton(2, 0x51, false), ton(2, 0x11, false)];
    for (const f of forms) {
      const lines = letterAddressLines(page(`<p>Deposit address: ${DEPOSIT}</p><p>${f.slice(0, 10)}…${f.slice(-8)}</p>`), signed);
      expect(lines).toMatchObject([{ level: 'ok' }]);
    }
    // a different account shortened, with base64's + / - _ in it, is caught
    const other = [3, 4, 6, 10, 11, 12].map((n) => ton(n, 0x11, false)).find((t) => /[+/]/.test(t.slice(0, 10) + t.slice(-8))) ?? ton(3, 0x11, false);
    expect(letterAddressLines(page(`<p>Deposit address: ${DEPOSIT}</p><p>${other.slice(0, 10)}…${other.slice(-8)}</p>`), signed)).toMatchObject([{ level: 'caution', text: expect.stringContaining("doesn't fit") }]);
  });

  it('a page for an XMR order never reads Solana: a random base58 string raises nothing', () => {
    const xmr: LetterAddress[] = [{ address: '45istt3RSruFAerMyAgX2WFtRSkLXGeyiJ7VyvWVm46hEmuZZa4rY5NHJBPyh5UyUpUDH6kvN8JAFgoUCoWTjKNp6D4RuTK', role: 'deposit' }];
    expect(letterAddressLines(page(`<p>Deposit address: ${xmr[0]!.address}</p><p>Deposit address: ${OTHER_SOL}</p>`), xmr)).toMatchObject([{ level: 'ok' }]);
  });

  it('copying a Solana or TON token is not judged; a copied Tron one still is', () => {
    expect(letterCopyWarning(OTHER_SOL, signed)).toBeNull();
    expect(letterCopyWarning(ton(7), signed)).toBeNull();
    expect(letterCopyWarning('TAcWbsKJryUGAGqHSJWa8bhgZQJtkvCaGd', signed)).toContain("doesn't name");
  });

  it('a deposit on a network XMRadar does not read: says so, with the network or without', () => {
    const payoutOnly: LetterAddress[] = [{ address: PAYOUT, role: 'payout' }];
    expect(letterAddressLines(page('<p>hi</p>'), payoutOnly, [], { network: 'Lightning' })).toEqual([
      { level: 'caution', text: "The signed letter's deposit address is on Lightning, which XMRadar can't check yet. Compare the address in your wallet with the signed text yourself." },
    ]);
    expect(letterAddressLines(page('<p>hi</p>'), payoutOnly, [], { network: null })[0]!.text).toContain('is on a network, which');
    expect(letterAddressLines(page('<p>hi</p>'), payoutOnly)[0]!.text).toContain('names no deposit address');
  });
});

describe('the card', () => {
  const letter = (addresses: LetterAddress[], verified = true): CardLetter => ({ name: 'BitcoinVN', orderId: 'BVTEST01', format: 'pgp', verified, addresses, signedText: LETTER, recheck: () => {} });
  const entry = (l: CardLetter, lines: CardEntry['lines'] = []): CardEntry => ({ letter: l, lines, saved: true });

  it('a token contract row is labelled so and has no Copy button', () => {
    const e = entry(letter(letterAddresses(LETTER)));
    const dl = letterDetails(e.letter!, e)[0] as HTMLElement;
    const rows = [...dl.querySelectorAll('dt')].map((dt) => [dt.textContent, !!dt.nextElementSibling!.querySelector('button')]);
    expect(rows).toEqual([
      ['Order', false],
      ['Token contract (not a send address)', false],
      ['You send to', true],
      ['Token contract (not a send address)', false],
      ['You get at', true],
    ]);
  });

  it('"same address as above" only under a signed deposit, and never beside a warning', () => {
    const withDeposit = entry(letter(letterAddresses(LETTER)));
    expect(showsSendNote([withDeposit], [])).toBe(true);
    expect(showsSendNote([entry(letter([{ address: PAYOUT, role: 'payout' }]))], [])).toBe(false);
    expect(showsSendNote([entry(letter(letterAddresses(LETTER), false))], [])).toBe(false);
    expect(showsSendNote([entry(letter(letterAddresses(LETTER)), [{ level: 'warn', text: "Don't send." }])], [])).toBe(false);
    // the copy check's warning sits in `extra`
    expect(showsSendNote([withDeposit], [{ level: 'warn', text: "You copied an address the signed letter doesn't name" }])).toBe(false);
  });
});
