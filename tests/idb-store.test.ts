import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SavedLetter } from '../src/log/store';
import type { SavedReceipt } from '../src/receipts/store';

// each test gets an empty IndexedDB and a fresh module, so the cached connection starts over
beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.resetModules();
});

const receipt = { commitment: 'c'.repeat(64), receipt: { policy_hash: 'p' }, page: 'https://example.swap/o', savedAt: 1 } as unknown as SavedReceipt;
const letter: SavedLetter = { id: 'a'.repeat(64), siteId: 'stereoswap', siteName: 'StereoSwap', format: 'pgp', orderId: 'STRRSXUE', page: 'https://stereoswap.app/swap/STRRSXUE', text: 't', key: 'k', feedIssuedAt: 1, savedAt: 2 };

/** the database as 0.4.0 left it: receipts and policies, no letters */
function openV1(): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('xmradar-receipts', 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore('receipts', { keyPath: 'commitment' });
      req.result.createObjectStore('policies');
    };
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction(['receipts', 'policies'], 'readwrite');
      tx.objectStore('receipts').put(receipt);
      tx.objectStore('policies').put(new Uint8Array([1, 2, 3]), 'p');
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    };
    req.onerror = () => reject(req.error);
  });
}

describe('IndexedDB: receipts and letters', () => {
  it('upgrading from 0.4.0 (v1) keeps the saved receipts and policies, and adds the letters store', async () => {
    await openV1();
    const { idbReceiptStore } = await import('../src/receipts/store');
    const { idbLetterStore } = await import('../src/log/store');
    expect(await idbReceiptStore.list()).toEqual([receipt]);
    expect(await idbReceiptStore.getPolicy('p')).toEqual(new Uint8Array([1, 2, 3]));
    expect(await idbLetterStore.list()).toEqual([]);
    await idbLetterStore.put(letter);
    expect(await idbLetterStore.get(letter.id)).toEqual(letter);
  });

  it('a new install gets all three stores', async () => {
    const { idbReceiptStore } = await import('../src/receipts/store');
    const { idbLetterStore } = await import('../src/log/store');
    await idbReceiptStore.put(receipt);
    await idbLetterStore.put(letter);
    expect(await idbReceiptStore.list()).toHaveLength(1);
    expect(await idbLetterStore.list()).toEqual([letter]);
  });

  it('letters: saved once, listed, deleted', async () => {
    const { idbLetterStore, saveLetter } = await import('../src/log/store');
    await saveLetter(idbLetterStore, letter);
    await saveLetter(idbLetterStore, letter);
    expect(await idbLetterStore.list()).toHaveLength(1);
    await idbLetterStore.delete(letter.id);
    expect(await idbLetterStore.get(letter.id)).toBeNull();
  });
});
