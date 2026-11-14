# Look-alike warnings before the page loads (round 3)

## Why
The look-alike check (PLAN-LOOKALIKE, shipped in aabfcee) runs from the content script at `document_idle`:
the copy's page has loaded and its scripts have run before the warning shows, and a copy that fails to load
(Chrome's error page; `pegasusswap.site` in a test) gets no warning at all. Chrome's Safe Browsing screen
(seen on `trocador-app.im`) is the model: stop before the request, on a page the site cannot touch.
xmr.club will not ship per-listing `phishing_hosts` (an empty list would read as safe); it plans a small
top-level impersonators list later. Same-name hits on services that take coins are too quiet today (only an
amber `?`). OrangeFren's 100 confirmed scam domains, run through our matcher: PegasusSwap 12/14 caught; the
two misses are letter swaps.

## 0. Feasibility: measured 2026-10-31 (throwaway unpacked test extension, removed after)
**Chrome** (current stable, `declarativeNetRequestWithHostAccess` + `<all_urls>`):
- A dynamic rule with `regexFilter` and `redirect.regexSubstitution = <guard URL>#t=<token>&u=\0` sends a
  `main_frame` navigation to the extension page with the full original URL (query and fragment kept). A local
  server logged **no request** for the redirected URL; a control URL was logged.
- `runtime.getURL` returns the `use_dynamic_url` form (`chrome-extension://<random uuid>/guard.html`) and the
  redirect lands there. From a web page, `fetch` of the static `chrome-extension://<id>/guard.html` fails.
- Session `allow` rule with higher priority lets the same URL through; the site then sees an **empty
  `document.referrer`** (the guard URL and token do not leak).
- Rule-set cost: 160 regex rules with 3 excluded domains each applied in 27 ms, 400 in 36 ms; match in
  2 ms. Limits reported: regex 1000 (1000 itself rejected: "regex rule count exceeded"), dynamic 30000,
  unsafe dynamic 5000, session 5000.
- `chrome.declarativeNetRequest.testMatchOutcome` (Chrome's RE2 matcher) on the name regex for `trocador`
  (section 3a): matched `www-trocador.app`, `trocador-app.im`, `trocador.app.evil.com/x`, `trocador.io`,
  `http://trocador.site:8080/x?y`, `https://user@trocador.app.evil.com/`, `https://user:pw@trocador.io/`,
  `TROCADOR-APP.IM`, `a.b.trocador.c.d`, `xn--trocador-abc.com`; did not match `trocador.app`,
  `app.trocador.app` (excluded domain), `nottrocador.com`, `trocadorx.com`, `evil.com/?q=trocador.app`,
  `evil.com/trocador.app`, `evil.com#trocador.app`, `trocador@evil.com`.
**Firefox 159** (temporary add-on via web-ext, `background.scripts`, same permissions): `<all_urls>` granted;
rules installed; both a probe URL and `https://www-trocador.app/` landed on
`moz-extension://<uuid>/guard.html#t=…&u=<full URL>`; the local server logged no request for the probe.
**Not pre-load-able, decided now (no spike needed):** typo variants (≈ 75 × length hosts per brand) and Unicode
look-alikes (IDN) stay on the in-page path (section 5).

## 1. Letter swap counts as one typo
`oneEdit` → `oneTypo`: one insertion, deletion, substitution, or swap of two adjacent different letters.
Same limits: brand ≥ 7, same public suffix. Tests: `pegasussawp.com`, `pegassuswap.com` → typo; a swap of
identical letters is no change; popular-domains scan unchanged; live-feed hosts null.

## 2. Which listings get pre-load rules
`COIN_CATEGORIES = exchanges, mixers, wagering, marketplaces, cards, merchants, wallets`. Only brands of
these listings get rules (plain-word brands of `tools`, `ai`, `forums` would otherwise send ordinary sites
through the guard page). Everything else keeps the in-page path.

## 3. Rules (`src/sites/guard-rules.ts`, pure: `guardRules(index, guardUrl, token) → Rule[]`)
- Built in the background when the lookalike index is rebuilt (feed `issuedAt` change), on startup, and when
  `siteInfo`/`siteWarnings` change. One `updateDynamicRules` removes every rule in XMRadar's ID range
  (100000–100999) and adds the new set. Settings off → dynamic range and all session allow rules emptied.
- `token`: 128 random bits, new per build, kept in `storage.session` with the previous token (accepted for
  60 s after a rebuild so an in-flight redirect still verifies).
- a. **Name rules**, one per coin brand (≤ 300 today; packed several brands per regex as alternation if a
  feed ever exceeds 900):
  `^https?://(?:[^/?#]*@)?(?:[^/?#@:]*[.-])?BRAND(?:[.-][^/?#@:]*)?(?::[0-9]+)?(?:[/?#]|$)`
  BRAND = listed ASCII label, regex-escaped (labels are `[a-z0-9-]`). `excludedRequestDomains` = the listed
  registrable domains whose labels contain BRAND (usually 1–3, not the whole list). `resourceTypes:
  ['main_frame']`, action redirect `regexSubstitution = guardUrl + '#t=' + token + '&u=\0'`.
- b. **Confirmed impersonators** (xmr.club's future top-level list): one `requestDomains` rule with a
  `regexFilter: '^https?://'` so it can substitute the URL. Its reader is a separate change once the format
  exists; nothing ships for it now beyond the reserved ID.
- c. **Allow rules** (session, priority 2, `requestDomains: [exact host]`, `main_frame`): added only by the
  background after the user clicks Continue on the guard page (section 4); cleared when settings go off or
  the browser restarts; on startup re-added from a **separate** record `local:guardContinued`
  (`{host: expiry}`, 7 days), written only by guard-page Continue. The in-page banner's dismiss record
  (`siteBannerDismissed`) never creates an allow.

## 4. Guard page (`src/entrypoints/guard/`, unlisted page; `web_accessible_resources` with
`use_dynamic_url: true`, matches `<all_urls>`)
- Renders nothing until the background answers. If `window.top !== window` it stays blank.
- Sends `guard-check { hash }` once. The background accepts it only from its own guard page in a tab
  (`sender.id === runtime.id`, `sender.tab` set, `sender.url` starts with the guard URL), parses the hash:
  `t` must equal the current or recent token, `u` must parse as an `http:`/`https:` URL. Otherwise →
  `{ kind: 'invalid' }`: the page shows "Nothing to check here." with no link and no navigation.
- With a valid token the background requires that the host is matched by one of the current name rules
  (re-tested in JS; otherwise `invalid`), then computes `lookalikeOf(index, host)` and the listing:
  - **red kinds** (listed-phishing, segment, homoglyph, typo): red full page. "This isn't {target}." /
    "{host} looks like {target} (listed on xmr.club as {name}), but it isn't. Copies of exchange sites take
    the coins you send." **Go to {target}** (`https://{target}/`, feed only). **Details** reveals
    "Continue to {host} (not recommended)".
  - **same-name**: amber page. "This is not {target}." / "{target} is listed on xmr.club as {name}. This site
    has the same name on another domain and may not be theirs." **Go to {target}** and **Continue to {host}**.
  - **null** (the host carries the brand as a whole name part but the matcher found no stronger signal:
    `trocador.de.evil.com`, `trocador-fan-blog.com`): amber page, no auto-pass. "This site's address
    contains {target}'s name." / "{target} is listed on xmr.club as {name}. If you meant to go there, use the
    button." **Go to {target}** and **Continue to {host}**. The matcher is not assumed complete: a name-rule
    hit always gets a page and a decision by the user.
  - **settings off** (rules raced a toggle): page shows "XMRadar's site warnings are off." and a plain link
    to the URL; no automatic navigation, no allow rule.
- **No navigation or allow without a click.** Continue is a button; its handler requires `event.isTrusted`
  and sends `guard-continue { hash }`; the background repeats every check (sender, token, name-rule hit) and
  only then adds the session allow for that exact host and writes `guardContinued`; the page then calls
  `location.replace(url)`. Go to {target} is a plain link to the feed's URL.
- What the token does and does not do: it stops a guard page opened without one of XMRadar's own
  redirects from getting an answer. It is not bound to a host or a navigation (the substitution is static),
  so a page that somehow learned the per-session guard URL and token could open the guard for another
  brand-matching URL; the result is a warning page whose only way forward is the user's own click, which is
  no more than an ordinary link to that URL.
- Text via `textContent`; the only page-derived value shown is the host from `new URL(u).hostname`. Links come
  from the feed. Extension CSP; no remote content.
- Same page in Firefox (`moz-extension:`).

## 5. In-page path (unchanged matching)
For non-coin brands, typos, Unicode look-alikes, and Firefox installs where `<all_urls>` was not granted (the
rules then don't apply; detected with `permissions.contains`, shown in Options as "Warnings before a page
loads: off, grant access to all sites"):
- Red banner and badge as today. **Same-name for coin categories** also gets an amber in-page banner (same
  text as the amber guard page, Go/Dismiss). Non-coin same-name keeps only `?` and the popup line.
- **Badge without a loaded page**: the background also sets the badge from `tabs.onUpdated`
  (`changeInfo.url`, http/https only), so a copy that fails to load shows red `!` / amber `?`.

## 6. Privacy and safety
No visited URL leaves the device; rules come from the signed feed. The guard URL is per-session random
(`use_dynamic_url`), web pages cannot load the static one (measured), the guard never navigates or adds an
allow without the user's click (section 4), and the site sees no referrer (measured), so the guard URL and
token are not handed to it. XMRadar has no other
DNR rules; it only touches its own ID range and its own session rules (IDs 101000–105999).

## Tests
- `oneTypo`: swaps, existing edit cases, identical-letter swap, 6-character brands excluded.
- `guardRules`: one rule per coin brand, non-coin brands absent, excluded domains = listed domains containing
  the brand, ID range, token in the substitution; the regex is checked in JS against the exact match/no-match
  table from section 0 (the same cases Chrome's matcher was run on) plus ports, userinfo, upper case,
  trailing dot; syntax limited to what RE2 accepts (a test rejects lookaround and backreferences).
  Popular domains (637) and every live-feed host: the exact list hit by any rule is asserted (expected:
  none of the listed hosts; every hit reviewed by hand and written in the test). Since every hit now shows a
  page, this list is the false-positive cost and must stay near zero.
- Settings off → empty dynamic set and session allows cleared; feed change → full replace, old token valid
  60 s then rejected.
- Background `guard-check`/`guard-continue`: wrong sender, missing/old token, `javascript:`/`data:`/relative
  `u`, host not matched by any name rule → `invalid`, no allow added; `guard-check` never adds an allow for
  any kind (null included); `guard-continue` adds exactly one allow for that host and writes
  `guardContinued`. `trocador.de.evil.com` and an IDN brand host → guard page (null/homoglyph), not passed.
- Dismissing the in-page red or amber banner writes `siteBannerDismissed` only; after a restart no allow rule
  exists for that host and the guard page still shows.
- Guard page (happy-dom): blank until answer, framed → blank, each kind's text and links (red, same-name,
  null, off), Continue hidden behind Details for red, a synthetic (untrusted) click does nothing,
  `location.replace` only after `guard-continue` answers.
- `tabs.onUpdated` badge for a URL whose page never loads; same-name coin banner in-page; non-coin none.

## Live
- Chrome, unpacked build: navigate `https://trocador-app.im/`, `https://www-trocador.app/`,
  `https://pegasusswap.site/` → guard page before any request (verified with a probe rule on a local server
  as in section 0); Go → real site; Continue → loads once, remembered; `trocador.app`, `github.com`, `x.com`,
  `foundation.app` → no guard page; `trocador.de.evil.com` → amber name page; settings off → none.
- Firefox (web-ext temporary add-on): the same three; without the host grant → in-page banner.
- A copy with no DNS (`pegasusswap.site` here) shows the guard page instead of Chrome's error page.

## After the round-3 pass (8.0): notes folded in
- **Continue also hides the in-page banner**: `guard-continue` writes both `guardContinued` (allow source) and
  `siteBannerDismissed` (banner); test that the loaded page shows no banner after Continue.
- **Hash parsing**: `#t=<token>&u=<rest>`; `t` is the 32 hex characters after `#t=`, and `u` is everything after
  the first `&u=` (never URLSearchParams). Tests with `?a=1&b=2`, `=`, `#frag`, `%26` in the original URL.
- **Null page data**: the JS re-test of the name rules returns the matched brands; the best (longest, then
  rank, as `lookalikeOf`) gives `target` and `name` for the amber "contains the name" page. Tests:
  `trocador.de.evil.com`, `trocador-fan-blog.com`, an IDN hit.
- **Settings off/on**: `guardContinued` is the user's own choice and is kept; on re-enable its unexpired
  hosts get their session allows back. Test across off → on and a restart.

## As built
- Modules: `src/sites/guard-rules.ts` (pure: regex, rules, hash, `checkGuard`), `src/sites/guard-keeper.ts`
  (rule apply/check/continue with injected DNR + storage, unit-tested with fakes), `src/ui/guard-view.ts`
  (rendering), `src/entrypoints/guard/` (thin page), background wiring (`guard-check`/`guard-continue`,
  `isGuardPage`, `addressBadge` on `tabs.onUpdated`). Manifest: `declarativeNetRequestWithHostAccess`,
  `web_accessible_resources` guard.html with `use_dynamic_url`.
- **Foundation Passport is in `wallets`**, so its rule would have sent the real foundation.app (NFT market) to
  an amber page. Added `KNOWN_UNRELATED = ['foundation.app']` (lookalike.ts): `lookalikeOf` returns null for it
  and it is in the rule's excluded domains. The popular-domains scan now finds nothing at all (was
  foundation.app → same-name).
- Fixture `xmrclub-feed-hosts.json` gained each listing's real `category` (from the 2026-10-31 feed) so the
  coin-category rules are tested against real data. 121 name rules from the live feed.
- Options: the existing "Allow access to all sites" prompt (`#perm`, Firefox) already covers the host grant;
  only the In-page warnings hint text changed.
- Live (Chrome, unpacked build): `www-trocador.app/swap?amount=1&coin=xmr` → red guard page; Details →
  Continue → went to the full original URL (no DNS → Chrome's error page), one session allow, red `!` badge on
  the error page; `pegasusswap.site`, `trocador.de.evil.com/x?a=1&b=2` → guard page; `trocador.app`,
  `github.com`, `foundation.app` → load normally; `pegasussawp.com` (a live scam site) → red `!` + banner via the
  new swap typo, after load (typos are in-page only); `xn--trocdor-6ve.app` → red `!` in-page. Test choices
  removed from the browser afterwards.
- Firefox: the mechanism was verified in the spike (section 0); the product build was built but not run live.

## After the code review (7.6, pass): fixes
- **Token vs rules after a stopped worker**: the keeper reads the token back from the rules in place and
  rewrites when it differs from storage; the new token is stored before the rules change (the rules' token
  becomes `previous` for the grace minute). Test: storage out of step → rules rewritten, old token still
  verifies.
- **Previous feed's rules**: the keeper keeps the previous feed's index and rules in memory; within the grace
  minute a redirect carrying the previous token is checked against them. Test: a feed update that drops a
  listing.
- **Intranet names**: the pattern requires a dot after the name (`trocador.app`, `www-trocador.app`); `http://trocador/`
  is left alone. A first version with a second alternative (name as the last label) was **rejected by Chrome
  (`isRegexSupported`: memoryLimitExceeded)**; the update then failed and left the previous rules, which still
  pointed at the previous session's guard address, so Chrome blocked those navigations
  (ERR_BLOCKED_BY_CLIENT). Fixed twice over: the alternative is dropped, and **a refused update now removes
  XMRadar's rules (fail open)** instead of leaving stale ones. Test for the fail-open path.
- **Trailing dot**: `guardMatch` strips it; live, `https://trocador.app./` loads normally (Chrome's excluded
  domains already cover it).
- **Browser restart**: `use_dynamic_url` gives the guard page a new address each browser session; a
  `runtime.onStartup` listener now starts the worker at launch so the rules are rewritten right away.
- **siteWarnings vs badge (review note, kept as is)**: the "In-page warnings" switch governs banners and the
  guard page; the toolbar badge and popup row belong to "Site info from xmr.club", as for grades and incidents.
- Live after the fixes (Chrome): guard page for www-trocador.app, trocador-app.im, pegasusswap.site,
  a.b.trocador.c.d; normal load for trocador.app., http://trocador/, foundation.app. 880 tests pass.
