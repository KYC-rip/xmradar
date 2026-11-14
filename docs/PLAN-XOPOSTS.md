# PLAN-XOPOSTS: xo counts everyone sees

User ask (2026-11-06): "should we allow everyone see the Xo count just like the 'likes'?" → yes, do both:
(A) a count beside the xo button on other people's posts, (B) the total on xmr.bio profile pages.

Today: a post's xo count shows only to its author (own posts, from the inbox). Others see the bare button.
xmr.bio already collects xos to listed handles and judges each sender (PLAN-XORINGS); the directory carries
a per-handle `xo_count`. This plan reuses those rows. Nothing ships before the XORINGS dry run is live.

## Principles
- Counts are from **verified senders only** (the XORINGS rule: `bio_xo_likers.ok = 1`, checked within 7 days,
  not the recipient's own linked key, not deleted). A raw relay count is free to inflate with throwaway keys.
- **No per-post requests.** The extension still downloads the whole directory hourly; xmr.bio never learns
  which posts anyone looks at. No new relay reads in the browser.
- Old clients (0.6.11–0.6.13) ignore the new field (the frozen-parser fixture checks it).

## Two numbers, stated plainly
- `xo_count` (per handle, existing): distinct posts per sender, at most 10 per sender, all time. Weighs fans.
- `xo_posts` (per post, new): distinct verified senders on that post. One sender counts once per post; no
  10-cap here (a cap limits a sender's weight in a total; on one post a sender is already one).
- So a profile's total is not the sum of its posts' counts. The labels say what each is.

## Privacy note
The new field publishes, in aggregate, which recent posts got xos from which senders (as key prefixes).
All of it is already public on Nostr relays (kind 17 with `i` and `p`/`X` tags); the directory only makes it
cheaper to read. Accepted: the point is a public count, like X's likes, which also show who liked.

## Server (kyc-rip-bio-register, branch off production after XORINGS goes live)

S1. `libs/bio/xoCount.ts`: one shared CTE `counted` = the XORINGS filter, so both numbers read the same rows:
```sql
WITH counted AS (
  SELECT x.recipient, x.status_id, x.sender, x.created_at
  FROM bio_xos x
  JOIN bio_xo_likers l ON l.pubkey = x.sender AND l.ok = 1 AND l.checked_at >= :okSince
  LEFT JOIN bio_xo_recipients r ON r.handle = x.recipient
  WHERE x.deleted = 0 AND (r.key IS NULL OR x.sender <> r.key)
)
```
  `xoCounts` is rewritten on it (same result; its existing tests must pass unchanged).
  `xoPosts(db, nowS)` → `Map<handle, Map<statusId, string[]>>`:
```sql
, posts AS (
  SELECT recipient, status_id, MAX(created_at) AS last
  FROM counted GROUP BY recipient, status_id HAVING MAX(created_at) >= :windowSince  -- 30 days
), ranked AS (
  SELECT *, ROW_NUMBER() OVER (PARTITION BY recipient ORDER BY last DESC, status_id DESC) AS rk FROM posts
)
SELECT DISTINCT c.recipient, c.status_id, c.sender, p.last
FROM counted c JOIN ranked p ON p.recipient = c.recipient AND p.status_id = c.status_id AND p.rk <= 50
ORDER BY p.last DESC, c.status_id DESC, c.sender
```
  In JS: per post, distinct **16-hex prefixes** (64 bits; collisions negligible, and grinding one only merges
  two entries, never adds one) of the senders, sorted, at most 200 (`POST_SENDER_CAP`; which 200 doesn't
  matter, the list length is what's shown). Global cap 20 000 prefixes per build: posts are taken in the query
  order (newest last-xo first, ties by status id) until the next one would pass it.
  Index: the existing `bio_xos_count (recipient, deleted, sender, status_id)` serves the filter; at today's
  scale (hundreds of rows) no new index. The build's time is logged; revisit past 1 s.
S2. `directory.ts`: each entry gets `xo_posts: { "<status id>": ["<16 hex>", ...] }` when non-empty. A list of
  exactly 200 reads "200+" (constant on both sides). Bytes logged as today.
S3. Public profile: `GET /v1/bio/profile/:handle` adds `xo_count` (> 0 only) read **from the stored directory
  in KV** (the last signed build, its entry for the handle), so it's the same number the extension shows.
  Injected at the route (`{ ...toPublicProfile(p), xo_count }`), not in `toPublicProfile`, which the
  verify/register/dashboard responses share and which stay unchanged. The parsed build is cached in module
  memory by `generated_at`, so a profile view doesn't re-parse it. No build / not listed / no count → absent.
S4. bio-ui `Profile.tsx`: when `xo_count > 0`, a line under the badges: `ɱ❤ 37 xos from Monero people`, title
  "Monero likes over Nostr from verified Monero people, counted by xmr.bio (up to 10 per person)". Theme tokens.
S5. Tests (bioXos.spec.ts style, node:sqlite D1):
  - `xoCounts` unchanged on the CTE (existing cases pass as they are);
  - xoPosts: one sender on 15 posts appears on all 15 lists (no 10-cap) while `xo_count` adds 10;
  - unverified / expired verdict / deleted / recipient's own key excluded; 30-day window by last xo;
  - 50-post cut with a tie on `last`; 200-sender cap; 20 000 global cap drops the oldest posts first;
  - directory entry carries `xo_posts`;
  - profile route returns the directory's number; absent with no build / unlisted; dashboard and verify
    responses have no `xo_count`.
  Shared vectors (`xo-vectors-v1.json`) gain an optional `directory_xo_posts` section; v stays 1.

## Client (XMRadar 0.6.14)

C1. `identity/directory.ts` `readDirectory`: parse `xo_posts` into `xoPosts?: Record<string, string[]>`.
  Status id `/^\d{1,20}$/`, prefix `/^[0-9a-f]{16}$/`, unique, ≤ 200 per post, ≤ 50 posts per entry; a bad
  post is dropped, never the entry. `resolve.ts`: `xoPostsOf(badge, statusId)` → string[] (xmr.bio source only,
  like `xoCountOf`).
C2. `x-xo.ts`:
  - `XoState` gains `myKey?: string` (16-hex prefix of the user's own pubkey, from the stored pubkey item and
    its watch) and `public: Record<string, string[]>` (per post, set by `place`, kept by `update`, so clicks,
    undo and other updates redraw from it). `XoOpts` gains `public?: string[]`.
  - Others' posts: `shown = |(public \ {me}) ∪ ({me} if sent)|`. The user's own xo follows the click at once
    (as X shows your own like at once, even if xmr.bio wouldn't count it); everyone else's is xmr.bio's. No
    key yet → `|public|`. `200+` when `public` without me has 200 entries.
  - Own posts: unchanged (the inbox count; local, and it can be higher than xmr.bio's since it includes
    senders xmr.bio hasn't judged).
  - Icon on others' posts fills only when the user sent one (filled = you did it).
  - Labels on others' posts, N = the count from others than the user:
    - N = 0: today's labels exactly (key known, and handle-only "hasn't set up XMRadar yet").
    - key known, N > 0: `N xos from Monero people (counted by xmr.bio). Click: xo · Hold: xo + like on X`;
      sent: `You and N Monero people sent xos. Click to take yours back.`
    - handle-only, N > 0: the same count sentence first (handle-addressed xos from verified senders are
      real), then today's "waits for @h to set up XMRadar" sentence.
C3. `x-badges.ts`: passes `rings ? xoPostsOf(badge, post) : []` into `xo.place`; a directory change already
  re-runs badge passes, which re-place and refresh `state.public`.
C4. Switch: the existing `xoRings` switch covers it; options text becomes "xo rings and counts from xmr.bio".
  Off → no ring, no badge total, no per-post xmr.bio count (own-post inbox counts unaffected).
C5. Tests: parser (good, bad id, bad/short prefix, dupes, caps; the frozen 0.6.12 reader and the current
  reader without the field read a directory with `xo_posts` unchanged); count math table (sent/unsent × me
  listed/not × key/no key × cap 200); `public` kept across `update` and through send/undo; label variants
  (key, handle-only, own, zero); switch off. CHANGELOG 0.6.14, README line.

## Out of scope
- Counts on posts by accounts not listed on xmr.bio (no verified collection for them).
- Showing who sent them.

## Rollout
1. After the XORINGS dry run is switched live (wake) and its counts look right.
2. Server: no migration. Deploy API, then bio-ui (`--branch production`).
3. Client 0.6.14 release. Each step needs the user's OK (commit/deploy/release).

## Revisions
- R1 (review round 1, 6.8): per-post vs total numbers defined (no 10-cap per post, stated); profile count
  from the signed build in KV, not a live query; 16-hex prefixes; `public` kept in manager state; concrete
  SQL with tie-breaks; all label variants; route-level injection; privacy note; tests for each.
- R2 (review round 2, 7.6 pass): the per-post prefixes live in a WeakMap keyed by the button wrap (gone with
  the node), not a growing state map; `200+` whenever the server list has 200 entries, whatever the local
  add/remove; profile count is the same field and source as the extension's (within its hourly refresh);
  profile route reads KV metadata first and the body only when `generated_at` changed; the global cap groups
  rows per post and has a combined-cap test; `BadgeEntry.xoPosts` + `directoryIndex` copy named; client status
  id regex `/^[1-9]\d{0,19}$/`; profile title "up to 10 posts per person"; `pubkeyItem` wired into x-badges.

## As built (2026-11-06)
- Code review round 1: 7.2 (pass). Fixed anyway: the user's lone xo showed no count; `+1` without a known key;
  the global-cap test never hit the cap (now 3 handles × 50 posts); unlisted handles' rows took cap room (now
  listed only); KV error serves held totals, a missing build is cached for the minute; list compare without
  join. Not changed: the click closure's `own` from insert time (pre-existing; `update` redraws right after).
- Server: branch `bio-xo-posts` (kyc-rip-bio-register), uncommitted. Client: syncToNostr main, uncommitted,
  version 0.6.14.
