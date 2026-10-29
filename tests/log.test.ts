import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { base64 } from '@scure/base';
import * as openpgp from 'openpgp';
import { describe, expect, it } from 'vitest';
import { verifyMistProof } from '../src/log/mistproof';
import { normalizeFingerprint } from '../src/log/fingerprint';
import { letterBlocks, MAX_BLOCKS, verifyLetter } from '../src/log/pgp';

const fx = JSON.parse(readFileSync(join(process.cwd(), 'tests/fixtures/log/letters.json'), 'utf8')) as {
  keys: Record<string, { fingerprint: string; key: string }>;
  letters: Record<string, string>;
};
const MISTEX_KEY = 'j/1x9v9Sv7n0BlSIbrW0IbsoAphfRrkF0pn9ObTRr7k=';
const PAYOUT = '45istt3RSruFAerMyAgX2WFtRSkLXGeyiJ7VyvWVm46hEmuZZa4rY5NHJBPyh5UyUpUDH6kvN8JAFgoUCoWTjKNp6D4RuTK';

const REAL: [site: string, file: string, signer: string][] = [
  ['bitcoinvn', 'bitcoinvn-BV97MXQZ.asc', 'f15b48df3d11ef7a'], // EdDSA signing subkey, SHA-256
  ['0trace', '0trace-89839aca.asc', '40c9637558a14b8b'], // EdDSA signing subkey, SHA-512, salt notation
  ['bitania', 'bitania-jbstqmqrr6.asc', '18096029551be178'], // RSA primary
  ['sageswap', 'sageswap-ded558e8.asc', '058932b7deccea7a'], // RSA-2048 primary
  ['stereoswap', 'stereoswap-STRRSXUE.asc', '096377f2bb285081'], // RSA-4096 primary, Sequoia
];

/** flips one character inside the armored signature body (not the checksum line) */
function tamperSignature(letter: string): string {
  const start = letter.indexOf('-----BEGIN PGP SIGNATURE-----');
  const body = letter.indexOf('\n\n', start) + 2;
  const i = body + 20;
  const c = letter[i] === 'A' ? 'B' : 'A';
  return letter.slice(0, i) + c + letter.slice(i + 1);
}

async function generated(opts: Partial<Parameters<typeof openpgp.generateKey>[0]> = {}) {
  const { privateKey, publicKey } = await openpgp.generateKey({ type: 'ecc', curve: 'ed25519Legacy', userIDs: [{ name: 'Test operator' }], format: 'object', ...opts } as never);
  return { privateKey: privateKey as unknown as openpgp.PrivateKey, publicKey: publicKey as unknown as openpgp.PublicKey };
}

async function clearSign(privateKey: openpgp.PrivateKey, text: string, config?: Partial<openpgp.Config>, date?: Date) {
  const message = await openpgp.createCleartextMessage({ text });
  return (await openpgp.sign({ message, signingKeys: privateKey, config, date })) as string;
}

/**
 * A clear-signed letter built at the packet level, for what the high-level API won't produce: a chosen
 * hash, a date outside the key's validity, critical notations. The packet-level API isn't fully typed.
 */
async function packetSign(signer: openpgp.PrivateKey | openpgp.Subkey, text: string, opts: { hash?: number; date?: Date; criticalNotation?: boolean } = {}) {
  const pgp = openpgp as any;
  const keyPacket = (signer as any).keyPacket;
  const literal = new pgp.LiteralDataPacket();
  literal.setText(text);
  const packet = new pgp.SignaturePacket();
  packet.signatureType = openpgp.enums.signature.text;
  packet.publicKeyAlgorithm = keyPacket.algorithm;
  packet.hashAlgorithm = opts.hash ?? openpgp.enums.hash.sha256;
  packet.issuerKeyID = keyPacket.getKeyID();
  packet.issuerFingerprint = keyPacket.getFingerprintBytes();
  if (opts.criticalNotation) packet.rawNotations = [{ name: 'unknown@example.com', value: new TextEncoder().encode('x'), humanReadable: true, critical: true }];
  await packet.sign(keyPacket, literal, opts.date ?? new Date(), false, { ...openpgp.config, nonDeterministicSignaturesViaNotation: false });
  const list = new pgp.PacketList();
  list.push(packet);
  return new pgp.CleartextMessage(text, new pgp.Signature(list)).armor() as string;
}

describe('verifyLetter: real letters with the keys from the xmr.club feed', () => {
  it.each(REAL)('%s verifies, signed by %s', async (site, file, signer) => {
    const { key, fingerprint } = fx.keys[site]!;
    const r = await verifyLetter(fx.letters[file]!, key, fingerprint);
    expect(r).toMatchObject({ ok: true });
    if (!r.ok) return;
    expect(r.blocks).toHaveLength(1);
    expect(r.blocks[0]!.keyId).toBe(signer);
    expect(r.blocks[0]!.text).toContain(PAYOUT);
    expect(r.blocks[0]!.signedAt).toBeGreaterThan(Date.UTC(2026, 9, 29));
  });

  it('refuses a letter checked with another operator key', async () => {
    const { key, fingerprint } = fx.keys.bitania!;
    expect(await verifyLetter(fx.letters['bitcoinvn-BV97MXQZ.asc']!, key, fingerprint)).toMatchObject({ ok: false, reason: 'signature' });
  });

  it("refuses a key whose fingerprint isn't the feed's", async () => {
    const { key } = fx.keys.bitcoinvn!;
    const r = await verifyLetter(fx.letters['bitcoinvn-BV97MXQZ.asc']!, key, fx.keys['0trace']!.fingerprint);
    expect(r).toMatchObject({ ok: false, reason: 'key' });
  });

  it('accepts the fingerprint spaced or lowercase', async () => {
    const { key, fingerprint } = fx.keys.bitcoinvn!;
    const spaced = fingerprint.toLowerCase().replace(/(.{4})/g, '$1 ');
    expect(await verifyLetter(fx.letters['bitcoinvn-BV97MXQZ.asc']!, key, spaced)).toMatchObject({ ok: true });
  });

  it('refuses a changed address in the signed text', async () => {
    const { key, fingerprint } = fx.keys.stereoswap!;
    const letter = fx.letters['stereoswap-STRRSXUE.asc']!.replace('bc1qmumua59vdrukll6segkjm2zh0zgp5fphrtgtx9', 'bc1qmumua59vdrukll6segkjm2zh0zgp5fphrtgtx8');
    expect(await verifyLetter(letter, key, fingerprint)).toMatchObject({ ok: false, reason: 'signature' });
  });

  it('refuses a changed signature packet (hashed subpackets included)', async () => {
    for (const [site, file] of REAL) {
      const { key, fingerprint } = fx.keys[site]!;
      expect(await verifyLetter(tamperSignature(fx.letters[file]!), key, fingerprint), site).toMatchObject({ ok: false });
    }
  });

  it('refuses a line added to the text, and one removed', async () => {
    const { key, fingerprint } = fx.keys['0trace']!;
    const letter = fx.letters['0trace-89839aca.asc']!;
    expect(await verifyLetter(letter.replace('Type: GUARANTEE\n', 'Type: GUARANTEE\nRefund: none\n'), key, fingerprint)).toMatchObject({ ok: false });
    expect(await verifyLetter(letter.replace('Network Fee: 0.000192 xmr\n', ''), key, fingerprint)).toMatchObject({ ok: false });
  });

  it('a key from the page is never enough: a private key, or a key without the feed fingerprint, is refused', async () => {
    const { privateKey } = await generated();
    const letter = await clearSign(privateKey, 'Order: X1\nDeposit Address: bc1qforged');
    expect(await verifyLetter(letter, privateKey.armor(), privateKey.getFingerprint())).toMatchObject({ ok: false, reason: 'key' });
    expect(await verifyLetter(letter, privateKey.toPublic().armor(), fx.keys.bitcoinvn!.fingerprint)).toMatchObject({ ok: false, reason: 'key' });
  });

  it('accepts a generated letter with its own public key (the harness itself works)', async () => {
    const { privateKey, publicKey } = await generated();
    const letter = await clearSign(privateKey, 'Order: X1\n- dashed line\nTrailing spaces   ');
    const r = await verifyLetter(letter, publicKey.armor(), publicKey.getFingerprint());
    expect(r).toMatchObject({ ok: true });
    if (r.ok) expect(r.blocks[0]!.text).toBe('Order: X1\n- dashed line\nTrailing spaces');
  });

  it('refuses a letter from a hard-revoked key, even one signed before the revocation (a compromised key can backdate)', async () => {
    const created = new Date(Date.now() - 2 * 3600_000);
    const { privateKey } = await generated({ date: created } as never);
    const letter = await clearSign(privateKey, 'Order: X2', undefined, new Date(created.getTime() + 60_000));
    expect(await verifyLetter(letter, privateKey.toPublic().armor(), privateKey.getFingerprint())).toMatchObject({ ok: true });
    const { publicKey: revoked } = await openpgp.revokeKey({ key: privateKey, format: 'object' });
    expect(await verifyLetter(letter, revoked.armor(), revoked.getFingerprint())).toMatchObject({ ok: false, reason: 'signature' });
  });

  it('keeps a letter signed before a soft revocation (key retired or superseded: a rotation)', async () => {
    const created = new Date(Date.now() - 2 * 3600_000);
    const { privateKey } = await generated({ date: created } as never);
    const letter = await clearSign(privateKey, 'Order: X2b', undefined, new Date(created.getTime() + 60_000));
    const { publicKey: retired } = await openpgp.revokeKey({ key: privateKey, reasonForRevocation: { flag: openpgp.enums.reasonForRevocation.keySuperseded }, format: 'object' });
    expect(await verifyLetter(letter, retired.armor(), retired.getFingerprint())).toMatchObject({ ok: true });
    // but nothing it signs after the revocation counts
    const after = await packetSign(privateKey, 'Order: X2c', { date: new Date() });
    expect(await verifyLetter(after, retired.armor(), retired.getFingerprint())).toMatchObject({ ok: false });
  });

  it('refuses a signing subkey revoked after the letter was signed', async () => {
    const created = new Date(Date.now() - 2 * 3600_000);
    const { privateKey } = await generated({ date: created, subkeys: [{ sign: true }] } as never);
    const letter = await clearSign(privateKey, 'Order: X3', undefined, new Date(created.getTime() + 60_000));
    const signer = (await privateKey.getSigningKey(undefined, new Date(created.getTime() + 60_000))).getKeyID();
    const sub = privateKey.subkeys.find((k) => k.getKeyID().equals(signer));
    expect(sub).toBeTruthy();
    expect(await verifyLetter(letter, privateKey.toPublic().armor(), privateKey.getFingerprint())).toMatchObject({ ok: true });
    privateKey.subkeys[privateKey.subkeys.indexOf(sub!)] = await sub!.revoke(privateKey.keyPacket as openpgp.SecretKeyPacket);
    expect(await verifyLetter(letter, privateKey.toPublic().armor(), privateKey.getFingerprint())).toMatchObject({ ok: false, reason: 'signature' });
  });

  it('refuses a subkey whose binding signature was removed', async () => {
    const { privateKey } = await generated({ subkeys: [{ sign: true }] } as never);
    const letter = await clearSign(privateKey, 'Order: X3b');
    const pub = privateKey.toPublic();
    const signer = (await privateKey.getSigningKey()).getKeyID();
    const sub = pub.subkeys.find((k) => k.getKeyID().equals(signer))!;
    expect(sub).toBeTruthy();
    sub.bindingSignatures = [];
    expect(await verifyLetter(letter, pub.armor(), pub.getFingerprint())).toMatchObject({ ok: false });
  });

  it('keeps a letter signed while the key was valid, refuses one signed after it expired, and one dated after "now"', async () => {
    const created = new Date(Date.now() - 3 * 3600_000);
    const { privateKey, publicKey } = await generated({ date: created, keyExpirationTime: 3600 } as never);
    const inTime = await clearSign(privateKey, 'Order: X4', undefined, new Date(created.getTime() + 60_000));
    // signed while valid: still valid later (a letter is a record of what was agreed then)
    expect(await verifyLetter(inTime, publicKey.armor(), publicKey.getFingerprint())).toMatchObject({ ok: true });
    // signed two hours after creation, one hour after the key expired
    const late = await packetSign(privateKey, 'Order: X4', { date: new Date(created.getTime() + 2 * 3600_000) });
    expect(await verifyLetter(late, publicKey.armor(), publicKey.getFingerprint())).toMatchObject({ ok: false });
    // checked at a time before it was signed
    expect(await verifyLetter(inTime, publicKey.armor(), publicKey.getFingerprint(), new Date(created.getTime() - 3600_000))).toMatchObject({ ok: false });
  });

  it('refuses a letter signed by an expired subkey', async () => {
    const created = new Date(Date.now() - 3 * 3600_000);
    const { privateKey } = await generated({ date: created, subkeys: [{ sign: true, keyExpirationTime: 3600 }] } as never);
    const sub = privateKey.subkeys.find((k) => k.getAlgorithmInfo().algorithm === 'eddsaLegacy' && k.bindingSignatures[0]!.keyFlags![0]! & openpgp.enums.keyFlags.signData)!;
    expect(sub).toBeTruthy();
    const late = await packetSign(sub, 'Order: X4b', { date: new Date(created.getTime() + 2 * 3600_000) });
    expect(await verifyLetter(late, privateKey.toPublic().armor(), privateKey.getFingerprint())).toMatchObject({ ok: false });
  });

  it('refuses a signature with an unknown critical notation', async () => {
    const { privateKey, publicKey } = await generated();
    const letter = await packetSign(privateKey, 'Order: X6', { criticalNotation: true });
    expect(await verifyLetter(letter, publicKey.armor(), publicKey.getFingerprint())).toMatchObject({ ok: false, reason: 'signature' });
    // the same construction without the notation verifies, so the refusal is about the notation
    expect(await verifyLetter(await packetSign(privateKey, 'Order: X6'), publicKey.armor(), publicKey.getFingerprint())).toMatchObject({ ok: true });
  });

  it('refuses a SHA-1 letter', async () => {
    // RSA: EdDSA keys refuse hashes shorter than 256 bits
    const { privateKey, publicKey } = await generated({ type: 'rsa', rsaBits: 2048, curve: undefined } as never);
    const letter = await packetSign(privateKey, 'Order: X5', { hash: openpgp.enums.hash.sha1 });
    const read = (await openpgp.readCleartextMessage({ cleartextMessage: letter })) as any;
    expect(read.signature.packets[0].hashAlgorithm).toBe(openpgp.enums.hash.sha1);
    // the same packet does verify when SHA-1 is allowed, so the refusal below is about the hash alone
    const loose = await openpgp.verify({ message: read, verificationKeys: publicKey, config: { rejectMessageHashAlgorithms: new Set() } });
    await expect(loose.signatures[0]!.verified).resolves.toBe(true);
    expect(await verifyLetter(letter, publicKey.armor(), publicKey.getFingerprint())).toMatchObject({ ok: false, reason: 'signature' });
  });

  it('verifies every block of a multi-step letter, and refuses the file if any block fails', async () => {
    const { privateKey, publicKey } = await generated();
    const a = await clearSign(privateKey, 'Statement: Swap created');
    const b = await clearSign(privateKey, 'Statement: Deposit received');
    const both = `${a}\n${b}`;
    const r = await verifyLetter(both, publicKey.armor(), publicKey.getFingerprint());
    expect(r.ok && r.blocks.map((x) => x.text)).toEqual(['Statement: Swap created', 'Statement: Deposit received']);
    expect(await verifyLetter(`${a}\n${tamperSignature(b)}`, publicKey.armor(), publicKey.getFingerprint())).toMatchObject({ ok: false });
  });

  it('bounds the input before parsing', async () => {
    const { key, fingerprint } = fx.keys.bitcoinvn!;
    const one = fx.letters['bitcoinvn-BV97MXQZ.asc']!;
    expect(letterBlocks(Array(MAX_BLOCKS + 1).fill(one).join('\n'))).toEqual([]);
    const huge = one.replace('Letter of guarantee', 'x'.repeat(70_000));
    expect(await verifyLetter(huge, key, fingerprint)).toMatchObject({ ok: false, reason: 'format' });
    expect(await verifyLetter('no letter here', key, fingerprint)).toMatchObject({ ok: false, reason: 'format' });
  });

  it('never throws on garbled input', async () => {
    const { key, fingerprint } = fx.keys.sageswap!;
    const letter = fx.letters['sageswap-ded558e8.asc']!;
    const sigAt = letter.indexOf('-----BEGIN PGP SIGNATURE-----');
    for (const cut of [40, 200, sigAt + 40, sigAt + 120]) {
      const r = await verifyLetter(letter.slice(0, cut) + '\n-----END PGP SIGNATURE-----', key, fingerprint);
      expect(r.ok).toBe(false);
    }
    expect(await verifyLetter(letter, 'not a key', fingerprint)).toMatchObject({ ok: false, reason: 'key' });
  });

  it('normalizeFingerprint', () => {
    expect(normalizeFingerprint('d70f 87d6 61e3 42a9 f4cd  50bb 1809 6029 551b e178')).toBe('D70F87D661E342A9F4CD50BB18096029551BE178');
    expect(normalizeFingerprint('D70F87D6')).toBeNull();
    expect(normalizeFingerprint('Z70F87D661E342A9F4CD50BB18096029551BE178')).toBeNull();
  });
});

describe('verifyMistProof', () => {
  const real = fx.letters['mistex-DX-4W850L.json']!;

  it('verifies the real MistProof and reads the order and addresses', () => {
    const r = verifyMistProof(real, MISTEX_KEY);
    expect(r).toMatchObject({ ok: true, proof: { order: 'DX-4W850L', issuer: 'mistex.io', send: { coin: 'BTC', depositAddress: 'bc1qy3xrhl57lw6fwllypel8adpmjra9yczchxy982' }, receive: { address: PAYOUT } } });
  });

  it('refuses one changed byte in the payload', () => {
    const r = JSON.parse(real);
    r.payload = r.payload.replace('bc1qy3xrhl57lw6fwllypel8adpmjra9yczchxy982', 'bc1qy3xrhl57lw6fwllypel8adpmjra9yczchxy983');
    expect(verifyMistProof(JSON.stringify(r), MISTEX_KEY)).toMatchObject({ ok: false, reason: 'signature' });
  });

  it('refuses another key', () => {
    const other = base64.encode(ed25519.getPublicKey(ed25519.utils.randomSecretKey()));
    // a different key: its key_id doesn't match either
    expect(verifyMistProof(real, other)).toMatchObject({ ok: false, reason: 'key' });
    expect(verifyMistProof(real, 'short')).toMatchObject({ ok: false, reason: 'key' });
  });

  it('refuses a key_id that is not the feed key, even with a valid signature', () => {
    const r = JSON.parse(real);
    expect(r.key_id).toBe('0a3a62142afbcc84');
    expect(verifyMistProof(JSON.stringify({ ...r, key_id: '0000000000000000' }), MISTEX_KEY)).toMatchObject({ ok: false, reason: 'key' });
  });

  it('refuses a bad signature encoding, another alg or format, and a payload without order or addresses', () => {
    const r = JSON.parse(real);
    expect(verifyMistProof(JSON.stringify({ ...r, signature: 'AAAA' }), MISTEX_KEY)).toMatchObject({ ok: false, reason: 'format' });
    expect(verifyMistProof(JSON.stringify({ ...r, alg: 'ed448' }), MISTEX_KEY)).toMatchObject({ ok: false, reason: 'format' });
    expect(verifyMistProof(JSON.stringify({ ...r, format: 'mistex-receipt/2' }), MISTEX_KEY)).toMatchObject({ ok: false, reason: 'format' });
    expect(verifyMistProof('not json', MISTEX_KEY)).toMatchObject({ ok: false, reason: 'format' });

    // validly signed but unusable payloads, with a generated key
    const sk = ed25519.utils.randomSecretKey();
    const pk = base64.encode(ed25519.getPublicKey(sk));
    const keyId = bytesToHex(sha256(ed25519.getPublicKey(sk))).slice(0, 16);
    const signed = (payload: string) => JSON.stringify({ alg: 'Ed25519', format: 'mistex-receipt/1', key_id: keyId, payload, signature: base64.encode(ed25519.sign(new TextEncoder().encode(payload), sk)) });
    expect(verifyMistProof(signed('not json'), pk)).toMatchObject({ ok: false, reason: 'format' });
    expect(verifyMistProof(signed(JSON.stringify({ send: { deposit_address: 'a' }, receive: { address: 'b' } })), pk)).toMatchObject({ ok: false, reason: 'format' });
    expect(verifyMistProof(signed(JSON.stringify({ order: 'DX-1', send: { deposit_address: 'a' }, receive: { address: 'b' } })), pk)).toMatchObject({ ok: true });
  });

  it('bounds the input', () => {
    expect(verifyMistProof(' '.repeat(17 * 1024) + real, MISTEX_KEY)).toMatchObject({ ok: false, reason: 'format' });
  });
});

describe('openpgp.js stays in the background', () => {
  it('only src/log and the background mention the verifier or openpgp (static or dynamic import)', () => {
    const { execSync } = require('node:child_process') as typeof import('node:child_process');
    const hits = execSync(`grep -rlE "openpgp|log/pgp" src || true`, { encoding: 'utf8' }).split('\n').filter(Boolean);
    expect(hits.every((f) => f.startsWith('src/log/') || f === 'src/entrypoints/background.ts')).toBe(true);
  });
});
