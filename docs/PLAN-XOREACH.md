# PLAN-XOREACH: get people set up, and let xo reach anyone

## Problem

xo only works between Monero people: a key with a Monero address (kind 10133) and an X account linked by a proof tweet (kind 10011). Today:

- The XMRadar identity (PLAN-MANAGEDID) is made only when something needs a signature, typically the first xo click.
  That xo doesn't count for its receiver, because the sender has no address or proof yet.
- An author with no known key gets a faded heart that can only like on X. Almost nobody has a key, so almost every heart is faded.
- Nothing asks a new user to set up; the four steps live in Options → Monero identity, which few open.

Result: an XMRadar user can xo nearly no one, and nearly no one can xo them.

## Goals

- **A. Setup card.** A new user goes from install to a working Monero identity (key, address, proof tweet, xmr.bio listing) in about a minute, prompted on X.
- **B. xo anyone.** The heart works on every X post. An xo to an author without a key waits on relays, addressed to their X handle. When they later set up, XMRadar finds those xos, counts them, and tells them once: "7 Monero people sent your posts xos."

## Non-goals

- No change to who counts: still only verified Monero people, one per person per post.
- No server-side storage. xmr.bio's directory and API are unchanged.
- No key custody change: the XMRadar identity stays background-only, in IndexedDB (PLAN-MANAGEDID).

---

## A. Setup card and setup page

### A1. Security shape: the card only launches

`setup-prepare`, `setup-sign`, `setup-retry` and `setup-cancel` accept extension pages only (`isExtensionPage`). That stays.

- The X card is a prompt with one button. The button asks the background to open the new extension page `setup.html` in a tab.
- All key, address and signing work happens on `setup.html`, through the same background handlers Options uses.
- Nothing on x.com gains the power to sign.

New message `open-setup`:
- Only from an x.com content script, top frame (`checkShareMenuSender`), after a trusted click.
- It may carry `handleHint`: the logged-in handle read from X's side nav (`a[data-testid="AppTabBar_Profile_Link"]` href).
- The hint is only a pre-fill. `setup.html` shows it in an editable field and the user confirms it.

### A2. When the card shows

All of these must hold:
- on x.com, top frame;
- the xo button switch is on;
- setup isn't complete for the current key: no key, no status check yet for this key (`statusFor` null counts as incomplete; the card then asks the background for one `setup-status` check, cached as today), or the check shows the address or link step not done;
- not dismissed.

Placement:
- A small card in a closed shadow root, bottom-left, above X's own UI.
- At most once per page load, starting 5 s after load.
- Clicks are honoured only when `isTrusted`.

Copy:
> **Get xos on X**
> Set up your Monero identity, about a minute: XMRadar makes your Nostr key, you add your Monero address and post one tweet. Then Monero people can xo your posts, and your xos count.
> [Set up] [Not now] [×]

Dismissal:
- "Not now" hides the card for 7 days.
- × hides it for good (`setupCardItem: { snoozedUntil?: number; dismissed?: boolean }`).
- Options → Monero identity always keeps the full steps. The popup gets a "Set up" link while setup is incomplete.

xo nudge:
- When a user who isn't set up sends an xo, the heart's tooltip and a one-time toast say: "Sent. It counts once you're set up: [Set up]".
- The toast shows once per browser (`setupCardItem.nudged`).

### A3. setup.html: three steps, one screen

This is a focused wizard, not a copy of Options. Each step shows done or next; the next step opens.

1. **Your Nostr key.**
   - If a signer key is already known (`pubkeyItem`), show it with Change → Options.
   - Else a [Make my key] button: the existing `get-pubkey` path in `auto` mode tries the NIP-07 signer first, and with none at all falls back to the XMRadar identity.
   - Shows the npub.

2. **Your Monero address.**
   - Field with local validation (`validateMoneroAddress`, mainnet).
   - Handle field, pre-filled from `handleHint` or `myHandleItem`. [Publish] first saves it to `myHandleItem` exactly as Options' Save does (a different handle resets `proven`), so step 3's `link-x` finds it.
   - [Publish] runs `setup-prepare`.
   - If `before` is null (no list yet, the usual case), it signs directly after the button press; the button text "Publish" is the consent.
   - If the user already has a kind-10133 list with other tags, show the same tag diff and "this is my key" check as Options, reusing the rendering code (moved from `options/identity.ts` into `src/ui/setup-review.ts`).

3. **Your proof tweet.**
   - [Post the tweet] opens `x.com/intent/post` with `proofTweetText(npub)`, as Options does.
   - Then the step waits for the tweet's link:
     - **auto (A4):** the X content script spots the user's own new tweet with this npub and reports it;
     - **or paste:** the link field, as in Options.
   - [Link] runs `setup-prepare` for `link-x`, then `setup-sign`. The proof check is the background's own `verifyTwitterProof`, as today.
   - Same rule as step 2: sign directly when `before` is null, show the diff otherwise.

Done state:
> You're set up. Monero people can xo your posts.

- xmr.bio listing runs as today (PLAN-XMRBIOLIST, default on, with its checkbox shown here).
- [Back to X]

### A4. Spotting the proof tweet

- The X content script already sees tweets. Each `article` whose author is the user's handle (`myHandleItem`, or the pending setup hint) and whose text contains the current npub as a whole word sends `proof-tweet-seen { statusId }` once.
- The background keeps it in session storage (`proofCandidateItem`, 30 min) for `setup.html` to fill in. It is only a suggestion: the link step still verifies the tweet through X, so a page faking the DOM can't link anything that X doesn't actually show.

### A5. Bundle

`background.js` is at 948.36 of 950 KB. The wizard UI goes in `setup.html`'s own bundle. The background gains only three things:
- `open-setup`;
- `proof-tweet-seen`;
- the xo inbox handle filter from B.

If that still doesn't fit, raise the budget to 960 KB in the same commit and say why. The content script grows too (the card, the spotter): measure it before and after and state both in the commit; the card's DOM is built only when it's shown.

---

## B. xo anyone

### B1. Event: an xo names the author's handle too

The xo is still a kind 17 with content `ɱ❤`, `k` = `web` and `i` = `https://x.com/i/status/<id>`, as now. New tag:

```
["X", "twitter:<handle, lowercased>"]
```

- `p` is present when the author's key is known (as now) and absent when it isn't.
- Every new xo carries `X`, keyed or not. If the author sets up a key later, xos sent before then still reach them by handle.
- Exactly one `X` tag, and the handle must pass `HANDLE_RE`.

Why `X`:
- Relays index single-letter tags only, so the receiver can query `#X`.
- A second `i` would break `postOf` (exactly one `i`), which Xap and 0.6.11/0.6.12 clients rely on.
- Lowercase letters clash elsewhere: `h` is NIP-29 groups (some relays reject unknown groups), `x` is NIP-94/Blossom hashes, and `t` is a hashtag.
- Uppercase `X` has no NIP meaning.
- Value form `twitter:<handle>` matches NIP-39's `i` tags in kind 10011.

**Step 0, before any code:**
- Publish a test kind 17 with an `X` tag to each default relay, query it back with `#X`, then delete it.
- Any default relay that doesn't index it: record it here.
- If more than one doesn't, fall back to `["t", "xo-twitter-<handle>"]` and note why.

**Compatibility:**
- 0.6.11/0.6.12 receivers ignore `X`, and keep counting keyed xos by `p`.
- Handle-only xos (no `p`) are dropped by old receivers' `xoOf` (it requires exactly one `p`). That is fine: they can't be counted for anyone without a key anyway.
- NKIP note: add the `X` tag to the xo section of NKIP-0002's amendment draft in this repo's docs. Nothing is published to nkips.org without the user.

### B2. Parsing

`xoOf(ev)` → `{ statusId, author: string | null, handle: string | null } | null`:
- at most one `p` (64-hex) and at most one `X` (`twitter:` + `HANDLE_RE`, compared lowercased);
- at least one of the two;
- otherwise the same rules (content, kind, the strict `postOf`, not from the future).

`xoTemplate(statusId, author | null, handle, now)`.

### B3. Sending

**x-xo.ts:** the heart is never faded for lack of a key.
- With no key, the tooltip reads: "@h hasn't set up XMRadar yet. Your xo waits for them, and counts once they do. Click: xo · Hold: xo + like on X".
- The faded, like-only state is removed.

**Background `xo-send`:**
- `author` becomes optional.
- `handle` is required: `HANDLE_RE`, from the slot's handle, which the content script already has.
- The xo still requires a known statusId.
- Relays: with a key, as now (`xoRelayOrder`). Without one: `xoRelayOrder([], defaults, mine)`. The defaults are the floor both sides read.
- `xoSent` and undo are unchanged: they are per post, and the undo is a kind 5 `e` to the xo id.

### B4. Receiving

`xoKeeper.run`:
- Reads `#p: [pubkey]` as now.
- When `myHandleItem` is proven for this key, it also reads `#X: ["twitter:<handle>"]`, with `since` = the same `xoSince`, except on the first run (baseline).
- Union by id.

`candidates`:
- Accepts an xo when its `author === pubkey`, or (`author` absent and `handle` === my proven handle).
- An xo with a `p` naming another key is never taken by handle: the sender knew the author's key and it isn't this one.

**First run with a handle** (`handleSinceAt` null): the `#X` read looks back `HANDLE_BASELINE_SECS` = 180 days, limit 500, and from it only X-only xos (no `p`) are taken; xos with a `p` keep the normal `#p` window. `handleSinceAt` is tracked apart from `sinceAt`.

The baseline still sends no per-xo notifications, with one exception:
- If the baseline counts handle-only xos (`author` absent), one notification goes out: "N Monero people sent your posts xos before you set up XMRadar".
- N is distinct senders; the X post links are in the inbox list as usual.
- Stored in a new `XoItem.early: true`.

A handle change (Options), or `proven` becoming false, restarts the inbox, as a key change does now.

**State change:** `XoInbox` gains `handle: string | null`. Migration: a held 0.6.12 inbox has no `handle`; it is backfilled from the current proven handle (or null) and keeps its likes, items and counts. Only a real change (a different handle, or `proven` turning false) starts fresh. Its first `#X` read is then a handle baseline (below).

### B5. Abuse and limits

- **Fake senders.** Anyone can publish `#X` xos. Only Monero people count (`verifyLiker`, unchanged), one per person per post. Unverified senders cost a check, capped by `VERIFY_PER_RUN` = 10 and `MAX_PENDING` = 500 with 7 days.
- **Floods.** A flood could delay real xos by filling `pending`. Mitigation: senders with a cached verdict skip the queue (as now), and `pending` keeps the 500 newest. Accepted; noted.
- **Wrong attribution.** A Monero person could name another handle's post. The post id is still the post; the receiver only shows counts on posts the DOM shows as theirs, and a notification links the post. Cost: one possibly odd notification, from a verified Monero person, who can be identified. Accepted.
- **Impersonation of the receiver.** Someone could claim another person's handle with their own key. Handle-addressed xos are counted only after `myHandleItem.proven`, and the proof tweet must verify. The xos themselves are public relay data in any case, as today.
- **Privacy.** Sending: no change, an xo already ties the sender's npub to the post publicly. Receiving: new, the inbox now also asks relays for `#X twitter:<handle>`, telling them (and showing them this IP) that this browser watches that handle. The key-handle link is already public (kind 10011), so this is accepted, and the setup page and Options' xo notifications hint say it: "XMRadar asks relays for xos to your key and your X handle." A hashed tag was considered and rejected: the handle is public, so a hash of it hides nothing.

---

## Tests

**A:**
- Card show and hide rules: incomplete vs complete; snooze; dismiss; the xo switch off.
- `open-setup` sender checks: content script top frame only; extension pages refused; untrusted clicks ignored.
- Handle hint read from the nav link.
- The proof tweet spotter:
  - fires only on the user's own article containing the npub as a whole word;
  - fires once;
  - a candidate older than 30 min is gone.
- `setup.html` steps from status:
  - direct sign when `before` is null;
  - the diff shown otherwise.

**B:**
- `xoOf`: `p` only, `X` only, both; two `X` tags rejected; bad handle rejected; neither rejected.
- `xoTemplate` with and without author.
- `candidates`:
  - an `X`-only xo with my handle is accepted;
  - with a `p` to another key it is not;
  - not before `proven`.
- Baseline early-xo notice: counts distinct senders; not repeated on the next run.
- Handle change restarts the inbox.
- `xo-send` without author: published to defaults + mine; `xoSent` recorded; undo works.
- Faded state removed: the tooltip text for no key.
- Compatibility fixtures: a frozen copy of 0.6.12's `xoOf`/`candidates` (tests/fixtures/xo-0612.ts) must count a new keyed xo with `X` and drop a new X-only xo; the new parser must count an old `p`-only xo.
- Inbox migration: a 0.6.12 inbox without `handle` keeps its likes and items.
- Handle baseline: an old keyed xo found by `#X` is not counted from the 180-day window; an old X-only xo is.

**Live checks (own background tabs, nothing posted as the user):**
- Step 0 relay indexing.
- `setup.html` with a throwaway profile and the XMRadar identity, up to (not including) posting the proof tweet.
- An xo to a handle-only test account: there is no real test account, so it is checked with a key-less event built by the test's own throwaway key on relays, then deleted.

## Docs and release

- CHANGELOG under Unreleased.
- README xo paragraph.
- Options hint text.
- The site's xo copy: "xo anyone on X; they get it when they join".
- Version 0.6.13 when the user says to release.

## Order

1. Step 0 relay check.
2. B parse/template/inbox, with tests.
3. B send path and the heart.
4. `setup.html` wizard.
5. Card + `open-setup` + the proof tweet spotter.
6. Docs.
7. Code review.

## As built (changes from the plan above)

- **Scope of "anyone":** the heart is cloned from the Xap button, which shows only for authors with a Monero badge. So xos to a handle reach badge holders without a Nostr key (mostly older xmr.bio profiles), not every X account. A heart on every post is a separate change.
- **Step 0:** damus, nos.lol and primal all index `#X` (tested with a throwaway key, then deleted). `X` stays.
- **Inbox reset:** `myHandleItem.proven` turns false when a relay read misses the proof list. So a missing proven handle keeps the inbox, and only the key is read. The inbox starts over only for another key or a different proven handle.
- **Early xos:** "before you set up" is decided by the xo's `created_at` < `handleFrom` (when this inbox started reading the handle), not by which run found it. A sender verified on a later run still joins the early notice. In a key baseline, only early xos are told; outside one, everything new is told together.
- **Card state:** `setupStatusLast` is session storage, which content scripts can't read. A new local `setupDoneItem {pubkey, done}` is written by every status check. `setup-card-state` answers from it; with none for this key and a proven handle, it runs one status check.
- **setup.html review:** it renders its own diff (tagDiff) rather than sharing Options' renderer.
- **Card placement:** bottom-right (`right: 20px; bottom: 84px`), not bottom-left: X's account switcher sits at the bottom of the left nav.
- **Review round 1 fixes:** a handle read no relay answered doesn't run (or end) the handle baseline; `X` values are compared lowercased; a failed card-state ask leaves the card unknown rather than complete; a key or handle change can show the card again; a malformed setup.html fragment is ignored.
- **Popup:** *Your tip badge* opens setup.html until setup is complete (by `setupDoneItem`, else the last status check).
- **Budgets:**
  - `background.js` went from 948.4 to 951.2 KB; the budget was raised to 960 KB.
  - `content.js` went from 241.8 to 245.5 KB, within the 250 KB budget.
