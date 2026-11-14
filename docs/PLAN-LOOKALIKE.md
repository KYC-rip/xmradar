# Lookalike warnings: a site posing as a listed service (round 4, one clean document)

## Why
`www-trocador.app` gets no warning today: XMRadar matches only the exact hosts in xmr.club's signed feed
(`sitesFor`). A copy of an exchange takes the coins sent to it. All matching runs in the background
against the feed XMRadar already holds; no visited host is sent anywhere.

## 1. Registrable domains
`tldts` (MIT; `parse(host, { allowPrivateDomains: true })` → `domain`, `domainWithoutSuffix`,
`publicSuffix`, `isPrivate`), for listed hosts and the visited host alike. A host with no `domain`
(an IP, a bare suffix, `.onion`, `localhost`) is never matched and seeds no brand.

## 2. Platforms (never a brand, never flagged)
`isPlatformHost(h)`: `h` equals or ends with `.` + any entry of `PLATFORM_HOSTS` (existing list, plus
`github.dev`, `github.blog`, `githubusercontent.com`, `youtu.be`, `redd.it`) or `SHARED_HOSTING`
(github.io, gitlab.io, codeberg.page, pages.dev, workers.dev, vercel.app, netlify.app, web.app,
firebaseapp.com, herokuapp.com, notion.site, carrd.co, linktr.ee, blogspot.com, wordpress.com,
tumblr.com, onion.ly), or tldts reports the suffix as private (`isPrivate`). So `gist.github.com`,
`foo.github.io`, `music.youtube.com`, `old.reddit.com` seed nothing and are never flagged.

## 3. Skeleton
`skeleton(label)`: tldts' Unicode form → NFKC → remove `\p{M}` and `\p{Cf}` → lower-case → map each
character through `CONFUSABLES` (vendored, generated from Unicode confusables.txt: entries whose target is
a–z or 0–9; the generator script `scripts/gen-confusables.py` is in the repo, the Unicode version is in
the generated file's header) → `rn→m`, `vv→w`, `0→o`, `1→l`.

## 4. Brands (`src/sites/lookalike.ts`, built once per feed, kept in memory by feed `issuedAt`)
From every listing host that is not a platform and has a `domain`:
`{ brand: skeleton(domainWithoutSuffix), domain, listing }`. A brand counts only if ≥ 5 characters, not all
digits, and not in `GENERIC` (complete list in the module: monero, xmr, wallet, wallets, crypto, bitcoin,
btc, coin, coins, exchange, swap, swaps, trade, market, proton, privacy, secure, mail, email, cloud, vpn,
pay, cash, money, bank, shop, store, card, cards, gift, gifts, sim, sims, phone, host, hosting, server,
node, mixer, dex, defi, token, tokens, chain, block, app, apps, web, site, online, official, support,
help, login, account). The set of listed registrable domains (`listedDomains`) is kept alongside.

## 5. Match: `lookalikeOf(index, host)` → `Lookalike | null`
```ts
type LookalikeKind = 'listed-phishing' | 'segment' | 'homoglyph' | 'typo' | 'same-name';
interface Lookalike { kind: LookalikeKind; imitates: string; target: string; name: string }
```
- `listed-phishing` (strongest, checked first, before every exit below): the exact host is in some
  listing's `phishing_hosts` (section 8). The signed feed is authoritative, so this fires on platforms,
  shared hosting (`x.github.io`) and listed hosts too.
- Otherwise `null` when the host is a platform, has no `domain`, or its registrable domain is in
  `listedDomains` (any listing: `app.trocador.app` is trocador's own).
- Let `L = skeleton(domainWithoutSuffix)` of the visited host, `raw` its Unicode text. Kinds, strongest
  first (the first kind that matches any brand wins):
  1. `homoglyph`: `L` == brand while `raw` != brand (`trоcador.app` with Cyrillic о, fullwidth,
     mathematical bold, zero-width or combining-mark variants). Checked before segment, so a disguised
     registrable label is reported as what it is.
  2. `segment`: a label **left of the registrable domain**, or a `-`-separated part of any label, has
     skeleton == brand: `www-trocador.app`, `trocador-app.com`, `trocador.app.evil.com`,
     `secure-trocador.app.login.xyz`. (The whole registrable label equal to a brand is homoglyph or
     same-name, never segment.)
  3. `typo`: edit distance 1 between `L` and a brand of ≥ 7 characters, same public suffix only
     (`trocadorr.app`).
  4. `same-name`: `raw` == brand exactly (plain ASCII, no confusable) and only the public suffix differs
     (`trocador.io`, `trocador.xyz`). Weak: an unrelated site of the same name is plausible.
- **Deliberate nulls**: a typo plus a TLD swap (`trocadorr.io`, `trocadr.xyz`) is not flagged: two
  weak signals together match too many unrelated names. `phishing_hosts` covers known ones.
- Ties within a kind: the longest brand, then the listing with the best grade, then feed order.
- `imitates`: the brand's listed registrable domain (`trocador.app`). `target`: `imitates` if it is one
  of the listing's hosts, else the listing's first non-onion host on that domain (`www.trocador.app`),
  re-checked with `validFeedHost`. `name`: the listing's name. All three come from the feed only;
  nothing from the page (host, path, query) is ever shown as a link or in the text.

## 6. Data flow and state
- `SiteInfo` gains `lookalike: Lookalike | null`; the background sets it whenever it computes site info,
  also when `sitesFor` is empty.
- `TabState` gains its own field, `lookalike?: LookalikeKind` (not folded into `site`), so the badge
  branches on the kind; `TabState.site` is unchanged. Turning `siteInfo` off clears `lookalike` with
  `site` (`applySiteInfoSetting`), and `dropTabState` already drops both. `tabSiteState` persistence
  carries it (session storage, same as `site`).
- `badgeFor`, highest first:
  receipt warn (red `!`) > **lookalike red kinds** (`listed-phishing`/`segment`/`homoglyph`/`typo`, red
  `!`) > incident > receipt caution > **same-name** (amber `?`) > intern > receipt ok > grade.
- `needsLookalikeBanner(l) = l && l.kind !== 'same-name'`.

## 7. What the user sees
- **Banner** (content, red, red kinds only; `siteInfo` and `siteWarnings` switches; dismiss 7 days per
  host as for other banners): "This site's name looks like **{target}** (listed on xmr.club as {name}),
  but it isn't. Copies of exchange sites take the coins you send. [Go to {target}]" — `listed-phishing`:
  "xmr.club lists this site as a phishing copy of **{target}** ({name}). [Go to {target}]".
  The link is `new URL('https://' + target + '/').href`, opened with `rel="noopener noreferrer"`.
  If a host has both a lookalike and listings (only possible for listed-phishing), the lookalike
  banner leads.
- **Same-name**: no banner. Amber `?` badge and a popup row: "This site has the same name as
  **{target}** (listed on xmr.club as {name}) on another domain. If you meant {target}, go there." with
  the same feed-built link.
- **Popup card** (`site-card.ts`): renders when `sites.length || lookalike`; the lookalike row first,
  red for red kinds, amber for same-name.

## 8. Known phishing hosts (feed field, xmr.club change asked separately)
`phishing_hosts` per listing: `validFeedHost` entries, normalised, deduped, ≤ 50 per listing, ignored
when absent. `FEED_READER_V` 5 → 6 so a cached feed is re-read. Until xmr.club ships it, this kind simply
never fires.

## Tests (`tests/lookalike.test.ts`, table-driven, three expected outcomes)
- **red** (kind asserted): www-trocador.app, trocador-app.com, trocador.app.evil.com,
  secure-trocador.app.login.xyz → segment; Cyrillic, Greek, fullwidth, mathematical bold, zero-width
  joiner, combining-mark variants → homoglyph; trocadorr.app → typo; a `phishing_hosts` entry →
  listed-phishing (also when that host is in some listing's `hosts`, and an exact
  `x.github.io` phishing host on shared hosting).
- **same-name**: trocador.io, trocador.xyz → `same-name`, not segment; badge amber `?`; no banner;
  popup row with link `https://{target}/`.
- **null**: trocador.app, app.trocador.app, the onion host; every host in the live feed fixture;
  platform apexes and subdomains (github.com, gist.github.com, github.dev, github.blog, foo.github.io,
  x.vercel.app, a.substack.com, music.youtube.com, old.reddit.com, foo.matrix.to); eTLD cases
  (trocador.co.uk vs a listed `.co.uk` brand on another label, x.com.br); short/generic brands
  (tota.io, monero.com, swap.io); a typo of a 6-character brand; an IP; `localhost`; typo + TLD swap
  (trocadorr.io, trocadr.xyz).
- **popular domains** (a fixed list of ~500 in the test file, run against the live feed fixture): the test
  asserts the exact set that comes out `same-name` (written in the test, reviewed by hand) and that
  **none** comes out red; everything else null.
- **link/target**: listing whose first host is `www.trocador.app` → text and href `www.trocador.app`;
  listing with `trocador.app` → `trocador.app`; a page at `trocador.app.evil.com/?u=https://evil` renders
  the banner with href `https://trocador.app/` and no page text.
- **strength**: a host matching one brand by segment and another by typo → segment.
- **state**: empty `sitesFor` + lookalike → SiteInfo and TabState set; `badgeFor` order for every pair
  above; siteInfo off clears it; a dismissed banner stays hidden 7 days.
- **feed**: `phishing_hosts` parse/validate/dedupe/cap; reader 5 cache re-read.

## Live
- Red: a throwaway Chrome profile started with `--host-resolver-rules="MAP www-trocador.app 127.0.0.1"`
  and a local `python3 -m http.server` page opened as `http://www-trocador.app:8000/` → red `!` badge, the
  banner, its link to `https://trocador.app/`; the popup card's red row.
- Same-name: the same setup with `trocador.xyz` → amber `?`, no banner, popup row.
- Real sites: trocador.app, github.com, x.com → no lookalike state.

## As built (after the round-4 pass at 7.2)
- **Segment narrowed** (found by scanning the live feed: it seeds plain words as brands — foundation,
  continue, brave, element, venice, agora, walls, silent): red only when the brand is followed by its own
  suffix (`trocador.app.evil.com`, `trocador.app.com`, `trocador-app.com`) or `-`-joined to filler words
  only (`www`, `login`, `secure`, `official`, `support`, `verify`, `wallet`, `swap`, …: `FILLER` in the
  module). `venice-hotels.com`, `brave-heart.org` and a bare `trocador.evil.com` are null. After the
  first code-review notes: the brand followed by a common suffix also counts (`COPY_SUFFIXES`: com net org
  io xyz app co me info biz cc to ru su), so `trocador.com.evil.net` and `foundation.app.evil.com` are red;
  `venice.hotels.com` stays null.
- `phishing_hosts` of a listing with no brand host (only a platform/shared host) link its first web
  host; a listing with only an onion host has nothing to link, so its entries are skipped.
- `stackexchange.com` joins `PLATFORM_HOSTS` (monero.stackexchange.com is listed).
- Skeleton uses NFKD (not NFKC) so accents split off before marks are removed.
- Types and wording live in `src/sites/lookalike-text.ts`, so the content script and popup don't carry
  tldts and the confusables table (content.js stays ~195 KB); background budget 700 → 900 KB
  (tldts ~130 KB, confusables ~30 KB).
- `tldts` 7.4.18 (7.4.19 is under two weeks old); confusables from Unicode 18.0.0.
- Fixtures: `tests/fixtures/xmrclub-feed-hosts.json` (ids, names, grades, hosts of the live feed,
  2026-10-31) and `tests/fixtures/popular-domains.txt` (637 domains); the scan finds exactly
  `foundation.app` → same-name, nothing red.
- Live (Chrome): red `!` badge and banner "xmr.club lists this site as a phishing copy of trocador.app
  (Trocador). [Go to trocador.app]" via a temporary `phishing_hosts` entry in the stored feed (restored
  after); foundation.app → amber `?`, no banner, popup row linking foundation.xyz. A fake-hostname page
  couldn't be reached (the local proxy refuses loopback and LAN addresses).
