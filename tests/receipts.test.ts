import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ed25519 } from '@noble/curves/ed25519.js';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';
import { canonicalize, canonicalWithout, parseStrict, type Json } from '../src/receipts/jcs';
import {
  checkAttestationEvent,
  commitment,
  keyFor,
  keyIdOf,
  linkableV1,
  parseManifest,
  policyMatches,
  readReceipt,
  receiptSigValid,
  unsaltedPublicDeposit,
  type Manifest,
  type Receipt,
} from '../src/receipts/verify';

const load = (name: string) => JSON.parse(readFileSync(join(process.cwd(), 'tests/fixtures/nkip01', name), 'utf8'));
const v1 = load('v1.json');
const v2 = load('v2.json');
const b64u = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64u = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const receiptOf = (o: unknown) => {
  const r = readReceipt(JSON.stringify(o));
  if ('error' in r) throw new Error(r.error);
  return r.receipt;
};
const nostrSk = generateSecretKey();
const manifestFor = (publicKeyB64u: string, keyId: string, extra: Partial<Manifest> = {}): Manifest => ({
  ...v1.manifest,
  keys: [{ ...v1.manifest.keys[0], key_id: keyId, public_key: publicKeyB64u }],
  nostr_pubkey: getPublicKey(nostrSk),
  ...extra,
});
const eventFor = (att: unknown, r: Receipt, over: { created_at?: number; tags?: string[][]; sk?: Uint8Array } = {}) =>
  finalizeEvent({ kind: 3711, created_at: over.created_at ?? (att as { created_at: number }).created_at, content: JSON.stringify(att), tags: over.tags ?? [['c', commitment(r)], ['i', r.issuer], ['v', r.v]] }, over.sk ?? nostrSk);

describe('strict JSON and JCS (RFC 8785)', () => {
  it('canonicalizes the vectors byte for byte', () => {
    const r = parseStrict(JSON.stringify(v1.vectors[0].receipt)) as { [k: string]: Json };
    expect(canonicalWithout(r, 'sig')).toBe(v1.vectors[0].jcs_without_sig);
  });
  it('sorts keys by UTF-16 code units, recursively, with nulls and booleans', () => {
    expect(canonicalize(parseStrict('{"b":[true,null,{"z":1,"a":"x"}],"a":false,"é":0,"Z":1}'))).toBe('{"Z":1,"a":false,"b":[true,null,{"a":"x","z":1}],"é":0}');
  });
  it('refuses duplicate keys, floats, unsafe integers and trailing content', () => {
    expect(parseStrict('{"a":1e3,"b":1.0}')).toEqual({ a: 1000, b: 1 });
    for (const bad of ['{"a":1,"a":2}', '{"a":1.5}', '{"a":1e-3}', '{"a":9007199254740993}', '{"a":1} x', '{"a":"\u0001"}', '[1,]', '{a:1}'])
      expect(() => parseStrict(bad), bad).toThrow();
  });
});

describe('receipts (v1 and v2 vectors)', () => {
  const v1Key = fromB64u(v1.public_key_b64u);
  const v2Key = fromB64u(v2.public_key_b64u);
  it('verifies the valid v1 receipt and refuses the tampered one', () => {
    const [valid, tampered] = v1.vectors;
    expect(receiptSigValid(receiptOf(valid.receipt), v1Key)).toBe(true);
    expect(receiptSigValid(receiptOf(tampered.receipt), v1Key)).toBe(false);
    expect(keyIdOf(v1Key)).toBe(v1.key_id);
    expect(commitment(receiptOf(valid.receipt))).toBe(valid.commitment);
  });
  it('verifies every v2 case and its salted commitment', () => {
    for (const c of v2.cases) {
      const r = receiptOf(c.receipt);
      expect(receiptSigValid(r, v2Key), c.name).toBe(true);
      expect(commitment(r), c.name).toBe(c.commitment);
    }
  });
  it('refuses receipts outside the schema', () => {
    const base = v2.cases[0].receipt;
    const { salt: _s, ...noSalt } = base;
    for (const bad of [{ ...base, v: 'nkip01/3' }, noSalt, { ...v1.vectors[0].receipt, salt: '0'.repeat(64) }, { ...base, extra: 1 }, { ...base, deposit_amount: '1.5' }, { ...base, issuer: 'Example.Swap' }, { ...base, expires_at: base.created_at }])
      expect('error' in readReceipt(JSON.stringify(bad))).toBe(true);
    expect('error' in readReceipt('{"v":"nkip01/2","v":"nkip01/1"}')).toBe(true);
  });
  it('R16: zero salt only for an XMR deposit; v1 with a public-chain deposit is linkable', () => {
    const xmrDeposit = receiptOf(v2.cases[2].receipt);
    expect(unsaltedPublicDeposit(xmrDeposit)).toBe(false);
    expect(unsaltedPublicDeposit({ ...receiptOf(v2.cases[0].receipt), salt: '0'.repeat(64) })).toBe(true);
    expect(linkableV1(receiptOf(v1.vectors[0].receipt))).toBe(false);
    expect(linkableV1({ ...receiptOf(v1.vectors[0].receipt), deposit_asset: 'BTC' })).toBe(true);
  });
});

describe('manifest keys (§3.3)', () => {
  const sk1 = ed25519.utils.randomSecretKey();
  const sk2 = ed25519.utils.randomSecretKey();
  const pk1 = ed25519.getPublicKey(sk1);
  const pk2 = ed25519.getPublicKey(sk2);
  const first = { key_id: keyIdOf(pk1), alg: 'ed25519' as const, public_key: b64u(pk1), not_before: 100, revoked_at: null, rotated_from: null, rotation_sig: null };
  const second = { key_id: keyIdOf(pk2), alg: 'ed25519' as const, public_key: b64u(pk2), not_before: 200, revoked_at: null, rotated_from: first.key_id, rotation_sig: null as string | null };
  const signRotation = (entry: typeof second, sk: Uint8Array) => b64u(ed25519.sign(new TextEncoder().encode(canonicalWithout(entry as unknown as { [k: string]: Json }, 'rotation_sig')), sk));
  const manifest = (keys: unknown[]) => {
    const m = parseManifest(parseStrict(JSON.stringify({ ...v1.manifest, keys })));
    if ('error' in m) throw new Error(m.error);
    return m.manifest;
  };
  it('the first key is trusted; a rotation signed by the old key is too', () => {
    const rotated = { ...second, rotation_sig: signRotation(second, sk1) };
    const m = manifest([first, rotated]);
    expect(keyFor(m, first.key_id, 150).status).toBe('ok');
    expect(keyFor(m, second.key_id, 250).status).toBe('ok');
    expect(keyFor(m, second.key_id, 150).status).toBe('not-yet');
  });
  it('a rotation signed by the wrong key, or none, is unrotated', () => {
    expect(keyFor(manifest([first, { ...second, rotation_sig: signRotation(second, sk2) }]), second.key_id, 250).status).toBe('unrotated');
    expect(keyFor(manifest([first, second]), second.key_id, 250).status).toBe('unrotated');
    expect(keyFor(manifest([first]), 'ffffffffffffffff', 250).status).toBe('unknown');
  });
  it('revoked at or before the signing time: invalid; revoked later: only △', () => {
    const m = manifest([{ ...first, revoked_at: 300 }]);
    expect(keyFor(m, first.key_id, 300).status).toBe('revoked');
    expect(keyFor(m, first.key_id, 250).status).toBe('revoked-later');
  });
  it('refuses a manifest outside the schema', () => {
    for (const bad of [{ ...v1.manifest, disputes: { email: 1 } }, { ...v1.manifest, relays: ['wss://a', 'wss://b'] }, { ...v1.manifest, keys: [{ ...first, extra: 1 }] }, { ...v1.manifest, nostr_pubkey: 'x' }, { ...v1.manifest, v: 'nkip01/2' }])
      expect('error' in parseManifest(parseStrict(JSON.stringify(bad)))).toBe(true);
  });
});

describe('attestation events (§3.5)', () => {
  const v1Receipt = receiptOf(v1.vectors[0].receipt);
  const v1Manifest = manifestFor(v1.public_key_b64u, v1.key_id);
  const v2Receipt = receiptOf(v2.cases[0].receipt);
  const v2Manifest = manifestFor(v2.public_key_b64u, v2.cases[0].receipt.key_id);

  it('accepts the vector attestations, with the salt box', () => {
    expect(checkAttestationEvent(eventFor(v1.attestation, v1Receipt), v1Receipt, v1Manifest)).toMatchObject({ ok: true, saltBoxMissing: false });
    expect(checkAttestationEvent(eventFor(v2.cases[0].attestation, v2Receipt), v2Receipt, v2Manifest)).toMatchObject({ ok: true, saltBoxMissing: false });
  });
  it('the salt box is signed: editing it fails; R17 flags one that is missing', () => {
    const att = v2.cases[0].attestation;
    expect(checkAttestationEvent(eventFor({ ...att, salt_box: { ...att.salt_box, ct: 'f'.repeat(64) } }, v2Receipt), v2Receipt, v2Manifest)).toMatchObject({ ok: false, reason: 'bad attestation signature' });
    expect(checkAttestationEvent(eventFor({ ...att, salt_box: { r: 'x' } }, v2Receipt), v2Receipt, v2Manifest)).toMatchObject({ ok: false, reason: 'bad attestation' });
    // re-signed by the issuer without a box: valid, but R17 is broken
    const sk = ed25519.utils.randomSecretKey();
    const pk = ed25519.getPublicKey(sk);
    const { salt_box: _b, sig: _s, ...rest } = att;
    const unboxed = { ...rest, key_id: keyIdOf(pk) };
    const signed = { ...unboxed, sig: b64u(ed25519.sign(new TextEncoder().encode(canonicalize(unboxed)), sk)) };
    const m = manifestFor(b64u(pk), keyIdOf(pk));
    expect(checkAttestationEvent(eventFor(signed, v2Receipt), v2Receipt, m)).toMatchObject({ ok: true, saltBoxMissing: true });
  });
  it('refuses wrong kind, key, tags, version, receipt, time or signature', () => {
    const att = v1.attestation;
    const ev = eventFor(att, v1Receipt);
    const cases: [string, ReturnType<typeof eventFor>, Receipt, Manifest][] = [
      ['other Nostr key', eventFor(att, v1Receipt, { sk: generateSecretKey() }), v1Receipt, v1Manifest],
      ['duplicate c', eventFor(att, v1Receipt, { tags: [['c', commitment(v1Receipt)], ['c', commitment(v1Receipt)], ['i', 'example.swap'], ['v', 'nkip01/1']] }), v1Receipt, v1Manifest],
      ['wrong v tag', eventFor(att, v1Receipt, { tags: [['c', commitment(v1Receipt)], ['i', 'example.swap'], ['v', 'nkip01/2']] }), v1Receipt, v1Manifest],
      ['another receipt', ev, { ...v1Receipt, payout_address: 'bc1qother' }, v1Manifest],
      ['time skew', eventFor(att, v1Receipt, { created_at: att.created_at + 301 }), v1Receipt, v1Manifest],
      ['unknown key', ev, v1Receipt, manifestFor(v1.public_key_b64u, 'ffffffffffffffff')],
      ['bad signature', eventFor({ ...att, created_at: att.created_at + 1 }, v1Receipt), v1Receipt, v1Manifest],
      ['unknown field', eventFor({ ...att, extra: 1 }, v1Receipt), v1Receipt, v1Manifest],
      ['v1 with a salt box', eventFor({ ...att, salt_box: v2.cases[0].attestation.salt_box }, v1Receipt), v1Receipt, v1Manifest],
    ];
    for (const [what, e, r, m] of cases) expect(checkAttestationEvent(e, r, m).ok, what).toBe(false);
    expect(checkAttestationEvent({ ...ev, kind: 1 }, v1Receipt, v1Manifest).ok).toBe(false);
    expect(checkAttestationEvent(ev, v1Receipt, { ...v1Manifest, issuer: 'other.swap' })).toMatchObject({ ok: false, reason: 'manifest is for another issuer' });
  });
  it('salt_nip44 is opaque but signed: kept when valid, refused when edited or malformed', () => {
    const sk = ed25519.utils.randomSecretKey();
    const pk = ed25519.getPublicKey(sk);
    const nip44 = 'A' + 'b'.repeat(131);
    const { sig: _s, ...rest } = v2.cases[0].attestation;
    const body = { ...rest, key_id: keyIdOf(pk), salt_nip44: nip44 };
    const signed = { ...body, sig: b64u(ed25519.sign(new TextEncoder().encode(canonicalize(body)), sk)) };
    const m = manifestFor(b64u(pk), keyIdOf(pk));
    expect(checkAttestationEvent(eventFor(signed, v2Receipt), v2Receipt, m)).toMatchObject({ ok: true });
    expect(checkAttestationEvent(eventFor({ ...signed, salt_nip44: 'B' + nip44.slice(1) }, v2Receipt), v2Receipt, m)).toMatchObject({ ok: false, reason: 'bad attestation signature' });
    expect(checkAttestationEvent(eventFor({ ...signed, salt_nip44: 'short' }, v2Receipt), v2Receipt, m)).toMatchObject({ ok: false, reason: 'bad attestation' });
    expect(checkAttestationEvent(eventFor({ ...signed, salt_box: { r: '0'.repeat(64), ct: 'a'.repeat(64) } }, v2Receipt), v2Receipt, m)).toMatchObject({ ok: false, reason: 'bad attestation' });
  });
});

describe('policy', () => {
  it('hashes the raw bytes', () => {
    expect(policyMatches(new TextEncoder().encode(v1.policy_text), v1.manifest.policies[0].policy_hash)).toBe(true);
    expect(policyMatches(new TextEncoder().encode('﻿' + v1.policy_text), v1.manifest.policies[0].policy_hash)).toBe(false);
  });
});

import { familyOf, findAddresses, sameAddress, validFor } from '../src/receipts/addresses';
import { issuerMatchesPage, orderPathMatches, safeRelay } from '../src/receipts/guards';

describe('address families (§4.3)', () => {
  const XMR = '44AFFq5kSiGBoZ4NMDwYtN18obc8AemS33DBLWs3H7otXft3XjrpDtQGv7SqSsaBYBb98uNbr2VBBEt7f2wfn3RVGQBEP3A';
  it('validates BTC base58 and bech32/bech32m, mainnet only', () => {
    for (const ok of ['1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa', '3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy', 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', 'BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4', 'bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0'])
      expect(validFor('BTC', ok), ok).toBe(true);
    for (const bad of ['1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNb', 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t5', 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx', 'bc1Qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', 'mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn'])
      expect(validFor('BTC', bad), bad).toBe(false);
    expect(validFor('XMR', XMR)).toBe(true);
    expect(familyOf(' btc ')).toBe('BTC');
    expect(familyOf('USDT')).toBeNull();
  });
  it('finds valid addresses of the receipt families in page text', () => {
    const text = `Send to ${XMR}. Payout: bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4, again bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4, fake 1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNb`;
    expect(findAddresses(text, new Set(['XMR', 'BTC'] as const))).toEqual([
      { address: XMR, family: 'XMR' },
      { address: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', family: 'BTC' },
    ]);
    expect(findAddresses(text, new Set(['BTC'] as const))).toHaveLength(1);
    expect(sameAddress('BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4', 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4')).toBe(true);
  });
});

describe('guards (§2, §11)', () => {
  it('relays: public wss hosts on 443 only', () => {
    for (const ok of ['wss://relay.damus.io', 'wss://relay.example:443/', 'wss://8.8.8.8', 'wss://relay.damus.io.']) expect(safeRelay(ok), ok).toBe(true);
    for (const bad of ['ws://relay.example', 'wss://127.0.0.1', 'wss://[::1]', 'wss://user:pass@relay.example', 'wss://router.local', 'wss://relay.example:8443', 'wss://localhost', 'wss://intranet', 'wss://10.0.0.2', 'wss://192.168.1.1', 'wss://100.64.0.1', 'wss://169.254.1.1', 'wss://[fd00::1]', 'https://relay.example', 'wss://localhost.', 'wss://router.local.', 'wss://intranet.'])
      expect(safeRelay(bad), bad).toBe(false);
  });
  it('binds the issuer to the exact https host or www.', () => {
    expect(issuerMatchesPage('kyc.rip', 'https://kyc.rip/order/1')).toBe(true);
    expect(issuerMatchesPage('kyc.rip', 'https://www.kyc.rip/order/1')).toBe(true);
    for (const bad of ['https://evil.kyc.rip/', 'https://kyc.rip.evil.com/', 'http://kyc.rip/', 'https://orders.kyc.rip/']) expect(issuerMatchesPage('kyc.rip', bad), bad).toBe(false);
    expect(issuerMatchesPage('orders.kyc.rip', 'https://kyc.rip/')).toBe(false);
  });
  it('order paths: literals, :id and a final *', () => {
    expect(orderPathMatches('/swap/order/:id', '/swap/order/EX-1/')).toBe(true);
    expect(orderPathMatches('/swap/order/:id', '/swap/order')).toBe(false);
    expect(orderPathMatches('/swap/order/:id', '/swap/order/EX-1/details')).toBe(false);
    expect(orderPathMatches('/swap/*', '/swap/order/EX-1')).toBe(true);
    expect(orderPathMatches('/swap/*', '/swap')).toBe(false);
    expect(orderPathMatches('/swap/order/:id', '/swap/order/a.b')).toBe(false);
    expect(orderPathMatches('/', '/anything')).toBe(false);
  });
});

import { fetchManifest, fetchPolicy, MAX_BYTES } from '../src/receipts/fetch';

describe('manifest and policy fetches (§4.2)', () => {
  const manifestText = JSON.stringify(v1.manifest);
  const respond = (body: BodyInit, type: string, status = 200) => new Response(body, { status, headers: { 'content-type': type } });
  it('asks the issuer’s well-known URL without cookies, referrer, redirects or cache', async () => {
    let seen: [string, RequestInit] | null = null;
    const f = (async (url: string, init: RequestInit) => ((seen = [url, init]), respond(manifestText, 'application/json; charset=utf-8'))) as unknown as typeof fetch;
    expect((await fetchManifest('example.swap', f)).issuer).toBe('example.swap');
    expect(seen![0]).toBe('https://example.swap/.well-known/nkip01.json');
    expect(seen![1]).toMatchObject({ credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error', cache: 'no-store' });
    expect(seen![1].signal).toBeInstanceOf(AbortSignal);
  });
  it('refuses another issuer’s manifest, wrong types, errors, oversized and malformed bodies', async () => {
    const f = (body: BodyInit, type = 'application/json', status = 200) => (async () => respond(body, type, status)) as unknown as typeof fetch;
    await expect(fetchManifest('other.swap', f(manifestText))).rejects.toThrow('another issuer');
    await expect(fetchManifest('example.swap', f(manifestText, 'text/html'))).rejects.toThrow('not JSON');
    await expect(fetchManifest('example.swap', f('', 'application/json', 404))).rejects.toThrow('404');
    await expect(fetchManifest('example.swap', f(' '.repeat(MAX_BYTES + 1) + manifestText))).rejects.toThrow('too large');
    await expect(fetchManifest('example.swap', f('{"v":"nkip01/1","v":"x"}'))).rejects.toThrow('duplicate');
    const redirecting = (async () => {
      throw new TypeError('redirect mode is error');
    }) as unknown as typeof fetch;
    await expect(fetchManifest('example.swap', redirecting)).rejects.toThrow('redirect');
  });
  it('policy: only from the issuer’s host, as text, hashed over the raw bytes', async () => {
    const m = v1.manifest as Manifest;
    const hash = m.policies[0]!.policy_hash;
    const text = (body: BodyInit, type = 'text/plain') => (async () => respond(body, type)) as unknown as typeof fetch;
    const ok = await fetchPolicy(m, hash, text(v1.policy_text));
    expect(ok).toMatchObject({ url: 'https://example.swap/policy/v1.txt', matches: true });
    expect(new TextDecoder().decode(ok.bytes)).toBe(v1.policy_text);
    expect((await fetchPolicy(m, hash, text('﻿' + v1.policy_text))).matches).toBe(false);
    await expect(fetchPolicy(m, hash, text(v1.policy_text, 'application/octet-stream'))).rejects.toThrow('not text');
    await expect(fetchPolicy(m, 'f'.repeat(64), text(''))).rejects.toThrow('no policy');
    for (const url of ['https://cdn.other.net/p.txt', 'https://example.swap:8443/p.txt', 'https://u:p@example.swap/p.txt']) {
      const elsewhere = { ...m, policies: [{ policy_hash: hash, url }] };
      await expect(fetchPolicy(elsewhere, hash, text(v1.policy_text)), url).rejects.toThrow('issuer’s host');
    }
    // a response without a stream is capped too
    const bodiless = (async () => ({ ok: true, status: 200, headers: new Headers({ 'content-type': 'text/plain' }), body: null, arrayBuffer: async () => new ArrayBuffer(MAX_BYTES + 1) })) as unknown as typeof fetch;
    await expect(fetchPolicy(m, hash, bodiless)).rejects.toThrow('too large');
  });
});

import { memoryReceiptStore, MAX_RECEIPTS, saveReceipt, toPrune, type SavedReceipt } from '../src/receipts/store';

describe('receipt store (§11, §12)', () => {
  const base = receiptOf(v2.cases[0].receipt);
  const saved = (n: number, over: Partial<SavedReceipt> = {}): SavedReceipt => ({
    commitment: n.toString(16).padStart(64, '0'),
    receipt: { ...base, expires_at: 2_000_000_000 },
    page: 'https://example.swap/order/1',
    savedAt: n,
    ...over,
  });
  it('a re-render updates in place and keeps the first-seen time, event id and public record', async () => {
    const s = memoryReceiptStore();
    await saveReceipt(s, saved(1, { eventId: 'e'.repeat(64) }), 0);
    await saveReceipt(s, saved(1, { savedAt: 99, page: 'https://example.swap/order/1#x' }), 0);
    expect(s.receipts.size).toBe(1);
    expect(s.receipts.get(saved(1).commitment)).toMatchObject({ savedAt: 1, eventId: 'e'.repeat(64), page: 'https://example.swap/order/1#x' });
  });
  it('keeps at most 500, dropping expired ones first, then the oldest', () => {
    const now = 1_900_000_000;
    const list = Array.from({ length: MAX_RECEIPTS }, (_, n) => saved(n + 1));
    list[400] = saved(401, { receipt: { ...base, expires_at: now - 1 } });
    expect(toPrune(list, 'new', now)).toEqual([saved(401).commitment]);
    expect(toPrune(list.filter((_, n) => n !== 400), 'new', now)).toEqual([]);
    expect(toPrune(list.map((r) => ({ ...r, receipt: { ...base, expires_at: 2_000_000_000 } })), 'new', now)).toEqual([saved(1).commitment]);
    // re-saving one that's already there drops nothing
    expect(toPrune(list, saved(5).commitment, now)).toEqual([]);
  });
});

import { checkPageReceipt } from '../src/receipts/check';

describe('order-page check (§1.1, §2, §12)', () => {
  // the v2 vector receipt, checked on its issuer's page against a manifest with its key
  const r2 = v2.cases[0].receipt;
  const manifest = { ...v1.manifest, keys: [{ ...v1.manifest.keys[0], key_id: r2.key_id, public_key: v2.public_key_b64u }] };
  const site = (over: { manifest?: unknown; policy?: string } = {}) => {
    const calls: string[] = [];
    const f = (async (url: string) => {
      calls.push(url);
      if (url.endsWith('/.well-known/nkip01.json')) return new Response(JSON.stringify(over.manifest ?? manifest), { headers: { 'content-type': 'application/json' } });
      return new Response(over.policy ?? v1.policy_text, { headers: { 'content-type': 'text/plain' } });
    }) as unknown as typeof fetch;
    return { f, calls };
  };
  const deps = (f: typeof fetch, access = true) => ({ store: memoryReceiptStore(), hasAccess: async () => access, fetch: f, now: () => (r2.created_at + 60) * 1000 });
  const page = 'https://example.swap/order/EX-V2-7';

  it('a good receipt: signed, valid, policy archived, saved; only the issuer is contacted', async () => {
    const { f, calls } = site();
    const d = deps(f);
    const res = await checkPageReceipt(JSON.stringify(r2), page, d);
    expect(res.lines.map((l) => l.level)).toEqual(['ok', 'ok']);
    expect(res.lines[0]!.text).toBe('Signed by example.swap');
    expect(res.saved).toBe(true);
    expect(calls.every((u) => u.startsWith('https://example.swap/'))).toBe(true);
    expect(d.store.policies.has(r2.policy_hash)).toBe(true);
    expect(d.store.receipts.get(v2.cases[0].commitment)).toMatchObject({ page: 'https://example.swap/order/EX-V2-7', receipt: { order_id: 'EX-V2-7' } });
    // the event id the page showed is kept for the later check; anything else isn't
    await checkPageReceipt(JSON.stringify(r2), page, d, { eventId: 'a'.repeat(64) });
    expect(d.store.receipts.get(v2.cases[0].commitment)!.eventId).toBe('a'.repeat(64));
    await checkPageReceipt(JSON.stringify(r2), page, deps(site().f), { eventId: 'nope' });
  });
  it('another host, http, or no access: nothing fetched, still saved', async () => {
    for (const [url, access, want] of [
      ['https://evil.example.swap/order', true, 'Receipt is for example.swap, but this page is evil.example.swap'],
      ['http://example.swap/order', true, 'Page not secure'],
      [page, false, 'needs access'],
    ] as const) {
      const { f, calls } = site();
      const res = await checkPageReceipt(JSON.stringify(r2), url, deps(f, access));
      expect(res.lines[0]!.text, url).toContain(want);
      expect(calls, url).toEqual([]);
      expect(res.saved).toBe(true);
    }
  });
  it('a changed receipt, an unknown key, an expired order, a wrong policy', async () => {
    const changed = await checkPageReceipt(JSON.stringify({ ...r2, payout_amount: '1' }), page, deps(site().f));
    expect(changed.lines[0]).toMatchObject({ level: 'warn', text: expect.stringContaining('changed after signing') });
    const unknown = await checkPageReceipt(JSON.stringify(r2), page, deps(site({ manifest: { ...manifest, keys: [{ ...manifest.keys[0], key_id: 'ffffffffffffffff' }] } }).f));
    expect(unknown.lines[0]).toMatchObject({ level: 'warn', text: expect.stringContaining('doesn\'t list') });
    const late = await checkPageReceipt(JSON.stringify(r2), page, { ...deps(site().f), now: () => r2.expires_at * 1000 });
    expect(late.lines.at(-1)).toMatchObject({ level: 'warn', text: expect.stringContaining('Expired') });
    const policy = await checkPageReceipt(JSON.stringify(r2), page, deps(site({ policy: 'edited' }).f));
    expect(policy.lines.at(-1)).toMatchObject({ level: 'caution', text: expect.stringContaining('doesn’t match') });
  });
  it('R18: a reused XMR payout address is noted, but never against the same receipt', async () => {
    const d = deps(site().f);
    await checkPageReceipt(JSON.stringify(r2), page, d);
    const again = await checkPageReceipt(JSON.stringify(r2), page, d);
    expect(again.lines.some((l) => l.text.includes('used this payout address'))).toBe(false);
    const other = { ...saved(7), receipt: { ...receiptOf(r2), order_id: 'EX-OLD' } };
    d.store.receipts.set(other.commitment, other);
    const third = await checkPageReceipt(JSON.stringify(r2), page, d);
    expect(third.lines.some((l) => l.text.includes('order EX-OLD'))).toBe(true);
  });
  it('a failing access check or store read becomes a caution, not a failed check', async () => {
    const d = { ...deps(site().f), hasAccess: async () => Promise.reject(new Error('no')) };
    const res = await checkPageReceipt(JSON.stringify(r2), page, d);
    expect(res.saved).toBe(true);
    expect(res.lines[0]).toMatchObject({ level: 'caution', text: expect.stringContaining('needs access') });
  });
  it('unreadable or oversized receipts are reported, not saved', async () => {
    expect(await checkPageReceipt('{"v":"nkip01/2"', page, deps(site().f))).toMatchObject({ saved: false });
    expect(await checkPageReceipt(' '.repeat(64 * 1024 + 1), page, deps(site().f))).toMatchObject({ saved: false, lines: [{ text: expect.stringContaining('too large') }] });
  });
});

function saved(n: number): SavedReceipt {
  return { commitment: n.toString(16).padStart(64, '0'), receipt: receiptOf(v2.cases[0].receipt), page: 'https://example.swap/order/1', savedAt: n };
}

import { checkPublicRecord, lookupRelays, lookupWaitMs, LOOKUP_MIN_AGE_MS } from '../src/receipts/witness';

describe('public-record check (§12, §12.1)', () => {
  const r = receiptOf(v1.vectors[0].receipt);
  const m = manifestFor(v1.public_key_b64u, v1.key_id, { relays: ['wss://relay.one', 'wss://127.0.0.1', 'wss://relay.two'] });
  const ev = eventFor(v1.attestation, r);
  const rec = (over: Partial<SavedReceipt> = {}): SavedReceipt => ({ commitment: commitment(r), receipt: r, page: 'https://example.swap/o', savedAt: 0, manifest: m, ...over });
  it('waits an hour after the order', async () => {
    expect(lookupWaitMs(rec(), LOOKUP_MIN_AGE_MS - 1)).toBe(1);
    await expect(checkPublicRecord(rec(), [], async () => [], LOOKUP_MIN_AGE_MS - 1)).rejects.toThrow('Too early');
  });
  it('asks guarded relays by commitment, at most 6, and counts only valid attestations', async () => {
    expect(lookupRelays(rec(), ['wss://mine', 'wss://relay.one', 'wss://a.x', 'wss://b.x', 'wss://c.x', 'wss://d.x'])).toEqual(['wss://relay.one', 'wss://relay.two', 'wss://a.x', 'wss://b.x', 'wss://c.x', 'wss://d.x']);
    const filters: unknown[] = [];
    const forged = { ...ev, content: ev.content.replace('"created_at":1793000000', '"created_at":1793000001') };
    const query = async (relay: string, f: unknown) => (filters.push(f), relay === 'wss://relay.one' ? [ev] : [forged]);
    const out = await checkPublicRecord(rec(), [], query, LOOKUP_MIN_AGE_MS);
    expect(out).toMatchObject({ seen: ['wss://relay.one'], asked: ['wss://relay.one', 'wss://relay.two'] });
    expect(filters[0]).toEqual({ kinds: [3711], '#c': [commitment(r)], limit: 20 });
  });
  it('tries the event id the page showed first, then the commitment', async () => {
    const filters: Record<string, unknown>[] = [];
    const query = async (_r: string, f: Record<string, unknown>) => (filters.push(f), f.ids ? [] : [ev]);
    const out = await checkPublicRecord(rec({ eventId: 'e'.repeat(64) }), [], query, LOOKUP_MIN_AGE_MS);
    expect(filters[0]).toEqual({ kinds: [3711], ids: ['e'.repeat(64)] });
    expect(out.seen).toHaveLength(2);
  });
  it('a wrong id that names some other event still falls back to the commitment', async () => {
    const other = finalizeEvent({ kind: 3711, created_at: 1, content: '{}', tags: [] }, nostrSk);
    const out = await checkPublicRecord(rec({ eventId: other.id }), [], async (_r, f: Record<string, unknown>) => (f.ids ? [other] : [ev]), LOOKUP_MIN_AGE_MS);
    expect(out.seen).toHaveLength(2);
  });
});
