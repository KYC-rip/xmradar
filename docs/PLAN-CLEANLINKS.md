# Clean X links: strip the share tokens X adds

## Why
X's "Copy link" (and "Share post via…") gives `https://x.com/<user>/status/<id>?a=<token>&s=20`.
`s` names the app that shared it (20 web, 46 iPhone, 19 Android); `a` (formerly `t`) is a fresh token per
share (seen live: two copies of one post gave `a=Zp7IdPNtAYNhmLPhasc` and `a=yiBW0vELHaKxo8YNEMY`), so X
can tell who shared the link to whom. A post link needs neither.

Checked live (Chrome, x.com): "Copy link" copies through a `copy` event with the URL selected; a capture
listener that sets `clipboardData` and calls `preventDefault()` wins (X doesn't overwrite it).

## Change (round 2: answers CLEANLINKS-1..5)

### `src/x/links.ts` (pure)
- **Host** (CLEANLINKS-3): `https:` or `http:`, hostname exactly one of `x.com`, `www.x.com`,
  `mobile.x.com`, `twitter.com`, `www.twitter.com`, `mobile.twitter.com` (URL parser's hostname, so
  `x.com.evil.com`, `x.com@evil.com` → evil); no username/password, no port; a trailing-dot host is not X.
- **What is removed** (CLEANLINKS-5):
  - post URL — path `/<user>/status/<digits>` or `/i/status/<digits>` or `/i/web/status/<digits>`, then
    optionally one of `/photo/<n>`, `/video/<n>`, `/analytics`, `/quotes`, `/retweets`, `/likes`, and an
    optional trailing `/`: every query parameter and the hash (a post link needs none);
  - profile URL — `/<user>` (1–15 `[A-Za-z0-9_]`, not a reserved first segment: `home`, `explore`, `search`,
    `i`, `settings`, `messages`, `notifications`, `compose`, `login`, `logout`, `signup`, `tos`, `privacy`,
    `hashtag`, `intent`, `share`): `s`, `t`, `a`, `ref`, `ref_src`, `ref_url`, `utm_*`;
  - any other X URL: only `ref_src`, `ref_url`, `utm_*` (search `q`, `f`, `src`, `t` etc. kept).
  `cleanXUrl(raw)` returns the cleaned string, or null if not X or nothing changed.
- **Tokenizer** (CLEANLINKS-4): `cleanXLinks(text)` finds `https?://` runs up to whitespace or one of
  `<>"'\``; then trims trailing `.,;:!?` and a trailing `)` or `]` when the run has no matching opener
  (so Markdown `[x](https://x.com/a/status/1?s=20)` keeps its `)`), then cleans that token in place. A URL
  inside another URL's query (`?u=https%3A…`) is percent-encoded and not matched. Code blocks are not
  special: an X link there is cleaned too (it is still the same post).

### Copy on x.com (`src/entrypoints/content/x-links.ts`, X top frame) (CLEANLINKS-1)
Capture `copy` listener. Takes over only a **plain-text** copy:
- the active element is an `input`/`textarea` (X's own Copy link uses a selection of a plain text) and
  its selected value, or
- the document selection is one range whose contents (`range.cloneContents()`) contain no element at all,
and the trimmed text is exactly one X URL that `cleanXUrl` changes. Then
`clipboardData.setData('text/plain', clean)` and `setData('text/html', '')` is not used: it calls
`clearData()` first, then sets only `text/plain`, then `preventDefault()`. A selection containing an
`<a>` or any element (a link, a post's text) is left completely alone.

### Copy to Nostr (CLEANLINKS-2)
- `cleanXLinksOn(s) = s?.cleanXLinks !== false` in `settings.ts`.
- `composer.ts`: when on (read with the other settings at open), the textarea, title and summary start
  from `cleanXLinks(...)` of the extracted text, so the user sees and can still edit what is posted.
- `buildNote` / `articleTemplate` get `cleanLinks: boolean` and pass the appended source URL through
  `cleanXUrl` when it is set. The composer passes the setting it read at open.

### Setting
`cleanXLinks?: boolean` (default on). Options → Behaviour: "Remove X's share tracking (?s=, ?a=, ?t=) from
X links you copy and from links in posts you copy to Nostr". The copy listener follows the setting live
(watch, like the share-menu switch).

## Tests (`tests/x-links.test.ts`)
- table for `cleanXUrl`: both real share shapes; every post-path variant with and without trailing `/`;
  `twitter.com`, `www.`, `mobile.`; profile `?s=20&t=x` → bare, profile `?lang=en` kept; `search?q=xmr&src=typed_query&f=live&t=1`
  untouched except none; `explore?utm_source=a&ref_src=b` → bare; lookalikes `x.com.evil.com`,
  `evil.com/x.com/a/status/1?s=20`, `x.com@evil.com`, `x.com:444`, `x.com.`; non-X `example.com/?s=20`;
  already clean → null.
- `cleanXLinks`: two links in prose; trailing `.`/`)`/`,`; Markdown link; URL in quotes; balanced
  `(https://x.com/a/status/1?s=20)`; a percent-encoded X URL inside another URL untouched; non-X untouched.
- copy listener (happy-dom): plain selection = dirty URL → cleaned, html cleared, default prevented;
  input selection → cleaned; selection containing an `<a>` → untouched; prose with a link → untouched;
  switch off → untouched.
- composer pieces: `buildNote({ …, cleanLinks: true })` with a dirty source URL → clean; `false` → as given.

## Live
x.com in Chrome: Share → Copy link → paste: bare `https://x.com/<user>/status/<id>`.
