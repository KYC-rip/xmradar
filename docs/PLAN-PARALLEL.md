# Copy to Nostr: several copies at once (round 3)

## Why
Today a page has one composer (PLAN-MINIPILL's `composerSlot`): while a post publishes, a second Copy to Nostr
is refused ("Still publishing the last post"), and an open draft blocks a new one ("Finish or close this one
first"). The user wants to copy several posts in parallel: start one, minimise it, copy the next while the
first uploads, signs and publishes.

## What already allows it
- Background: each Copy opens its own session (`composerSessions` is a list; `checkSessionSender` by id).
- Signer bridge: installed once per page (`__s2nBridge`), every request has its own id; concurrent
  `getPublicKey`/`signEvent` calls are answered separately (the NIP-07 signer shows its prompts in turn).
- Uploads and relay publishes are per composer (no shared state besides `postedItem`).

## 1. Which post a copy is: `composerKey(target, msg, doc)` (`src/entrypoints/content/composer-key.ts`)
DOM-aware (reads the page), kept out of the pure dock module; tested with happy-dom. Known before the
composer mounts (the claim happens first). **The explicit request wins**, in this order:
1. **A selection** (`msg.selection` non-blank): `sel:` + page origin + path + the full SHA-256 hex of the trimmed text (Web Crypto `digest`) (the
   same words on another page, or a selection inside a tweet, are their own copy).
2. **An image copy** (`msg.srcUrl`): `img:` + the image URL without query and fragment.
3. **An X tweet**: the tweet's status id (`tweetFor(target)` → `ownStatusId`, the id the share menu and the
   extractor use) → `x:<id>`. Independent of x.com/twitter.com, query, tracking or trailing slash.
4. **Anything else**: `page:` + origin + path (query and fragment dropped).

## 2. `composerSlot` → `composerDock` (same file)
Each claim is a **keyed reservation**: `{ key, state: 'mounting' | 'open', instance? }`, oldest first.
- `claim(key)`:
  - a reservation with that key **mounting** → refuse (a double click before mount opens nothing twice);
  - an **open** one with that key: if **finished** (published, nothing to retry) → it closes and the new copy
    opens (a fresh draft; the "You already posted this" warning shows as today); otherwise (draft, busy,
    failed, relays to retry) → it is expanded (any other expanded one minimised first), "Already open",
    refuse;
  - other finished composers close to make room, oldest first;
  - **at most 5 reservations** (mounting ones count): at 5 with none finished → refuse, the newest pill
    says "Up to 5 at a time: finish or close one";
  - an expanded composer (draft or busy) is **minimised to its pill**, draft kept; then the reservation is
    added as `mounting` → open.
- `mounted(key, instance | null)`: the reservation becomes `open`, or is removed on a failed mount. Idempotent.
- `release(instance)`: removes its reservation; a late or repeated release changes nothing.
- At most one composer expanded: `expand()` through the dock minimises any other expanded one first.

## 3. Stacked pills
Each composer keeps its own shadow-root UI and pill. The dock lays the pills out: `instance.stack(i)` sets the
pill's offset from the bottom corner (`bottom: 16px + i × 52px`), oldest at the bottom; re-laid out whenever
one opens, closes or is released. The newest pill gets the notices.

## 4. Unchanged
Composer contents, publish steps, Retry/View/Copy/Open/×, drafts never lost, the background session per
copy, the signer bridge, duplicate warning ("You already posted this").

## Tests (`tests/publish-pill.test.ts`, the "one composer per page" block rewritten)
- `composerKey` (happy-dom): an X tweet on x.com and twitter.com, with `?s=20&t=…` and a trailing slash → one
  key; two tweets → two keys; a selection inside a tweet ≠ the tweet's key; an image inside a tweet ≠ the
  tweet's key; the same selection on two pages → two keys; image URL with and without query → one key.
- Same key finished → full lifecycle: published composer closes, a new one mounts with the same key.
- Selection key: `sel:<origin><path>:<64 hex>`; two selections differing in one character → two keys.
- Busy pill + new copy → opens; two busy pills → both kept, stacked 0 and 1.
- Expanded draft + new copy → the draft is minimised (not closed), the new one opens.
- Same key while mounting (double click) → refused; same key open as a draft/busy → expanded, "Already
  open", no new mount; same key finished → it closes, the new one opens.
- 6 claims in a row before any mounts → 5 reserved, the 6th refused; a failed mount frees its place.
- 5 open, none finished → refused with the notice; 5 open, one finished → it closes, new opens; finished
  ones close oldest first.
- `expand()` of one pill minimises the other expanded one.
- Closing the middle pill re-stacks the rest; a repeated release changes nothing.
- `openComposer` with the dock (happy-dom, composer mount stubbed): two copies of different tweets both mount
  and both pills exist; the same tweet twice mounts once.

## Live
X: copy post A (publish, minimise), copy post B while A uploads, copy post C; three pills stacked; each
finishes with its own View link; copying B again while it is still a draft or publishing expands B's pill; copying A again after it published closes A's pill and opens a fresh composer (with the "You already posted this" warning).

## Added by the user (approved to build after round 3)
- A pill whose copy is **published with nothing left to retry** closes by itself **10 s** later (not while the
  composer is expanded; a published one with failed relays keeps its pill and Retry). Test with fake timers.

## As built
- `composerDock` (publish-pill.ts) replaces `composerSlot`; `composerKey` (composer-key.ts, SHA-256 via Web
  Crypto); composer.ts claims by key, `mounted(key, …)`, `dock.focus` on expand, `minimise`/`stack` on the
  instance, pills stacked with a `--stack` CSS variable (52 px per pill, desktop and narrow layouts).
- Auto-close: `autoCloses(state)` (published, nothing retryable) arms a 10 s timer whenever the pill shows that
  state (after publish, after a retry, after minimising); cancelled when expanded or removed; closes only if
  still minimised and finished.
- Tests: dock rules (tests/publish-pill.test.ts, replaced block), composerKey with happy-dom documents and
  autoCloses (tests/composer-key.test.ts). 931 tests pass; both builds pass.
- Live: not run — exercising it means opening several real composers on X; publishing would post to the user's
  Nostr account, so it is left to the user (copy two posts, minimise, see two pills stacked).
- Code review 7.2 (pass) notes fixed: only pills take a stack place and the dock re-lays out on expand and
  minimise (`relayout`); keys for other sites use the post's own address from the site extractor (two
  Mastodon/Bluesky posts in one timeline are two copies) and a selection falls back to a local FNV hash where
  Web Crypto is missing (plain http); the auto-close timer is `autoCloser` (publish-pill.ts) with fake-timer
  tests. 936 tests pass.
