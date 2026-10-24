# XMRadar: copy X Articles to Nostr as long-form (NIP-23)

## 1. Problem

- **Same URL as tweets.** An X Article lives at an ordinary `/status/<id>` URL.
- **Logged-in page.** When you're logged in, X renders it as `article[data-testid="twitterArticleReadView"]`, with no `article[data-testid="tweet"]`.
  - So `xExtractor` returns null.
  - The generic fallback then dumps the whole article, buttons and counters included, as plain text into a kind-1 note.
- **Logged-out page.** X serves a completely different page logged out: Tailwind classes, `data-article-part="cover|title|byline|body"`, and semantic `<p>/<h3>/<ul>/<strong>`. It's covered as a second layout. It's cheap to support, and X may move logged-in users to it later.

**Fixtures (real, the user's own article):**
- `tests/fixtures/x-article-loggedin.html` is trimmed to the article element.
- `tests/fixtures/x-article-loggedout.html` has styles and icons removed.
- `tests/fixtures/syndication-x-article.json` gives the title, cover and preview only. Syndication has no body, so it isn't used for extraction.

**Logged-in markup (Draft.js, read from the fixture):**
- **Title:** `[data-testid="twitter-article-title"]`.
- **Cover:** the first `[data-testid="tweetPhoto"] img` inside the read view, before the title.
- **Body:** `[data-testid="longformRichTextComponent"] [data-contents]`. Each child has `data-block="true"`.
- **Block classes:**
  - `div.longform-unstyled` is a paragraph.
  - `h2.longform-header-two` is a heading.
  - `li.longform-unordered-list-item` and `li.longform-ordered-list-item` are list items, inside `ul`/`ol`.
  - `section[data-block]` is an atomic block: an image (`tweetPhoto img`) and, presumably, embeds.
- **Inline formatting:** bold and italic are `<span style="font-weight: bold">` and `<span style="font-style: italic">`.
- **Links:**
  - `<a href>`, which can be protocol-relative (`//pwa.cash`) or relative (`/XBToshi/article/…/media/…` for image links).
  - The visible link text can be shortened by X (logged out: `https://pwa.cas` + `h`), so links always use the `href`.
- **Date:** logged in, a `<time datetime>` gives the date. Logged out, there isn't one.

## 2. Design

### 2.1 Extraction: `src/extractors/x-article.ts`

**Output.** `ExtractedPost` gains an optional field:
```ts
article?: { id: string; title: string; markdown: string; summary: string;
            cover?: ExtractedImage; images: ExtractedImage[]; publishedAt: number }
```
- `text` is set to the Markdown, so the generic paths still work.
- `images` = the cover plus the inline images, in order.

**Matching.**
- `xArticleExtractor` runs **before** `xExtractor` on X hosts. It matches when `target.closest('article[data-testid="twitterArticleReadView"]')`, or the logged-out `[data-article-part="body"]` ancestor container, exists.
- **The page must be a status page.** The tweet ID comes from `location.pathname` matching `^/<handle>/status/(\d+)`. Otherwise there's no stable `d` tag, and it falls back to the existing behaviour.
- **Source URL:** `https://x.com/<handle>/status/<id>`.
- **`publishedAt`:** the tweet ID's snowflake time (`(id >> 22) + 1288834974657` ms), which works in both layouts. `<time datetime>` is only a cross-check in tests.

**Converter: `src/extractors/html-to-markdown.ts`.** One recursive walker with a block resolver that understands both layouts.
- **Blocks:**
  - `p`, `.longform-unstyled` → paragraph.
  - `h1`–`h6`, `.longform-header-one|two|three` → `#` × level. The article title is carried in the event's `title` tag, not the body, so body headings keep their own level unchanged.
  - `ul > li`, `.longform-unordered-list-item` → `- `.
  - `ol > li`, `.longform-ordered-list-item` → `1. `, `2. ` …, counting within a run of items.
  - `blockquote`, `.longform-blockquote` → `> `.
  - `pre`, `.longform-code-block` → a fenced code block.
  - An atomic `section` or `figure` with an image → `![alt](url)` on its own paragraph. With no image, its text is kept as a paragraph, so an unknown embed degrades to text rather than vanishing.
- **Inline:**
  - Bold (`b`, `strong`, `font-weight: bold|700+`) → `**…**`.
  - Italic (`i`, `em`, `font-style: italic`) → `*…*`.
  - Links → `[text](href)`:
    - `href` is resolved against `https://x.com`, and protocol-relative links become https.
    - Only `http`/`https` are kept. Any other scheme becomes plain text.
    - When the visible text is a URL (possibly shortened), the output is `<href>`, so it isn't shown truncated.
  - An image link (`/…/media/…`) wrapping an image becomes just the image.
- **Escaping:** text is Markdown-escaped (`\ * _ [ ] # > \``, a leading `-`/`+`/`1.`), so literal characters in the article stay literal.
- **Skipped:**
  - `SCRIPT`, `STYLE`, `BUTTON`, `SVG`, `aria-hidden` (the shared `SKIP` set).
  - Everything outside the body root: the author cell, the action bar, counters and the title. They're never part of the Markdown.
- **Images:**
  - `pbs.twimg.com/media/<id>?format=…&name=…` is rewritten to `name=orig` (reusing `fullSizeTwimg`).
  - `alt="Image"` counts as no alt text.
- **Summary:** the first paragraph's plain text, cut at 300 characters on a word boundary with `…`.
- **Title:** the title element's text, trimmed. If it's missing, the extractor returns null (fallback).

### 2.2 Event: `buildArticle()` in `src/nostr/event.ts`

**Kind 30023 template.**
- `content` = the Markdown, with images already replaced by their uploaded URLs. When "Add link to original" is ticked (the existing checkbox), `\n\n---\n\nOriginally published on X: <sourceUrl>` is appended.
- **Tags:**
  - `["d", "x-<tweetId>"]`: the same article always replaces itself on Nostr (it's an addressable event), so re-publishing an edit updates it instead of duplicating.
  - `["title", title]`, `["summary", summary]`.
  - `["image", coverUrl]`, when there's a cover.
  - `["published_at", String(publishedAt seconds)]`.
  - `["r", sourceUrl]`.
  - `["alt", "Long-form article: <title>"]` (NIP-31).
  - one `imeta` per image (existing `imetaTag`).
  - `["client", "XMRadar"]`.
- **Limit:** Markdown over 60 KB raises a warning in the composer ("some relays reject events this large") but isn't blocked. The test article is about 15 KB.

### 2.3 Signing and publishing

- **Bridge.** `bridge.ts` `ALLOWED_KINDS` becomes `[1, 24242, 30023]`. The content script already runs `checkSigned(template, signed, pubkey)`, an exact template match, for every signature, and that applies unchanged.
  - Risk note: the page could already call `window.nostr` itself. The allowlist only limits what *the extension* will ask the signer for.
- **Background `publish`.**
  - It accepts `kind === 1 || kind === 30023` (today it refuses anything but 1).
  - For 30023 it also requires a `d` tag of `x-<digits>` and a `title` tag, so a content script can't push arbitrary addressable events.
  - After publishing, it returns an `naddr` (kind, pubkey, d, relays) instead of an `nevent`.
- **Duplicate check.** It stays keyed by source URL plus text.
  - For articles, the composer shows "Already published. Publishing again replaces the earlier version (same article ID)."
  - That's informational, not a block, because replacing is the intended behaviour.

### 2.4 Composer: long-form mode

When `post.article` is set:
- **Header:** "Copy article to Nostr".
- **Fields:**
  - a **Title** input
  - a **Summary** input (one line)
  - the **Markdown** textarea (taller: 16 rows)
  - a word count
- **Images:**
  - The cover preview plus the existing image list with ticks.
  - An unticked inline image is removed from the Markdown. Its `![…](url)` line is dropped, so no dangling hotlink is left.
  - With "Re-upload images" on (the existing setting), each image goes through the existing Blossom flow, and its URL in the Markdown is replaced with the uploaded one (an exact-string replace of the original URL).
  - The existing upload-failure prompt ("use the original URL instead?") applies per image.
- **Buttons:** **Publish article**. Afterwards: "View on njump" (`https://njump.me/<naddr>`) and **Copy naddr**.
- **Kept from note mode:** the source-link checkbox, debug JSON and relay results all work the same.

### 2.5 Shared article card in a timeline (out of scope)

- A normal tweet that only *shares* an article (a card) keeps today's behaviour: a kind-1 note with the tweet text and link.
- If that tweet contains an article card, the composer shows a hint: "This is an X Article. Open it and use Copy to Nostr there to publish the full article."
- Detection: any link inside the tweet whose path matches `/<handle>/article/<id>`. If the selector misses, nothing breaks.

## 3. Tests (vitest + happy-dom)

- **Logged-in fixture → extractor:**
  - Title: "The Web-App Cash Register Nobody Can Delist".
  - Cover: `HVU6ugabYAAnzMr` with `name=orig`.
  - Inline images: the count equals the number of atomic image blocks (9 expected).
  - `publishedAt` equals the `<time>` value (2026-10-23T16:04:07Z), within 1 s.
  - Markdown:
    - starts with `**TL;DR:**`
    - contains `## What [pwa.cash](https://pwa.cash) used to be`
    - links are https with the full href
    - list items start with `- ` / `1. `
    - images appear as `![](https://pbs.twimg.com/media/…name=orig)`
  - None of "Reply", the counters, the author name line or "Bookmark" appear in the Markdown.
- **Logged-out fixture:** the same title, cover and image count. Its Markdown matches the logged-in one up to heading level (the logged-out page uses `h3`, the logged-in one `h2`), compared by normalizing `#`-runs. That proves both paths extract the same article.
- **Converter unit tests:**
  - escaping of `*`, `_`, `#` and a leading `1.`
  - a `javascript:` link becomes plain text
  - nested bold+italic
  - ordered-list numbering resets after a paragraph
  - an unknown atomic block keeps its text
  - an empty paragraph produces no `\n\n\n`
- **`buildArticle`:** tags exactly as in §2.2; `d` = `x-<id>`; source footer on and off; images replaced.
- **Background `publish`:**
  - accepts 1 and 30023
  - rejects a 30023 with no `d` or a non-`x-<digits>` `d`
  - rejects other kinds
  - `naddr` returned for 30023
- **Bridge:** 30023 allowed; kinds 0, 3 and 10002 still refused.
- **Extractor order:** on a normal tweet fixture (`x.html`), `xArticleExtractor` returns null and `xExtractor` is unchanged.
- **Unticked image:** its Markdown line is removed.

## 4. Manual checks

1. Logged in, on https://x.com/XBToshi/status/2113662765525282909: right-click → Copy to Nostr. The long-form composer opens with the title, summary, cover and 9 images.
2. Publish with re-upload on, open the njump link, and check headings, bold, lists, links and images.
3. Publish again after editing the title. njump shows the new title, and there's only one article (same `naddr`).
4. A normal tweet still opens the note composer.
5. A timeline tweet sharing an article shows the hint.

## 5. Files

| File | Change |
|---|---|
| `src/extractors/x-article.ts` | new extractor (both layouts) |
| `src/extractors/html-to-markdown.ts` | new converter |
| `src/extractors/types.ts` | optional `article` field |
| `src/extractors/index.ts` | register before `xExtractor` |
| `src/extractors/x.ts` | export `fullSizeTwimg`; detect article card for the hint |
| `src/nostr/event.ts` | `buildArticle` |
| `src/bridge.ts` | allow 30023 |
| `src/entrypoints/background.ts` | `publish` accepts a validated 30023 and returns `naddr` |
| `src/messaging.ts` | publish result: `nevent` or `naddr` |
| `src/entrypoints/content/composer.ts`, `style.css` | long-form mode |
| `tests/article.test.ts` | new |
| `README.md` | X Articles section |

## 6. Conditions from plan review (OpenCode, passed 7.3)

- **SNOWFLAKE-BIGINT.** `publishedAt = Number((BigInt(id) >> 22n) + 1288834974657n)`. Tests cover the fixture ID and a small ID.
- **DRAFT-LINK-DIV.**
  - Only the explicit block types start a block: `p`, the `.longform-*` block classes, `h1`–`h6`, `li`, `blockquote`, `pre`, atomic `section`/`figure`, and separators.
  - Every other element, including Draft's `div.public-DraftStyleDefault-block` and the `div` wrapping each link, is inline.
  - Test: a paragraph with links stays one paragraph.
- **Separators.** `hr` (logged out) and `[role="separator"]` (logged in) become `---`.
- **LOGGEDOUT-MATCH.**
  - The logged-out article root is the nearest ancestor of the target that contains `[data-article-part="body"]`. Title, cover and body are found inside it.
  - Tests: right-clicking the title, the cover and the body give the same article.
- **COVER-REUPLOAD + URL-REPLACE-EXACT.** The composer keeps an original → final URL map per image.
  - **Generated image syntax.** The converter always writes images as `![alt](<url>)`.
  - **Replacing.** Replacement and removal act on these **whole image tokens** only, matched exactly, never on substrings of other text. A user-edited textarea stays readable; there are no hidden placeholders.
  - **Cover.** The `image` tag uses the cover's final URL. An unticked cover drops the `image` tag and its `imeta`.
  - **Duplicates.** The same original URL appearing twice is the same image: it gets the same upload, and unticking it removes both.
  - **Tests:** cover re-uploaded, cover unticked, a duplicate image, a URL that's a prefix of another.
- **MARKDOWN-ESCAPE.**
  - Text escapes ``\ ` * _ [ ] < >``, a leading `#`/`>`/`-`/`+`, and `1.`.
  - Every link and image destination is written as `<url>`, with `<`, `>`, spaces and newlines percent-encoded.
  - Alt text and link text are escaped the same way as body text.
  - Code blocks use a fence one backtick longer than the longest run of backticks inside.
  - Tests: `<script>`, a URL containing `)` and a space, alt text containing `]`, a code block containing backticks.
- **SELECTION-ARTICLE.** An explicit text selection means "share this fragment as a note". `extractPost` drops `article` when a selection overrides the text. Test.
- **LOGGEDOUT-CTA.** Checked: in both fixtures the body root ends with the article's last paragraph. Test: "Join" / "More articles" are absent from the Markdown.
- **BRIDGE-30023.** The generic bridge allowlist gets 30023, and the risk note stays. The signer prompt is the boundary, as it is for kind 1.
- **BACKGROUND-D-MATCH.** `publish` for 30023 requires `d === "x-" + tweetIdFrom(msg.sourceUrl)`, and `msg.sourceUrl` must be an X status URL. Test: a mismatched `d` is rejected.
- **ARTICLE-CARD-HINT.** Best-effort only (link path `/article/`). It's not tested beyond "no crash".
- **Large articles.** A test checks the 60 KB warning helper.
