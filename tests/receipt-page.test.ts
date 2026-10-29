import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { neventEncode } from 'nostr-tools/nip19';
import { describe, expect, it } from 'vitest';
import { addressLines, copyWarning, pageEventId, receiptTexts } from '../src/receipts/page';
import type { Receipt } from '../src/receipts/verify';
import { makeDoc } from './helpers';

const v2 = JSON.parse(readFileSync(join(process.cwd(), 'tests/fixtures/nkip01/v2.json'), 'utf8'));
// BTC deposit, XMR payout; real mainnet-shaped addresses so the family checks apply
const DEP = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';
const OTHER_BTC = '3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy';
const PAY = '44AFFq5kSiGBoZ4NMDwYtN18obc8AemS33DBLWs3H7otXft3XjrpDtQGv7SqSsaBYBb98uNbr2VBBEt7f2wfn3RVGQBEP3A';
const r: Receipt = { ...v2.cases[0].receipt, deposit_address: DEP, payout_address: PAY };
const doc = (body: string) => makeDoc('https://example.swap/order/1', body);
const levels = (body: string) => addressLines(doc(body), r).map((l) => l.level);

describe('order page (§4.3, §11)', () => {
  it('finds the machine-readable receipts', () => {
    const d = doc(`<script type="application/nkip01+json">{"a":1}</script><script type="application/json">{}</script>`);
    expect(receiptTexts(d)).toEqual(['{"a":1}']);
  });
  it('the signed deposit address under a deposit label, the payout under its own: ✓', () => {
    const lines = addressLines(doc(`<div><div><label>Send exactly to</label> <code>${DEP}</code></div><div><label>You receive at</label> <code>${PAY}</code></div></div>`), r);
    expect(lines).toEqual([{ level: 'ok', text: 'The deposit and payout addresses on this page are the ones the exchange signed.' }]);
  });
  it('the issuer’s data-nkip01 markup wins over labels', () => {
    expect(levels(`<div data-nkip01="deposit_address">Payout: ${DEP}</div>`)).toEqual(['ok']);
  });
  it('payout and deposit swapped: ⚠, with the right message for each side', () => {
    const swapped = addressLines(doc(`<p>Deposit address: ${PAY}</p><p>Payout: ${DEP}</p>`), r);
    expect(swapped.map((l) => l.text)).toContain('The page shows the payout address where the deposit address should be. Don’t send.');
    expect(addressLines(doc(`<p>Payout: ${DEP}</p>`), r)[0]!.text).toContain('deposit address where your payout address should be');
  });
  it('a payout address shown without its label isn’t called confirmed', () => {
    expect(addressLines(doc(`<p>Deposit: ${DEP}</p><p>${PAY}</p>`), r)[0]!.text).toBe('Deposit address matches; the payout address is shown, but not labelled as yours.');
  });
  it('an unsigned address of the family anywhere: ⚠, even with the signed one present', () => {
    const lines = addressLines(doc(`<p>Deposit: ${DEP}</p><p>Deposit here instead: ${OTHER_BTC}</p>`), r);
    expect(lines[0]).toMatchObject({ level: 'warn', text: expect.stringContaining('didn\'t sign') });
  });
  it('hidden copies don’t count; QR-only gives the compare-in-wallet caution', () => {
    expect(addressLines(doc(`<input type="hidden" value="${DEP}"><div hidden>Deposit ${OTHER_BTC}</div><img alt="QR">`), r)).toEqual([
      { level: 'caution', text: expect.stringContaining('QR only') },
    ]);
  });
  it('no recognisable label: roles not confirmed', () => {
    expect(levels(`<p>${DEP}</p>`)).toEqual(['caution']);
  });
  it('an asset XMRadar can’t check is said so', () => {
    expect(addressLines(doc(`<p>Deposit ${DEP}</p>`), { ...r, deposit_asset: 'USDT', payout_asset: 'USDC' })).toEqual([{ level: 'off', text: 'Addresses not checked for USDT.' }]);
  });
  it('copying an unsigned address warns; a signed one doesn’t', () => {
    expect(copyWarning(` ${OTHER_BTC}\n`, r)).toContain('didn\'t sign');
    expect(copyWarning(DEP.toUpperCase(), r)).toBeNull();
    expect(copyWarning(PAY, r)).toBeNull();
    expect(copyWarning('hello', r)).toBeNull();
  });
  it('reads the event id the page shows next to a label: hex or a kind 3711 nevent', () => {
    const id = 'ab'.repeat(32);
    expect(pageEventId(doc(`<p>Attestation event: <code>${id}</code></p>`))).toBe(id);
    expect(pageEventId(doc(`<p>Witness record ${neventEncode({ id, kind: 3711 })}</p>`))).toBe(id);
    expect(pageEventId(doc(`<p>Witness record ${neventEncode({ id, kind: 1 })}</p>`))).toBeUndefined();
    expect(pageEventId(doc(`<p>Order hash <code>${id}</code></p>`))).toBeUndefined();
  });
});
