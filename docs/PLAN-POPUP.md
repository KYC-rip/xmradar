# PLAN-POPUP: toolbar popup

Clicking the XMRadar icon opens a popup with the things used day to day. Setup stays on the options page, which the popup links to.

Revision 2: changes after plan review 1 (6.9) are marked with their review IDs.

## 1. What moves where

| Item | Popup | Options page |
|---|---|---|
| Monero on X: "Show badges" and "Discover via Nostr" | yes, saved on change, one-line privacy hint | **removed entirely**: HTML, `load()` reads and the Save write (XMR-TOGGLES-REMOVAL) |
| Identity status: address published, X linked, badge live, Check status | yes, read-only | kept, next to the setup steps |
| Identity setup: handle, publish address, link X, review/sign | no ("Set up" link) | kept |
| Burner email: address, Copy, Get, Burn, Forget, status | yes | kept |
| Burner import of a paid inbox | no ("Use a paid inbox…" link) | kept |
| Signer, relays, images, behaviour, host-permission grant | no | kept |

Why setup stays in options: signing opens a temporary signer tab, and a popup closes as soon as focus leaves it, which would drop the reviewed diff and the result list.

### Layout

A tab bar, so more tabs can be added later without reshuffling:
- **Monero**: the two toggles and the identity status.
- **Burner**: the burner email panel.
- Later, not in this plan: **Swap**, a kyc.rip swap widget. Whether it is an iframe of kyc.rip (needs `frame-src` in the extension CSP, and kyc.rip must allow framing by the extension origin) or a native panel calling the kyc.rip API is decided in its own plan.

Tabs follow the ARIA tabs pattern (TABS-A11Y): a `role="tablist"` container, `role="tab"` buttons with `aria-selected` and `aria-controls`, `role="tabpanel"` panels with `aria-labelledby`, roving `tabindex`, and the Left/Right/Home/End keys. The last open tab is remembered in `storage.local` (`popupTab`); an unknown value falls back to Monero. Each panel's code is loaded on first show (dynamic `import()`), so a heavy future tab doesn't slow the others.

Footer: "All settings".

### Links into the options page (POPUP-HASH-NAV)

`openOptionsPage()` takes no section, and a plain link would navigate the popup itself. All three links call `browser.tabs.create({ url: browser.runtime.getURL('/options.html#identity' | '#burner' | '') })` and then `window.close()`. The options page scrolls to `location.hash` after its first render (the sections render async). Tested in Chrome and Firefox.

## 2. Code

- `src/entrypoints/popup/index.html`, `main.ts`, `style.css`. WXT turns `entrypoints/popup` into `action.default_popup`; no manifest edit. Width 340 px.
- **Shared styles** (SHARED-CSS): the panel classes used by both pages (`row`, `hint`, `hidden`, `state`, `ok`, `error`, `warn`, `primary`, `confirm`, colour tokens, dark mode) move from `options/style.css` to `src/ui/base.css`. Both pages import it; each page's own `style.css` keeps only its layout.
- **Shared panels** (SHARED-UI-REFS): each is a function `mount(root: HTMLElement)` that finds its children with `root.querySelector('[data-…="name"]')`. The options HTML switches the burner, status and toggle elements from `id` to these `data-` attributes, and both pages hold the same markup for them.
  - `src/ui/burner-panel.ts` (today's `options/burner.ts`). Required elements: address, copy, meta, create, burn, forget, status. Optional: the import form (`importBox` and its fields); when absent, the import code is skipped. A required element missing throws at mount, with its name.
  - `src/ui/identity-status.ts`: the status lines and the Check status button, with its own status line and busy flag. `options/identity.ts` keeps setup, review and signing, and calls the shared `refresh()` after a publish.
  - `src/ui/xmr-toggles.ts`: reads `xmrSettingsItem`, writes it on `change`, and watches it so an open options page and the popup agree. It is the only code that touches these checkboxes.
- Options `main.ts`: the toggle reads, `badgesEl`/`discoveryEl` and the `xmrSettingsItem` write on Save are deleted. The Save button covers relays, images and behaviour only.
- **Burn confirmation**: an inline two-step button on both pages ("Burn now" → "Confirm burn", which resets after 5 s). Firefox popups don't support `window.confirm`.

## 3. Behaviour in a popup

### Get address (POPUP-POW-LIFETIME)

The create runs in the background and today depends on the caller's port to keep the service worker alive. A popup that closes drops the port, and the worker can then stop mid-proof-of-work. Two changes, which also help the options page:

1. **Keepalive in the background**: while `createFreeInbox` runs, the background calls `browser.runtime.getPlatformInfo()` every 10 s. Chrome (110+) resets the worker's idle timer on every extension API call, and Firefox's event page idle timer is reset by API activity too. The timer stops in `finally`. The proof of work is capped at 45 s, so the keepalive is bounded.
2. **Creating state is stored**: `session:burnerCreating` holds `{ startedAt }` while a create runs, and `session:burnerLastError` holds `{ message, at }` when one fails. Both are written by the background, not the page. A popup opened mid-create shows "Getting an address…" and disables Get; one opened after a failure shows the error once and clears it. A `startedAt` older than 90 s is treated as stale (the worker died) and ignored.

What's left at risk: the worker dying in the moment between GhostMail answering the create and the token being written. Then the next click gets the network's 429 and the limited message (one free address per hour), as documented in PLAN-BURNER CREATE-RETRY-LOSS. The keepalive makes this as unlikely as on the options page today.

### Check status (CHECK-STATUS-LOST)

The background stores the last `setup-status` result in `session:setupStatusLast` with its time, whoever asked. Both pages render it at once on open ("checked 3 min ago"); Check status refreshes it. A popup that closes during the check (relays and xmr.bio, up to about 15 s) loses nothing: the result is there next time.

### Senders

`isExtensionPage` already accepts the popup (same extension origin), so no gate changes.

## 4. The token boundary, stated accurately (TOKEN-BOUNDARY-CLAIM)

The runtime boundary is between content scripts and the extension: content scripts run under the web page's origin and cannot open the extension origin's IndexedDB. The options page and the popup are trusted extension pages on that same origin; they *could* open the database, and the rule that they don't is code discipline. The tests enforce that discipline in two ways:
- the import-graph walk, now from `options/main.ts`, `popup/main.ts` and every dynamically imported panel module, never reaches `burner/token-store.ts`;
- a source scan: the database name `xmradar-burner` and `indexedDB` appear only in `burner/token-store.ts` under `src/`.

## 5. Tests

- Token boundary: both checks above.
- `burner-panel`: mounts with and without the import form; a missing required element throws with its name; the two-step burn sends `burner-burn` only on the second click and resets after 5 s (fake timers).
- `xmr-toggles`: a change writes the setting; a storage change updates the checkbox.
- Tabs: arrow keys move selection and focus, `aria-selected` follows, `popupTab` round-trips, an unknown value falls back to Monero.
- Background keepalive: `createFreeInbox` with a slow fake proof of work calls the keepalive and stops it after success and after failure; `burnerCreating` is set and cleared; a failure sets `burnerLastError`.
- Build check: Chrome and Firefox manifests contain `action.default_popup`.

## 6. Manual test

1. Click the icon: the popup opens on the Monero tab; switch to Burner, close, reopen: Burner is shown. Arrow keys switch tabs.
2. Toggle badges off: badges disappear on an open X tab; an open options page has no toggles any more.
3. Check status, close the popup straight away, reopen: the result is shown with its time.
4. With DevTools CPU throttle 6× on the background worker, get an address in the popup and close it at once. Reopen within the 45 s: "Getting an address…". Reopen after: the address is there, or the error is shown once.
5. Burn: two-step confirm, in Chrome and Firefox.
6. Links: "Set up" opens the options page scrolled to identity, "Use a paid inbox…" to burner, "All settings" to the top, in Chrome and Firefox.

## 7. Revision 3: review 2 (8.1, pass) items and the xmr.bio status

Review 2 items, folded in:
- KEEPALIVE-FIREFOX: verify on Firefox 140 in manual test 4 (popup closed, background inspector open). The result is recorded in §8 after testing.
- KEEPALIVE-TEST-SEAM: the keepalive and creating/error state are one helper, `src/burner/tracked.ts` `trackCreate(run, {creating, lastError, ping})`, used by the background and tested on its own with fake timers. `ping` is called at once and every 10 s.
- BURNER-LAST-ERROR-ONCE: simpler rule instead of "show once and clear": `burnerLastError` stays until the next create starts or 10 minutes pass, and every page with the burner panel shows it as "Last attempt failed: …". No consumer, so nothing is lost or doubled.
- DYNAMIC-IMPORT-TEST: the import walker follows `import('…')` too.
- IDENTITY-STATUS-TEST: the status text is a pure function `statusLines(status)` with tests; the panel only renders it.
- SHARED-CSS-MISSING: `base.css` takes every rule from `options/style.css` that isn't page layout, including the inputs, `details` and `.diff`.
- XMR-TOGGLES-WORDING: the toggles live only in the popup; the options page has none.

The xmr.bio status (user report, 26 Oct): the user's handle is verified on xmr.bio and linked to their npub there, but the status said "not linked yet" because it only looked at Nostr.
- `setup-status` also resolves the confirmed handle on xmr.bio (the existing `xmrbio-resolve` path and queue: one signed `/resolve` request, only on a click). `SetupStatus.xmrbio` is `null` (no handle), `{found:false}`, `{found:true, address, check, linked}` (`linked`: a `nostr` proof for this npub), or `{error}`.
- `statusLines()` shows the two sources separately, warns when both have a usable address and they differ ("badges show the xmr.bio one"), and says where a badge comes from: xmr.bio once the directory is live in XMRadar (Phase 2d, directory from 3 Nov), or Nostr for users with discovery on.
- The relay line is a warning, not green, when some relays couldn't be read.

## 8. Review 3 (code, 8.4, pass) and manual results

Fixed after review: `xmrbioLinked()` accepts an npub or hex proof identifier (tested); the status refreshes after a successful retry; a stored status from another signer key isn't shown; the Checking copy names xmr.bio and the longer wait.

Keepalive (KEEPALIVE-FIREFOX): pending the user's manual test 4 in Chrome and Firefox 140. If Firefox lets the event page die mid-create, the fallback is a dedicated Worker for the proof of work.
