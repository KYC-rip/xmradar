import type { LetterStore } from '../log/store';
import type { ReceiptStore } from './store';

/**
 * Saved letters and receipts deleted after a chosen number of days (PLAN-AUTOCLEAN), counted from when
 * each was first saved: 90 unless the user picks another (0 keeps them). Receipt policy texts stay: they
 * are the site's published policy, linked to no order.
 */

export const SWAP_RECORD_DAYS = [0, 1, 7, 30, 90] as const;
export const SWAP_RECORDS_ALARM = 'swap-records-clean';
const DAY_MS = 86_400_000;

/** The kept setting as one of the offered choices; anything else is 0 (keep). */
export const swapRecordDaysOf = (v: unknown): number => (SWAP_RECORD_DAYS as readonly unknown[]).includes(v) ? (v as number) : 0;

export const isOld = (savedAt: number, days: number, now: number) => days > 0 && savedAt <= now - days * DAY_MS;

export interface CleanCounts {
  receipts: number;
  letters: number;
}

export async function cleanSwapRecords(stores: { receipts: ReceiptStore; letters: LetterStore }, days: number, now: number): Promise<CleanCounts> {
  const out = { receipts: 0, letters: 0 };
  if (!days) return out;
  for (const r of await stores.receipts.list()) {
    if (!isOld(r.savedAt, days, now)) continue;
    await stores.receipts.delete(r.commitment);
    out.receipts++;
  }
  for (const l of await stores.letters.list()) {
    if (!isOld(l.savedAt, days, now)) continue;
    await stores.letters.delete(l.id);
    out.letters++;
  }
  return out;
}

export interface KeeperDeps {
  stores: { receipts: ReceiptStore; letters: LetterStore };
  days: () => Promise<number>;
  alarms: { create(name: string, info: { periodInMinutes: number }): Promise<void> | void; clear(name: string): Promise<unknown> | void };
  /** something was deleted: the options page reloads its list from this */
  cleaned: (c: CleanCounts & { at: number }) => Promise<void> | void;
  now?: () => number;
}

/** One step at a time (clean-ups and alarm changes); a failed step doesn't stop the ones after it. */
export function swapRecordsKeeper(deps: KeeperDeps) {
  const now = deps.now ?? Date.now;
  const NONE: CleanCounts = { receipts: 0, letters: 0 };
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(step: () => Promise<T>): Promise<T> => {
    const run = queue.then(step, step);
    queue = run.catch(() => undefined);
    return run;
  };

  const cleanNow = async (): Promise<CleanCounts> => {
    const c = await cleanSwapRecords(deps.stores, swapRecordDaysOf(await deps.days()), now());
    if (c.receipts || c.letters) await deps.cleaned({ ...c, at: now() });
    return c;
  };

  /** Worker start or a changed setting: clean now and keep the daily alarm, or clear it when off. Read at its turn, so the last change wins. */
  const apply = () =>
    serial(async () => {
      if (!swapRecordDaysOf(await deps.days())) {
        await deps.alarms.clear(SWAP_RECORDS_ALARM);
        return NONE;
      }
      await deps.alarms.create(SWAP_RECORDS_ALARM, { periodInMinutes: 1440 });
      return cleanNow();
    });

  const onAlarm = (name: string) => (name === SWAP_RECORDS_ALARM ? serial(cleanNow) : undefined);
  return { apply, onAlarm };
}
