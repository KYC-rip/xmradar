# xmr.club's confirmed impersonators: read and blocked before load (round 2)

## Feed (live, issued 1793455084)
Top level of the signed payload: `impersonators: [{ host, imitates, name, added }]` (renamed by xmr.club to
match our request), e.g. `{ "host": "pegasussawp.com", "imitates": "pegasusswap", "name": "PegasusSwap",
"added": "2026-10-31" }`; additive, `v` stays 1. xmr.club guarantees a host used by any listing never appears;
today 3 entries (pegasussawp.com, www-trocador.app, trocador-app.im). Hand-confirmed by xmr.club. It replaces the
per-listing `phishing_hosts` idea (never shipped by xmr.club; XMRadar's reader for it stays harmless).

## 1. Reading (`src/sites/feed.ts`, no tldts there: it also runs in pages)
- `SiteFeed.impersonators?: { host: string; siteId: string; added: string | null }[]`.
- Parsed only if an array; each entry an object with `validFeedHost(host)` (not `.onion`), `normalizeHost`,
  `imitates` = the id of a listing in the same feed (otherwise dropped), `added` kept if
  `YYYY-MM-DD`. The feed's `name` is ignored (the listing's own name is shown). Deduped by host; at most
  10,000 kept.
- `FEED_READER_V` 6 → 7 (a kept copy is re-read).

## 2. Matching (`src/sites/lookalike.ts`, background only)
- `lookalikeIndex` adds the impersonators to the existing `phishing` map (kind `listed-phishing`, target the
  listing's first web host as for `phishing_hosts`) and to `index.impersonators`, after a safety filter. An
  entry is **dropped** if:
  - it has no registrable domain (a bare public suffix) or is an IP;
  - `isPlatformHost(host)`: a platform or shared-hosting host **or any subdomain of one** or a private
    suffix (`github.io`, `user.github.io`, `gist.github.com`, `foo.vercel.app`, `a.substack.com`,
    `www.youtube.com`): XMRadar never blocks a page on a shared platform from a list entry;
  - it is, or is under, a KNOWN_UNRELATED domain (`foundation.app`, `www.foundation.app`);
  - it touches a real listing: equal to or under **any** listed host (all listings' `hosts`, platform ones
    included: `somegit.github.io` and its subdomains), or under a listed registrable domain
    (`trocador.app` → `x.trocador.app`), or a parent of a listed host;
  - its listing has no web host to link (onion-only): no "Go to" target, so no entry.
- `lookalikeOf`: the phishing lookup also tries the host's parent names down to its registrable domain, so
  `www.pegasussawp.com` is the listed copy too. (The filter above guarantees no parent of a real listed host is
  ever in the map.)

## 3. Before load
- The typo rules' domain list becomes the typo set ∪ `index.impersonators` (same chunked `requestDomains`
  rules, same token, same fail-open; `requestDomains` covers subdomains).
- `shouldGuard`: `listed-phishing` is guarded for any category (xmr.club confirmed it); other red kinds for coin
  listings only, as now. So `checkGuard` answers red for an impersonator reached through the rule even when no
  name or typo rule matches, and after-load replacement covers it if a browser refused the rules.

## Tests
- Parse: the live shape; unknown listing id, bad host, onion, duplicate, non-array → dropped; cap; reader 7.
- Index, dropped: `github.io`, `user.github.io`, `gist.github.com`, `foo.vercel.app`, `a.substack.com`,
  `www.youtube.com`, a public suffix (`co.uk`), an IP, `foundation.app`, `www.foundation.app`, `trocador.app`,
  `x.trocador.app`, a listing's platform host (`somegit.github.io`) and `a.somegit.github.io`, an entry for an
  onion-only listing. Kept: the three live entries.
- `www.pegasussawp.com` → listed-phishing PegasusSwap; `pegasussawp.com.evil.net` → not listed-phishing.
- Rules: impersonator hosts in the requestDomains lists, none of the dropped ones; an impersonator not matched
  by any name or typo rule (`pegasus-swap-exchange.net`) → guard red "xmr.club lists … as a phishing copy of
  pegasusswap.com".
- `shouldGuard({ kind: 'listed-phishing', category: 'tools' })` → true.

## Live
Chrome: the three hosts and `www.` of them → guard page with the "xmr.club lists this site as a phishing copy"
text, before load.

## As built
- feed.ts `parseImpersonators` (reader 7), lookalike.ts safety filter + `index.impersonators` + parent lookup,
  guard-keeper adds them to the exact-domain rules, `shouldGuard` guards `listed-phishing` for any category.
  `tests/impersonators.test.ts` (23 tests, real ed25519-signed payloads). 917 tests pass; background 882,748 B.
- Live (Chrome): reader 7 read the 3 live entries; all 3 in the requestDomains rules; `www-trocador.app` → guard
  page. `trocador-app.im` loaded because a Continue choice for it (made before xmr.club listed it) was still
  live — the allow works as designed; whether a confirmation should override an earlier Continue is open.

## After the code review (6.9, fail): fixes
- PRIOR-CONTINUE: a Continue made before xmr.club confirmed a host no longer lets it through; only a Continue
  on the page that said "xmr.club lists this as a phishing copy" counts (`local:guardContinuedListed`).
  Allows and the after-load check both use it. Test with the trocador-app.im sequence; live: the earlier
  allow for trocador-app.im is gone and it lands on the guard page.
- PER-LISTING-PHISHING: the older per-listing `phishing_hosts` entries pass the same safety filter.
- TOPLEVEL-CONFLICT: the top-level list is applied first and wins for a shared host; test.
- WWW-NORMALIZE: impersonator hosts are kept exactly as listed (`www.` not stripped); the phishing lookup uses
  the visited host as is plus its parents, so `www.copy.example` never widens to `copy.example`; test.
- 920 tests pass; background 883,171 B.
- Round 2 (6.9) fixes: allow rules exclude listed copies under the continued host that the user did not continue
  to themselves (`excludedRequestDomains`), and the after-load check uses the same predicate (`allowance`:
  host or subdomain of a continued host, minus such copies); per-listing `phishing_hosts` kept exact (`www.`
  not stripped). Tests: parent Continue + confirmed child (excluded + guarded after load), continued subdomain,
  per-listing `www.`. 923 tests pass.
