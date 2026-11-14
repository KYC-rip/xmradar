# PLAN-MONEROLIKE: Xo, a Monero like on X posts, sent over Nostr (round 2)

## Why
The user wants an X-style like that only Monero people can give, sent over Nostr, that the author's
XMRadar notices. Decisions (user, 2026-11-04): only **verified** likers count; counts show on the user's
**own posts only**; one fixed reaction, **ɱ ❤**; it needs **a cool animation**; it's called **Xo**
(X + O, as in xoxo; pairs with Xap). Casing: lowercase `xo` on the button, tooltip and counter ("Send an
xo", "❤ xo 3"); `Xo` only where a sentence starts or the feature is named; never `XO`.

## Facts
- NIP-25 kind 17 = reaction to external content, NIP-73 tags `["k","web"]`, `["i","https://x.com/i/status/<id>"]`;
  Xaps use the same `i` (`xPostId`, `POST_K` in src/xap/post.ts).
- Author's npub for an X post: the lookup Xap uses (`xapEntry(badge)`, src/identity/resolve.ts).
- Identity pieces in src/identity/nostr.ts: `newestPerPubkey`, `twitterClaims` (kind 10011 / kind 0 `i`),
  `fetchPayto` + `moneroPayto` (kind 10133), `verifyTwitterProof(handle, tweetId, pubkey)` (oEmbed /
  syndication). All handle-centric today.
- Xap inbox (src/xap/inbox.ts): 30-min alarm, receipt-shaped state (`InboxItem` has amount/target,
  one seen/notified ledger, 50 items). `myHandleItem` (settings) = the user's own X handle.

## Changes
1. **Event** `src/like/event.ts`: `likeEvent(statusId, author | null)` → kind 17, content `ɱ❤`, tags `k=web`,
   `i=https://x.com/i/status/<id>`, `p=<author>` when known. `likeOf(ev)`: exactly one X-status `i`, `k=web`,
   content `ɱ❤`, at most one `p`, created_at not > now+10 min; else null.
2. **Sending** (background `like` / `unlike` messages from the content script on a trusted click, X tab top
   frame, 1/s per tab; signed through the existing NIP-07 session flow):
   - Relays: the liker's post relays ∪ the author's NIP-65 **read** relays (kind 10002, newest, max 4,
     `safeRelay`-checked, cached 1 h) ∪ the 3 default index relays. The author's side reads its own read
     relays ∪ the defaults, so the defaults are the shared floor. README says delivery is best-effort.
   - `likedItem`: `Record<statusId, { id, at }>` (cap 2000) set only when ≥1 relay accepted.
   - Un-like: NIP-09 kind 5 (`e` = like id, `k` = 17) to the same relay set; the like is forgotten **only
     when ≥1 relay accepted the deletion**; otherwise the button stays liked and shows "Couldn't undo".
3. **Verified likers** `src/like/verify.ts` `verifyLiker(pubkey)` (pubkey-centric):
   query kinds 10011, 0, 10133 `authors=[pubkey]` on lookup relays; newest 10011 else kind 0; its X claims
   (`twitterClaims` with any handle); a valid Monero payto; then `verifyTwitterProof` for the first claim
   until one verifies. Result `{ ok, handle? }` cached 24 h per pubkey (`likerCacheItem`, cap 1000);
   at most 10 uncached likers checked per run, the rest next run. The proof fetch goes to X's oEmbed /
   syndication like badge proofs do (same privacy note).
4. **Like inbox** (own state, not the Xap ledger): `likeInboxItem` = { pubkey, sinceAt,
   likes: Record<statusId, Record<liker, eventId>> (cap 2000 statuses), notified: string[] (event ids,
   cap 5000), unread }. Runs in the same 30-min alarm right after the Xap check, under the same switch
   (renamed "Notifications from Monero people": Xaps and Monero likes). Per run: kind 17 `#p=[me]` since
   `sinceAt` (limit 200) → `likeOf` → only `p` = me → verify likers → kind 5 `authors=likers` `#e=ids`
   (validated: author = liker, kind 5, references the id) → update `likes` (one per liker per status;
   deletions remove). First run is a baseline (lists, doesn't notify), like the Xap inbox.
5. **Notification**: one per run, grouped: "@alice sent your post an Xo" / "@alice and 3 others sent your posts Xos";
   names = the verified X handle; menu list shows Monero likes next to Xaps.
6. **Counts on own posts**: background writes `likeCountsItem` = Record<statusId, number> from `likes`
   (all kept statuses, not just 50). The content script shows the count beside the button only on posts
   whose author handle = `myHandleItem`. Options text: counts need the notifications switch (they come
   from the same check). No per-post relay queries while scrolling.
7. **Button & animation** "Echo Bloom" (shadow root, CSS transform/opacity only):
   - Xo (600 ms): squash 0–120 ms `scale(1.15, 0.82)` `cubic-bezier(0.3, 0, 0.8, 0.15)`; bloom 120–600 ms
     `scale(1.26)` → `scale(1)` `cubic-bezier(0.34, 1.56, 0.64, 1)` while the fill turns Monero orange; a ghost
     outline 120–450 ms `scale(1)` → `scale(1.55)`, opacity 0.75 → 0; 6 dots (1.5 px) move 15 px outward and fade,
     `cubic-bezier(0, 0, 0.2, 1)`; the count rolls up one digit.
   - Un-Xo (250 ms): `scaleY(0.7)` → `scaleY(1)` `cubic-bezier(0.2, 0, 0, 1)`, fill back to outline; no dots.
   - New Xos on own posts (once, when scrolled into view): an outline echo ring `scale(1)` → `scale(1.4)`,
     opacity 0.6 → 0, 750 ms.
   - `prefers-reduced-motion`: no movement, a 120 ms opacity/colour change only.
8. **Options**: "Show the Xo button on X" (on).
9. **Tests**: event build/parse edge cases; relay set union and caps; liked set only on acceptance; un-like
   kept on failed deletion; verifyLiker (no 10133 / invalid address / no claim / proof fails / proof ok / cache
   / 10-per-run cap); inbox: baseline, `p` filter, dedupe per liker, deletion validation, separate from Xap
   ledger; grouped text; counts only on `myHandle` posts; reduced-motion class; rate limit.

## Round 2 review fixes (OpenCode 7.7)
- Author's read relays: new `readRelaysFrom(kind 10002)`: unmarked and `read` tags count, `write`-only don't
  (the existing helpers are write-side); the author's own inbox reads its read relays ∪ defaults the same way.
- No lost likes: likes whose liker isn't verified yet stay in `pending` (event + first seen, cap 500, dropped
  after 7 days) and are retried next run; the query looks back from `sinceAt − 2 days` like the Xap inbox, and
  `notified`/`seen` ids keep the overlap from counting twice.
- Own-post counts only when `myHandleItem.proven === true`.
- `likeOf` uses the strict `postOf` tag rules (exactly one `i`, exactly one `k`, no `e`) plus content `ɱ❤`.
- Tests for read markers, deferred likes across two runs, a late like inside the overlap, unproven handle,
  duplicate `k`.

## Build notes
- The xo button goes right after the Xap button, so only on posts whose author has a known key (the same
  `xapEntry`): every xo names its author in `p`, and the "Monero people" idea holds both ways.
- Playful to send, joyful to receive (user): sending = Echo Bloom with its dot burst; receiving = on the
  user's own post with new xos since last seen, once when it scrolls into view, 5 tiny orange hearts float up
  from the button and fade while the count pops; reduced motion = the count just changes.

## Out of scope
Counts on others' posts; other emoji; likes on Nostr notes (kind 7).
