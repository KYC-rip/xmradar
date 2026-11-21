# XMRadar — Chrome Web Store submission kit

Everything to paste into the Chrome Web Store developer dashboard, plus the
assets and the package. The dashboard itself is reachable only by you: Chrome
does not let extensions (including BrowserMCP) read or fill
`chrome.google.com/webstore`.

## 1. Package

Upload **`output/xmradar-0.6.17-chrome.zip`**.

- Built from the v0.6.17 tree (`0ac2f19`) plus the Chrome-only manifest fix in
  `wxt.config.ts` (uncommitted at build time): no `browser_specific_settings`
  (Firefox-only key), and `minimum_chrome_version: "114"` for the side panel.
  Commit that fix before the next release so CI's Chrome zip stays clean too.
- Typecheck and the full test suite pass (`pnpm compile`, `pnpm test`).
- SHA-256 is printed at the bottom of this file after the final build.

If the dashboard asks for a **source code** upload, Chrome does not require one
for a normal extension. Firefox/AMO does; that is the separate `-sources.zip`.

## 2. Store listing

| Field | Value |
| --- | --- |
| Name | `XMRadar` |
| Short description | `Monero on X: tip badges, your own XMR badge, lookalike warnings, burner email, and posts copied to Nostr. No keys, no funds.` (124 chars) |
| Category | **Social & Communication** |
| Language | **English** |
| Homepage URL | `https://xmradar.app` |
| Support URL | `https://github.com/KYC-rip/xmradar/issues` |
| Privacy policy URL | `https://xmradar.app/privacy` |
| Mature content | No |
| Visibility | Public |
| Regions | All regions |
| Pricing | Free |
| Trader status | Choose **non-trader** unless you sell XMRadar or earn from it as a business. Donations alone normally do not make you a trader; if unsure, answer as kyc.rip's business status. |

### Detailed description (paste as plain text)

```
XMRadar brings Monero to the web pages you already use. It is free, open source, and holds no Monero keys and no funds.

ON X
- See who takes Monero. An XMR pill appears next to the name of people who published a Monero address, and their posts get a tip button.
- Tip from your own wallet. Open the tip dialog for a QR code and a monero: link that opens the wallet you already use.
- Send a Monero like (xo). A heart next to the tip button sends a public Nostr reaction to the author's key.
- Prove your own badge. Link your X handle to your Nostr key and Monero address with one proof tweet.

SWAP SAFETY
- Warnings before a lookalike loads. If a listed exchange or wallet has a lookalike, a typo or a confirmed impersonator, XMRadar shows a warning page before any request reaches the site.
- Signed receipts. On an exchange order page that carries a signed NKIP-0001 receipt, XMRadar checks the signature and the addresses and saves a copy in your browser for disputes.
- Letters of guarantee, checked against xmr.club's signed list.

MORE
- Burner email. Create a throwaway GhostMail address in one click for sign-ups.
- Copy posts to Nostr. From X, Bluesky, Mastodon, LinkedIn, Facebook or any page, right-click a post or selection, edit it in the composer, and publish through your NIP-07 signer. Images and videos go to your Blossom server. Threads, quote tweets and X Articles are supported.
- Chat in the side panel. chat.xmr.club opens beside the page you are on.

PRIVACY BY DESIGN
No account. No analytics. No telemetry. No ads. Settings and caches stay in your browser. Data leaves it only to the services a feature needs: your Nostr relays, your Blossom server, xmr.bio, GhostMail, or X. Each flow is described in the privacy policy. The daily update check, badge discovery, xmr.bio listing, Xap notifications, tag suggestions and site warnings can each be turned off in Options.

REQUIREMENTS
- Chrome 114 or later.
- A Monero wallet that opens monero: links (optional).
- A NIP-07 Nostr signer for publishing posts to Nostr (optional; XMRadar can make a local key for badges, xos and Xap receipts).

XMRadar is free software under the GNU GPL v3 or later. Source: https://github.com/KYC-rip/xmradar
X is a trademark of X Corp. XMRadar is not affiliated with X Corp.
```

### Graphic assets

| Asset | File | Notes |
| --- | --- | --- |
| Store icon | `store/icon-128.png` | 128×128 PNG |
| Screenshot 1 | `store/screenshots/shot-01.png` | 1280×800, tip badge on a post |
| Screenshot 2 | `store/screenshots/shot-02.png` | 1280×800, tip dialog |
| Screenshot 3 | `store/screenshots/shot-03.png` | 1280×800, XMR badge on a profile |
| Small promo tile | `store/promo-440x280.png` | 440×280 PNG (optional) |

Screenshots are composed from real XMRadar UI captures (`site/shots/`), not
mock-ups. Source HTML for regenerating them is in `store/_src/`.

## 3. Privacy practices tab

### Single purpose

```
XMRadar is a Monero companion for the web: it shows Monero tip and identity badges on X, opens tips in the user's own wallet, warns about lookalike exchange sites before they load, and lets the user carry posts to Nostr. Every feature serves that one purpose of bringing Monero identity, payments and safety information to the page the user is already on. There are no unrelated features, no ads and no analytics.
```

### Permission justifications

**host_permissions — `<all_urls>`**

```
XMRadar has no fixed site list. It works wherever the user is: (1) copying a post or selection to Nostr from X, Bluesky, Mastodon, LinkedIn, Facebook, or any page the user chooses; (2) detecting and checking signed swap receipts and letters on an exchange's order page; (3) showing a warning before a lookalike of a listed exchange loads. Broad host access is also required by declarativeNetRequestWithHostAccess for the lookalike redirect. The content script reads the current page only to provide these features. It does not collect, log or upload page content automatically, and does not send anything to the publisher.
```

**declarativeNetRequestWithHostAccess**

```
Used only to protect the user from phishing. XMRadar downloads xmr.club's signed list of exchange and wallet names, verifies the signature inside the extension, and creates main-frame redirect rules for lookalikes, typos and confirmed impersonators. A matching navigation is sent to XMRadar's local warning page before the request reaches the site, and the user can read why and continue. No other request is blocked, changed or observed.
```

**contextMenus**

```
Adds right-click items the user invokes: Tip with Monero (look up on xmr.bio), Look up on xmr.bio, Copy post to Nostr, and Copy selection to Nostr. They act only when clicked, on the page the user is viewing.
```

**storage**

```
Saves the user's settings and switches, their public key and X handle, and small local caches (badge and proof results, relay list, signed directory, recent lookups) so the extension does not repeat requests. Settings may be copied by the user's own browser sync. Nothing in storage is sent to the publisher.
```

**activeTab**

```
Gives temporary access to the current tab only when the user invokes XMRadar (toolbar button, keyboard shortcut, or context-menu item) so it can read the hovered post or selected text and offer to copy it. It is not used for background browsing or history.
```

**scripting**

```
Injects the copy/extract bridge into the current tab when the user asks to copy a post, and re-injects the content script into already-open tabs after an extension update. It runs only on the tab the user chose and returns the selected post's data to the extension.
```

**notifications**

```
Shows at most one notification when a newer XMRadar version is published and, only if the user turns it on, one notification for new Xap receipts. Clicking a notification opens the matching XMRadar page. There are no promotional notifications.
```

**alarms**

```
Chrome MV3 service workers are suspended, so alarms schedule the once-daily update check and the optional 30-minute Xap receipt check. The alarms are cleared when the corresponding switch is off.
```

**sidePanel**

```
Shows chat.xmr.club in Chrome's side panel when the user chooses Chat from XMRadar's menu, so they can chat while browsing. The panel loads only after that click.
```

### Remote code

**No.** All JavaScript is bundled in the package. XMRadar fetches data (signed
lists, relay events, API responses) but never downloads or executes code.

### Data usage checkboxes

Check these:

- **Personally identifiable information** — X handle, Nostr public key, X
  handle-to-key link.
- **Financial and payment information** — the user's own Monero address and the
  amounts they choose to put in a Xap receipt.
- **Authentication information** — the GhostMail access token for the user's own
  burner inbox. The user's Nostr secret key is never transmitted.
- **Personal communications** — posts, selections and images the user chooses
  to publish to Nostr; burner mail requested and displayed through GhostMail.
- **User activity** — xos and Xap receipts the user creates; with discovery on
  (off by default), the handles of accounts on pages the user views.
- **Website content** — the post text, images and videos the user chooses to
  copy.

Leave these unchecked: **Health**, **Location**, **Web history** (XMRadar does
not read or transmit browsing history; discovery looks up accounts visible on
the current page, not a history list).

### Data usage explanation

```
Data is sent only for a feature the user uses.

- Website content and personal communications: posts, images and videos the user chooses to copy go to their Nostr relays and Blossom server; burner mail is fetched from GhostMail only when requested.
- Personally identifiable information: one X handle is sent to xmr.bio on a user-requested lookup. The user's own handle, Monero address, public key and proof-tweet id go to xmr.bio only if the default-on, switchable listing is left on.
- Financial information: the user's Monero address is published to Nostr as part of their identity and in Xap receipts they create. XMRadar never handles funds.
- User activity: xos and Xap receipts are public Nostr events. With discovery on (off by default), handles on pages the user views are looked up on relays.
- Authentication information: a GhostMail access token, only for the user's own burner inbox.

No data is sold, used for advertising, or used for creditworthiness. No analytics or telemetry.
```

### Certified answers

- Does the item sell or transfer user data to third parties? **No.**
- Is user data used or transferred for purposes unrelated to the item's single
  purpose? **No.**
- Is user data used or transferred to determine creditworthiness or for
  lending? **No.**

## 4. Reviewer test instructions (paste into "Test instructions")

```
XMRadar needs no account or login. Most of it can be checked in two minutes.

1. Lookalike warning (no login, no real site contacted): wait about 10 seconds after install for the signed xmr.club list to load (opening Options once also triggers it), then open https://www-trocador.example/ in a new tab. XMRadar redirects to its local warning page before any request reaches the host and explains that the address is a lookalike of trocador.app. The .example TLD is reserved, so this tests the guard without visiting a real site. Click Continue if you want to see the recorded decision; you do not need to.
2. Options: click the XMRadar toolbar icon, then "All settings". Every switch and the privacy explanation are visible without an account.
3. Burner email: toolbar icon, then "Burner email", then "Create address". The free tier solves a short proof-of-work and returns a GhostMail address. Open the inbox to see the empty mailbox. This is the only step that contacts mail-api.kyc.rip.
4. X badges (optional; X may ask you to log in): after the same short wait, open https://x.com/XBToshi. @XBToshi is in xmr.bio's signed directory, so the XMR pill appears next to the display name and the action bar shows a Monero tip button with an amount. Click it for the tip dialog with a QR code and a monero: link. No transaction is made and no wallet is needed. If X shows a login wall to logged-out visitors, the other steps still exercise the same code paths.
5. Copy to Nostr (composer only): on any page, select a paragraph, right-click, then "Copy selection to Nostr". The composer opens with the text and tags. Publishing needs a NIP-07 signer; you can close the composer without publishing.
6. Chat: toolbar icon, then "Chat". chat.xmr.club opens in Chrome's side panel.
7. Notifications and alarms are used only for the daily update check and the optional Xap receipt check; neither is needed for the test.

Site access is used for the copy/extract features and signed exchange receipts. The lookalike warning uses declarativeNetRequest. No page content is uploaded unless the tester clicks Copy. The extension has no analytics or telemetry.
```

## 5. Before you click Submit

- [x] Deployed 21 Nov 2026 — `https://xmradar.app/privacy` serves the policy.
- [ ] Upload `output/xmradar-0.6.17-chrome.zip`.
- [ ] Check the package tab shows no errors. Warnings about broad host access
      are expected; the justifications above answer them.
- [ ] Fill the listing fields and upload the five images.
- [ ] Fill Privacy practices with the text above.
- [ ] Paste the reviewer instructions.
- [ ] Set visibility Public, all regions, free.
- [ ] Submit for review.

## 6. If review pushes back

- **Broad host permissions:** point to the "copy any page" feature, the
  receipt/letter checks on exchange order pages, and the lookalike redirect.
  All are user-initiated or protective; none upload page content automatically.
- **Redirects navigations:** it is a phishing warning built from a
  signature-verified list, and the user can continue.
- **Multiple features / single purpose:** everything is Monero identity,
  payments and swap safety on the page the user is on; burner email and Nostr
  copying are privacy tools for the same audience. If asked to narrow it,
  remove the burner-email and chat mentions from the listing first, not the code.
- **X login wall:** the guard page, options, burner email and side panel tests
  need no X account. The badge test is the only one that may need a free X login.

---

## Package checksum

```
1051e1e9962c49c651749d07877e86898e2b522227488ad2115b06ca5b7c8770  xmradar-0.6.17-chrome.zip
```

Chrome Web Store does not let extensions automate its dashboard, so these
fields are for you to paste. Everything else in this repo is ready.

## Repo changes made (uncommitted)

- `wxt.config.ts` — strips Firefox-only `browser_specific_settings` from the
  Chrome build and sets `minimum_chrome_version: "114"`.
- `site/privacy.html` — the policy page; `site/build.py` copies it and sets its
  headers; `site/index.html` links to it. Deployed to xmradar.app.
- `store/` — this kit, `icon-128.png`, `promo-440x280.png`,
  `screenshots/*.png`, and the HTML sources in `_src/`.
