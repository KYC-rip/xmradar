import type { Manifest, Receipt } from './verify';

/**
 * Saved swap receipts (NKIP-0001 R12, PLAN-NKIP01 §11, §12): only in this browser, in the extension's
 * own IndexedDB, which only the background opens (pages and content scripts can't). They leave it only
 * through Export. A receipt is keyed by its commitment, so a page re-rendering it updates it in place;
 * policy texts are kept once per hash.
 */

export interface PublicRecord {
  /** ms */
  checkedAt: number;
  /** relays that returned a valid attestation, of those asked */
  seen: string[];
  asked: string[];
  saltBoxMissing?: boolean;
}

export interface SavedReceipt {
  commitment: string;
  receipt: Receipt;
  /** the page it was found on: origin and path only */
  page: string;
  /** ms, first saved */
  savedAt: number;
  /** the attestation event id the page showed next to the address, if any (§12.1) */
  eventId?: string;
  /** the manifest it was checked against, for the export */
  manifest?: Manifest;
  publicRecord?: PublicRecord;
}

export interface ReceiptStore {
  get(commitment: string): Promise<SavedReceipt | null>;
  put(r: SavedReceipt): Promise<void>;
  list(): Promise<SavedReceipt[]>;
  delete(commitment: string): Promise<void>;
  getPolicy(hash: string): Promise<Uint8Array | null>;
  putPolicy(hash: string, bytes: Uint8Array): Promise<void>;
}

export const MAX_RECEIPTS = 500;

/**
 * Which receipts to drop to stay at MAX_RECEIPTS once `incoming` is saved: expired ones first, oldest
 * first, then the oldest of the rest. A receipt being re-saved is never dropped for itself.
 */
export function toPrune(saved: SavedReceipt[], incoming: string, nowSecs: number): string[] {
  const others = saved.filter((r) => r.commitment !== incoming);
  const excess = others.length + 1 - MAX_RECEIPTS;
  if (excess <= 0) return [];
  const expired = (r: SavedReceipt) => r.receipt.expires_at <= nowSecs;
  return [...others]
    .sort((a, b) => Number(expired(b)) - Number(expired(a)) || a.savedAt - b.savedAt)
    .slice(0, excess)
    .map((r) => r.commitment);
}

/** Save or update a receipt, keeping what an earlier save learned (first-seen time, event id, record). */
export async function saveReceipt(store: ReceiptStore, r: SavedReceipt, nowSecs: number): Promise<{ pruned: number }> {
  const prev = await store.get(r.commitment);
  const merged: SavedReceipt = prev ? { ...prev, ...r, savedAt: prev.savedAt, eventId: r.eventId ?? prev.eventId, publicRecord: r.publicRecord ?? prev.publicRecord } : r;
  const drop = prev ? [] : toPrune(await store.list(), r.commitment, nowSecs);
  for (const c of drop) await store.delete(c);
  await store.put(merged);
  return { pruned: drop.length };
}

// ---- IndexedDB (background only) ----

const DB_NAME = 'xmradar-receipts';
const RECEIPTS = 'receipts';
const POLICIES = 'policies';
let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(RECEIPTS, { keyPath: 'commitment' });
      req.result.createObjectStore(POLICIES);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      dbPromise = null;
      reject(req.error ?? new Error('IndexedDB unavailable'));
    };
  });
  return dbPromise;
}

/** Resolves when the transaction commits, so a write that aborts later (quota) is not taken as stored. */
async function run<T>(name: string, mode: IDBTransactionMode, op: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(name, mode);
    const req = op(tx.objectStore(name));
    tx.oncomplete = () => resolve(req.result as T);
    tx.onerror = () => reject(tx.error ?? req.error);
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB write aborted'));
  });
}

export const idbReceiptStore: ReceiptStore = {
  get: async (c) => (await run<SavedReceipt | undefined>(RECEIPTS, 'readonly', (s) => s.get(c))) ?? null,
  put: (r) => run(RECEIPTS, 'readwrite', (s) => s.put(r)),
  list: () => run<SavedReceipt[]>(RECEIPTS, 'readonly', (s) => s.getAll()),
  delete: (c) => run(RECEIPTS, 'readwrite', (s) => s.delete(c)),
  getPolicy: async (h) => (await run<Uint8Array | undefined>(POLICIES, 'readonly', (s) => s.get(h))) ?? null,
  putPolicy: (h, bytes) => run(POLICIES, 'readwrite', (s) => s.put(bytes, h)),
};

export function memoryReceiptStore(): ReceiptStore & { receipts: Map<string, SavedReceipt>; policies: Map<string, Uint8Array> } {
  const receipts = new Map<string, SavedReceipt>();
  const policies = new Map<string, Uint8Array>();
  return {
    receipts,
    policies,
    get: async (c) => receipts.get(c) ?? null,
    put: async (r) => void receipts.set(r.commitment, r),
    list: async () => [...receipts.values()],
    delete: async (c) => void receipts.delete(c),
    getPolicy: async (h) => policies.get(h) ?? null,
    putPolicy: async (h, b) => void policies.set(h, b),
  };
}
