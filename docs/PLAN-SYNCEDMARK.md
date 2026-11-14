# PLAN-SYNCEDMARK: mark posts on X that were copied to Nostr

## Why
The user wants to see, on X, which posts they already copied to Nostr.

Facts:
- `postedItem` (local:posted) keeps only hashes of (normalised source URL + text), for duplicate warnings;
  no status id, no event id. Old copies can't be marked from it.
- `publish` (background.ts) has `msg.sourceUrl`, the signed event, the relays that accepted it, and
  builds `nevent` / `naddr`. `statusIdFromUrl` (extractors/x-article.ts) gives the X status id.
- After publishing, the composer links notes to `https://app.ros.rip/nostr/note/<nevent>` and articles
  to `https://njump.me/<naddr>`.
- Per-post UI on X lives in x-badges.ts (MutationObserver over tweets) and x-xap.ts; quote pictures hide
  `OVERLAYS` = 'xmradar-ui, xmradar-tip, xmradar-site, xmradar-receipt' (PLAN-SHOTOVERLAYS).

## Changes
1. `src/settings.ts`: `syncedPostsItem` = `local:syncedPosts`, `Record<statusId, { ref: string; kind:
   'note' | 'article'; at: number }>`, at most 1000 entries (oldest `at` dropped). `syncedMarkOn(settings)`
   with `syncedMark?: boolean` (on unless switched off).
2. Background `publish`: when at least one relay accepted and `statusIdFromUrl(msg.sourceUrl)` gives an
   id, record `{ ref: nevent | naddr, kind, at: now }` (pure helper `recordSynced(map, id, entry, max)`,
   tested). Nothing else is stored; no network.
3. Content script on X (`x-synced.ts`, started from index.ts when on X and the switch is on):
   - Reads `syncedPostsItem` once and watches it.
   - For each `article[data-testid="tweet"]` (initial pass + the existing badge observer's batches, or its
     own observer throttled with rAF), the post's own status id = the `/status/<id>` link wrapping its own
     `time` element (not a quoted post's: nearest-article ownership like `actionBars`).
   - If synced: insert once, right after that time link, an `<xmradar-synced>` element (custom tag, own
     open shadow root with `:host{all:initial}` styling) containing a small link "✓ Nostr" (purple,
     12px, title "Copied to Nostr <date>. Opens the note."), `href` = ros.rip note URL / njump article URL
     built from the stored ref (ref must match `^(nevent|naddr)1[02-9ac-hj-np-z]+$`), target _blank,
     rel noopener noreferrer. Click events stop propagation so X doesn't open the tweet.
   - Removes marks whose post is no longer synced (map changed) and all marks when switched off /
     invalidated.
4. `quote-shot.ts`: add `xmradar-synced` to `OVERLAYS` (the picture of a quoted post shows no mark).
5. Options → Posting to Nostr: a checkbox "Mark posts on X that you copied to Nostr" (`syncedMark`).
6. Tests: recordSynced cap/order; publish records only with a status id and an accepting relay (unit
   on the helper + a background-free wrapper); content: mark appears after the post's own time link,
   not on a quoted post inside, once only, removed when the entry goes / switch off; link built only for a
   valid ref; OVERLAYS contains it; options checkbox wiring.
7. README: one line under Posting.

## Out of scope (ask the user later)
Marking posts copied before this version (would need asking relays for the user's own notes).
