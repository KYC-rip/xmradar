import { keccak_256 } from '@noble/hashes/sha3.js';
import { describe, expect, it } from 'vitest';
import { base58Decode, base58Encode, isValidAmount, moneroUri, validateMoneroAddress } from '../src/xmr/address';
import { qrPath } from '../src/xmr/qr';

// real mainnet addresses: xmr.bio's @xbtoshi (subaddress) and the Monero General Fund (standard)
const SUB = '89fM69NVioz94JQrJFLGPDa8PMpjea7TV8JQktbLBLpX9gKMfrt3dge7KMdqg86coZjCxCm3fn1WKdM8WBMJhEdaUimo8Q3';
const STD = '44AFFq5kSiGBoZ4NMDwYtN18obc8AemS33DBLWs3H7otXft3XjrpDtQGv7SqSsaBYBb98uNbr2VBBEt7f2wfn3RVGQBEP3A';

/** Re-encode STD's keys under another prefix (and optional payment ID) with a correct checksum. */
function withPrefix(prefix: number, paymentId?: Uint8Array): string {
  const keys = base58Decode(STD).subarray(1, 65);
  const body = new Uint8Array([prefix, ...keys, ...(paymentId ?? [])]);
  return base58Encode(new Uint8Array([...body, ...keccak_256(body).subarray(0, 4)]));
}

describe('validateMoneroAddress', () => {
  it('accepts mainnet standard, subaddress and integrated addresses', () => {
    expect(validateMoneroAddress(STD)).toEqual({ ok: true, type: 'standard' });
    expect(validateMoneroAddress(SUB)).toEqual({ ok: true, type: 'subaddress' });
    const integrated = withPrefix(19, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
    expect(integrated).toHaveLength(106);
    expect(validateMoneroAddress(integrated)).toEqual({ ok: true, type: 'integrated', paymentId: '0102030405060708' });
  });

  it('round-trips through base58', () => {
    expect(withPrefix(18)).toBe(STD);
  });

  it('rejects testnet and stagenet', () => {
    expect(validateMoneroAddress(withPrefix(53))).toEqual({ ok: false, reason: 'testnet address' });
    expect(validateMoneroAddress(withPrefix(63))).toEqual({ ok: false, reason: 'testnet address' });
    expect(validateMoneroAddress(withPrefix(24))).toEqual({ ok: false, reason: 'stagenet address' });
  });

  it('rejects a corrupted checksum, bad characters and wrong lengths', () => {
    const bytes = base58Decode(STD);
    bytes[10]! ^= 1;
    expect(validateMoneroAddress(base58Encode(bytes))).toEqual({ ok: false, reason: 'bad checksum' });
    expect(validateMoneroAddress(`${STD.slice(0, 94)}0`).ok).toBe(false);
    expect(validateMoneroAddress(STD.slice(0, 94))).toEqual({ ok: false, reason: 'wrong length' });
    expect(validateMoneroAddress('')).toEqual({ ok: false, reason: 'wrong length' });
    // a standard prefix with an integrated length
    expect(validateMoneroAddress(withPrefix(18, new Uint8Array(8)))).toEqual({ ok: false, reason: 'wrong length for type' });
    // 'zzzzzzzzzzz' is above 2^64, so the block overflows 8 bytes
    expect(() => base58Decode('zzzzzzzzzzz')).toThrow(/overflow/);
    expect(validateMoneroAddress(`zzzzzzzzzzz${STD.slice(11)}`)).toEqual({ ok: false, reason: 'not base58 (block overflow)' });
  });
});

describe('moneroUri', () => {
  it('builds a plain link and one with an amount and description', () => {
    expect(moneroUri(STD)).toBe(`monero:${STD}`);
    expect(moneroUri(STD, { amount: '0.05', description: 'tip ❤ & thanks' })).toBe(`monero:${STD}?tx_amount=0.05&tx_description=tip%20%E2%9D%A4%20%26%20thanks`);
  });

  it('rejects invalid amounts and addresses', () => {
    for (const bad of ['-1', '1e3', '0.1234567890123', '1,5', '1234567890', '.5', ' 1']) {
      expect(isValidAmount(bad)).toBe(false);
      expect(() => moneroUri(STD, { amount: bad })).toThrow(/amount/);
    }
    expect(isValidAmount('123456789.123456789012')).toBe(true);
    expect(() => moneroUri(withPrefix(53))).toThrow(/address/);
  });
});

describe('qrPath', () => {
  it('draws a deterministic square code for a monero link', () => {
    const a = qrPath(`monero:${STD}?tx_amount=1`);
    expect(a.size).toBeGreaterThanOrEqual(21);
    expect((a.size - 17) % 4).toBe(0);
    expect(a.d).toMatch(/^(M\d+ \d+h1v1h-1z)+$/);
    expect(qrPath(`monero:${STD}?tx_amount=1`)).toEqual(a);
  });
});
