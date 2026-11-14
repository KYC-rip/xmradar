# PLAN-UPDATECHECK: tell users when a new XMRadar is out (0.6.1)

## Why
XMRadar is installed from a zip (Chrome) or an unsigned build (Firefox, id `xmradar@local`). Neither browser
updates it: Chrome only self-updates store or policy installs, and Firefox's `update_url` needs a Mozilla-signed
build. Today a user on 0.6.0 learns about 0.6.1 only from an announcement.

## What

### 1. `xmradar.app/latest.json` (site/build.py)
- build.py already reads the latest GitHub release (tag, assets, SHA256SUMS, commit). It also writes
  `site-dist/latest.json`:
  `{"version":"0.6.1","tag":"v0.6.1","build":"0.6.1.7"}` — `version` is the tag without `v`, `build` the
  4-part zip version. Nothing else (no URLs: the extension builds its own links).
- `_headers` and HEADERS stay unchanged: Pages already serves `.json` as `application/json`, the site-wide CSP
  and no-referrer apply, and no CORS header is needed (the background has `<all_urls>`). So `safe_out` keeps
  recognising the existing `site-dist`; no manual step.
- The JSON comes from a pure function `latest_json(tag, version) -> str` in build.py (checks `tag == 'v' +
  first three parts of version`, exits otherwise), called by `main()` with the values it already validated.
- tests/site.test.ts runs that function without gh or network:
  `python3 -I -c` loading `site/build.py` with `importlib.util.spec_from_file_location`, calling
  `latest_json('v0.6.1', '0.6.1.7')` → exact JSON; a mismatched tag → exits non-zero. Plus a text check that
  `main()` writes `latest.json`.

### 2. The check (src/update/check.ts, pure, with injected deps like directory.ts / cleanup.ts)
- `readLatest(json): { version: string } | null` — accepts only an object whose `version` matches
  `^\d{1,4}\.\d{1,4}\.\d{1,4}$` and whose `tag === 'v' + version`; anything else is null (ignored, not stored).
- `isNewer(latest, current)`: compares the first three numeric parts of the manifest version
  (`0.6.0.6` → `0.6.0`). A newer CI build of the same version is not an update. A dev build (no build number)
  is compared the same way.
- `updateKeeper(deps)`:
  - `deps`: `fetch`, `readBody` (boundedBody), `alarms`, `enabled()`, `current()`, `held` (storage item
    `local:updateCheck` = `{ checkedAt: number, latest: string | null, notified: string | null }`),
    `notify(version)`, `clearNotice()`, `now()`.
  - Held state: `{ attemptAt, latest, notified }`. `attemptAt` is set when an attempt finishes, success or
    failure (HTTP error, timeout, non-JSON, oversize, bad or invalid JSON): a failing site is asked at most once
    a day, however often the worker starts. `latest` and `notified` only ever go up (the max of held and new);
    every write merges into the held value.
  - `apply(on)`: on → alarm `update-check` every 24 h; check now if `attemptAt` is older than 24 h; and if the
    held `latest` is not newer than `current()` (the user updated), `clearNotice()`.
    off → generation++, clear the alarm, the held value and the notification (`clearNotice()`).
  - `check()`: one at a time per generation (the in-flight promise is kept with its generation; after off→on a
    new check starts instead of waiting on the dropped one). GET `https://xmradar.app/latest.json` with
    `credentials: 'omit'`, `referrerPolicy: 'no-referrer'`, `redirect: 'error'`, `cache: 'no-store'`,
    15 s timeout, JSON content type, body capped at 4 KB. The request carries no version, id or query string.
    On success `latest = max(held.latest, new)`; on failure only `attemptAt` changes. A result that arrives after
    the setting went off (generation changed) is dropped entirely.
  - Notify when `latest > current()` and (`notified` is null or `latest > notified`); then `notified = latest`.
    So: one notification per version, none again for the same version, none after a rollback of latest.json,
    and a later, higher version notifies again.
  - `onAlarm(name)` runs `check()` for `update-check` only.

### 3. Where the user sees it
- **Notification** (existing `notifications` permission): "XMRadar 0.6.1 is out. Click to see what's new and
  download." Its id is `xmradar-update`. A click opens
  `https://github.com/KYC-rip/xmradar/releases/tag/v<version>` — built from the validated version, never from
  the JSON — in a new tab, then clears the notification. `notifications.onClicked` only acts on that id, and
  does nothing when no newer version is held.
- **Popup**: a line at the top of `<main>` while an update is held: "XMRadar 0.6.1 is out · Download".
  The button opens the same release page in a tab (a link would navigate the popup). Hidden otherwise.
- **Options**: the sidebar build line gets a second line "0.6.1 is out: download" linking to the release page.
- After the user installs the new version, `current()` catches up: popup and Options hide the line, and the
  background clears a notification still showing at its start (`apply`).
- No toolbar badge: the badge is per tab and already owned by receipts and lookalike warnings (`applyBadge`).

### 4. The switch
- `Settings.updateCheck?: boolean`, read with `updateCheckOn(s) = s?.updateCheck !== false` (on by default),
  synced like the other `Settings` switches.
- Options, sidebar under the build line: a checkbox "Check for updates once a day" with the hint
  "Once a day, asks xmradar.app for the latest version number. The request carries no version, ID or page;
  like visiting the site, it shows your IP address and browser, and that XMRadar is in use."
- Background: `updates.apply(updateCheckOn(s))` at start and whenever `settingsItem` changes that field.

### 5. Docs
- README "What it sends where" (or the equivalent section) and the site's privacy copy: one line for the daily
  version check and how to switch it off.
- package.json → 0.6.1.

## Tests (vitest)
- readLatest: valid; wrong types; tag mismatch; 5-digit parts; extra fields ignored; non-object.
- isNewer: 0.6.1 > 0.6.0.6; 0.6.0 vs 0.6.0.9 not newer; 0.10.0 > 0.9.9; equal; older.
- keeper: off → no fetch, alarm cleared, held removed, notification cleared; on with fresh `attemptAt` → no
  fetch; on with stale → one fetch with the exact options above; two concurrent checks → one fetch;
  HTTP error / non-JSON / oversize / bad JSON / invalid fields → `attemptAt` set, `latest` kept, no notify, and a
  second start right after makes no fetch; newer → notify once; the same version again → no notify; latest.json
  rolled back then the same version again → no notify; an older latest never lowers the held one; a still newer
  version notifies again; off mid-fetch → result dropped; off→on mid-fetch → a new fetch starts and its result
  is kept; held latest not newer than current at apply → notification cleared.
- Popup and Options: the line shows only when held latest > current; the link/button targets the release page.
- site.test.ts: `latest_json` as above.

## Not in scope
- Downloading or installing anything; the user downloads and checks SHA256SUMS themselves.
- Firefox AMO unlisted signing + `update_url` (real auto-update for Firefox): a separate later step.
- Signing latest.json: a forged file can only cause a notice that links to our own GitHub release page for
  a version that must match the strict pattern; a missing release page is harmless.

## Release
- Users on 0.6.0 never see this check; the 0.6.1 announcement tells them to update by hand.
