# PLAN-XVIDEO: videos and GIFs from X posts, copied to Nostr

User (2026-11-06): "XMRadar doesn't support video in the post yet."

Today a video tweet copies as text only: the extractor takes `[data-testid="tweetPhoto"] img`, and a video's
tile has no `<img>` (just `<video poster=… src="blob:…">`), so the video and even its poster are dropped.

## What X gives us (checked live 2026-11-06)
- Video tile: `[data-testid="tweetPhoto"] [data-testid="videoComponent"] video`, `src` a `blob:` (MSE stream,
  useless off the page), `poster` = `https://pbs.twimg.com/amplify_video_thumb/<media id>/img/…jpg` (or
  `ext_tw_video_thumb/<media id>/…`).
- GIF tile: `<video src="https://video.twimg.com/tweet_video/<id>.mp4">`: a direct mp4.
- The mp4 files: X's public embed endpoint `https://cdn.syndication.twimg.com/tweet-result?id=<status>&token=<t>`
  (the one embedded tweets use; no login; `token` derived from the id) lists `mediaDetails[]` with
  `media_url_https` (the poster, same media id), `original_info` (w×h), `video_info.duration_millis` and
  `variants[]` (`video/mp4` with bitrates, plus an HLS playlist). The mp4 URLs on video.twimg.com answer
  `HEAD` with `Content-Length` and `Access-Control-Allow-Origin: *`. Sample: a 60 s 1080×1920 video, 3.6 MB at
  720p, 11.8 MB at 1080p.

## Design

V1. Extraction (`extractors/x.ts`, so threads and every caller get it): walk the post's own media tiles in
  order (`[data-testid="tweetPhoto"]`, as today's `own` filter). A tile is checked for a `<video>` **first**
  (a video tile can also hold a poster `<img>`); with none, an `<img>` keeps it a photo. A video tile becomes
  `{ url: <poster, full size>, kind: 'video', poster, mediaId?, statusId, mp4? }` (`ExtractedImage` gains
  optional `kind`, `poster`, `mediaId`, `mp4`, `statusId`, `size`, `dim`, `duration`):
  - `mp4`: the `<video src>` only when it's `https://video.twimg.com/…` (a GIF's `tweet_video/<id>.mp4`); any
    other src (blob:, another host) is ignored and the resolver is used instead.
  - poster: the `<video poster>`, else the `<img>` in the tile, else for a GIF `pbs.twimg.com/tweet_video_thumb/<id>.jpg`
    (X's thumbnail for `tweet_video/<id>.mp4`). Full size: `fullSizeTwimg` also handles pbs.twimg.com's
    `amplify_video_thumb/`, `ext_tw_video_thumb/` and `tweet_video_thumb/` paths by setting
    `format=<extension>&name=orig` (checked live: 45 KB default → 85 KB original for a 1080×1920 poster).
  - mediaId: the path segment after `amplify_video_thumb/`, `ext_tw_video_thumb/` or `tweet_video_thumb/`.
  - Skipped only when there's neither a poster nor a usable mp4/mediaId (nothing to show or fetch).
V2. Finding the mp4 (background, new message `resolve-video { sessionId, statusId, mediaId }`, session-checked
  like `fetch-image`):
  - a GIF's direct `mp4` needs none of this;
  - else GET the syndication endpoint (credentials omitted, 10 s timeout, ≤ 1 MB JSON), find the mediaDetail
    whose `media_url_https` holds `mediaId`, take its `video/mp4` variants;
  - choose the highest bitrate whose `HEAD` Content-Length ≤ VIDEO_MAX (50 MB), checking from the top; a HEAD
    that fails or has no Content-Length skips to the next variant (the lowest, if every HEAD fails, is taken
    with size unknown: the background's streamed cap still decides);
  - redirects: the final URL must still be on video.twimg.com;
  - only `https://video.twimg.com/` mp4 URLs are accepted (anything else in the JSON is ignored);
  - result: `{ url, size, dim: "<w>x<h>", duration }` or a reason (`not found`, `too large`, `X didn't answer`).
  - Cached per (statusId, mediaId) for the session (≤ 8 entries).
V3. Publishing (composer `prepareImage`: `kind: 'video'` is branched **before** the generic early return, which
  would otherwise publish the poster as the video). The mp4 URL is the GIF's direct `mp4` or the resolver's.
  A video's `PostImage.dim` is the resolver's `original_info` (or none for a GIF), never `imageDim` (which can't
  decode an mp4; the background skips it for `video/*`); `PostImage` gains `image` (the poster) and `size`,
  and `imetaTag` writes `image` and `size`.
  - re-upload on (the existing checkbox): `fetch-image` with the mp4 URL, then `upload-image` → the Blossom
    URL; imeta `url`, `m video/mp4`, `x`, `size`, `dim`, `image <poster>`. Background changes for this:
    - `loadImage` reads `content-type` and `Content-Length` first: the cap is 20 MB for images, VIDEO_MAX for
      `video/*`; a stated length over it is refused before reading, and the body is read streamed with the cap
      (like `boundedBody`), so nothing larger is ever held;
    - the fetch timeout is 20 s for images, 20 s + 1 s per MB (of the stated or capped size) for video; the
      Blossom upload timeout likewise 30 s + 1 s per MB (the retry keeps it);
    - `imageCache` is bounded by bytes too: at most 64 MB in total, oldest dropped first, and an entry goes as
      soon as its upload ends (as today).
  - re-upload off: the video.twimg.com mp4 URL itself (public, no login; Nostr clients play mp4 links), imeta
    `m video/mp4`, `dim`, `image <poster>`.
  - upload fails: the same confirm as images ("Use the original video URL instead?").
  - no mp4 found at all: the poster image goes out instead, marked in the text as
    `▶ Video: https://x.com/i/status/<the media's own statusId>` (in a thread, the tweet the video is in, not
    the first), so readers can watch it on X; the composer says why on the tile.
  - The URL goes in the note's content like an image URL (NIP-92 wants it there); threads place it at its
    `[🖼 N]` marker as today.
V4. Composer: a video's tile shows its poster with a ▶ badge and "Video · 0:59" (duration once resolved;
  resolved when the composer opens, in the background, so the size is known: "Video · 0:59 · 11.8 MB");
  untick like any image (its checkbox says "Include video"). The result is kept on the media item and reused at
  publish (one resolve per video per composer; the background's cache serves a reopen in the same session).
  A too-large video says so on its tile and falls back per V3. The re-upload label becomes "Re-upload images
  and videos to Blossom" when there's a video.
V5. Articles (x-article) and other sites: unchanged. Quote tweets: the quoted post's media aren't copied today;
  unchanged.
V6. Privacy: the syndication request tells X which post you're copying (X already served you that post); no
  cookies. Stated in the README's "what XMRadar contacts" list.

## Tests
- extractor: a post with photo + video + GIF tiles in order → 3 items, kinds right; a video tile that also
  holds an `<img>` is a video; poster full-size (`format=jpg&name=orig`) for amplify/ext_tw/tweet_video thumbs;
  mediaId from each; GIF's direct mp4 kept only on video.twimg.com (an off-host src ignored); a poster-less GIF
  gets its tweet_video_thumb poster and survives; blob: never kept; quoted post's media excluded; a tile with
  nothing usable skipped.
- resolve-video (fetch mocked): token formula against a known pair; mediaDetail matched by media id; highest
  variant under 50 MB chosen by HEAD; a failing / length-less HEAD skips to the next; all too large → `too
  large`; non-video.twimg.com URLs and off-host redirects ignored; bad JSON / timeout → reason; non-digit ids
  refused; cache and its 8-entry bound.
- background caps: a `video/mp4` of 30 MB accepted; 60 MB refused from Content-Length before any read, and
  without Content-Length once the stream passes the cap; images still 20 MB; imageCache's 64 MB bound.
- event: imeta for a video (`m`, `image`, `dim`, `size`, `x`); content carries the URL; thread marker placement.
- composer: tile label/badge; re-upload off uses the mp4 URL (not the poster) with dim from the resolver;
  re-upload on uploads the mp4; the fallback confirm uses the mp4; no-mp4 fallback text names the video's own
  tweet in a thread; unticking a video leaves no URL or marker for it.

## Budget
Measured now: background.js 951.8 KB (budget 960 KB), content.js 252.4 KB (budget 260 KB). Expected +2–3 KB
background (resolver, streamed read), +1–2 KB content. Measure after; if background passes 960 KB, raise it to
970 KB in the same commit with the reason.

## Rollout
In 0.6.14 with the rest. CHANGELOG, README. Commit/release need the user's OK.

## Revisions
- R1 (plan review 6.4): `<video>` checked before `<img>`; full-size posters (`format=…&name=orig`, measured);
  poster-less GIFs kept via tweet_video_thumb; direct mp4 only on video.twimg.com; video branch before the
  early return; dim from the resolver, imageDim skipped for video; streamed read with Content-Length cap,
  size-scaled timeouts, imageCache bounded by bytes; HEAD failure rule; fallback link to the video's own tweet;
  measured budgets; more tests; "Include video" and the re-upload label.
- R2 (plan review 7.6, pass): `fetch-image` carries `kind: 'video'`, which picks the video cap and the
  timeout up front (20 s + 1 s per MB of VIDEO_MAX = 70 s), whatever the response's content-type says; a
  poster-less GIF is kept without a guessed thumbnail (the tile shows the muted mp4, imeta has no `image`);
  tweet_video_thumb mediaId without its extension; a GIF is labelled "GIF", a video "Video · m:ss", the size
  only when known; imeta `size` is the fetched byte length when re-uploaded, the HEAD size otherwise.

## As built (2026-11-06)
- Plan review 6.4 → 7.6; code review 7.6 (pass). Fixed after it: a video tile with nothing to fetch stays a
  video (poster + "▶ Video:" link), not a photo; resolver failures aren't cached (and never push a found one
  out); a 20 s budget for the whole lookup (then the smallest variant, size unknown); media id matched before
  a query too. Not done: composer UI tests (the composer has none in the repo); redirects on HEAD are
  contacted before the host check (their result is ignored; the initial URL is always video.twimg.com).
- Live: the resolver found a real tweet's 1080p mp4 (11.8 MB, 1080×1920, 60 s).
- background.js 954.8 KB / 960, content.js 255.8 KB / 260. Tests 1501/1501.
