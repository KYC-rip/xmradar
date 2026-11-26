import { finalizeEvent, generateSecretKey, getPublicKey, type Event, type EventTemplate } from 'nostr-tools/pure';
import { decode, nsecEncode } from 'nostr-tools/nip19';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { KIND_CONFIRMATION, KIND_RECEIPT } from '../xap/events';
import { KIND_IDENTITIES, KIND_PAYTO } from './nostr';

/**
 * The XMRadar identity (PLAN-MANAGEDID): a Nostr key XMRadar makes or imports and keeps when no signer
 * is used, so xo, Xap receipts and the Monero identity steps work without one. It lives in the extension
 * origin's IndexedDB, which content scripts and pages can't open (unlike storage.local), and only the
 * background imports this module. It signs only the kinds XMRadar itself publishes; it never posts copies.
 */

export interface KeyStore {
  get(): Promise<{ sk: string; createdAt: number } | null>;
  set(v: { sk: string; createdAt: number }): Promise<void>;
  delete(): Promise<void>;
}

/**
 * xo and its deletion, Xap receipts and confirmations, profile name, relay list, Monero address, X proof, and
 * the xmr.bio listing request (27235, built only by `registerTemplate`).
 */
export const MANAGED_KINDS: ReadonlySet<number> = new Set([17, 5, KIND_RECEIPT, KIND_CONFIRMATION, 0, 10002, KIND_PAYTO, KIND_IDENTITIES, 27235]);

const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const HEX64_RE = /^[0-9a-fA-F]{64}$/;
const INVALID_KEY_MSG = 'Enter a valid Nostr private key (nsec1… or 64-character hex).';

export class KindNotAllowed extends Error {}

export class KeyReplaceRequired extends Error {
  constructor(public readonly existingPubkey: string) {
    super('A different XMRadar identity is already stored; confirm before replacing it.');
  }
}

/**
 * Validates and decodes a user-provided Nostr secret key (`nsec1…` Bech32 or 64-char hex).
 * Strips outer whitespace only, rejects mixed-case Bech32 / inner whitespace / non-nsec prefixes,
 * verifies `0 < d < SECP256K1_N`, and NEVER includes the secret input in thrown error messages.
 */
export function parseSecretKey(raw: string): Uint8Array {
  if (typeof raw !== 'string') throw new Error(INVALID_KEY_MSG);
  const s = raw.trim();
  if (!s || /\s/.test(s)) throw new Error(INVALID_KEY_MSG);

  let sk: Uint8Array;
  if (/^nsec1/i.test(s)) {
    // BIP-173 forbids mixed-case Bech32
    if (s !== s.toLowerCase() && s !== s.toUpperCase()) throw new Error(INVALID_KEY_MSG);
    try {
      const decoded = decode(s.toLowerCase());
      if (decoded.type !== 'nsec' || !(decoded.data instanceof Uint8Array) || decoded.data.length !== 32) {
        throw new Error(INVALID_KEY_MSG);
      }
      sk = decoded.data;
    } catch {
      throw new Error(INVALID_KEY_MSG);
    }
  } else if (HEX64_RE.test(s)) {
    sk = hexToBytes(s.toLowerCase());
  } else {
    throw new Error(INVALID_KEY_MSG);
  }

  let scalar = 0n;
  for (const b of sk) scalar = (scalar << 8n) | BigInt(b);
  if (scalar <= 0n || scalar >= SECP256K1_N) throw new Error(INVALID_KEY_MSG);

  try {
    getPublicKey(sk);
  } catch {
    throw new Error(INVALID_KEY_MSG);
  }
  return sk;
}

export function managedIdentity(store: KeyStore, now: () => number = Date.now) {
  // Single serialized queue so concurrent ensure / importKey / forget / sign never observe half-written state.
  let queue: Promise<void> = Promise.resolve();
  const serialize = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = queue.then(fn);
    queue = run.then(
      () => {},
      () => {},
    );
    return run;
  };

  async function readKey(): Promise<Uint8Array | null> {
    const held = await store.get();
    return held && /^[0-9a-f]{64}$/.test(held.sk) ? hexToBytes(held.sk) : null;
  }

  return {
    /** the key's public half, or null when there's none */
    pubkey(): Promise<string | null> {
      return serialize(async () => {
        const sk = await readKey();
        return sk ? getPublicKey(sk) : null;
      });
    },
    /** the key, made on first use; `created` says this call made it. One at a time, so two signatures at once never make two keys. */
    ensure(): Promise<{ pubkey: string; created: boolean }> {
      return serialize(async () => {
        const sk = await readKey();
        if (sk) return { pubkey: getPublicKey(sk), created: false };
        const fresh = generateSecretKey();
        await store.set({ sk: bytesToHex(fresh), createdAt: now() });
        return { pubkey: getPublicKey(fresh), created: true };
      });
    },
    /**
     * Imports a user-supplied secret key (`nsec1…` or 64-char hex) into the extension-only store.
     * Importing the already-stored key is a no-op (`unchanged: true`). Replacing a different stored key
     * requires `confirmOverwrite: true`; otherwise throws `KeyReplaceRequired(existingPubkey)`.
     * Returns an async `rollback` callback so callers can atomically revert if downstream storage writes fail.
     */
    importKey(
      raw: string,
      opts: { confirmOverwrite?: boolean } = {},
    ): Promise<{ pubkey: string; unchanged: boolean; rollback: () => Promise<void> }> {
      return serialize(async () => {
        const nextSk = parseSecretKey(raw);
        const nextPubkey = getPublicKey(nextSk);
        const prev = await store.get();
        const prevSk = prev && /^[0-9a-f]{64}$/.test(prev.sk) ? hexToBytes(prev.sk) : null;
        const prevPubkey = prevSk ? getPublicKey(prevSk) : null;

        if (prevPubkey === nextPubkey) {
          return { pubkey: nextPubkey, unchanged: true, rollback: async () => {} };
        }
        if (prevPubkey && !opts.confirmOverwrite) {
          throw new KeyReplaceRequired(prevPubkey);
        }
        const nextSkHex = bytesToHex(nextSk);
        await store.set({ sk: nextSkHex, createdAt: now() });
        return {
          pubkey: nextPubkey,
          unchanged: false,
          rollback: () =>
            serialize(async () => {
              // Guard against a stale rollback clobbering a newer concurrent import.
              const cur = await store.get();
              if (cur?.sk !== nextSkHex) return;
              if (prev) await store.set(prev);
              else await store.delete();
            }),
        };
      });
    },
    /** signs one of XMRadar's own kinds; anything else is refused */
    sign(template: EventTemplate): Promise<Event> {
      return serialize(async () => {
        if (!MANAGED_KINDS.has(template.kind)) throw new KindNotAllowed(`The XMRadar identity doesn’t sign kind ${template.kind}`);
        const sk = await readKey();
        if (!sk) throw new Error('No XMRadar identity');
        return finalizeEvent(template, sk);
      });
    },
    exportNsec(): Promise<string | null> {
      return serialize(async () => {
        const sk = await readKey();
        return sk ? nsecEncode(sk) : null;
      });
    },
    forget: () => serialize(() => store.delete()),
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
    req.onsuccess = () => {
      const db = req.result;
      db.onclose = () => {
        dbPromise = null;
      };
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
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
