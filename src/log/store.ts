import { LETTERS, run } from '../receipts/store';

/**
 * Saved letters of guarantee (PLAN-LOG §5, Round 2 item 7): only letters that verified with the key in
 * the signed feed, in the same background-only IndexedDB as receipts. Keyed by the SHA-256 of the exact
 * text, so a page showing it again saves nothing new. Each keeps the operator's key as the feed carried
 * it, so the export verifies offline even after the feed moves on.
 */

export interface SavedLetter {
  /** hex SHA-256 of `text` */
  id: string;
  siteId: string;
  siteName: string;
  format: 'pgp' | 'mistproof';
  orderId: string;
  /** the order page: origin and path only */
  page: string;
  /** exactly as fetched or captured */
  text: string;
  /** PGP: the primary fingerprint the feed names */
  fingerprint?: string;
  /** the armored PGP key, or the base64 Ed25519 key, from the feed */
  key: string;
  /** unix seconds: the feed the key came from */
  feedIssuedAt: number;
  /** ms, PGP: the latest block's signature time */
  signedAt?: number;
  /** ms, first saved */
  savedAt: number;
}

export interface LetterStore {
  get(id: string): Promise<SavedLetter | null>;
  put(l: SavedLetter): Promise<void>;
  list(): Promise<SavedLetter[]>;
  delete(id: string): Promise<void>;
}

export const MAX_LETTERS = 500;

/** Save a letter once; past MAX_LETTERS the oldest go. A letter saved before keeps its first save time. */
export async function saveLetter(store: LetterStore, l: SavedLetter): Promise<{ pruned: number }> {
  if (await store.get(l.id)) return { pruned: 0 };
  const others = await store.list();
  const drop = [...others]
    .sort((a, b) => a.savedAt - b.savedAt)
    .slice(0, Math.max(0, others.length + 1 - MAX_LETTERS))
    .map((x) => x.id);
  for (const id of drop) await store.delete(id);
  await store.put(l);
  return { pruned: drop.length };
}

export const idbLetterStore: LetterStore = {
  get: async (id) => (await run<SavedLetter | undefined>(LETTERS, 'readonly', (s) => s.get(id))) ?? null,
  put: (l) => run(LETTERS, 'readwrite', (s) => s.put(l)),
  list: () => run<SavedLetter[]>(LETTERS, 'readonly', (s) => s.getAll()),
  delete: (id) => run(LETTERS, 'readwrite', (s) => s.delete(id)),
};

export function memoryLetterStore(): LetterStore & { letters: Map<string, SavedLetter> } {
  const letters = new Map<string, SavedLetter>();
  return {
    letters,
    get: async (id) => letters.get(id) ?? null,
    put: async (l) => void letters.set(l.id, l),
    list: async () => [...letters.values()],
    delete: async (id) => void letters.delete(id),
  };
}
