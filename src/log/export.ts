import type { SavedLetter } from './store';

/**
 * A saved letter as a file for a dispute (PLAN-LOG §5): the exact text, the operator's key as the
 * signed xmr.club feed carried it, and how to check it offline. Only verified letters are saved, so
 * only those can be exported.
 */
export interface LetterExport {
  format: 'xmradar-letter/1';
  exportedAt: string;
  site: { id: string; name: string };
  orderId: string;
  page: string;
  savedAt: string;
  signedAt?: string;
  letter: { format: SavedLetter['format']; text: string };
  key: { fingerprint?: string; armored?: string; ed25519?: string; source: string };
  verify: string;
}

export function buildLetterExport(l: SavedLetter, now: number): LetterExport {
  const source = `From the signed xmr.club feed issued ${new Date(l.feedIssuedAt * 1000).toISOString()}`;
  return {
    format: 'xmradar-letter/1',
    exportedAt: new Date(now).toISOString(),
    site: { id: l.siteId, name: l.siteName },
    orderId: l.orderId,
    page: l.page,
    savedAt: new Date(l.savedAt).toISOString(),
    ...(l.signedAt ? { signedAt: new Date(l.signedAt).toISOString() } : {}),
    letter: { format: l.format, text: l.text },
    key:
      l.format === 'pgp'
        ? { fingerprint: l.fingerprint, armored: l.key, source }
        : { ed25519: l.key, source },
    verify:
      l.format === 'pgp'
        ? 'Save letter.text as letter.asc and key.armored as key.asc, then: gpg --import key.asc && gpg --verify letter.asc (each signed block). The primary key fingerprint must be key.fingerprint.'
        : 'MistProof: an Ed25519 signature (base64 "signature") over the exact UTF-8 bytes of "payload", with key.ed25519 (base64); "key_id" is the first 8 bytes of SHA-256 over that key, in hex.',
  };
}

export const LETTER_EXPORT_WARNING = 'Contains your order id and swap addresses: share it only with whoever handles a dispute.';
