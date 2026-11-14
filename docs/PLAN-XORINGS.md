# PLAN-XORINGS: xo totals in xmr.bio's directory, and an xo ring on avatars

## Goal

On X, a badge holder who has received xos from Monero people gets:
- a thin Monero-orange ring around their avatar;
- the total in XMRadar's own name badge (`ɱ❤ 37`).

The ring says "Monero people sent this person xos". It is not a trust score: no levels, no tier colors.

## Why the server counts

Each browser can only count xos for its own posts (the xo inbox). Counting everyone's on a timeline would take hundreds of relay reads and proof-tweet fetches per page, from every user's browser.

xmr.bio's API already builds a signed directory of badge holders every 10 minutes, and every XMRadar downloads it. So the API counts xos once, and the count travels in the directory as one more signed, optional field. Anyone can recount from the public xo events.

---

## S. Server: kyc-rip API (worktree `kyc-rip-bio-register`, branch from `production`)

### S1. Storage (migration `76.bio-xos.sql`)

```sql
CREATE TABLE IF NOT EXISTS bio_xos (
  id TEXT PRIMARY KEY,            -- xo event id
  recipient TEXT NOT NULL,        -- listed handle, lowercase
  status_id TEXT NOT NULL,
  sender TEXT NOT NULL,           -- hex pubkey
  created_at INTEGER NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS bio_xos_recipient ON bio_xos (recipient);
CREATE INDEX IF NOT EXISTS bio_xos_sender ON bio_xos (sender);
CREATE TABLE IF NOT EXISTS bio_xo_likers (
  pubkey TEXT PRIMARY KEY,
  ok INTEGER NOT NULL,            -- 1: a Monero person
  handle TEXT,                    -- their verified X handle
  checked_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS bio_xo_cursor (id INTEGER PRIMARY KEY CHECK (id = 1), since INTEGER NOT NULL);
```

### S2. Collecting (`libs/bio/xos.ts`, run by the `*/10` cron before the directory build, under the same lease)

**Recipients:** the listed handles, plus their linked Nostr keys (`nostr_pubkey`), from the same query the directory build uses.

**Read:**
- Relays: XMRadar's defaults (damus, nos.lol, primal), through nostr-tools `SimplePool`, as `nkip01Nostr.ts` does.
- Filters:
  - kind 17 with `#X` = `twitter:<handle>`, in chunks of 50 handles;
  - kind 17 with `#p` = the linked keys, in chunks of 50.
- `since` = the cursor minus 2 days of overlap. The first run uses 365 days.
- Limit 500 per filter, 8 s per relay.
- The cursor advances only when at least one relay answered.

**Parse:** a port of XMRadar's `xoOf`, run against shared test vectors:
- kind 17, content `ɱ❤`;
- the strict one-`i`/one-`k` post rule;
- at most one `p` and at most one `X`, at least one of the two;
- not from the future;
- the signature verified (`verifyEvent`).

**Attribution** (who an xo is for):
- **`X` present:** its handle, if listed. If there is also a `p`, it must be that handle's linked key or the handle must have none; a `p` naming another listed handle's key drops the xo.
- **`p` only** (0.6.11/0.6.12 senders): the listed handle whose linked key it is, else dropped.
- **Own xos dropped:** the sender is the recipient's linked key.

**Deletions:**
- kind 5 by the stored xos' senders, `#e` = their ids, read each run for ids from the last 30 days, in chunks.
- A deletion signed by the xo's own sender sets `deleted = 1`.

### S3. Who counts: Monero people

Same rule as XMRadar's `verifyLiker`:
- the sender's newest kind 10133 has a valid Monero mainnet address. Checked with the server's address check: format, plus the checksum if `siwr.ts`'s Monero code exposes one, else format only (noted);
- their kind 10011 (else kind 0) claims an X handle;
- that proof tweet carries their npub, checked with `xproof.ts`'s tweet text: oEmbed, else syndication.

Verdicts are kept in `bio_xo_likers`:
- `ok` for 7 days;
- not `ok` for 1 day;
- an X error is not a verdict.

At most 20 new senders are checked per run (X rate limits). The rest wait for the next run, and their xos are stored, uncounted until then.

### S4. Count and publish

`xo_count` per listed handle is the number of distinct (sender, status_id) pairs where:
- `deleted = 0`;
- the sender is `ok`;
- the sender is not the recipient's own key.

`DirectoryEntry` gains `xo_count?: number`, present only when > 0. It's additive, like `nostr_pubkey`: older readers ignore it. It is signed with the rest of the envelope. The size warning stays.

**Cost bound:** one more SELECT with GROUP BY per build. Relay reads and at most 20 X fetches per 10 minutes.

### S5. Tests (vitest, API)

- The parse vectors are shared with XMRadar: the same JSON fixture is copied into both repos, and a test checks the copies are equal by hash.
- Attribution:
  - X only;
  - p only via the linked key;
  - X with a mismatched p dropped;
  - own xo dropped.
- Deletions only by the sender.
- Verdict cache: TTLs; an X error is not cached; the cap of 20.
- Count: distinct per sender and post; not-ok senders not counted.
- The cursor doesn't advance when no relay answered.
- The directory entry carries `xo_count` only when > 0.

---

## C. Client: XMRadar

### C1. Directory

- `parseDirectory` accepts `xo_count`: an integer from 1 to 10^7. Any other value is ignored, not fatal to the entry.
- `DirectoryEntry.xoCount?`.
- The badge merge carries it as `Badge.xoCount` from the xmr.bio source only. A Nostr-only badge has no count.

### C2. The ring

**Which avatars:**
- on X posts, and on the profile header avatar;
- for authors whose badge has `xoCount > 0`.

**Where:** X's avatar container (`[data-testid="Tweet-User-Avatar"]` on posts, the profile photo link on profiles) gets one absolutely positioned element:
- a 2px Monero-orange (`#f26822`) ring, 2px outside the photo, `pointer-events: none`;
- `border-radius: 50%`, or the avatar's own computed radius for square (organization) avatars;
- keyed like the badge slots, so X's recycled nodes are redrawn.

**Ethos and other extensions:**
- No pill under the avatar: that's where Ethos draws its own.
- The ring sits outside the photo's edge and doesn't replace anything there.

**Accessibility:**
- The ring is decorative (`aria-hidden`).
- The count is in the badge's text and label.

### C3. The count

- XMRadar's name badge shows `ɱ❤ 37` after the badge's own content, when `xoCount > 0`.
- The badge's tooltip and label: "37 xos from Monero people (counted by xmr.bio)".
- Your own badge: the directory's count, up to ~10 min behind your inbox.

### C4. Switch

- Options → Badges on X → *xo rings and counts* (default on).
- Off removes rings and counts live, like the other badge switches.

### C5. Tests

- `parseDirectory` with good and bad `xo_count`.
- The badge merge keeps `xoCount` from xmr.bio only.
- Ring insertion:
  - only with a count;
  - one per avatar;
  - removed when the switch goes off;
  - redrawn on a recycled node;
  - square radius copied.
- The badge text and label with a count.

### C6. Budgets

The content script is at 245.5 of 250 KB. The ring and count code must fit (estimate ~1.5 KB); measure before and after.

## Docs

- CHANGELOG (Unreleased).
- README badges section.
- The site's xo paragraph.
- xmr.bio's directory doc: the field, and how it's counted.

## Rollout

The server ships first: the directory gains `xo_count`, which older XMRadar ignores. Then XMRadar.

Both need the user's go: the production API deploy (D1 migration included) and the XMRadar release. Nothing is deployed or committed in this run.

## Order

1. Shared parse vectors.
2. Server S1–S4 with tests.
3. Client C1–C4 with tests.
4. Docs.
5. Code review.

---

## Revision 1 (after OpenCode plan review, 6.2). These rules replace the sections above where they differ.

### R1. Collection runs on its own, never inside the directory lease

- `collectXos` is a separate step of the `*/10` tick, in its own `ctx.waitUntil` and its own try/catch.
- It has its own one-row lease, `bio_xo_lease`, shaped like `bio_directory_lease` (migration 76):
  - lease 4 min;
  - hard overall deadline 90 s (one `AbortSignal.timeout(90_000)` passed to every relay read and X fetch);
  - whatever is unfinished at the deadline waits for the next tick.
- `refreshDirectory` is unchanged: its 2-min lease covers only SELECT + sign + KV. It reads the stored counts (one GROUP BY), whatever state collection is in.
- A collection failure never blocks or aborts the directory build. It is logged, and the next tick retries.
- X checks:
  - bounded concurrency of 5;
  - per sender, 15 s total, covering up to 3 claims, stopping at the first verified one.

### R2. Cursors that never skip events

**Recipients.** `bio_xo_recipients(handle PK, caught_up INTEGER)`:
- A handle newly listed (or a newly linked key) starts not caught up.
- It gets its own backfill read: 365 days, at most 10 handles per tick.
- It is marked caught up only when every one of its filters was fully read.

**Caught-up handles** share one cursor:
- Each run reads the window [cursor − 2 d, now].
- The cursor moves to `now` only if every chunk filter was fully read. Otherwise it stays, and the next run reads the same window again; ids deduplicate.

**"Fully read"** means:
- at least one relay answered that filter;
- and no answer hit the limit. A full page is paginated with `until` = the oldest `created_at` seen, up to 5 pages. Still full after 5: not fully read.

**Tests:**
- a mid-run failure of one chunk doesn't move the cursor;
- a limit-full chunk paginates;
- a new handle backfills, then joins the shared cursor.

### R3. Only definite verdicts are cached

- `bio_xo_likers` stores ok=1, or ok=0, only from a complete answer:
  - relays answered with the sender's events;
  - and every claimed proof was checked to a result.
- Not cached, and asked again next tick:
  - no relay answered;
  - relays answered but had nothing for the key (could be a relay gap);
  - any proof check that ended in an X or network error.
- Tests for all three.

### R4. Address rule parity with XMRadar

- The server ports `validateMoneroAddress` semantics into `libs/bio/xmrAddress.ts`:
  - mainnet standard (18), subaddress (42) and integrated (19);
  - keccak checksum, with `@noble/hashes`, as `siwr.ts` already uses.
- `isSigninAddress` is not used: it refuses integrated addresses.
- The shared vectors include:
  - a valid integrated address;
  - a bad-checksum address;
  - a testnet address.

### R5. Abuse and inflation: the threat model, and a cap

**What `xo_count` means:** xos from Monero people.
- Each is a distinct (sender key, post).
- A sender counts toward a recipient for at most 10 posts, so one key can add at most 10.
- Each further key needs its own Monero address and its own proof tweet on a separate X account.

**Two things are not checked, and are documented as such:**
- An xo addressed by handle is not authenticated by the recipient.
- Its `status_id` isn't checked to be the recipient's post: that would need one X fetch per xo.

So a verified Monero person can add up to 10 to anyone's count. That's acceptable for a "likes" figure that claims no trust. The badge label says "xos from Monero people", and the directory doc explains the cap.

Per tick, at most 2000 new xo rows are stored. Any beyond wait, because the cursor doesn't move.

### R6. Retention

- Rows with `deleted = 1` are removed 30 days after `created_at`. A re-read inside the 2-day overlap could re-add one, but its deletion is read in the same window.
- Rows of handles no longer listed are removed at the next build.
- Index `bio_xos (recipient, deleted, sender, status_id)` serves the count.
- Expected size: at today's scale (tens of listed handles), well under 100k rows. The run log prints the row total.

### R7. Deletions, by sender, not by age

Kind 5, read with:
- `authors` = the senders of stored live xos, in chunks of 50;
- the same window and cursor rules as R2.

A deletion's `e` tags are matched to stored ids of the same sender. So an old xo deleted later is still applied.

### R8. Case

- `X` values are lowercased before validation and matching, on the server and in XMRadar (already done there in the XOREACH round-1 fix).
- The shared vectors include `twitter:Alice`.

### R9. Shared vectors

- One file, `xo-vectors-v1.json`: events plus the expected `xoOf` result, attribution and countability.
- Each repo's tests run the vectors through its own code: a behavior check, not a byte-copy check.
- A `version` field is bumped on any change. Each repo asserts the version it was written for, so a stale copy fails loudly.

### R10. Relay reads in the Worker: step 0

Before any other server code:
- Run `SimplePool.querySync` (or `subscribeMany` with `oneose`) against the three default relays under `wrangler dev`, on the API's `compatibility_date` with `nodejs_compat`.
- Record the time per query.
- If SimplePool misbehaves in the Worker, use a small raw-WebSocket REQ/EOSE reader, about 40 lines.

Subrequest count per tick:
- ≤ 3 relays × (chunks + pages + deletion chunks), as WebSockets;
- plus ≤ 5 × 2 concurrent X HTTP fetches, at most 40 per tick.

This is within the paid plan's limits. The run log prints the totals.

### R11. Dry run and metrics

- Env `BIO_XO_DRYRUN=1`: collect, verify and log the counts, but write neither `xo_count` nor rows. The first production deploy runs dry for a day.
- Each run logs:
  - handles, chunks and pages;
  - relays answered;
  - new rows;
  - senders verified, skipped and errored;
  - deadline hit or not;
  - the lease outcome.

### R12. Client: ring placement that isn't clipped

**Selectors:**
- `div[data-testid^="UserAvatar-Container-"]`, which X uses for both post and profile-header avatars and which carries the handle.
- Fallback: `[data-testid="Tweet-User-Avatar"]` on posts.

**Clipping:** the ring is placed on the nearest ancestor, up to 4 levels, whose computed `overflow` is visible. It is positioned to the avatar's box, plus 2 px. If none is found within 4 levels, no ring.

**Stacking:** `z-index: 1`; `pointer-events: none`; `aria-hidden`. The avatar itself is never restyled.

**Tests:** jsdom fixtures for post and profile markup, including a clipping ancestor, plus the recycled-node redraw.

### R13. Names, budgets, wording

- C1's parser is `readDirectory` (src/identity/directory.ts), not `parseDirectory`.
- Tests: an older-reader fixture (0.6.12's `readDirectory` logic) ignores `xo_count`. A malformed `xo_count` (0, negative, float, string, > 10^7) drops the field, not the entry.
- Content budget: measured before and after. If over 250 KB, raise it to 256 KB in the same commit with the reason, as PLAN-XOREACH did for the background.
- The badge label adds "counted by xmr.bio, every 10 minutes".
- Migration number: 76, next after `75.order-answers-tip-stats.sql`.

---

## Revision 2 (after round 2, 7.4 pass). These rules replace R1, R2 and R3 where they differ.

### V1. Per-handle progress, no shared cursor

`bio_xo_recipients`:
```
handle PK,
since INTEGER,       -- complete up to here
gap_until INTEGER,   -- null, or: a pass is under way and everything newer than this was read
pass_top INTEGER     -- when the pass under way started
```

**New handle:** `since` = now − 365 d.

**Each tick:**
- Handles are taken stalest first (`gap_until` not null first, then oldest `since`).
- Handles are read one at a time: kind 17, `#X` = the handle, with `#p` = its key when linked. Two filters in one REQ.
- `until` = `gap_until` ?? now. The read pages back (limit 500, `until` = the oldest seen) until it reaches `since` − 2 d.
- **Reached `since` − 2 d:** `since` = `pass_top` ?? the read's start time; `gap_until` = null; `pass_top` = null.
- **Stopped by the deadline, the row cap or 5 pages:** `gap_until` = the oldest seen; `pass_top` = `pass_top` ?? the start time.
- A page that doesn't move `until` (more than 500 events in one second) also stops the pass, with `gap_until` set 1 s lower. That loss is accepted and noted.

Progress therefore always moves forward: nothing is re-read without end, and nothing is skipped. The 2000-row cap ends the tick's handle loop.

### V2. Undecided senders don't starve new ones

**`bio_xo_seen(pubkey PK, attempts, last_at)`.** A sender whose check didn't reach a definite verdict:
- is retried no sooner than 1 h later;
- then 6 h after the third attempt.

The 20-per-tick budget is spent on senders due for a check, oldest-seen first.

**Definite not-ok:** at least 2 relays sent EOSE and none had any kind 10133, 0 or 10011 for the key. Cached ok=0 for 1 day.

**Not definite:**
- fewer than 2 relays answered;
- a relay answered with only some kinds;
- any proof check ended in an X or network error.

A metric counts the senders still waiting.

### V3. Relay reads with a real deadline

- A ~60-line raw-WebSocket reader: REQ, collect events, EOSE or the timeout, then CLOSE. Each relay gets `min(8 s, time left before the deadline)`.
- It honours the deadline directly; SimplePool's params have no `signal`.
- Step 0 runs this reader against the three default relays (from Node, which has the same WebSocket API, and in tests with a fake socket). It records the timings.
- X fetches keep their own `AbortSignal`s.

### V4. One `waitUntil`, in order, lease released

- In the `*/10` tick: `collectXos` (its lease, the 90 s deadline), then `refreshDirectory`, one after the other inside the same `waitUntil`. The directory is then at most one tick (~10 min) behind.
- `bio_xo_lease` is released in `finally`.

**Deletions:**
- Each tick reads kind 5 for up to 100 senders, from rows within retention.
- They are taken in rotation: `bio_xo_cursor` stores the last sender reached.
- The window is `since` = 32 days back (retention + overlap).

### V5. Threat model, corrected

The cost of one more counted key is:
- a kind 10133 with any valid Monero address (the same address can be reused);
- plus a proof tweet naming its npub (one X account can post several).

The 10-posts-per-sender-per-recipient cap bounds each key's effect; it doesn't make keys expensive. So `xo_count` is a soft, public signal, not proof of distinct people. The directory doc says so.

Address uniqueness across keys is a possible later hardening, not in this plan.

### V6. Ring placement

**Scope:**
- avatars inside `[data-testid="primaryColumn"]` only, so not the nav, the sidebar or hover cards;
- posts: `[data-testid="Tweet-User-Avatar"]`;
- profile header: the `UserAvatar-Container-<handle>` within the profile header's photo link.

**Positioning:**
- The ring is a child of the nearest ancestor (up to 4 levels) whose `overflow` is visible.
- If that ancestor is `position: static`, it gets `position: relative`, as the xo heart's charge ring already does.
- The ring's offsets are computed from the two elements' rects at insert time and redrawn on the existing badge pass. It doesn't follow scroll on its own; both elements scroll together.

**Tests:** in jsdom, with mocked rects:
- the ring's rect sits 2 px outside the avatar's;
- nav avatars aren't ringed.

## As built

- **Step 0:** the raw-WebSocket reader read all three default relays to EOSE in 1.2–1.8 s per query, from Node. SimplePool isn't used.
- **Server:** `api/src/libs/bio/relayRead.ts`, `xmrAddress.ts` and `xos.ts`; `directory.ts` gains `xo_count`; `index.ts` runs collection and then the build in one `waitUntil`; migration 76.
  - Tests: `bioXos.spec.ts`, 20 tests on node:sqlite with fake relays and a fake X.
  - The full API suite has 9 failures, all live smoke tests (exchange and SMS APIs, no keys here) and one engine-config KV assertion, unrelated to bio.
- **Shared vectors:** `xo-vectors-v1.json`, the same file in both repos. Each repo runs it through its own code.
- **Client:**
  - `x-xo-ring.ts`;
  - the badge count in `badge-look.ts`;
  - `xoCount` in `directory.ts`/`resolve.ts`;
  - the switch `xoRings`, wired in `x-badges.ts` (a new directory redraws counts and rings, as it already redraws badges);
  - tests: `tests/xo-rings.test.ts`, 13 tests.
- **Ring cost:** existing rings are found without reading styles; styles are read only to draw a new one.
- **Budgets:**
  - `content.js` went from 245.5 to 248.0 KB, within 250 KB;
  - `background.js` is 951.4 KB.
- **Not done:**
  - no live look at a ring on X: the production directory has no `xo_count` until the API is deployed;
  - no deploy, no commit.
- **Code review round 1 (OpenCode, 7.0 pass): all eleven findings fixed.**
  - **Deletions** are bounded per tick: at most 500 events and 1000 updates, a filter `limit`, and a deadline check.
  - **A key linked later:** `bio_xo_recipients.key` restarts that handle's year-long backfill.
  - **The count**
    - excludes the recipient's own current key;
    - enforces the 7-day ok TTL;
    - moved to `xoCount.ts`, which removes the import cycle with `directory.ts`.
  - **Dry run** checks senders in memory and logs `dryCounts`.
  - **Page fullness** is judged per filter (`#X` vs `#p`).
  - **Rings**
    - are re-placed on every badge pass;
    - are owned by their avatar (a WeakMap), so another avatar never takes one;
    - put back `position` on the host when they go.
  - **The round badge** keeps the total in its label only.
- **Live check on x.com (own tab, nothing posted):**
  - X's profile avatar is `UserAvatar-Container-<handle>` beside the /photo link, not inside it; `profileAvatar` was fixed to match.
  - The ring's placement logic, run in the page, drew correctly around the profile header avatar and a post avatar. Screenshots are taken; the test rings were removed with the tab.
- **Tests:**
  - API `bioXos` + `bioDirectory`: 46 pass;
  - XMRadar: 1448 pass;
  - `content.js` 248.5 KB.
