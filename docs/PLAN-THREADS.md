# PLAN-THREADS: copy a whole X thread to Nostr as one note

## Why
A thread (an author replying to their own tweet, several times in a row) is one piece of writing split by
X's length limit. Copy to Nostr today takes one tweet. The user chose: the thread becomes **one kind:1
note** (tweets joined by blank lines, every tweet's images, the first tweet as the source link).

## What X renders (checked live 2026-11-02, https://x.com/XBToshi/status/2117283687834571228, 5 tweets)
- On a tweet's page the conversation is a list of `[data-testid="cellInnerDiv"]` cells. The opened tweet's
  cell, then an empty cell (no text; the reply box area), then the author's continuation tweets, one per
  cell, each an `article[data-testid="tweet"]` whose own `User-Name` link is `/XBToshi`; then an empty cell.
- A long tweet in the thread is cut with `[data-testid="tweet-text-show-more-link"]`, a `<button>` (the
  4th tweet here), which expands in place like on timelines.
- If the opened tweet is in the middle of a thread, the earlier tweets are cells above it.
- Other people's replies come after the thread; X virtualises long lists, so a very long thread may not be
  fully rendered until scrolled.

## 1. Finding the thread (src/extractors/x-thread.ts, pure DOM, tested with happy-dom)
- `authorOf(article)`: the tweet's own `[data-testid="User-Name"]` handle link (`/^\/([A-Za-z0-9_]{1,15})$/`),
  not one inside a quoted tweet (`div[role=link]`), lower-cased.
- `xThread(tweet, doc): { tweets: Element[]; mayContinue: boolean } | null`
  - only on a tweet's own page (`/<user>/status/<id>`) and only for a tweet inside a `cellInnerDiv` of the
    conversation list (the cells' common parent);
  - from the tweet's cell, walk the sibling cells down, then up. A cell with no text and no article is
    skipped (the reply box and spacers); a cell whose article's author is the same is taken; anything else
    (another author, a promoted tweet, "Show replies", "Discover more") ends that direction;
  - at most 50 tweets; `mayContinue` when the walk down ran off the last rendered cell rather than ending
    on another cell;
  - null unless it found 2 or more tweets, or the opened tweet is an X Article.
- `combineThread(posts: ExtractedPost[]): ExtractedPost`: text = each tweet's text trimmed, empty ones
  skipped, joined by a blank line; images = all, in order (buildNote already dedupes); sourceUrl = the first
  tweet's; `articleCard` if any tweet shares an X Article.

## 2. In the composer (src/entrypoints/content/composer.ts)
- Only for X, no selection, no image (`srcUrl`), and not an X Article.
- Find the thread around the target tweet. If there is one: expand each tweet's own "Show more" button one
  after another (`expandTweet`, already waits for the text to grow; links are never clicked), find the
  thread again (X may redraw), extract each tweet with `xExtractor.extract`, combine.
- A checkbox above the text: "Whole thread (5 posts)", on by default. Off → the single tweet as today.
  Switching rebuilds the text and the image grid; once the user has edited the text the checkbox is
  disabled (title: "Edited; reopen to switch") so no edit is silently lost. Pasted images stay.
- With `mayContinue`: a note under it, "The thread may go on below; scroll down to load it, then open
  Copy to Nostr again."
- Publishing is unchanged (one kind:1 via buildNote; dedupe key = first tweet's URL + text; `r` tag and
  appended link = first tweet). The composer key stays the opened tweet's id.

## 3. Docs
README "Copy to Nostr" section: a thread on its own page is copied whole as one note (switchable).

## Tests (vitest, happy-dom)
- x-thread: a 5-tweet thread found from the first, a middle and the last tweet (with tweets above);
  the empty cell skipped; stops at another author, a promoted tweet, a non-empty non-tweet cell; a quoted
  tweet's author doesn't count; timeline page → null; single tweet → null; `mayContinue` true when the
  last cell is the author's, false when another cell ends it; 50 cap.
- combineThread: order, blank-line joins, empty texts skipped, images in order, first sourceUrl, articleCard.
- composer: a thread page opens with the checkbox on and the joined text; off → single tweet; disabled after an edit;
  a truncated thread tweet's "Show more" button is clicked and its full text used.

## Not in scope
- Publishing as a Nostr reply chain (NIP-10) or an article; threads on timelines ("Show this thread").

## 4. Amendment: each tweet's images under that tweet (user request, after 0.6.2)
- `combineThread` puts a line `[image N]` after each tweet's text for each of its images (N = 1-based
  position in the combined `images`), and marks the post `inlineImages: true` (new optional field on
  ExtractedPost). Single tweets and other sites are unchanged.
- Composer, thread mode: each thread thumbnail shows its number (a small badge). At publish, after uploads:
  `[image N]` → that image's final URL (Blossom or original) when ticked; dropped when unticked or N is
  unknown; then runs of 3+ newlines collapse to 2. Images whose marker the user deleted (still ticked) and
  pasted images are appended at the end as today.
- `buildNote` gets `inlined?: string[]`: URLs already placed in the text are not appended again at the end;
  every image still gets its `imeta` tag. The text sent for the dedupe key is the textarea's (with markers),
  as today.
- The tag-suggestion text drops the markers.
- Tests: combineThread markers and numbering; a pure `placeImages(text, images, finals)` helper (ticked,
  unticked, unknown N, deleted marker → appended list, newline collapse); buildNote with `inlined`
  (no duplicate URL in content, imeta for all).
