# Auto-delete saved swap records (letters of guarantee and receipts)

## Why
Saved letters and NKIP-0001 receipts stay in this browser only, but they hold order ids, deposit and
payout addresses and salts: anyone with this browser profile can link a user's deposits to payouts.
Today they are kept until 500 accumulate or the user deletes each one. Add an automatic clean-up.

## Change (round 2: answers AUTOCLEAN-1..3)
1. **One store** (AUTOCLEAN-2): `Settings.swapRecordDays?: number` in `sync:settings`, next to
   `receiptsCheck` and `logFetch` (the Swaps and sites switches that already live there). Read with
   `swapRecordDaysOf(s)`: one of 0, 1, 7, 30, 90, anything else 0. Default 90 days (the user's choice, 2026-10-31); Never stays available.
2. Options → Swaps and sites, above the list: select "Delete saved letters and receipts after"
   [Never · 1 day · 7 days · 30 days · 90 days]; hint "Counted from when each was saved. Export one first
   if you may need it for a claim." On change: `patchSettings({ swapRecordDays })`, then the request
   `{ type: 'swap-records-clean' }` (extension pages only) which runs the clean-up now and answers
   `{ receipts, letters }` deleted; the panel reloads its list and says "Deleted N old letters and
   receipts" (or nothing when 0).
3. **Clean-up** (`src/receipts/cleanup.ts`): pure `isOld(savedAt, days, now)` and
   `cleanSwapRecords({ receipts, letters }, days, now)` → counts; deletes by `savedAt <= now - days·86 400 000`.
   Receipt policy texts are not deleted: they are the site's published policy, shared by every order and
   linked to none (no order id, address or time in them).
4. **Background** (AUTOCLEAN-2/3): a `swapRecordsKeeper({ stores, days: () => Promise<number>, alarms,
   now, changed })` with
   - `start()` on worker start: days > 0 → clean now and `alarms.create('swap-records-clean', { periodInMinutes: 1440 })`; 0 → `alarms.clear`;
   - `onAlarm(name)` → clean;
   - `apply()` from a new `settingsItem.watch` when `swapRecordDays` changes (same as start);
   - after any clean-up that deleted something: `swapRecordsCleanedItem` (`local:swapRecordsCleaned`,
     `{ at, receipts, letters }`) is written.
5. **Open options page** (AUTOCLEAN-1): the receipts panel watches `swapRecordsCleanedItem` and reloads
   its list when it changes (a daily clean-up while the page is open removes the rows too).
6. Unchanged: MAX_RECEIPTS / MAX_LETTERS pruning, export, per-row Delete.

## Tests (`tests/swap-cleanup.test.ts`)
- `isOld` boundaries; days 0 → never; `swapRecordDaysOf` unknown/negative/string → 0.
- `cleanSwapRecords` with memory stores: newer kept, older deleted, both kinds, counts; policies untouched.
- keeper with fake alarms: start with 7 → cleans and creates the daily alarm; start with 0 → clears it,
  deletes nothing; `onAlarm('swap-records-clean')` cleans; another alarm name → nothing; apply 0 → 7 → 0
  creates then clears; the cleaned item is written only when something was deleted.
- panel (happy-dom, mocked sendToBackground): a write of the cleaned item reloads the list; the select
  change sends `swap-records-clean` and shows the count.

## Live
Options → Swaps and sites with a saved letter: choose 1 day after setting its savedAt back 2 days in the
background console → it disappears from the open list.
