import { finalizeEvent, generateSecretKey, getPublicKey, type Event, type EventTemplate } from 'nostr-tools/pure';
import { nsecEncode } from 'nostr-tools/nip19';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { KIND_CONFIRMATION, KIND_RECEIPT } from '../xap/events';
import { KIND_IDENTITIES, KIND_PAYTO } from './nostr';

/**
 * The XMRadar identity (PLAN-MANAGEDID): a Nostr key XMRadar makes and keeps when no NIP-07 signer is found,
 * so xo, Xap receipts and the Monero identity steps work without one. It lives in the extension origin's
 * IndexedDB, which content scripts and pages can't open (unlike storage.local), and only the background
 * imports this module. It signs only the kinds XMRadar itself publishes; it never posts copies.
 */

export interface KeyStore {
  get(): Promise<{ sk: string; createdAt: number } | null>;
  set(v: { sk: string; createdAt: number }): Promise<void>;
  delete(): Promise<void>;
}

/** xo and its deletion, Xap receipts and confirmations, profile name, relay list, Monero address, X proof. */
export const MANAGED_KINDS: ReadonlySet<number> = new Set([17, 5, KIND_RECEIPT, KIND_CONFIRMATION, 0, 10002, KIND_PAYTO, KIND_IDENTITIES]);

export class KindNotAllowed extends Error {}

export function managedIdentity(store: KeyStore, now: () => number = Date.now) {
  let making: Promise<void> = Promise.resolve();
  async function key(): Promise<Uint8Array | null> {
    const held = await store.get();
    return held && /^[0-9a-f]{64}$/.test(held.sk) ? hexToBytes(held.sk) : null;
  }
  return {
    /** the key's public half, or null when there's none */
    async pubkey(): Promise<string | null> {
      const sk = await key();
      return sk ? getPublicKey(sk) : null;
    },
    /** the key, made on first use; `created` says this call made it. One at a time, so two signatures at once never make two keys. */
    ensure(): Promise<{ pubkey: string; created: boolean }> {
      const run = making.then(async () => {
        const sk = await key();
        if (sk) return { pubkey: getPublicKey(sk), created: false };
        const fresh = generateSecretKey();
        await store.set({ sk: bytesToHex(fresh), createdAt: now() });
        return { pubkey: getPublicKey(fresh), created: true };
      });
      making = run.then(
        () => {},
        () => {},
      );
      return run;
    },
    /** signs one of XMRadar's own kinds; anything else is refused */
    async sign(template: EventTemplate): Promise<Event> {
      if (!MANAGED_KINDS.has(template.kind)) throw new KindNotAllowed(`The XMRadar identity doesn’t sign kind ${template.kind}`);
      const sk = await key();
      if (!sk) throw new Error('No XMRadar identity');
      return finalizeEvent(template, sk);
    },
    async exportNsec(): Promise<string | null> {
      const sk = await key();
      return sk ? nsecEncode(sk) : null;
    },
    forget: () => store.delete(),
  };
}

const DB_NAME = 'xmradar-identity';
const STORE = 'keys';
const KEY = 'managed';
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

/** Resolves when the transaction commits, so a write that aborts later is not taken as stored. */
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

export const idbKeyStore: KeyStore = {
  get: async () => (await run<{ sk: string; createdAt: number } | undefined>('readonly', (s) => s.get(KEY))) ?? null,
  set: (v) => run('readwrite', (s) => s.put(v, KEY)),
  delete: () => run('readwrite', (s) => s.delete(KEY)),
};

export function memoryKeyStore(): KeyStore & { held: { sk: string; createdAt: number } | null } {
  const box = {
    held: null as { sk: string; createdAt: number } | null,
    get: async () => box.held,
    set: async (v: { sk: string; createdAt: number }) => void (box.held = v),
    delete: async () => void (box.held = null),
  };
  return box;
}
