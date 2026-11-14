# PLAN-DEADRELAYS: stop posting to relays that keep failing, and let the pill go away

## Why
A user's NIP-65 list holds relays that are gone (`connection failure`) or members-only (`blocked: you do
not have a Nostr Plebs NIP-05`). Every post shows the same red lines, and because a connection failure
counts as worth retrying (`retryable`), the pill never auto-closes: it waits on a Retry that will fail.
Refusals (`blocked:` etc.) already get no Retry button.

XMRadar must not edit the user's relay list (kind 10002); the fix there is the user's, in their client.

## 1. Relay health (background)
- `src/nostr/relay-health.ts`, pure: `Health = Record<relay, { fails: number; skipUntil?: number }>`.
  - `recordResults(health, results, now)`: an ok result deletes the relay's entry; a failure (any kind)
    adds 1 to `fails`; at `fails >= 3`, `skipUntil = now + 24 h`. At most 200 entries (oldest dropped).
  - `partition(health, relays, now) → { use, skipped }`: a relay with `skipUntil > now` is skipped. Once
    the day is over it's used again (one try): a failure re-arms the skip at once (fails is still ≥ 3),
    success clears it. **Never skips everything**: if all would be skipped, all are used.
- Stored in `local:relayHealth`; writes go through one promise queue (parallel copies, PLAN-PARALLEL).
- `publish`: post relays → `partition` → publish to `use` (and store `use` for retry, as now) →
  `recordResults`. `republish` records its results too.
- The publish response gains `skipped: string[]` and `source: 'manual' | 'nip65' | 'fallback'`.
- Xap receipts and other publishes don't use or feed the health record (out of scope).

## 2. The pill closes
- `autoCloses(state)`: published, and either no retryable failure **or at least 2 relays accepted**. A note
  on 2+ relays is out; the Retry stays in the composer while it's open, but the pill doesn't wait for it.
- Only when 0–1 relays accepted does the pill stay with its Retry.

## 3. Saying what happened (composer results)
- Skipped relays: one line under the results, "Skipped N relays that failed on your last 3 posts: a, b.
  XMRadar tries each again once a day." followed by where to fix it, by source:
  - `nip65`: "They're in your NIP-65 relay list; remove them in your Nostr client's relay settings.";
  - `manual`: "Remove them under Options → Posting → Relays.";
  - `fallback`: nothing more.
- Failed (not skipped) relays keep their red line. Text only (textContent).

## Tests
- `recordResults`: ok clears; 3 failures → skip for 24 h; failure after the day re-arms at once; success
  after the day clears; the cap.
- `partition`: skip only within the day; all skipped → all used; order kept.
- `autoCloses`: all ok; 2 ok + retryable failures → closes; 1 ok + retryable → stays; refusals only → closes.
- `skippedText(skipped, source)` for each source, singular/plural.

## Docs
README "Relays": relays failing on 3 posts in a row are skipped for a day; fix your list in your client.

## Amendment after plan review round 1 (6.7, failed) — these rules replace the matching ones above
1. **One "settled" rule.** Pure `settled(results)` in `src/nostr/retry.ts`: at least 1 relay accepted, and
   either no retryable failure or at least 2 accepted. So: 1 accepted + retryable failures → not settled
   (pill stays with Retry); 1 accepted + only refusals → settled; 0 accepted → never settled.
   `autoCloses(state)` = published && `settled(state.results)`; the composer's `finished()` =
   `done && settled(shown)`. Both the auto-close timer's `closeIfIdle` and the dock (which call
   `finished()`) therefore agree.
2. **Health entries carry `at`** (the last time the relay's result was recorded). The cap keeps the 200
   with the newest `at`; deterministic, tested.
3. **All skipped → all used, and said.** `partition` returns `{ use, skipped, overridden: boolean }`; when
   every relay would be skipped, it uses all of them with `overridden: true`, and the composer adds
   "Every relay has been failing lately, so XMRadar tried them all." The relays still show their results.
4. **Writes serialized and tested.** `healthStore(item)` (pure factory, like `shotGate`) exposes
   `record(results)` and `partition(relays)`; `record` runs through one promise chain. Test: two
   concurrent `record` calls → both failures counted (fails 2, not 1).
5. **Response and retry, end to end.** `publish` returns `{ results, nevent, naddr?, skipped: string[],
   overridden: boolean, source }`. The relays stored for retry are `use` only, so a skipped relay can never
   be retried. `republish` records its results through the same store. `relayNotice(skipped, source,
   overridden)` (pure) builds the line.
6. **Source text is neutral when it can't be sure.** Relays come from one source per publish (manual,
   NIP-65 or fallback; mixing doesn't happen: an index relay in a manual list is dropped before, not
   skipped). The fix text follows that source: `nip65` → "remove them in your Nostr client's relay
   settings", `manual` → "remove them under Options → Posting → Relays", `fallback` → no fix text.
7. **Tests.** `settled` (all four cases), `autoCloses` via `settled`, `recordResults` incl. `at` and the
   cap, `partition` incl. `overridden`, the queue concurrency test, `relayNotice` for each source,
   singular/plural and override. The composer DOM itself isn't unit-tested here (no harness for it); the
   live check covers the pill closing with 2 ok + 1 dead relay.
