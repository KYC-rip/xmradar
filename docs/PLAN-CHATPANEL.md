# PLAN-CHATPANEL: chat.xmr.club in a side panel, with a room per site

## Why
Users asked to chat while they browse, without a separate tab. chat.xmr.club already has rooms
(`?room=<slug>`, `[a-z0-9_-]`, ≤20 chars, default `lobby`), a compact layout for frames (`?embed=1`),
and uses a NIP-07 signer when one is present. Its `?embed=1` page now sends
`frame-ancestors … chrome-extension: moz-extension:` (live, checked), so an extension page may frame it.
XMRadar adds no chat code of its own: the panel only frames the page.

## 1. The panel
- New WXT entrypoint `src/entrypoints/sidepanel/` (index.html, main.ts, style.css). WXT emits Chrome's
  `side_panel.default_path` + the `sidePanel` permission, and Firefox's `sidebar_action` (title
  "XMRadar chat", the extension icon).
- Layout: a slim bar on top, then one iframe filling the rest.
  - Bar: the room name ("#lobby" / "#x"), a **Lobby** button, a **<Site> room** button (only when the
    active tab maps to a room, see 2), and **Open in a tab** (`https://chat.xmr.club/?room=<slug>`,
    `target=_blank rel=noopener noreferrer`).
- The iframe:
  - `src` only from `chatUrl(slug)` = `https://chat.xmr.club/?embed=1&room=<slug>`; `slug` passes
    `^[a-z0-9_-]{1,20}$` or becomes `lobby`. Built with `URL`/`URLSearchParams`, never string-joined
    from page data.
  - `sandbox="allow-scripts allow-same-origin allow-forms allow-popups"` (no top navigation, no modals,
    popups stay sandboxed; amendment 5), `referrerpolicy="no-referrer"`, no `allow=` features.
  - **Isolation rule (xmr.club's):** the chat is untrusted. The panel never posts to it, never listens for
    its messages (no `message` listener), never reads its DOM, and passes it nothing but the room in the URL.
- Room change = set a new `src` (the chat reloads into that room). The last room is kept in
  `local:chatRoom` so reopening the panel returns there; default `lobby`.

## 2. A room per site (the user's ask: on X → the X room, plus a common lobby)
- Pure `roomFor(url, sites): { slug, label } | null` in `src/chat/rooms.ts`:
  - `x.com`, `twitter.com` (and `mobile.` subdomains) → `{ slug: 'x', label: 'X' }`;
  - a host listed in the xmr.club directory, exact host via `sitesFor` → that listing's room (smallest
    `id` when several), `roomSlug(id)` per amendment 4, label = listing name;
  - anything else → null (the bar shows only Lobby).
- **No automatic switching.** The panel watches the active tab (`tabs.onActivated`, `tabs.onUpdated`
  for the active tab, `windows.onFocusChanged`) only to show or hide the **<Site> room** button. Loading a
  room happens only on a click. Why: switching by itself would tell chat.xmr.club (its `/api/recent?room=`
  cache) and the relays which sites the user visits. Only rooms from the fixed list above can ever be
  offered, so arbitrary domains never become room names.
- The tab URL is read locally (`tabs.query`, covered by the existing `<all_urls>` host permission) and
  goes nowhere.

## 3. Opening it
- Popup: a **Chat** nav card ("Chat on chat.xmr.club, a room for this site and a lobby"). The click
  sequence is amendment 7.
- Chrome also gets the side panel from its own side-panel menu; Firefox from View → Sidebar.

## 4. What users should know (README "Chat")
- The chat is chat.xmr.club; XMRadar only shows it. Messages go to Nostr relays as the chat decides.
- Inside the panel the chat keeps its own storage (browsers partition framed pages), so without a signer
  it gets a separate anonymous identity from a chat.xmr.club tab. With a NIP-07 signer it can sign as
  you, if the signer injects into framed pages (checked live per signer before release).
- Picking a site's room tells chat.xmr.club and the relays that room's name, nothing else.

## Tests
- `chatUrl`: lobby default, valid slug, bad slugs (`../`, 21 chars, uppercase, empty) → lobby; origin is
  always `https://chat.xmr.club`, `embed=1` always set.
- `roomFor`: x.com/twitter.com/mobile.x.com → x; a listed host (exact, `www.` ignored) → its room;
  a subdomain of a listed host → null; several listings → smallest id; unlisted / non-http → null.
- `roomSlug`: see amendment 4.
- Built manifests (both browsers, like the existing manifest tests): Chrome has `side_panel` and
  `sidePanel`; Firefox has `sidebar_action`; no new host permission.
- Panel source: the iframe's sandbox list is exactly `allow-scripts allow-same-origin allow-forms allow-popups`, and the panel has no `postMessage`
  or `addEventListener('message'`.

## Live check (before release)
Chrome and Firefox: open from the popup; lobby loads; on x.com the **X room** button appears and works;
on an unlisted site it doesn't; switching tabs never reloads the frame; with the user's signer, whether
the chat sees `window.nostr` in the panel (reported, not required).

## Out of scope
Message buttons on badges/receipts (direct messages), unread counts, notifications from the chat.

## Amendment after plan review round 1 (6.5, failed) — these rules replace the matching ones above
1. **WXT output verified.** A throwaway `src/entrypoints/sidepanel/index.html` (removed again) built to
   Chrome `side_panel: {default_path: 'sidepanel.html'}` + permission `sidePanel`, and Firefox
   `sidebar_action: {default_panel: 'sidepanel.html', default_title: <the page title>}`. A manifest test
   fails if either is missing.
2. **Exact host, via the existing helper.** `roomFor` uses `sitesFor(feed, host)` as is (normalized host,
   `www.` dropped, exact match, platform hosts excluded). No subdomain matching; the test says so
   (`app.example.com` for a listing of `example.com` → null). X is handled before, by its own rule.
3. **One listing, deterministically.** Several listings on one host → the one with the smallest `id`
   (plain string order), so adding a listing elsewhere never moves a room.
4. **Room names (`roomSlug(id)`, pure).** Of 360 listing ids today, 357 are already valid room names.
   - Kept as is: an id matching `^[a-z0-9-]{1,20}$` (no `_`) that isn't reserved (`lobby`, `x`).
   - Otherwise generated: the id lowercased, other characters → `-`, first 13 characters, then `_`, then
     6 hex digits of the 32-bit FNV-1a hash of the full id (`cypher-stack-research` → `cypher-stack-_1a2b3c`).
   - A kept name never contains `_` and every generated one does, so a kept id can't equal a generated
     name. Two generated names can share a room only if both the first 13 characters and the 24 hash bits
     match; with 3 such ids today that's negligible, and the outcome would only be a shared room.
   - Tests: kept id, reserved ids, an id with `_`, long ids, two long ids sharing 13 characters → different.
5. **No `allow-popups-to-escape-sandbox`.** Sandbox = `allow-scripts allow-same-origin allow-forms
   allow-popups`. Links the chat opens in a new tab stay under the same sandbox (no top navigation, no
   modals). If a chat flow needs more, that's a later, stated exception.
6. **The feed is watched too.** The panel reads `local:siteFeed` (extension page, same as the popup's
   data) and re-evaluates the **<Site> room** button on feed changes as well as on tab/window changes.
   Re-evaluating only shows/hides the button; it never changes the frame's `src`.
7. **Opening, exactly.** Popup **Chat** card click handler, with no `await` before the call:
   - Chrome: `if (chrome.sidePanel?.open) chrome.sidePanel.open({ windowId })` where `windowId` was read
     when the popup loaded (`windows.getCurrent()` at startup, so the click needs no await). Then
     `.then(() => window.close(), openTab)`.
   - Firefox: `if (browser.sidebarAction?.open) browser.sidebarAction.open().then(() => window.close(), openTab)`.
   - Neither API → `openTab()` = `tabs.create({ url: 'https://chat.xmr.club/' })`, then close.
   The call is wrapped in try/catch: a synchronous throw also falls back to the tab.
   Pure `openChat(api)` takes the APIs as arguments so it is unit-tested: Chrome path, Firefox path,
   reject → tab, throw → tab, missing APIs → tab, and that the open call happens synchronously.
   Live: both browsers, from the popup.
8. **Panel logic is a pure controller, tested.** `src/chat/panel.ts`: `chatPanel({ frame, bar, getActiveUrl,
   feed, store })` with injected deps. Tests (happy-dom): starts on the stored room (default lobby);
   tab change / feed change shows or hides the site button without touching `frame.src`; clicking the
   site button sets `src` to `chatUrl(slug)` and stores the room; Lobby likewise; no `message` listener
   and no `postMessage`.
