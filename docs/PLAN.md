# XMRadar — Browser extension plan (formerly syncToNostr)

Personal-use Chrome + Firefox extension: right-click one of my posts (X, Mastodon, Bluesky,
LinkedIn, Facebook, or any page), preview/edit it in a modal, then publish it to Nostr
as a kind-1 note. Signing goes through an existing NIP-07 signer (Alby, nos2x). Images
are re-uploaded to a Blossom server.

## Stack
- **WXT** (Vite-based, MV3, builds Chrome + Firefox from one codebase), TypeScript.
- **nostr-tools** for event building, the relay pool and NIP-19.
- **Preact** for the modal and options UI, rendered inside a Shadow DOM so page CSS can't leak in.
- **Vitest + happy-dom** for unit tests.
- No backend.

## Architecture

```
contextmenu click ─▶ background (service worker / FF event page)
                         │  tabs.sendMessage("open-composer", {srcUrl?, selection?})
                         ▼
 content script (ISOLATED world, <all_urls>)
   - records the last right-clicked element
   - runs the site extractor ─▶ {text, images[], sourceUrl}
   - mounts the Preact modal in a Shadow DOM: editable text, image thumbnails (removable), Publish button
                         │ window.postMessage (nonce-checked)
                         ▼
 bridge script (MAIN world)  ── window.nostr.getPublicKey / signEvent   (NIP-07 exists only in the page's world)
                         │
 content ─▶ background: "upload-image" (fetch bytes using host perms, sha256, PUT to Blossom with a signed kind-24242 auth)
 content ─▶ background: "publish" (signed event ─▶ SimplePool.publish to the relays ─▶ per-relay ok/fail)
```

Why it's split like this:
- The extension's own popup can't reach `window.nostr`, which a signer injects into web pages only. So signing has to happen in a MAIN-world script on the page.
- Relay WebSockets and image fetches run in the background, so page CSP (x.com, facebook.com) and CORS can't block them.
- The bridge only accepts messages that carry a random per-load nonce the content script hands it. The bridge exposes nothing beyond `getPublicKey` and `signEvent`, and the signer still shows its own approval prompt.

## Extractors (`src/extractors/`)
Common interface: `extract(target: Element, doc: Document): ExtractedPost | null`. The registry picks one by hostname and falls back to `generic`.

| Site | Post root (closest to the click target) | Text | Images |
|---|---|---|---|
| X (`x.com`, `twitter.com`) | `article[data-testid="tweet"]` | `[data-testid="tweetText"]` (keep emoji `img[alt]`, expand `t.co` links via the anchor's text/`href`) | `[data-testid="tweetPhoto"] img`, upgraded with `name=orig` |
| Bluesky (`bsky.app`) | `[data-testid^="postThreadItem"], [data-testid^="feedItem"]` | `[data-testid="postText"]` | `img[src*="cdn.bsky.app/img/feed_"]`, upgraded to `feed_fullsize` |
| Mastodon (detected by `meta[property="og:site_name"]` / `#mastodon` root, any host) | `.status, .detailed-status` | `.status__content` (HTML → text, keeping links) | `.media-gallery img`; take the full URL from the parent `a[href]` |
| LinkedIn | `.feed-shared-update-v2` | `.update-components-text` | `.update-components-image img` |
| Facebook | `[role="article"]` | `[data-ad-preview="message"]`, or the largest `div[dir="auto"]` block | `img[src*="scontent"]` that are larger than 100px |
| Generic | — | current selection, or the `og:description` / `<article>` text | the right-clicked `<img>` (`srcUrl`) or `og:image` |

- HTML → plaintext uses one shared helper: `<br>`/`<p>` become newlines, links become their `href` when the anchor text is truncated, and whitespace gets cleaned up.
- If a site extractor returns null, the generic extractor runs and the modal shows "couldn't detect a post — using selection".
- Selectors live in one file per site, each with an HTML fixture test, so when a site changes its DOM only that file and its fixture need updating.

## Context menu entries
- "Copy post to Nostr" (contexts: page, selection, image, link).
- Keyboard command `Alt+Shift+N` opens the composer for the hovered post, or the selection.

## Publishing
1. Get the pubkey from the signer.
2. Get relays: the options-page list if set, otherwise the user's NIP-65 (kind 10002) write relays, otherwise these defaults: `wss://relay.damus.io`, `wss://nos.lol`, `wss://relay.primal.net`.
3. Images (each one can be unchecked in the modal):
   - The background fetches the bytes and computes the sha256.
   - The bridge signs a kind-24242 auth event (`t=upload`, `x=<sha256>`, `expiration` = now + 5 min).
   - The background sends `PUT <blossom>/upload`.
   - On success: append the returned URL to the content and add a NIP-92 `imeta` tag (url, m, x, dim if known).
   - On failure: offer to "use the original URL instead" or abort.
4. Build the kind-1 event `{content, tags: [...imeta, ["client","XMRadar"]], created_at: now}`.
   - Optional (off by default): append the source URL and add an `["r", sourceUrl]` tag.
5. Sign it through the bridge, publish through the background, and show per-relay results plus the `nevent`/njump link to copy.
6. Duplicate guard: store the hashes of source URLs already posted (`storage.local`) and warn before re-posting.

## Options page
- Relays: textarea, plus a "Load from my NIP-65" button.
- Blossom server URL. Default `https://blossom.primal.net`, editable.
- Toggles: append source link; strip trailing hashtags/`t.co`.
- "Test signer" button: shows the npub and whether NIP-07 was found on a test page.

## Permissions
`contextMenus`, `storage`, `activeTab`, `scripting`, plus `host_permissions: ["<all_urls>"]` (acceptable for personal use; it's needed for image fetches and the content script). Firefox: `browser_specific_settings.gecko.id`, MV3. MAIN-world content scripts need Firefox 128+.

## Layout
```
wxt.config.ts
src/entrypoints/background.ts
src/entrypoints/content/index.tsx      # isolated: target tracking, extractor, modal
src/entrypoints/bridge.content.ts      # world: MAIN, NIP-07 proxy
src/entrypoints/options/{index.html,main.tsx}
src/extractors/{index,x,bluesky,mastodon,linkedin,facebook,generic,html-to-text}.ts
src/nostr/{event,relays,blossom}.ts
src/messaging.ts                       # typed message contracts
tests/fixtures/*.html, tests/*.test.ts
```

## Implementation phases
1. Scaffold WXT with TS and Preact. Builds for `chrome` and `firefox` both load unpacked.
2. Messaging contracts, the MAIN-world bridge, and the signer handshake. Verify: modal shows the npub on x.com with Alby/nos2x.
3. Generic extractor and modal. Publish text-only notes through background relays. **Milestone: first real note.**
4. Site extractors with fixtures and tests (X → Bluesky → Mastodon → LinkedIn → Facebook).
5. Blossom upload with `imeta`.
6. Options page, NIP-65 relay loading, duplicate guard, keyboard command.
7. `pnpm build && pnpm zip` for both browsers. README covers loading unpacked in Chrome, and installing in Firefox via `about:debugging` or as a signed self-distributed XPI through AMO "unlisted" so it survives restarts.

## Testing
- Unit:
  - Extractors run against saved HTML fixtures (text, image URLs, source URL).
  - `html-to-text` edge cases.
  - Event building and `imeta` tags.
  - Blossom auth event shape.
  - Relay fallback logic.
- Manual checklist per site in Chrome and Firefox: right-click a post → modal shows correct text and images → publish → the note appears on njump.me.
- No live-relay calls in automated tests; mock `SimplePool`.

## Risks
- **Site DOM churn** (X and FB especially): isolated selectors plus the generic fallback (selection) mean it degrades but never fully breaks.
- **Signer not injected on some pages**: the modal says so, with a link to the options test.
- **FB/LinkedIn image URLs are signed and expire**: they're fetched right away at publish time, which is fine.
- **Long X posts / threads**: MVP posts a single note; threads are out of scope.

## Revisions after OpenCode review (round 1, 7.1/10)
- **Security model (S1, S2)**
  - There is no secret channel between the ISOLATED and MAIN worlds; page scripts can see every `postMessage`. The real security boundary is the signer's approval prompt.
  - The bridge is injected on demand with `scripting.executeScript({world:'MAIN'})`, and only after the user opens the composer. The persistent `bridge.content.ts` is dropped.
  - The bridge allows only kinds 1 and 24242, validates the event shape, and confirms the returned pubkey and signature match.
  - The background keeps a composer session `{id, tabId, expires}` created by the context-menu/command handler. `upload`/`publish` messages must carry a matching session id and come from the same `sender.tab.id` with `sender.id === runtime.id`. Sessions expire after 15 min.
- **Blossom sequence (C1)**
  1. content → bg `fetch-image` returns `{sha256, mime, size, dim}`, with the bytes cached in the bg by sha256.
  2. content → bridge signs 24242 `{t:upload, x, expiration}`.
  3. content → bg `upload-image {sha256, auth}`: the bg sends `PUT /upload` with `Authorization: Nostr <b64>`, accepts 200/201, then returns the URL.
  - Timeouts on every step; one retry.
  - `data:`/`blob:` image sources are fetched in the content script instead; if that fails, the original URL is linked.
- **t.co links (C2)**: use the anchor text when it isn't truncated (`…`), and the `title` attribute when present. Otherwise keep the t.co URL.
- **Signer timing (F1)**: the bridge polls for `window.nostr` for up to 3s. The modal shows "no signer / locked" with a retry button.
- **Firefox permissions (F2)**: the options page checks `permissions.contains({origins:['<all_urls>']})` and shows a grant button. The README documents this.
- **Messaging fallback (F3)**
  - Pass `frameId` to `tabs.sendMessage`; the content script runs in `all_frames`.
  - On "Receiving end does not exist", inject the content script with `scripting.executeScript` and retry.
  - Restricted pages (chrome://, the Web Store, etc.) get a notification instead.
- **Relay timeouts (F4)**: each publish runs `Promise.allSettled` with a per-relay timeout (6s). Each relay's `ok`/reason is shown in the UI. No pool state is kept across handlers.
- **CSS (C3)**: `createShadowRootUi` with `cssInjectionMode:'ui'`; class-based styles only, no inline style attributes.
- **Mastodon detection (C4)**: `meta[name=generator][content*=Mastodon]`, or the presence of `.status__content` / `.detailed-status`.
- **imeta (C5)**: entries in the form `["imeta","url <u>","m <mime>","x <sha>","dim WxH","alt <alt>"]`, deduplicated by `x`. `dim` comes from `createImageBitmap` in the bg. Source alt text is carried over.
- **Shortcut (C6)**: track the last `pointerover`'d element (throttled); fall back to the selection's anchor node.
- **Modal UX (C7)**
  - Accessibility: `aria-modal`, Escape to close, focus on the textarea.
  - The Publish button is disabled and shows a busy state while publishing.
  - Each relay gets its own result row.
  - Closing the modal cancels pending UI work, but already-sent publishes are not recalled.
- **Test signer (C8)**: the options button opens `https://example.com`, injects the bridge, and shows the npub or the error.
- **Duplicate guard (C9)**: normalize the URL (drop the query/fragment for known sites), hash normalized URL + content, and record it only after at least one relay accepts.
- **NIP-65 (F5)**: query kind 10002 across the default relays with a timeout and deduplicate the write relays.
- **Debug and libraries**
  - A debug toggle shows the unsigned event JSON before signing.
  - Use `wxt/browser` for a unified browser API across Chrome and Firefox.
  - Pin dependency versions.

## Future (not MVP): X ↔ Nostr identity badge and tips

> Superseded by **[PLAN-PHASE2.md](PLAN-PHASE2.md)**, which uses xmr.bio + NIP-A3 + NIP-39. The notes below are the original sketch.
- **Binding**: use NIP-39 external identities. The user's profile claims `twitter:<handle>`, and the proof is a tweet that contains their npub. The extension can build the claim and pre-fill the proof tweet.
- **Badge**: a content script on x.com looks up the author handle of each visible tweet and finds the matching Nostr profile by querying relays for the `i` tag, with a local cache. It verifies the proof tweet (author == handle, text contains the npub) before showing a Nostr icon. Without verification, anyone could claim any handle.
- **Tips**:
  - Nostr has no standard Monero field, so we'd use a custom profile field (e.g. `monero` in kind 0). Clicking the badge shows a `monero:` URI and QR code, and the tipper pays from their own wallet. The extension never holds funds.
  - Also offer Lightning zaps (NIP-57, `lud16`), which are the Nostr-native standard.
- **Limitation**: only visitors who have the extension installed see the badge.
- **MVP prep**: the X extractor already resolves the tweet author's handle, and the Shadow-DOM UI is reusable.
