# The XMR pill after names on posts, and "Report this copy" on the warning page (round 2)

## Part A: the pill after the author's name on every post

### Why
On X a blue check follows the name wherever it appears. XMRadar's XMR pill shows on profile headers, people
lists and hover cards, but on posts only the ɱ tip button in the action row: when Xap came (213d4b1) the tweet
branch of `apply()` switched from the name pill to the Xap button. The user wants the pill after the name on
posts too, as X does with its check.

### Change (`src/entrypoints/content/x-badges.ts`)
- `BadgeSlot` gains `pill?: boolean`, set **only by `tweetSlot`** (not by `articleViewSlot`, whose `anchor` is
  the whole X Article reading page and has no name row: it stays Xap-only).
- `apply(slot)` for a slot with an `article`: the Xap as today, and **if `slot.pill`**, the pill in the name row
  (`slot.anchor`, right after the display name) for an author whose badge has a **primary** address. When the
  badge is missing **or has no primary**, both the pill and the Xap are removed from that node (the current
  Xap cleanup extended to the pill), so a recycled node never keeps a stale one. Same rules as elsewhere:
  - the pill's `data-key` is the slot key (`<status id>:<handle>`); a recycled tweet node whose pill has
    another key gets it replaced, and a node whose author has no badge loses any pill and Xap;
  - the user's badge look (icon, label) and the "own badge" rule apply unchanged (`mountBadge`, `look`);
  - click opens the tip popup (prevents X's navigation, as `insert` does);
  - its tooltip carries the account's Xap totals as for other pills.
- Quoted tweets inside a post: unchanged (no slot today); noted as a follow-up.
- No layout change in X's row beyond the pill (the name row already wraps the check; the pill is
  `inline-flex`, same size as in people lists).

### Tests (`tests/x-badges.test.ts`)
- A tweet by an author with a badge: pill in the name row right after the name, and the Xap in the action bar.
- No badge, and a badge with no primary address: neither; a recycled node (another author) drops the old pill
  and Xap.
- The X Article reading page (`articleViewSlot`): Xap only, never a pill.
- Two tweets by one author: two pills; the pill's tooltip carries the Xap totals (`data-pubkey` set).
- The tweet's own page (stacked name/handle rows): the pill sits in the name row, not on its own line.
- Own badge hidden while logged in as the proven handle (existing rule) also on posts.
- Click on the pill: tip popup, no navigation.

## Part B: "Report this copy" on the warning page

### Why
xmr.club built the report endpoint (live): `POST https://xmr.club/api/v1/report-impersonator`, JSON
`{"host","imitates"}` only (extra keys → 400), host lowercase ASCII/punycode with `www.` stripped, no scheme,
port or path; `imitates` = a listed id. 202 `{}` (also for a listing's own host), 400 bad body /
`unknown_listing`, 413 > 512 bytes, 415 non-JSON, 429 rate limited. Reports go to a review queue; confirmed
hosts come back in the signed feed's `impersonators` list, which XMRadar already blocks before load. xmr.club:
"stores no IP addresses or client data with reports; the rate limiter uses a salted hourly hash that expires
with its window. Requests pass through Cloudflare, whose own infrastructure logging applies (see
xmr.club/privacy)."

### Change
1. `GuardAnswer` red/same-name/name answers carry `siteId` (the listing's id) — from the matcher's brand /
   lookalike (`Lookalike.siteId`, set in `result()` and `copyOf`), never from the page.
2. Guard page (`src/ui/guard-view.ts`): on a **red** page that is **not** `listed-phishing` (already listed),
   a quiet button under the actions: **Report this copy to xmr.club**, with one line under it:
   "Sends only this address and the service it copies. xmr.club stores no IP address or other data about you
   with a report; requests pass through Cloudflare (see xmr.club/privacy)." Not on amber pages (same-name /
   name may be unrelated sites). Click (trusted only) → `guard-report { hash }` → "Sending…" →
   "Reported. xmr.club checks each report by hand." / "Too many reports from here right now; try again later." /
   "Couldn't send the report." / (already) "Already reported from this browser." After **sent** or **already**
   the button stays disabled; after **limited** or **failed** it is enabled again (retry).
3. Background `guard-report`: same sender check as `guard-check` (`isGuardPage`), re-runs the guard check on
   the hash (token, name/typo rules), requires a red, non-listed answer, then sends
   `{ host: normalizeHost(answer.host), imitates: answer.siteId }` with `fetch` (`credentials: 'omit'`,
   `referrerPolicy: 'no-referrer'`, `redirect: 'error'`, 10 s timeout, `content-type: application/json`).
   One report per host per browser session (`session:guardReported`), **written only after a 202**; a second →
   `{ status: 'already' }`. Status: 202 → `sent`; 429 → `limited`; **every other response (400, 413, 415, 5xx),
   a network error or the timeout → `failed`** (nothing recorded, so the user can retry).
   Returns `{ status: 'sent' | 'limited' | 'failed' | 'already' }`. Settings off → refused.
4. Options (Swaps and sites): switch **"Report button on the warning page"** (`xmrSettings.copyReports`, on by
   default; read with `copyReportsOn`). The background puts it into the guard answer: red answers carry
   `report: boolean` (= setting on **and** not listed-phishing **and** a `siteId`); `renderGuard` shows the button
   only when `report` is true. Off → no button, and `guard-report` refuses.

### Privacy
Nothing is sent unless the user clicks. The body is the bare host (no path, query, scheme) and the listing id
from the feed. No cookies, no referrer.

### Tests
- `checkGuard` answers carry `siteId`; listed-phishing → no report.
- `reportCopy(answer, fetchFn)` (pure helper in guard-rules or a new `src/sites/report.ts`): body exactly
  `{"host","imitates"}`, `www.` stripped, punycode host kept; 202 → sent, 429 → limited, 400/5xx/network/timeout →
  failed; a non-red or listed-phishing answer → not sent.
- `reportCopy` statuses: 202 sent, 429 limited, 400/413/415/500 failed, network error failed, timeout failed.
- Keeper/background-level: a 202 records the host and a second report → already; a failed or limited one
  records nothing (a retry sends again); settings off → refused; wrong sender → refused; `report` flag in the
  answer follows the setting.
- Guard view: button only when `report` is true (red non-listed, setting on), hidden when false, untrusted
  click ignored, each status text, enabled again after limited/failed, disabled after sent/already.
- Options switch persists `copyReports`.

## Live
- A: x.com timeline and a reply thread: pill after the name of a badged author, ɱ in the action row; click →
  tip popup. Two tweets of one author: two pills.
- B: Chrome, `https://pegasusswapq.com/` (typo, not a real site) → red guard page → Report → "Reported" (202);
  second click → disabled. (One real report to xmr.club's queue for a fake typo domain; the xmr.club curator
  is told it was a test.)

## As built
- A: `BadgeSlot.pill` (tweetSlot only); `apply` adds/replaces the pill in the name row and the Xap, and removes
  both without a primary. Tests: pill placement and key, no-primary recycled node, two posts → two pills,
  article view without `pill`.
- B: `Lookalike.siteId`; `GuardAnswer` carries `siteId`, `report`, `reported`; `src/sites/report.ts`
  (`reportBody`, `sendReport`, `reportFlags`, `reportCopy`); background `guard-check` adds the flags,
  `guard-report` sends; guard page button + note; Options switch `copyReports` (needs warnings on).
  Tests: tests/report.test.ts (bodies, every status, retry rules, flags, view), receipts-panel switch.
- 956 tests pass; both builds pass.
- Live (Chrome): x.com/XBToshi — the pill right after the blue check on all 4 posts checked, and the ɱ in each
  action row. `pegasusswapq.com` → red page with "Report this copy to xmr.club" and the note;
  `www-trocador.app` (listed) → "xmr.club lists …", no Report button. The Report click itself was not sent
  live (it would put a test entry into xmr.club's queue) — left for the user to decide.
