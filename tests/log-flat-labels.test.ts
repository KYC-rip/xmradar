// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { letterAddresses } from '../src/log/check';
import { letterAddressLines } from '../src/log/page';

// DEX.fo's order page (2026-11-06): labels and addresses are siblings in one box, payout first
const DEPOSIT = 'bc1q378cl9k0ddnxzf2d258zc4hncgs3zj6uj9uynf';
const PAYOUT = '0xdadB0d80178819F2319190D340ce9A924f783711';
const LETTER = `-----BEGIN PGP SIGNED MESSAGE-----
Hash: SHA512

DEX Swap Guarantee:

Swap: BTC -> ETH
Swap ID: 6aed9415826ecce960c1328b
Deposit Address: ${DEPOSIT}
Receive Address: ${PAYOUT}
-----BEGIN PGP SIGNATURE-----
`;
const signed = letterAddresses(LETTER);
const dexfo = (deposit = DEPOSIT, payout = PAYOUT, sendLabel = 'Send 0.001 BTC (BTC Mainnet) to:', heading = 'Make a deposit') => {
  document.body.innerHTML = `<div class="box"><p>Receiver</p><div><a href="https://etherscan.io/address/${payout}">${payout}</a><button>c</button></div>
    <p>${heading}</p><p>${sendLabel}</p><div><a href="https://mempool.space/address/${deposit}">${deposit}</a><button>c</button></div></div>`;
  return document;
};

describe('a flat label/value layout', () => {
  it('reads the deposit and the payout from the labels just before each', () => {
    expect(signed.map((a) => a.role).sort()).toEqual(['deposit', 'payout']);
    const lines = letterAddressLines(dexfo(), signed);
    expect(lines.map((l) => l.level)).toEqual(['ok']);
    expect(lines[0]!.text).toBe('The deposit address on this page is the one in the signed letter.');
  });
  it('swapped on the page: the deposit shown under "Receiver" is a warning of its own', () => {
    const lines = letterAddressLines(dexfo(PAYOUT, DEPOSIT), signed);
    expect(lines.some((l) => l.level === 'warn' && l.text.includes('where your payout address should be'))).toBe(true);
  });
  it('deposit first, payout after, each with a copy button: no warning from the payout’s button', () => {
    document.body.innerHTML = `<div class="box"><p>Send 0.001 BTC to:</p><div><a>${DEPOSIT}</a><button data-clipboard-text="${DEPOSIT}">c</button></div>
      <p>Receiver</p><div><a>${PAYOUT}</a><button data-clipboard-text="${PAYOUT}">c</button></div></div>`;
    const lines = letterAddressLines(document, signed);
    expect(lines.map((l) => l.level)).toEqual(['ok']);
  });
  it('the copy buttons in DEX.fo’s order read their own labels too', () => {
    document.body.innerHTML = `<div class="box"><p>Receiver</p><div><a>${PAYOUT}</a><button data-clipboard-text="${PAYOUT}">c</button></div>
      <p>Make a deposit</p><p>Send 0.001 BTC (BTC Mainnet) to:</p><div><a>${DEPOSIT}</a><button data-clipboard-text="${DEPOSIT}">c</button></div></div>`;
    expect(letterAddressLines(document, signed).map((l) => l.level)).toEqual(['ok']);
  });
  it('a label after its value: the next value can take it (here a warning), never an ok', () => {
    document.body.innerHTML = `<div class="box"><div><a>${PAYOUT}</a></div><p>Receiver</p><div><a>${DEPOSIT}</a></div><p>Deposit address</p></div>`;
    const lines = letterAddressLines(document, signed);
    expect(lines.map((l) => l.level)).toEqual(['warn']);
    expect(lines[0]!.text).toContain('where your payout address should be');
  });
  it('a signed payout only in the deposit’s copy button is a warning', () => {
    document.body.innerHTML = `<div class="box"><p>Receiver</p><div><a>${PAYOUT}</a></div>
      <p>Send 0.001 BTC to:</p><div><a>${DEPOSIT}</a><button data-clipboard-text="${PAYOUT}">c</button></div></div>`;
    const lines = letterAddressLines(document, signed);
    expect(lines.some((l) => l.level === 'warn' && l.text.includes("isn't the deposit"))).toBe(true);
  });
  it('an unreadable payment link in the flat deposit box is a caution', () => {
    document.body.innerHTML = `<div class="box"><p>Receiver</p><div><a>${PAYOUT}</a></div>
      <p>Send 0.001 BTC to:</p><div><a>${DEPOSIT}</a><a href="bitcoin:${DEPOSIT}?address=a&address=b">Pay</a></div></div>`;
    const lines = letterAddressLines(document, signed);
    expect(lines.some((l) => l.level === 'caution' && l.text.includes("can't be read for sure"))).toBe(true);
    expect(lines.some((l) => l.level === 'ok')).toBe(false);
  });
  it('a shortened deposit with the full one in the copy button beside it, in the flat box: ok', () => {
    document.body.innerHTML = `<div class="box"><p>Receiver</p><div><a>${PAYOUT}</a></div>
      <p>Send 0.001 BTC to:</p><div><span>${DEPOSIT.slice(0, 10)}…${DEPOSIT.slice(-6)}</span><button data-clipboard-text="${DEPOSIT}">c</button></div></div>`;
    const lines = letterAddressLines(document, signed);
    expect(lines.map((l) => l.level)).toEqual(['ok']);
    expect(lines[0]!.text).toContain('shortened on screen');
  });
  it('a run with both kinds of label, or none, decides nothing', () => {
    expect(letterAddressLines(dexfo(DEPOSIT, PAYOUT, 'Send to your receiving wallet:'), signed).some((l) => l.level === 'ok')).toBe(false);
    expect(letterAddressLines(dexfo(DEPOSIT, PAYOUT, 'Address:', 'Step 2'), signed).some((l) => l.level === 'ok')).toBe(false);
  });
});
