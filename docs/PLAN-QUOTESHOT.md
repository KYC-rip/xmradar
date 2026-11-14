# PLAN-QUOTESHOT: a quoted post as a picture

## Why
A quote tweet copied to Nostr today loses the post it quotes: XMRadar takes only the outer tweet's own
text and images (the quote is nested in `div[role="link"]` and skipped). The comment then lacks what it
answers. The user asked for the quoted box as a picture in the note.

User's constraints:
- **No link to X.** Nostr readers won't click through, so there's no "Quoting @x: https://x.com/…" line.
- **No timestamp.** The quote shows its time as X renders it for this browser: an hour in the viewer's
  local time zone, or a relative "3h". Either reveals the user's time zone or when they looked, so it's
  hidden in the picture.

## What X renders (checked on the extractor's fixtures and live, 2026-11)
A quote inside `article[data-testid="tweet"]` is a `div[role="link"]` box holding its own `User-Name`
(name, @handle, a `time` inside a link, a "·" separator), its `tweetText`, perhaps a "Show more" link
(`tweet-text-show-more-link`) and media (`tweetPhoto`, video).

## 1. Finding the quote (src/extractors/x-quote.ts, pure DOM)
- `quoteBox(article): Element | null`: the outermost `div[role="link"]` inside the article that holds a
  `[data-testid="User-Name"]`. That is the quoted post, not a link card. Only the opened tweet's own quote
  counts: the box must not sit inside another quote.
- `quoteAlt(box): string`: "Quoted post by Name (@handle): text", with the text from `htmlToText`, cut to
  400 characters, and **no time and no URL**. It becomes the picture's description (`alt` in `imeta`).
- `hideForShot(box): () => void`: hides, with `visibility: hidden` so the layout doesn't move, every
  `time` element in the box and the "·" separator next to it, plus X's own controls in the box ("Show
  more", "Translate post"), which show the X interface language. Returns a function that puts each one's
  inline style back exactly.

## 2. Capturing (background + content)
- Content, in `mountComposer`, only for X, a single tweet or the opened tweet of a thread, no selection,
  no image (`srcUrl`), and not an article. Before the composer's UI is created:
  1. find the box; if there's none, nothing changes;
  2. scroll it into view (`block: 'center'`) if it isn't fully inside the viewport, and wait two
     animation frames;
  3. hide every XMRadar UI on the page (other composers, pills, toasts: the `xmradar-ui` hosts) and the
     box's time and controls (`hideForShot`), and wait one frame;
  4. send `{type: 'capture-quote', sessionId, rect}`, where `rect` is the box's `getBoundingClientRect()`
     clipped to the viewport, in CSS pixels, plus the viewport's width and height;
  5. put everything back in a `finally`.
- Background `capture-quote`:
  - `requireSession(sessionId, sender)`: only for a composer the user opened in that tab (the existing
    session rule), from the top frame;
  - at most once per session;
  - `tabs.captureVisibleTab(sender.tab.windowId, { format: 'png' })`, but only while that tab is the
    window's active one;
  - scale = the captured bitmap's width ÷ the viewport width the content sent;
  - crop with `createImageBitmap` and `OffscreenCanvas`; refuse a rect of zero size or one outside the
    capture;
  - return a `data:image/png` URL at most 8 MB, else an error.
- Content: the data URL becomes a page-local `blob:` image with the `alt` above, added like a pasted
  picture. It's always uploaded to Blossom, ticked by default, can be unticked, and is placed **after
  the tweet's own images**.
- Failure (permission missing, Firefox without site access, a rect off screen, a capture error): the
  composer opens as today. The status line says "Couldn't take a picture of the quoted post", and no
  retry loop runs.

## 3. In the note
- `buildNote` already puts uploaded image URLs at the end with `imeta`. The quote picture's `imeta`
  carries `alt <quoteAlt>`. No link and no text line for the quote.
- Threads: only the opened tweet's quote is captured; quotes in other tweets of the thread aren't.

## 4. Privacy and safety
- The picture holds only the quote's box, cropped in the background from a capture of that tab. Nothing
  else on the page is kept: the full capture is never stored or sent.
- Time and X's interface labels are hidden during the capture. The picture shows the theme (dark or
  light) as it is; that's said in the README.
- `captureVisibleTab` needs `<all_urls>`, which XMRadar already has. Firefox grants it only after "Grant
  access", which XMRadar needs on x.com anyway.

## Tests (vitest, happy-dom)
- `quoteBox`: a quote tweet's box; none for a plain tweet; a link card isn't a quote; a quote inside a
  quote isn't taken.
- `quoteAlt`: name, handle and text; no time, no URL; cut at 400.
- `hideForShot`: time, separator, Show more and Translate are hidden with layout kept; restore brings back
  earlier inline styles exactly.
- Background crop (pure helper `cropRect(rect, viewport, bitmapSize)`): scaling at DPR 1, 2 and 1.5,
  clipping to the capture, zero or off-capture rects refused.
- Session rules: no session, another tab, or a second capture → refused.

## Docs
README "Copy posts to Nostr": a quote tweet gets the quoted post as a picture (without its time and X's
labels, in your theme), with its author and text as the picture's description; untick it to leave it out.

## Not in scope
Quotes inside other tweets of a thread; a quote taller than the window (only the visible part is
captured); videos (their still frame is what's captured).

## Amendment after plan review round 1 (5.8, failed) — these rules replace the matching ones above
1. **Same tab, before and after.** The background asks `tabs.query({active: true, windowId})` right
   before and right after `captureVisibleTab`. Both answers must be the sender's tab id, with an x.com
   URL, and the capture must finish within 2 s of the request. Otherwise the bitmap is dropped unread,
   and its pixels are never cropped or returned.
2. **Top frame only.** `capture-quote` requires `sender.frameId === 0`, besides the session and its tab.
3. **The description** (`quoteAlt`) comes only from the quote's own `User-Name` (the display name and the
   @handle link's text, never the `time` link or the separator) and the quote's own `tweetText` (not a
   nested quote's), through `htmlToText` with links shown as their text. Tests assert: no time, no "·",
   no Show more or Translate, no URL, no nested quote.
4. **Geometry.** The content sends `innerWidth`, `innerHeight` and `visualViewport.scale`. A pinch zoom
   (scale ≠ 1) → no picture. The background scales x by bitmap width ÷ innerWidth and y by bitmap height ÷
   innerHeight separately, and refuses when the two differ by more than 2%. The crop is clipped to the
   bitmap. Tests cover DPR 1, 1.5 and 2, a scrollbar-wide difference, and a mismatched aspect.
5. **Hide by allowlist, not by list of labels.** Inside the box, these stay visible: the avatar image, the
   name and @handle (not the time link), `tweetText`, and media images (`tweetPhoto`, a card's image).
   Every text node outside those, and every `button`, `[role="button"]` and `time`, has its nearest
   element hidden with `visibility: hidden`. That covers polls ("2 days left"), "Promoted", Show more,
   Translate, community-note and "translated" labels, and video durations. Restore puts back exact inline
   styles. Tests: a poll, a video, a translated post, a link card.
6. **The rect is bounded in the background**: its width ≤ innerWidth, its height ≤ 90% of innerHeight,
   and its area ≤ 60% of the viewport. Anything else is refused. Only the crop ever leaves the background;
   the full capture is dropped in the same function. Messages come only from XMRadar's own content script
   (pages can't send runtime messages), and only within a session the user opened.
7. **Room.** The quote picture counts as one added picture against `MAX_PASTED_IMAGES` and
   `MAX_PASTED_TOTAL`. With no room, it isn't added, and the status line says so.
8. **Never left hidden.** The content waits at most 3 s for the answer and restores in a `finally`.
   Restore also runs on `pagehide`, and it's idempotent.
9. **Firefox.** Firefox MV3 has `tabs.captureVisibleTab` with `<all_urls>`, and its background page has
   `createImageBitmap` and `OffscreenCanvas` (Firefox ≥ 105; XMRadar needs 140). They're still
   feature-detected: when one is missing, the answer is `unsupported`, and the composer opens without the
   picture and says so. The live check covers both browsers.
10. **Once per session, atomically.** A `Set` of session ids in the background is marked synchronously
    before the first await, so two concurrent requests can't both pass. The session record in session
    storage gains `quoteShot: true`, so a restarted worker refuses too. Test: two concurrent requests →
    one capture.
