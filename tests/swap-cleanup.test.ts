import { describe, expect, it, vi } from 'vitest';
import { memoryLetterStore, type SavedLetter } from '../src/log/store';
import { cleanSwapRecords, isOld, SWAP_RECORDS_ALARM, swapRecordDaysOf, swapRecordsKeeper } from '../src/receipts/cleanup';
import type { ReceiptStore, SavedReceipt } from '../src/receipts/store';

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;

function receiptStore(savedAts: number[]) {
  const map = new Map<string, SavedReceipt>(savedAts.map((at, i) => [`c${i}`, { commitment: `c${i}`, savedAt: at } as SavedReceipt]));
  const policies = new Map<string, Uint8Array>([['p', new Uint8Array([1])]]);
  const store: ReceiptStore = {
    get: async (c) => map.get(c) ?? null,
    put: async (r) => void map.set(r.commitment, r),
    list: async () => [...map.values()],
    delete: async (c) => void map.delete(c),
    getPolicy: async (h) => policies.get(h) ?? null,
    putPolicy: async (h, b) => void policies.set(h, b),
  };
  return { store, map, policies };
}
function letterStore(savedAts: number[]) {
  const s = memoryLetterStore();
  savedAts.forEach((at, i) => s.letters.set(`l${i}`, { id: `l${i}`, savedAt: at } as SavedLetter));
  return s;
}

describe('which records are old', () => {
  it('counted in whole days from the first save; 0 keeps everything', () => {
    expect(isOld(NOW - DAY, 1, NOW)).toBe(true);
    expect(isOld(NOW - DAY + 1, 1, NOW)).toBe(false);
    expect(isOld(0, 0, NOW)).toBe(false);
  });
  it('only the offered choices count; anything else keeps', () => {
    expect([0, 1, 7, 30, 90].map(swapRecordDaysOf)).toEqual([0, 1, 7, 30, 90]);
    expect([2, -1, '7', null, undefined, NaN].map(swapRecordDaysOf)).toEqual([0, 0, 0, 0, 0, 0]);
  });
});

describe('cleaning', () => {
  it('deletes old receipts and letters, keeps newer ones and the policy texts', async () => {
    const r = receiptStore([NOW - 10 * DAY, NOW - DAY / 2]);
    const l = letterStore([NOW - 8 * DAY, NOW - 6 * DAY, NOW]);
    expect(await cleanSwapRecords({ receipts: r.store, letters: l }, 7, NOW)).toEqual({ receipts: 1, letters: 1 });
    expect([...r.map.keys()]).toEqual(['c1']);
    expect([...l.letters.keys()]).toEqual(['l1', 'l2']);
    expect(r.policies.size).toBe(1);
  });
  it('0: nothing is deleted', async () => {
    const r = receiptStore([0]);
    const l = letterStore([0]);
    expect(await cleanSwapRecords({ receipts: r.store, letters: l }, 0, NOW)).toEqual({ receipts: 0, letters: 0 });
  });
});

describe('the background keeper', () => {
  const setup = (days: number) => {
    const r = receiptStore([NOW - 10 * DAY]);
    const l = letterStore([NOW - 10 * DAY, NOW]);
    const alarms = { create: vi.fn(), clear: vi.fn() };
    const cleaned = vi.fn();
    let d = days;
    const keeper = swapRecordsKeeper({ stores: { receipts: r.store, letters: l }, days: async () => d, alarms, cleaned, now: () => NOW });
    return { keeper, alarms, cleaned, r, l, set: (n: number) => (d = n) };
  };

  it('worker start with 7 days: cleans now and keeps a daily alarm; the panel hears what went', async () => {
    const { keeper, alarms, cleaned, r, l } = setup(7);
    expect(await keeper.apply()).toEqual({ receipts: 1, letters: 1 });
    expect(alarms.create).toHaveBeenCalledWith(SWAP_RECORDS_ALARM, { periodInMinutes: 1440 });
    expect(cleaned).toHaveBeenCalledWith({ receipts: 1, letters: 1, at: NOW });
    expect(r.map.size + l.letters.size).toBe(1);
  });
  it('worker start with 0: the alarm is cleared and nothing deleted', async () => {
    const { keeper, alarms, cleaned, l } = setup(0);
    await keeper.apply();
    expect(alarms.clear).toHaveBeenCalledWith(SWAP_RECORDS_ALARM);
    expect(alarms.create).not.toHaveBeenCalled();
    expect(cleaned).not.toHaveBeenCalled();
    expect(l.letters.size).toBe(2);
  });
  it('the daily alarm cleans; another alarm does nothing; nothing deleted → no notice', async () => {
    const { keeper, cleaned, set } = setup(7);
    expect(keeper.onAlarm('xmrbio-directory')).toBeUndefined();
    await keeper.onAlarm(SWAP_RECORDS_ALARM);
    expect(cleaned).toHaveBeenCalledTimes(1);
    set(7);
    await keeper.onAlarm(SWAP_RECORDS_ALARM);
    expect(cleaned).toHaveBeenCalledTimes(1);
  });
  it('0 → 7 → 0: the alarm is created, then cleared', async () => {
    const { keeper, alarms, set } = setup(0);
    await keeper.apply();
    set(7);
    await keeper.apply();
    set(0);
    await keeper.apply();
    expect(alarms.create).toHaveBeenCalledTimes(1);
    expect(alarms.clear).toHaveBeenCalledTimes(2);
  });
  it('clean-ups started together run one after the other: each record is counted once', async () => {
    const { keeper, cleaned } = setup(7);
    const [a, b] = await Promise.all([keeper.apply(), keeper.onAlarm(SWAP_RECORDS_ALARM)]);
    expect(a.receipts + b!.receipts).toBe(1);
    expect(a.letters + b!.letters).toBe(1);
    expect(cleaned).toHaveBeenCalledTimes(1);
  });
  it('a failed clean-up does not stop the next one', async () => {
    const { keeper, l } = setup(7);
    const list = l.list;
    l.list = async () => {
      throw new Error('IndexedDB busy');
    };
    await expect(keeper.onAlarm(SWAP_RECORDS_ALARM)).rejects.toThrow('IndexedDB busy');
    l.list = list;
    expect((await keeper.onAlarm(SWAP_RECORDS_ALARM))!.letters).toBe(1);
  });
  it('quick 0 → 7 → 0 changes: the alarm ends as the last setting says', async () => {
    const { keeper, alarms, set } = setup(0);
    const order: string[] = [];
    alarms.create.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 5));
      order.push('create');
    });
    alarms.clear.mockImplementation(async () => void order.push('clear'));
    set(7);
    const a = keeper.apply();
    const b = keeper.apply().then(() => undefined);
    set(0);
    const c = keeper.apply();
    await Promise.all([a, b, c]);
    expect(order.at(-1)).toBe('clear');
  });
});
