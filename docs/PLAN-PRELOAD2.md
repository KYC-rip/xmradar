# Typo copies and look-alike letters: a full page too (follow-up to PLAN-PRELOAD, round 2)

## Why
The user opened `pegasussawp.com` (a live copy of PegasusSwap, letters swapped) and saw only the small red `!`
on the toolbar icon: typos and look-alike letters were left to the in-page path (badge + bottom banner),
after the copy's page had loaded. For a copy of an exchange that is too quiet and too late.

## Measured (2026-10-31; throwaway test extensions/profiles, removed after)
- One-typo variants of the 98 coin-listing names of ≥ 7 letters, on their own suffix (deletion, insertion,
  substitution over `a-z0-9-`, swap of neighbours), listed domains removed: **67,008 domains, ~1 MB, built in
  26 ms** (node, the live-feed fixture).
- **Chrome**: one `redirect` rule with `requestDomains` of 10k / 70k / 150k: applied in 23 / 58 / 98 ms, match
  in 1–2 ms (`testMatchOutcome`: the typo matched, the real `pegasusswap.com` did not).
- **Firefox 159**: 10k / 70k / 150k applied in 37 / 155 / 333 ms; a navigation to a subdomain of a listed
  entry (`https://www.<entry>/x?a=1&b=2`) landed on `moz-extension://…/guard.html#t=…&u=<full URL>`.
- **False positives**: none of the 637 popular domains is in the set.
- Running the full matcher (`lookalikeOf`, with tldts) on every variant takes **11 s**: too slow for the
  worker, and it disagrees on 108 variants where `rn`/`vv` change the skeleton (`sparnowwallet.com`). So the
  set is not filtered by the matcher; the guard answers from the set itself (§2).

## 1. Typo rule (before load)
- `typoDomains(index) → Map<domain, Brand>`: for each coin brand (COIN_CATEGORIES, ASCII label, brand ≥ 7)
  every one-typo variant of the listed label (as measured) + `.` + the brand's own public suffix; drop
  variants starting/ending with `-`, listed registrable domains and KNOWN_UNRELATED. Cached by feed
  `issuedAt` with the name rules (built once per feed, ~26 ms).
- DNR: the set split into rules of ≤ 20,000 domains, ids 100900–100949 (name rules stay ≤ 100899),
  `regexFilter: '^https?://.*'` (so `\0` is the whole URL), `requestDomains`, same redirect and token as
  the name rules. `requestDomains` also covers subdomains.
- Applied in a **second** `updateDynamicRules` after the name rules: if a browser refuses the typo rules,
  they are removed (fail open) and the name rules stay; logged.

## 2. Guard check
`checkGuard`: valid token, then:
- host matched by a name rule → as today;
- else host equal to or under a typo-set domain → **red**, `why: 'typo'`, target/name from that entry's
  brand (the matcher's answer is used when it is red; otherwise the set's brand: a host is in the set only
  because it is one typo from a coin listing's name on its suffix);
- else `lookalikeOf` red for a coin listing (look-alike letters reaching the guard through §3) → red;
- else `invalid`.

## 3. After load, for look-alike letters (IDN) only
No rule can list Unicode look-alikes. In the background, `tabs.onUpdated` with `changeInfo.url`
(http/https) runs `shouldGuard`, **inside the keeper's serial chain**:
- warnings on, DNR available, a current token stored **and** the name rules in place (otherwise: nothing,
  the in-page badge and banner stay as the fallback — e.g. Firefox without the host grant, or before the first
  apply);
- `lookalikeOf` is `homoglyph` for a coin listing (typos are covered by §1; segment/name by the name rules);
- no live `guardContinued` entry for the host, re-read right before the update;
- the tab's URL still has that host (`tabs.get` right before the update).
Then `tabs.update(tabId, { url: guardUrl#t=<current token>&u=<url> })`. The copy's page may have started and
is replaced at once. Continue → session allow + `guardContinued`, and the re-read stops another redirect.

## Deliberate nulls (documented, tested)
- A typo label inside another host (`pegasussawp.evil.com`, `pegasussawp.com.evil.com`) is not a typo for the
  matcher today and is not in the set; segment rules still catch the exact name (`pegasusswap.com.evil.com`).
- Typo plus another suffix (`pegasussawp.io`) stays null, as in PLAN-LOOKALIKE.

## 4. Unchanged
Non-coin listings keep the badge and banner. Same-name and name pages unchanged.

## Tests
- `typoDomains`: contains `pegasussawp.com`, `pegassuswap.com`, `pegasusswapp.com`, `trocadro.app`; not
  `pegasusswap.com`, not listed domains, not KNOWN_UNRELATED, not other suffixes (`pegasussawp.io`), not
  6-letter brands' typos, not non-coin brands; size < 100k; **none of the 637 popular domains**; none of the
  live-feed hosts.
- Rules: chunks of ≤ 20k, ids 100900+, `^https?://.*`, the token; settings off → removed with the others; a
  refused typo update keeps the name rules and removes the typo rules.
- `checkGuard`: typo host (and `www.` of it) without a name-rule hit → red with the set's target; IDN
  look-alike of a coin listing → red; a non-coin red lookalike → invalid; unrelated host → invalid;
  `pegasussawp.evil.com` → invalid.
- `shouldGuard`: homoglyph coin + token + rules + not continued → yes; typo / same-name / non-coin /
  continued / off / no token / no rules → no; a Continue between decision and update → no redirect.

## Live
Chrome: `https://pegasussawp.com/` → guard page, **no request** (DevTools network / no page title); Continue →
loads; `https://xn--trcador-…app/` → page replaced by the guard page; `pegasusswap.com` normal.

## After the round-2 pass (7.4): notes folded in
- The set keeps a variant only if the matcher's own skeleton test agrees (`skeleton(variant)` is one typo
  from, or equal to, the brand's skeleton; skeleton is cheap, no tldts), so the 108 `rn`/`vv` variants
  (`sparnowwallet.com`) are dropped; test.
- After-load escalation covers every red kind for a coin listing that no rule caught (homoglyph, a look-alike
  letter in a subdomain → segment, listed-phishing), not only homoglyph; tests for `trоcador.evil.com`-style
  hosts and a listed-phishing host with no rule.
- Previous-feed handling covers the typo set as for the name rules; test.

## As built
- `typoDomains`, `typoRules`, `typoMatch`, `shouldGuard` in guard-rules.ts; `checkGuard` takes the typo set;
  the keeper builds name rules + typo set once per feed, writes typo rules in a second update (fail open, name
  rules kept), passes the previous feed's typo set during the grace minute, and `afterLoad` (serial) decides the
  after-load replacement; background `guardAfterLoad` re-reads the tab URL before `tabs.update`.
- Live (Chrome): 121 name rules + 4 typo rules (66,900 domains). `pegasusswapq.com/x?a=1&b=2` and
  `www.pegasusswapq.com` → guard page before load with the full URL; `trоcador.app` (Cyrillic о) → replaced by the
  guard page; real `pegasusswap.com` loads. 892 tests pass. Background bundle ~882 KB (budget 900 KB).

## After the code review (7.2, pass): fixes
- Continue runs entirely in the keeper's serial chain (check, records, allow), and the after-load redirect
  happens inside the chain too (`afterLoad(url, …, go)`): a Continue is either seen by the decision or comes
  after the redirect; test with Continue queued first.
- The background re-reads the tab and redirects only if it is still on exactly that URL (not just the host).
- Typo rules are rewritten when their own token differs from the current one (read back from the first typo
  rule), even if the name rules are current; test.
- Tests for after-load on a look-alike letter in a subdomain (segment) and a typo the rules missed.
- 894 tests pass; background bundle 881,713 bytes (budget 900,000).
