# PLAN-BURNER — burner email + OTP codes in XMRadar

Revision 2, 2026-10-25. This revision answers OpenCode round 1 (6.8):

- POW-SW-LIFETIME, DOMPARSER-IN-SW, CONTEXT-MENU-TARGET, ALARM-PERSISTENCE
- 429-WAIT-TIME, PAID-BURN-GUARD, OPTIONS-TOKEN-ACCESS, HTML-TEXT-INJECTION
- CREATE-RETRY-LOSS, OTP-FALSE-NEGATIVES, CONTROL-CHARS
- the review's suggestions

Tags in brackets mark where each one is handled.

## 1. Goal

A user signing up somewhere can get a throwaway address from kyc.rip GhostMail
(`mail-api.kyc.rip`) without leaving the page, and see the verification code
when it arrives.

**User decision (fixed):** a code is shown in a notification and in the
extension's inbox view, and the user copies it. XMRadar never writes a code
into a page field, and never opens a link from a mail.

Filling the *address* into an email field is in scope. It happens only when the
user asks for it from the context menu.

## 2. What GhostMail offers today (read from `kyc-rip/mail`)

| Endpoint | Use here |
|---|---|
| `POST /api/free {seed, nonce}` | Free inbox. Needs a proof of work: `sha256("seed:nonce")` must start with 20 zero bits. Gives a `<8 hex>@ros.rip` address for 60 min, limited to one per IP per hour. Returns `{email, token, expiresAt, ttl}`. On a 429 it returns `{error, email}`: the active address, **no token and no wait time**. |
| `GET /api/inbox?email&token` | `{emails[], expiresAt, pgpEnabled, serverTime}`, sent with `no-store`. Each email has `id, from, fromName, subject, text, html`. |
| `POST /api/email/delete {email, token, emailId}` | Delete one mail. |
| `POST /api/inbox/burn {email, token}` | Delete the inbox. Only Pro accounts refuse this without `confirm`. **Paid tier inboxes (BASIC/PREMIUM/PRIVATE) are deleted with just email + token** [PAID-BURN-GUARD]. |
| Paid tiers (bought at kyc.rip/mail) | BASIC $0.20 for 4 h, PREMIUM $1 for 3 d, PRIVATE $5 for 7 d, on better-reputation domains. They use the same inbox API with the user's email + token. |

All calls come from the background, which has the `<all_urls>` host
permission, so GhostMail's CORS list needs no change. **No kyc-rip change is
needed for v1**; optional items are in §8.

## 3. Architecture: the background owns everything

**The background is the only part that holds the token, calls GhostMail,
polls, and notifies.** [OPTIONS-TOKEN-ACCESS, ALARM-PERSISTENCE]

- The options page and content scripts talk to it through messaging. They
  never receive the token.
- The options page gets inbox data from a background snapshot in
  `storage.session`. Snapshot contents:
  - the address, expiry and watch state;
  - each message's id, sender, subject, cleaned text, codes and `hasLink`.

  It re-renders on `storage.onChanged`.
- Storage:
  - `storage.local` `burner:inbox` = `{email, token, expiresAt, tier, source:
    'free'|'imported', lastSeenIds[≤100], watchUntil}`. The token must survive
    a browser restart.
  - `storage.session` `burner:view` = the snapshot above. It has no token and
    no raw HTML.
- After an import, the import form's input is cleared. The token is never
  logged and never put in a notification, an error message or the DOM.

## 4. Phases

Each phase is its own commit and code review. You can stop after any phase.

### B1. Get an inbox

#### Proof of work [POW-SW-LIFETIME]

- `src/burner/pow.ts`: a synchronous `@noble/hashes` SHA-256 loop (already a
  dependency).
  - It runs in chunks of 50k hashes, with `await` between chunks.
  - Random 16-char seed. It gives up after 45 s.
- Benchmark on the dev Mac: 0.1–2.5 s over 5 runs, about 0.8 µs per hash.
  - The expected cost is 1M hashes; the long tail is about 3M.
  - A 4× slower device puts the tail at about 10 s.
- Keepalive:
  - The caller holds a `runtime.connect` port open, and the background posts
    progress on it every chunk. Port messages reset Chrome's idle timer.
  - Firefox 140's MV3 background is an event page, and the same port keeps it
    awake.
- B1 test gate:
  - a unit test of the loop and the bit counter;
  - a manual check with Chrome DevTools at 6× CPU throttle: it must finish
    while the port stays open.

  If it doesn't, fall back to a Web Worker in a Chrome offscreen document
  (`offscreen` permission, reason `WORKERS`). That's documented, and not built
  unless needed.

#### Create

- Started from:
  - the options page ("Get a 60-minute address"), which holds the port;
  - or "Get burner email and fill" (B2). There the content script holds the
    port and shows a small in-page "Getting address…" note.
- **No automatic retry** [CREATE-RETRY-LOSS]. If the response is lost after the
  server created the inbox, a retry only gets a 429.
- **On 429** [429-WAIT-TIME, CREATE-RETRY-LOSS]:
  - If `429.email` equals the stored inbox's address, reuse the stored token;
    this is not an error.
  - Otherwise: "Your network already has a free address (<email>) that this
    browser can't open. A new one is possible within an hour. Paid inboxes at
    kyc.rip/mail have no wait." No exact time is shown, because the server
    doesn't give one.

#### Import, burn, forget

- **Import:** paste an email + token from kyc.rip/mail for a paid inbox.
  - The background checks it with `GET /api/inbox` before saving.
  - `lastSeenIds` is seeded from that first fetch, so existing mail doesn't
    notify.
- **Burn** (free inboxes only): the button calls `/api/inbox/burn`.
- **Forget** (imported inboxes): removes it locally, with no network call.
  - Invariant: `source === 'imported'` never calls burn, because the backend
    would delete paid tiers [PAID-BURN-GUARD].
  - Unit test: the burn path throws for imported inboxes.
- **Expiry:** at `expiresAt` the inbox is removed locally. The server lets it
  expire on its own (KV TTL).
- Only one active inbox at a time.

### B2. Fill the address [CONTEXT-MENU-TARGET]

- Context-menu item on `contexts: ['editable']`:
  - "Fill burner email" while an inbox is active;
  - "Get burner email and fill" otherwise;
  - not shown while the feature is off.
- Finding the field: `onClicked` gives `info.frameId` and, on Firefox,
  `info.targetElementId`. The background injects a fill function into **that
  frame only** with `scripting.executeScript({target: {tabId, frameIds:
  [frameId]}})`.
  - **Firefox:** `browser.menus.getTargetElement(targetElementId)`.
  - **Chrome:** that API doesn't exist, so it uses `document.activeElement`.
    Right-clicking a text input or textarea focuses it in Chrome.
  - It accepts only:
    - `input` of type `email`, `text` or no type;
    - `textarea`;
    - a `contenteditable` element.
  - On anything else it shows "Click the email field and try again", and
    fills nothing.
- Filling:
  - For an input or textarea: use the prototype's native `value` setter, then
    fire `input` + `change` (bubbles) so React/Vue forms see it.
  - For a contenteditable element: insert the text at the caret.
  - Only that element is touched. It never submits.
- Copying the address is also available on the options page.

### B3. Watch for mail [ALARM-PERSISTENCE]

- Add the `alarms` permission. One alarm, `burner-poll`, every 0.5 min.
  - Chrome 120+ allows 30 s.
  - Firefox has no lower limit, so the same 30 s is used.
- `watchUntil` is stored in `burner:inbox`:
  - set to now + 15 min on create, import, fill, or "Watch again";
  - extended to at least now + 2 min while the inbox view is open (the options
    page pings every minute).
- On every background start (top-level code and `runtime.onStartup`):
  - if `watchUntil > now` and the inbox hasn't expired, the alarm is re-created
    (alarms don't survive a browser restart);
  - otherwise it's cleared.

  When the window passes, the alarm is cleared.
- Each tick runs one `GET /api/inbox`. A guard flag in `storage.session`
  stops overlapping ticks.
  - New messages are ids not in `lastSeenIds`. That list is capped at 100 and
    seeded on create, import, and the first fetch after a restart.
  - The background is the **only** notifier. The options page never polls on
    its own; it asks the background for an immediate tick when the view opens.
- A 404 or 403 stops polling, clears the inbox, and tells the user once
  (expired, burned, or bad token).

### B4. Find the code: two pure, DOM-free functions [DOMPARSER-IN-SW, HTML-TEXT-INJECTION, OTP-FALSE-NEGATIVES]

#### `htmlToText(html) → {text, hrefs}`

A string parser, with no DOM, so it runs in the service worker.

- The input is capped at 100 kB.
- These are removed along with their content:
  - `script`, `style`, `noscript`, `template`, `head`, `title`, `svg`;
  - comments;
  - elements whose inline style has `display:none`, `visibility:hidden`,
    `font-size:0`, `opacity:0` or `max-height:0`, as best effort.
- Then:
  - block tags become newlines and the remaining tags are stripped;
  - HTML entities are decoded;
  - `a[href]` values are collected into `hrefs`.
- `text` is used when present; `htmlToText` is the fallback.

#### `extractCodes(subject, text, hrefs) → {codes: {display, copy}[], hasLink, encrypted}`

- Input handling:
  - Text is normalized first: NBSP and other unusual spaces become a plain
    space.
  - A mail starting with `-----BEGIN PGP MESSAGE-----` returns
    `encrypted: true` and is not read.
- Candidates:
  - 4–8 digits, optionally split once by a space, hyphen or newline;
  - 9–10 digits only when the keyword is directly next to it (within 20
    characters);
  - 6–10 letters and digits containing at least one digit. Uppercase is always
    accepted. Lowercase or mixed case only when the keyword is directly next to
    it.
- Keywords:
  - English: code, verification, verify, OTP, one-time, passcode, PIN,
    security code, confirm, login, sign in, 2FA;
  - plus a fixed short list for de/fr/es/pt/ru/zh/ja.

  A candidate counts only within about 60 characters of a keyword. The
  subject is checked first.
- Rejected:
  - standalone years 1900–2099;
  - numbers next to a currency symbol or `%`;
  - parts of dates, times or phone-number patterns;
  - anything inside a URL.
  - "Order / invoice / tracking / reference" nearby vetoes a candidate **only
    when no code keyword is closer**.
- Output:
  - at most 2 codes. Score: subject hit, then distance to the keyword, then 6
    digits before other lengths.
  - `display` keeps the format the mail used; `copy` drops spaces and hyphens.
  - `hasLink`: some href or text URL is near "verify / confirm / sign in /
    magic link / log in".

Both functions are tested with plain strings in Node, without jsdom. One test
also imports the background bundle to check that no DOM global is touched.

### B5. Show it [CONTROL-CHARS]

- **Clean before display.** Every mail-derived string loses:
  - C0/C1 control characters;
  - bidi overrides and isolates (U+202A–202E, U+2066–2069);
  - zero-width characters.

  Whitespace is collapsed and lengths are capped. A code's `copy` form is
  `[0-9A-Za-z]` only.
- **Notification** (existing `notifications` permission):
  - Title: `Code: 123 456`. With the "Hide codes on the lock screen" option
    (off by default), the title is `New code from <sender>` and the code only
    appears in the inbox view.
  - Body: the sender name/domain and subject, at most 80 characters.
  - Without a code:
    - "New mail from <sender>";
    - with `hasLink`: "contains a sign-in link — open the inbox to see it";
    - encrypted: "encrypted mail — open kyc.rip/mail to read it".
- **Clicking the notification** opens the options page inbox view:
  - Each message shows its codes in large, selectable text with a Copy button.
    The user presses it themselves, which follows the decision in §1. The
    button copies the `copy` form.
  - The body is shown as cleaned text through `textContent` only, so mail HTML
    is never rendered.
  - Links are shown as plain text, never as anchors, and are never opened.

### B6. Settings and docs

- "Burner email" is **off by default**. The toggle text explains:
  - which service it uses: kyc.rip GhostMail;
  - what is sent there: the address and the token, nothing about the page you
    are on;
  - that kyc.rip can read mail at the address until it expires.
- Turning it off:
  - stops polling, clears the alarm and removes the menu item;
  - keeps the inbox until it expires, or until the user burns or forgets it.
- Add the `alarms` permission, and update the README and the store
  description.

## 5. Privacy and security

- **Network:** XMRadar talks only to `mail-api.kyc.rip`. The site you're on,
  its URL and its fields are never sent.
  - GhostMail does see the mail itself: the sender, and so which service you
    signed up to. The options text says so.
- **Token:** a bearer secret held only by the background (§3).
  - It goes into the `GET /api/inbox` query string, because that's how the API
    works today; §8 has a fix.
- **Mail is untrusted input.**
  - It goes through string parsing only.
  - On screen it's cleaned text, shown with `textContent` or as notification
    plain text.
  - Text hidden in scripts, styles or display-none parts is removed before
    extraction, so a mail has a harder time planting a fake code.
- **No automatic actions:** no code auto-fill, no link opening, no submits.
  The fill only ever touches the element the user right-clicked.

## 6. Tests

- **Extractor, about 50 fixtures:**
  - real-shaped mails: X, Google, Apple, Discord, GitHub, Microsoft, Telegram,
    banks, exchange-style;
  - code in the subject vs the body;
  - codes split by a space, hyphen, newline or NBSP;
  - lowercase alphanumeric codes, 9–10 digit codes, and a code next to "order
    #".
  - Must give no code:
    - an order confirmation with prices;
    - an invite with dates and phone numbers;
    - a newsletter with a year and a %;
    - a fake code inside `<script>`, `<style>` or a `display:none` element.
  - PGP mail and magic-link mail.
- **Cleaning:** control and bidi characters in sender and subject, and the
  length caps.
- **PoW:** a known seed/nonce pair checks out; the bit counter at its
  boundaries; chunking yields between chunks.
- **Background:**
  - 429 with a matching address reuses the token;
  - 429 otherwise gives the message, and there's no automatic retry;
  - imported inboxes never burn;
  - `lastSeenIds` seeding on import;
  - the watch window and alarm re-arm on start;
  - 404/403 stops polling;
  - the overlapping-tick guard;
  - the token never appears in `storage.session`, notifications or log output
    (captured console).
- **Fill (jsdom):**
  - the native setter + events on a plain input and a React-style controlled
    input;
  - contenteditable;
  - rejecting a non-editable target;
  - no other field is touched.
- **Live (you, about 10 min):**
  1. Get an address.
  2. Right-click → fill on a real signup that sends a code, in Chrome and in
     Firefox.
  3. The notification shows the code.
  4. Click it → the inbox view shows the code with Copy.
  5. Restart the browser within 15 min; polling resumes.
  6. Burn.
  7. Import a paid inbox from kyc.rip/mail: existing mail doesn't notify, and
     Forget doesn't delete it on the server.

## 7. Order

| # | Phase | Live check |
|---|---|---|
| B1 | PoW, create / import / burn / forget | get (with CPU throttle), import, burn |
| B2 | Fill | right-click fill, Chrome + Firefox |
| B3–B5 | Watch, extract, notify | a real signup code arrives |
| B6 | Settings, docs | off by default; turning it off stops polling |

## 8. Out of scope (v1), and optional kyc-rip follow-ups (separate approval)

Out of scope:
- buying a paid inbox inside XMRadar (XMR402 needs a tx proof from the user's
  wallet);
- several inboxes, Pro accounts and aliases, sending mail;
- PGP decryption;
- any auto-fill of codes.

Optional kyc-rip follow-ups:
- **MAIL-TOKEN-HEADER:** `GET /api/inbox` also accepts
  `Authorization: Bearer`, so the token stays out of URLs and logs.
- **FREE-RETRY-AFTER:** the `/api/free` 429 includes `Retry-After`, so the
  extension can show the real wait.
- **PAID-BURN-CONFIRM:** `/api/inbox/burn` requires `confirm` for paid tiers
  as well as Pro. That moves the paid-inbox guarantee from XMRadar's UI to
  the server.

## 9. Conditions from review round 2 (passed 8.2), part of the build

- **TOKEN-STORAGE-BOUNDARY:** call
  `storage.local.setAccessLevel({accessLevel: 'TRUSTED_CONTEXTS'})` at
  background start, where the browser supports it. The options page is a
  trusted context, but by rule it never reads `burner:inbox`.
  - Test: a content-script context can't read the token.
- **GUARD-TTL:** the tick guard is `{at}`.
  - A guard older than 60 s counts as free.
  - It's cleared in a `finally` block.
  - Test: a tick killed midway doesn't block later ticks.
- **RESTART-SEED:** don't seed after a restart. Mails with `receivedAt`
  (GhostMail stores it) at or after the start of the watch window, and not in
  `lastSeenIds`, are notified. A code that arrives while the browser is closed
  still shows up.
  - Seeding applies only on create and import.
  - Test: a mail received during a restart.
- **HTML-ONLY-CODE:** extraction runs on `text` *and* on
  `htmlToText(html).text`, then merges and dedupes the results.
  - GhostMail's own `isEncrypted` flag sets `encrypted`.
  - Fixture: a stub text part, with the code only in the HTML.
- **MENUS-PERMISSION:** add `menus` to the Firefox manifest only. Chrome keeps
  `contextMenus` and has no target element API.
  - Checked live on Firefox 140.
- **CHROME-CONTENTEDITABLE:** on Chrome, `activeElement` covers input and
  textarea only. A contenteditable is filled when it's the focused element.
  Otherwise the user sees "Click into the field first, then right-click".
  - Firefox resolves the exact target.
- **HTML-PARSER-HIDDEN:** these are also removed:
  - `[hidden]`;
  - `aria-hidden="true"`;
  - `input[type=hidden]`;
  - `class` names containing `hidden`, `preheader` or `sr-only`.

  Fixtures: malformed HTML (unclosed tags, nested comments).
- **SNAPSHOT-QUOTA:** the snapshot keeps the newest 30 messages, with 4 kB of
  text each. If `set` fails, the previous snapshot stays.
- **Suggestions taken:**
  - **Rate-limit probe:** send `POST /api/free` with an empty body before
    mining. A limited IP gets a 429 without wasting the work; an unlimited one
    gets a 400.
  - **Firefox PoW fallback:** a Worker in the event page.
  - **DOM check in tests:** a static check (esbuild metafile and a grep for
    `DOMParser`/`document`) instead of importing the service worker.
  - **Token input:** the import field is `type=password` and
    `autocomplete=off`, and is cleared after import.
  - **Disclosure:** update Firefox's `data_collection_permissions` and the
    store listing for the mail feature.
