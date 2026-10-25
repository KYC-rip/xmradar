/**
 * Inbox tokens live in the extension origin's IndexedDB, not storage.local:
 * content scripts can read storage.local (x-badges does), but they run under
 * the page's origin and can't open this database (PLAN-BURNER §9
 * TOKEN-STORAGE-BOUNDARY). Extension pages share the origin, so only the
 * background imports this module; a test keeps it out of the options page.
 */

export interface TokenStore {
  get(email: string): Promise<string | null>;
  set(email: string, token: string): Promise<void>;
  delete(email: string): Promise<void>;
}

const DB_NAME = 'xmradar-burner';
const STORE = 'tokens';

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      dbPromise = null;
      reject(req.error ?? new Error('IndexedDB unavailable'));
    };
  });
  return dbPromise;
}

/** Resolves when the transaction commits, so a write that aborts later (quota) is not taken as stored. */
async function run<T>(mode: IDBTransactionMode, op: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = op(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(req.result as T);
    tx.onerror = () => reject(tx.error ?? req.error);
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB write aborted'));
  });
}

export const idbTokenStore: TokenStore = {
  get: async (email) => (await run<string | undefined>('readonly', (s) => s.get(email))) ?? null,
  set: (email, token) => run('readwrite', (s) => s.put(token, email)),
  delete: (email) => run('readwrite', (s) => s.delete(email)),
};

export function memoryTokenStore(): TokenStore & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    get: async (e) => map.get(e) ?? null,
    set: async (e, t) => void map.set(e, t),
    delete: async (e) => void map.delete(e),
  };
}
