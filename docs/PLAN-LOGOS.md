# PLAN-LOGOS: exchange logos on swap records, from xmr.club's signed logo pack

## Why
The saved receipts and letters (Options → Swaps and sites) are text-only cards. xmr.club now publishes one
logo pack for all its listings, referenced from the signed swap-sites list. Fetching a logo per record would
tell a server which exchanges the user used; the pack is the same file for everyone, so it reveals no exchange
or record. Like the site-info list itself, the request still shows the user's IP address, its timing and that
XMRadar's site info is in use.

## The source (checked 2026-11-02)
- The signed payload of `https://xmr.club/api/v1/swap-sites.json` has
  `logo_pack: { url, sha256, bytes, count, size_px, format, generated_at }`, e.g.
  `url: https://xmr.club/feed/logos-77c05d749ebb.json`, `sha256: 77c05d74…412a` (64 hex), `bytes: 238740`,
  `count: 328`, `size_px: 32`, `format: "webp"`.
- The pack is a flat JSON object `{ "<site id>": "data:image/webp;base64,…" }`; every value is a real WebP
  (RIFF…WEBP), at most 1.2 KB decoded; ids are the feed's site ids. Served `application/json`,
  `cache-control: immutable`, its name carries the hash. 88 of the 92 sites with receipts/letters have one.

## 1. Reading it from the feed (src/sites/feed.ts)
- `SiteFeed.logoPack?: { url: string; sha256: string; bytes: number; sizePx: number }`, parsed whole or dropped:
  `url` parsed with `URL`: protocol `https:`, hostname exactly `xmr.club`, no username or password, no port,
  empty search and hash, and the raw string's path matching `^/feed/[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*\.json$`
  (no `%`, so no encoded dot segments; no `..`). `sha256` 64 lowercase hex, `bytes` an integer 1…1 MB,
  `format === 'webp'`, `size_px` an integer 8…64. Other fields ignored.
- `FEED_READER_V` 7 → 8 so a kept feed is re-read once (the existing reader check does the rest).

## 2. Keeping it (src/sites/logos.ts, pure with injected deps; wired in background.ts)
- Storage item `local:logoPack` = `{ sha256: string; logos: Record<string, string>; hosts: Record<string, string> }`,
  both records built with `Object.create(null)` and read with `Object.hasOwn`; ids must match
  `^[a-z0-9][a-z0-9-]{0,63}$` (so no `__proto__` / `constructor`).
- `hosts` maps a host to a site id only when exactly one site in the current feed lists that host; a host two
  listings share gets no entry (the card shows the initial instead of maybe the wrong logo). It is rebuilt from
  every accepted feed, also when the pack's hash is unchanged (sites and hosts change more often than logos);
  logos of ids no longer in the feed are dropped at that point too.
- `syncLogos(feed)` runs after a new feed is stored and at worker start:
  - feed has no `logoPack` → remove the item; same `sha256` as kept → only `hosts`/ids are refreshed (no request).
  - else GET the url: `credentials: 'omit'`, `referrerPolicy: 'no-referrer'`, `redirect: 'error'`, 15 s,
    body capped at `min(bytes, 1 MB)` + JSON content type; SHA-256 of the body must equal `sha256`
    (crypto.subtle). Then parse: an object; keep only keys that are ids of the feed's sites and values matching
    `^data:image/webp;base64,[A-Za-z0-9+/]+={0,2}$`, decoded ≤ 4 KB, a RIFF/WEBP file whose size field fits the
    data, whose first chunk is `VP8 `, `VP8L` or `VP8X`, and whose width and height (read from that chunk's
    header) are 1…`sizePx * 2` (64 px at most). Anything else is dropped one by one; a hash mismatch or bad
    JSON drops the whole pack (the kept one stays).
  - Each download is stamped with the hash it was started for. Before it is stored, the current kept feed must
    still name that hash and site info must still be on (the feed's generation); otherwise it is discarded.
    A newer feed with another hash starts its own download rather than joining the old one.
- Site info switched off → the item is removed with the feed (`applySiteInfoSetting(false)`).
- The pack is downloaded only when its hash changes, so normally once per pack, not twice a day.

## 3. Showing it (src/ui/receipts-panel.ts, shared helper src/ui/site-logo.ts)
- `siteLogo(pack, { siteId?, host? }): HTMLElement` → a 28×28 `<img src=data:… alt="" width height>` with
  rounded corners, or, without a logo, a same-size circle with the name's first letter (theme colours), so the
  cards line up either way.
- Letters: by `siteId`. Receipts: by issuer host (`normalizeHost`) through `pack.hosts`.
- The card title row becomes `[logo] DX-VJGTWF · Mistex`; the panel re-renders when `local:logoPack` changes.
- Only `data:image/webp` URIs from the checked pack ever reach `src`; no network request from the page.
  Extension pages allow `data:` images under the default MV3 CSP.

## 4. Docs
- README "Site info (xmr.club)" and the Options hint: "and xmr.club's logo pack, one file for everyone,
  downloaded when it changes; like the list, the request shows your IP address but nothing about your swaps".
  The site's privacy line stays true (the same signed list, the same files for everyone).

## Tests (vitest)
- feed: logo_pack parsed; http / other host / `xmr.club.evil` / userinfo / port / query / fragment / `..` /
  `%2e%2e` / other path / bad sha / huge bytes / other format / size_px out of range → dropped, the rest of the
  feed kept.
- syncLogos: same hash → no fetch; new hash → one fetch with the options above; hash mismatch / bad JSON /
  oversize / non-JSON → kept pack unchanged; entries filtered (unknown id, png data URI, not WebP magic,
  > 4 KB, `javascript:`, a 300-byte WebP claiming 10000×10000, `__proto__`/`constructor` keys); hosts map
  built; a host two sites share → no entry; same hash with a site added/removed → hosts updated, no fetch;
  no logoPack → item removed; switched off mid-fetch → dropped; a newer feed with another hash arriving
  mid-fetch → the old result discarded, the new one fetched and kept.
- panel: a letter card and a receipt card get the `<img>` with the pack's data URI; no logo → the initial;
  no `<img>` with any other src.

## Not in scope
- Logos on the in-page card, the popup's site card, or the warning page (possible later, same helper).
