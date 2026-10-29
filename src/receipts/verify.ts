import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { verifyEvent, type Event } from 'nostr-tools/pure';
import { canonicalWithout, parseStrict, type Json } from './jcs';

/**
 * NKIP-0001 verification for the browser-extension role (PLAN-NKIP01): receipts (v1 and v2),
 * commitments, the issuer manifest's keys, and kind 3711 attestations. Pure functions; nothing here
 * fetches. Every check returns a reason a card can show, never a bare boolean.
 */

export const V1 = 'nkip01/1';
export const V2 = 'nkip01/2';
export type Version = typeof V1 | typeof V2;
export const KIND_ATTESTATION = 3711;
export const ZERO_SALT = '0'.repeat(64);
/** event and attestation timestamps may differ by this much */
const SKEW_SECS = 300;

export interface Receipt {
  v: Version;
  issuer: string;
  order_id: string;
  deposit_asset: string;
  deposit_address: string;
  deposit_amount: string;
  payout_asset: string;
  payout_address: string;
  payout_amount: string;
  rate_type: 'fixed' | 'float';
  created_at: number;
  expires_at: number;
  refund_address?: string;
  policy_hash: string;
  salt?: string;
  key_id: string;
  sig: string;
}

export interface ManifestKey {
  key_id: string;
  alg: 'ed25519';
  public_key: string;
  not_before: number;
  revoked_at: number | null;
  rotated_from: string | null;
  rotation_sig: string | null;
}

export interface Manifest {
  v: typeof V1;
  issuer: string;
  adopted_at: number;
  keys: ManifestKey[];
  nostr_pubkey: string;
  relays: string[];
  policies: { policy_hash: string; url: string }[];
  disputes: Record<string, string>;
}

export interface Attestation {
  v: Version;
  issuer: string;
  commitment: string;
  created_at: number;
  key_id: string;
  salt_box?: { r: string; ct: string };
  salt_nip44?: string;
  sig: string;
}

type Obj = { [k: string]: Json };
const ISSUER_RE = /^[a-z0-9.-]+\.[a-z]{2,}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const KEY_ID_RE = /^[0-9a-f]{16}$/;
const SIG_RE = /^[A-Za-z0-9_-]{86}$/;
const PUBKEY_RE = /^[A-Za-z0-9_-]{43}$/;
const AMOUNT_RE = /^[0-9]+$/;

const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown, max: number, min = 1) => typeof v === 'string' && v.length >= min && v.length <= max;
const int = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const onlyKeys = (o: Obj, allowed: readonly string[]) => Object.keys(o).every((k) => allowed.includes(k));

export function b64urlDecode(s: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error('Not base64url');
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

const RECEIPT_FIELDS = ['v', 'issuer', 'order_id', 'deposit_asset', 'deposit_address', 'deposit_amount', 'payout_asset', 'payout_address', 'payout_amount', 'rate_type', 'created_at', 'expires_at', 'refund_address', 'policy_hash', 'salt', 'key_id', 'sig'] as const;

/** A receipt that matches receipt.schema.json (v1 without `salt`, v2 with it), else the reason it doesn't. */
export function parseReceipt(v: Json): { receipt: Receipt } | { error: string } {
  if (!isObj(v)) return { error: 'not an object' };
  if (!onlyKeys(v, RECEIPT_FIELDS)) return { error: 'unknown field' };
  if (v.v !== V1 && v.v !== V2) return { error: 'unknown version' };
  if (v.v === V2 ? typeof v.salt !== 'string' || !HEX64.test(v.salt) : 'salt' in v) return { error: 'salt does not match the version' };
  if (typeof v.issuer !== 'string' || !ISSUER_RE.test(v.issuer)) return { error: 'bad issuer' };
  if (!str(v.order_id, 128)) return { error: 'bad order_id' };
  for (const side of ['deposit', 'payout'] as const) {
    if (!str(v[`${side}_asset`], 32) || !str(v[`${side}_address`], 256)) return { error: `bad ${side}` };
    const amount = v[`${side}_amount`];
    if (typeof amount !== 'string' || !AMOUNT_RE.test(amount)) return { error: `bad ${side}_amount` };
  }
  if (v.rate_type !== 'fixed' && v.rate_type !== 'float') return { error: 'bad rate_type' };
  if (!int(v.created_at) || !int(v.expires_at) || (v.expires_at as number) <= (v.created_at as number)) return { error: 'bad times' };
  if ('refund_address' in v && !str(v.refund_address, 256, 0)) return { error: 'bad refund_address' };
  if (typeof v.policy_hash !== 'string' || !HEX64.test(v.policy_hash)) return { error: 'bad policy_hash' };
  if (typeof v.key_id !== 'string' || !KEY_ID_RE.test(v.key_id)) return { error: 'bad key_id' };
  if (typeof v.sig !== 'string' || !SIG_RE.test(v.sig)) return { error: 'bad sig' };
  return { receipt: v as unknown as Receipt };
}

/** Parse and check a receipt's text from a page: strict JSON, then the schema. */
export function readReceipt(text: string): { receipt: Receipt } | { error: string } {
  try {
    return parseReceipt(parseStrict(text));
  } catch (e) {
    return { error: (e as Error).message };
  }
}

export const keyIdOf = (publicKey: Uint8Array) => bytesToHex(sha256(publicKey)).slice(0, 16);

function sigValid(sigB64: string, message: string, publicKey: Uint8Array): boolean {
  try {
    return ed25519.verify(b64urlDecode(sigB64), new TextEncoder().encode(message), publicKey);
  } catch {
    return false;
  }
}

/** Ed25519 over the JCS of the receipt without `sig`. */
export const receiptSigValid = (r: Receipt, publicKey: Uint8Array) => sigValid(r.sig, canonicalWithout(r as unknown as Obj, 'sig'), publicKey);

/** v1: SHA-256("nkip01/1"‖0‖issuer‖0‖deposit‖0‖payout); v2 adds ‖0‖salt (32 raw bytes) under "nkip01/2". */
export function commitment(r: Pick<Receipt, 'v' | 'issuer' | 'deposit_address' | 'payout_address' | 'salt'>): string {
  const enc = new TextEncoder();
  const z = new Uint8Array([0]);
  const parts: Uint8Array[] = [enc.encode(r.v), z, enc.encode(r.issuer), z, enc.encode(r.deposit_address), z, enc.encode(r.payout_address)];
  if (r.v === V2) parts.push(z, hexToBytes(r.salt!));
  const buf = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    buf.set(p, offset);
    offset += p.length;
  }
  return bytesToHex(sha256(buf));
}

/** R16: an all-zero salt is allowed only for an XMR deposit, whose address never appears on chain. */
export const unsaltedPublicDeposit = (r: Receipt) => r.v === V2 && r.salt === ZERO_SALT && r.deposit_asset.toUpperCase() !== 'XMR';
/** A v1 receipt for a public-chain deposit: anyone who knows the payout address can link it. */
export const linkableV1 = (r: Receipt) => r.v === V1 && r.deposit_asset.toUpperCase() !== 'XMR';

const KEY_FIELDS = ['key_id', 'alg', 'public_key', 'not_before', 'revoked_at', 'rotated_from', 'rotation_sig'] as const;

/** A manifest that matches manifest.schema.json, else the reason. */
export function parseManifest(v: Json): { manifest: Manifest } | { error: string } {
  if (!isObj(v)) return { error: 'not an object' };
  if (v.v !== V1) return { error: 'unknown manifest version' };
  if (typeof v.issuer !== 'string' || !ISSUER_RE.test(v.issuer)) return { error: 'bad issuer' };
  if (!int(v.adopted_at)) return { error: 'bad adopted_at' };
  if (typeof v.nostr_pubkey !== 'string' || !HEX64.test(v.nostr_pubkey)) return { error: 'bad nostr_pubkey' };
  if (!Array.isArray(v.relays) || v.relays.length < 3 || !v.relays.every((r) => typeof r === 'string' && r.startsWith('wss://'))) return { error: 'bad relays' };
  if (!Array.isArray(v.policies) || !v.policies.length || !v.policies.every((p) => isObj(p) && typeof p.policy_hash === 'string' && HEX64.test(p.policy_hash) && typeof p.url === 'string' && p.url.startsWith('https://')))
    return { error: 'bad policies' };
  if (!isObj(v.disputes) || !Object.keys(v.disputes).length || !Object.values(v.disputes).every((d) => typeof d === 'string')) return { error: 'bad disputes' };
  if (!Array.isArray(v.keys) || !v.keys.length) return { error: 'no keys' };
  for (const k of v.keys) {
    if (!isObj(k) || !onlyKeys(k, KEY_FIELDS) || KEY_FIELDS.some((f) => !(f in k))) return { error: 'bad key entry' };
    if (typeof k.key_id !== 'string' || !KEY_ID_RE.test(k.key_id) || k.alg !== 'ed25519' || typeof k.public_key !== 'string' || !PUBKEY_RE.test(k.public_key)) return { error: 'bad key entry' };
    if (!int(k.not_before) || !(k.revoked_at === null || int(k.revoked_at))) return { error: 'bad key times' };
    if (!(k.rotated_from === null || (typeof k.rotated_from === 'string' && KEY_ID_RE.test(k.rotated_from)))) return { error: 'bad rotated_from' };
    if (!(k.rotation_sig === null || (typeof k.rotation_sig === 'string' && SIG_RE.test(k.rotation_sig)))) return { error: 'bad rotation_sig' };
  }
  return { manifest: v as unknown as Manifest };
}

export type KeyStatus =
  | { status: 'ok'; key: ManifestKey; publicKey: Uint8Array }
  /** signed before a later revocation: valid only with a log root before `revoked_at`, which isn't checked (△) */
  | { status: 'revoked-later'; key: ManifestKey; publicKey: Uint8Array }
  | { status: 'revoked' | 'not-yet' | 'unrotated' | 'unknown' | 'bad-key' };

/**
 * The manifest key a signature may use (§3.3): the first key without `rotated_from`, or a later key whose
 * `rotation_sig` by the key it names (listed earlier) verifies; then `not_before` and `revoked_at` against `at`.
 */
export function keyFor(m: Manifest, keyId: string, at: number): KeyStatus {
  const trusted = new Map<string, Uint8Array>();
  for (const [n, k] of m.keys.entries()) {
    let pk: Uint8Array;
    try {
      pk = b64urlDecode(k.public_key);
    } catch {
      continue;
    }
    if (pk.length !== 32 || keyIdOf(pk) !== k.key_id) continue;
    if (n === 0 && k.rotated_from === null) trusted.set(k.key_id, pk);
    else if (k.rotated_from && k.rotation_sig && trusted.has(k.rotated_from)) {
      if (sigValid(k.rotation_sig, canonicalWithout(k as unknown as Obj, 'rotation_sig'), trusted.get(k.rotated_from)!)) trusted.set(k.key_id, pk);
    }
  }
  const key = m.keys.find((k) => k.key_id === keyId);
  if (!key) return { status: 'unknown' };
  const publicKey = trusted.get(keyId);
  if (!publicKey) {
    try {
      const pk = b64urlDecode(key.public_key);
      return pk.length === 32 && keyIdOf(pk) === key.key_id ? { status: 'unrotated' } : { status: 'bad-key' };
    } catch {
      return { status: 'bad-key' };
    }
  }
  if (at < key.not_before) return { status: 'not-yet' };
  if (key.revoked_at !== null && at >= key.revoked_at) return { status: 'revoked' };
  return { status: key.revoked_at !== null ? 'revoked-later' : 'ok', key, publicKey };
}

const ATT_FIELDS = ['v', 'issuer', 'commitment', 'created_at', 'key_id', 'salt_box', 'salt_nip44', 'sig'] as const;

/** An attestation of the shape NKIP-0001 defines: v1 exactly, v2 with optional salt_box and salt_nip44. */
export function parseAttestation(v: Json): Attestation | null {
  if (!isObj(v) || !onlyKeys(v, ATT_FIELDS)) return null;
  if ((v.v !== V1 && v.v !== V2) || typeof v.issuer !== 'string' || typeof v.commitment !== 'string' || !HEX64.test(v.commitment)) return null;
  if (!int(v.created_at) || typeof v.key_id !== 'string' || !KEY_ID_RE.test(v.key_id) || typeof v.sig !== 'string' || !SIG_RE.test(v.sig)) return null;
  if (v.v === V1 && ('salt_box' in v || 'salt_nip44' in v)) return null;
  if ('salt_box' in v) {
    const b = v.salt_box;
    if (!isObj(b) || !onlyKeys(b, ['r', 'ct']) || typeof b.r !== 'string' || !HEX64.test(b.r) || b.r === ZERO_SALT || typeof b.ct !== 'string' || !HEX64.test(b.ct)) return null;
  }
  // NIP-44 v2: base64 of version, nonce, ciphertext and MAC; opaque here, so only its shape is checked
  if ('salt_nip44' in v && (typeof v.salt_nip44 !== 'string' || v.salt_nip44.length < 132 || v.salt_nip44.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(v.salt_nip44))) return null;
  return v as unknown as Attestation;
}

export type AttestationCheck = { ok: true; attestation: Attestation; keyStatus: KeyStatus['status']; saltBoxMissing: boolean } | { ok: false; reason: string };

/**
 * A kind 3711 event that attests this receipt (§3.5): signed by the manifest's Nostr key, tags c/i/v
 * matching once each, content an attestation for this commitment, signed by a trusted manifest key,
 * and created within 300 s of the attestation's own time. Both signatures must hold.
 */
export function checkAttestationEvent(ev: Event, r: Receipt, m: Manifest): AttestationCheck {
  const c = commitment(r);
  if (m.issuer !== r.issuer) return { ok: false, reason: 'manifest is for another issuer' };
  if (ev.kind !== KIND_ATTESTATION) return { ok: false, reason: 'wrong kind' };
  if (ev.pubkey !== m.nostr_pubkey) return { ok: false, reason: 'not the issuer’s Nostr key' };
  if (!verifyEvent({ ...ev })) return { ok: false, reason: 'bad Nostr signature' };
  const tags = (name: string) => ev.tags.filter((t) => t[0] === name).map((t) => t[1]);
  const [ct, it, vt] = [tags('c'), tags('i'), tags('v')];
  if (ct.length !== 1 || ct[0] !== c || it.length !== 1 || it[0] !== r.issuer || vt.length !== 1 || vt[0] !== r.v) return { ok: false, reason: 'tags don’t match' };
  let att: Attestation | null;
  try {
    att = parseAttestation(parseStrict(ev.content));
  } catch {
    att = null;
  }
  if (!att) return { ok: false, reason: 'bad attestation' };
  if (att.v !== r.v || att.issuer !== r.issuer || att.commitment !== c) return { ok: false, reason: 'attestation is for another receipt' };
  if (Math.abs(ev.created_at - att.created_at) > SKEW_SECS) return { ok: false, reason: 'event time too far from the attestation’s' };
  const key = keyFor(m, att.key_id, att.created_at);
  if (key.status !== 'ok' && key.status !== 'revoked-later') return { ok: false, reason: `attestation key ${key.status}` };
  if (!sigValid(att.sig, canonicalWithout(att as unknown as Obj, 'sig'), key.publicKey)) return { ok: false, reason: 'bad attestation signature' };
  // R17: a random salt and an XMR payout need the salt box, the payout wallet's way back to the salt
  const saltBoxMissing = r.v === V2 && r.salt !== ZERO_SALT && r.payout_asset.toUpperCase() === 'XMR' && !att.salt_box;
  return { ok: true, attestation: att, keyStatus: key.status, saltBoxMissing };
}

/** The policy text matches the receipt's hash: over the raw bytes, before any decoding. */
export const policyMatches = (bytes: Uint8Array, policyHash: string) => bytesToHex(sha256(bytes)) === policyHash;
