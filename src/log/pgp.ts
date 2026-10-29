import { normalizeFingerprint } from './fingerprint';

/**
 * Letters of guarantee signed with OpenPGP (PLAN-LOG §4.2, Round 2): clear-signed text, checked only
 * against the operator key carried in the signed xmr.club feed, after asserting that key's primary
 * fingerprint equals the feed's. A key the page or the letter offers is never used.
 *
 * openpgp.js (lightweight build) is imported only here, from the background: the service worker is one
 * script (MV3 workers can't load chunks), so it is bundled into background.js and nowhere else, and the
 * dynamic import defers running it until the first letter.
 */

/** per clear-signed block and per key, before any parsing */
export const MAX_BLOCK_BYTES = 64 * 1024;
/** Bitania adds one block per order step */
export const MAX_BLOCKS = 8;
/** the whole file, checked before searching it */
export const MAX_LETTER_BYTES = MAX_BLOCKS * MAX_BLOCK_BYTES;

const BLOCK_RE = /-----BEGIN PGP SIGNED MESSAGE-----[\s\S]*?-----END PGP SIGNATURE-----/g;

export type LetterFailure =
  /** no clear-signed block, too many, or too large */
  | 'format'
  /** the feed's key doesn't parse, is private, or isn't v4 with that fingerprint */
  | 'key'
  /** the signature doesn't verify with that key (tampered, other key, revoked, weak hash) */
  | 'signature';

export interface SignedBlock {
  /** the signed text, as the signer hashed it (dash-unescaped, line ends normalised) */
  text: string;
  /** the signing key or subkey, 16 hex */
  keyId: string;
  /** ms */
  signedAt: number;
}

export type LetterResult = { ok: true; blocks: SignedBlock[] } | { ok: false; reason: LetterFailure; detail: string };

const utf8Len = (s: string) => new TextEncoder().encode(s).length;

/** The clear-signed blocks of a letter file, in order; [] if there are none or the file is out of bounds. */
export function letterBlocks(text: string): string[] {
  if (utf8Len(text) > MAX_LETTER_BYTES) return [];
  const blocks = text.match(BLOCK_RE) ?? [];
  if (blocks.length > MAX_BLOCKS || blocks.some((b) => utf8Len(b) > MAX_BLOCK_BYTES)) return [];
  return blocks;
}

let lib: Promise<typeof import('openpgp/lightweight')> | null = null;
const openpgp = () => (lib ??= import('openpgp/lightweight'));

/**
 * Verifies every clear-signed block of `letter` with `armoredKey`, which must be a public v4 key whose
 * primary fingerprint is `fingerprint`. A signature by the primary or by a signing subkey bound to it
 * counts; openpgp.js checks the bindings, back-signatures, revocations and expiry. Revocations follow
 * OpenPGP: a hard one (compromised, or no reason given) fails every letter whatever its date, since a
 * compromised key can backdate; a soft one (retired, superseded) and an expiry keep letters signed
 * before it, which stay a record of what was agreed then. The key comes from today's feed, so a
 * revocation the operator publishes reaches XMRadar with the next feed. Exactly one signature per
 * block (no operator co-signs). All blocks must pass.
 */
export async function verifyLetter(letter: string, armoredKey: string, fingerprint: string, now = new Date()): Promise<LetterResult> {
  const blocks = letterBlocks(letter);
  if (!blocks.length) return { ok: false, reason: 'format', detail: 'No signed letter found' };
  const want = normalizeFingerprint(fingerprint);
  if (!want || utf8Len(armoredKey) > MAX_BLOCK_BYTES) return { ok: false, reason: 'key', detail: 'No usable key fingerprint' };

  const pgp = await openpgp();
  const config = {
    // never accept a letter hashed with a broken function, whatever the key prefers
    rejectMessageHashAlgorithms: new Set([pgp.enums.hash.md5, pgp.enums.hash.ripemd, pgp.enums.hash.sha1]),
    // and none for the key's own self-signatures and bindings either
    rejectHashAlgorithms: new Set([pgp.enums.hash.md5, pgp.enums.hash.ripemd, pgp.enums.hash.sha1]),
    minRSABits: 2048,
  };
  let key: Awaited<ReturnType<typeof pgp.readKey>>;
  try {
    key = await pgp.readKey({ armoredKey, config });
  } catch (e) {
    return { ok: false, reason: 'key', detail: `Key doesn't parse: ${(e as Error).message}` };
  }
  if (key.isPrivate() || key.keyPacket.version !== 4 || key.getFingerprint().toUpperCase() !== want) {
    return { ok: false, reason: 'key', detail: "The key isn't the one the feed names" };
  }

  const out: SignedBlock[] = [];
  for (const block of blocks) {
    try {
      const message = await pgp.readCleartextMessage({ cleartextMessage: block, config });
      const { signatures } = await pgp.verify({ message, verificationKeys: key, expectSigned: true, date: now, config });
      // one signature per block; expectSigned already threw if it didn't verify
      if (signatures.length !== 1) return { ok: false, reason: 'signature', detail: 'Expected exactly one signature' };
      const sig = signatures[0]!;
      await sig.verified;
      const packet = (await sig.signature).packets[0]!;
      out.push({ text: message.getText(), keyId: sig.keyID.toHex(), signedAt: packet.created?.getTime() ?? 0 });
    } catch (e) {
      return { ok: false, reason: 'signature', detail: (e as Error).message };
    }
  }
  return { ok: true, blocks: out };
}
