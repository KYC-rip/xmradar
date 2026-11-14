# xmr.club interns: shown as a warning state, never an endorsement

## Feed (live, 2026-10-31)
An intern is a listing with `grade: null` and `intern: {day, days_required, track}`, e.g.
`torisim` (sims, day 3/60, `standard`) and `noxswap` (exchanges, day 3/90, `funds`, with a PGP `log`).
Graduation: the same id returns with a real grade and no `intern`. An intern that drops out was
archived (not a scam signal); real problems come as `incident: true`. Matching (hosts, path_prefix) as for
graded listings.

Today XMRadar parses it as `grade: ''`: toolbar badge grey `•`, popup card shows only the name, no banner.

## Change
1. `src/sites/feed.ts`
   - `SiteEntry.intern?: { day: number; daysRequired: number; track: 'funds' | 'standard' | string }`, parsed
     only when `grade` is null/'' and `intern` is an object with safe integers `1 ≤ day`, `1 ≤ days_required ≤ 3650`
     and `track` a short `[a-z_]{1,20}` string; `day` is shown capped at `days_required`. A listing with a
     grade and an `intern` block: the grade wins, `intern` is dropped (graduated).
   - `FEED_READER_V` 4 → 5, so a cached feed is re-read.
   - `internText(i)`: "Intern · day 3/90 · not graded yet"; `internCaution(i)`: for `track: 'funds'` →
     "It holds your coins during a swap: keep amounts small." else null.
2. Toolbar badge (`badgeFor`): `TabState.site` gains `intern: boolean`; an intern listing (no incident)
   → text `new`, amber `#b26a00` (the caution colour), never a grade colour. Order unchanged: receipt
   warn, incident, receipt caution, receipt ok, then the listing.
   With several listings on one host, the one shown is: incident first, then the worst graded, then an
   intern, then ungraded (`worstGrade` untouched; an intern never stands in for a grade).
3. Popup "This site" card (`src/ui/site-card.ts`): intern row title "Name · new on xmr.club" (no grade
   text), a hint line `internText`, and for funds an amber hint `internCaution`. No "graded"/"verified"
   wording anywhere for an intern. NKIP-0001 level, incident and the listing link as for any listing.
4. Page banner (`src/entrypoints/content/site.ts`): a `funds` intern gets a banner (dismissable as today,
   7 days per site): "NoxSwap is new on xmr.club (intern, day 3 of 90, not graded yet). It holds your
   coins during a swap: keep amounts small." `needsBanner` = incident || D/E/F || funds intern; the
   banner names the incident first, then a D/E/F grade, then the funds intern. Standard-track interns:
   no banner (card and badge only).
5. Letters and receipts: unchanged; an intern's `log` / `nkip01` is checked as for any listing (a
   verified letter is a real signal before a grade).
6. No ranking or "trusted" filter exists in XMRadar today; nothing to exclude. (If one is added, interns
   are excluded by `grade === ''`.)

## Tests
- parse: the two live shapes; grade + intern → intern dropped; bad intern (day 0, negative, huge,
  string track with spaces) → intern dropped, listing kept as ungraded; old cached reader v4 re-read.
- `internText` / `internCaution`: funds vs standard, day capped.
- `badgeFor`: intern → `new` amber; intern with incident → incident red; receipt states still win.
- card: intern row has no "grade", has the day line, funds caution present only for funds.
- banner: funds intern → banner text; standard intern → none; incident + funds intern on one host →
  incident leads; D grade + funds intern → D leads.

## Live
noxswap.io in Chrome: amber `new` badge, popup card with "Intern · day 3/90 · not graded yet" and the
keep-amounts-small line, the banner.

## Decisions after the plan review (INTERNS-1..4), as built
- Wording: an intern never shows a grade, "graded by xmr.club" or "verified site"; "not graded yet" and
  its NKIP-0001 receipt status (e.g. "verified receipts", which is about the order's receipt, not the
  site) are shown.
- Badge: receipt warn > incident > receipt caution > **intern (amber `new`)** > receipt ok > grade. A
  verified receipt or a grade never stands in for "this service is new and unrated".
- Lead listing (banner, badge): incident > D–F grade > funds intern > any intern > worst grade.
- `day` and `days_required` capped at 3650.
