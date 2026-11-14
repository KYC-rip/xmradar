# PLAN-XOSOUND + PLAN-LOGLINK (XMRadar 0.6.14, with PLAN-XOPOSTS)

Two small additions, reviewed together.

## A. PLAN-XOSOUND: a short, joyful sound on sending an xo

User (2026-11-06): "should we add a little sound when clicking Xo? short, enjoyful" → "yes, go with the sound too".

A1. `src/xo/sound.ts`: `playXoSound(big = false)`, synthesized with Web Audio (no audio file, nothing fetched):
  - a soft "pop" that rises into two notes: triangle wave, 660 Hz gliding to 990 Hz over 50 ms, then a sine at
    1320 Hz from 60 ms; each with a fast attack (5 ms) and an exponential decay; total ~180 ms.
  - `big` (hold: xo + like on X): a third note, 1760 Hz at 120 ms, ~260 ms total — the sound of the bigger bloom.
  - All notes go through one master `GainNode` at 0.08 (quiet; it's a tick, not a chime); per-note envelopes
    peak at 0.6, so even overlapping notes stay near the master's level. Decay: `exponentialRampToValueAtTime(0.0001, …)`, then `stop()`; never a ramp to 0.
  - One lazily made `AudioContext`, reused; closed when idle for 30 s (timer reset on each sound; a closed
    context is made again on the next send).
  - Autoplay: `primeXoSound()` makes/resumes the context **in the gesture handler itself** (click, Shift+Enter
    keydown, and the pointerdown that starts a hold), because the hold's xo fires from a 500 ms timer, which is
    not a user gesture. `playXoSound` then only schedules notes on a running context; if it isn't running, silent.
    The sound is scheduled right after `bloom`, before `toggle`'s first `await`.
  - Never throws: no Web Audio, a suspended context that won't resume, or any error → silent.
  - A muted tab is silent by the browser itself.
A2. When: only the user's own send, at the bloom (`toggle` in x-xo.ts, not undo, not a refusal, not received
  xos, not the celebrate animation on own posts). A send that's refused afterwards already played; fine (the
  shake says so).
A3. Switch: `XmrSettings.xoSound` (on unless `false`, like `xoRings`); Options → Badges on X, under the xo
  rows: "Sound when I send an xo" / hint "A short, quiet pop. Made in the browser, nothing downloaded." The
  content script reads it with the other xo settings (`xoManager` state `sound`).
A4. Tests (jsdom has no Web Audio): a fake `AudioContext` records oscillators/frequencies/gains: plain vs big
  note count, master gain 0.08 and every ramp target > 0, nothing when the switch is off, nothing on undo,
  the hold primes on pointerdown and plays from the timer, no throw when `AudioContext` is missing or
  `resume()` rejects, context closed after 30 s idle (fake timers) and made again on the next send.

## B. PLAN-LOGLINK: a letter of guarantee behind a download link

Found on dex.fo (2026-11-06): the "PGP Signed Guarantee" accordion has no letter text on the page; the signed
message is only in `<a download="receipt.asc" href="data:application/pgp-keys,...">` (and a Copy button).
XMRadar's letter reader (`pageLetterText`, receipt.ts) reads visible text, textareas and closed `<details>`;
it never sees a `data:` link. xmr.club is adding DEX.fo's key to the feed (`log.format = pgp`).

B1. `pageLetterText` also takes the decoded body of `data:` links on the page (`a[href]`, scheme matched
  case-insensitively):
  - only `data:` (never fetching anything); at most 5 such links, each at most 64 KB encoded;
  - media type (lowercased, parameters ignored) any `text/*`, `application/pgp-*`, `application/octet-stream`,
    `application/json`, `application/*+json` or none; `;base64` (case-insensitive) decoded with `atob` then
    `TextDecoder('utf-8')`, else `decodeURIComponent`; a decode error drops the link;
  - decoded once per href: a page-session `Map<href, text | null>` (bounded to 20 entries) so the 2 s rescans
    don't decode the same link again;
  - kept only when the decoded text holds a letter marker (`PGP_BEGIN` or `MISTPROOF_MARK`), as for `<details>`.
  - Everything else is unchanged: the letter is still checked against the feed's key by the background; the
    rescan (every 2 s while the page changes) picks up a link whose href fills in later. An attribute change
    must trigger the rescan: the receipt watcher's observer becomes
    `{ childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['href'] }` (href only,
    so class/style churn doesn't rescan). Text order: visible text, textareas, `<details>`, then data links; the
    background still picks and verifies the letter (several PGP blocks on one page is a pre-existing case).
B2. No `blob:` links (reading one needs a fetch of the page's object URL; not now). The Copy button already works
  through XMRadar's paste/copy path.
B3. Tests: a page with a base64 and a percent-encoded `data:` letter → found; `DATA:` and `;BASE64` → found; an
  empty `data:` link (dex.fo today) → nothing; a letter in an `image/svg+xml` link → ignored; a MistProof in an
  `application/json` link → found; > 5 links / > 64 KB → ignored; bad base64 / bad percent → ignored; a link
  decoded once across scans (cache); an href filled in after load triggers the real observer and is found.

## Budget
content.js is 249.9 KB against the 250 KB test budget (tests/log-wiring.test.ts), which exists to catch
openpgp.js (~240 KB) leaking into the page script. Raise it to 260 KB in the same commit, with that reason in
the comment: a 240 KB leak still fails it. Measure before/after.

## Rollout
Both go into 0.6.14 with PLAN-XOPOSTS. CHANGELOG lines. Commit/release need the user's OK.

## Revisions
- R1 (plan review 6.8): content budget section (raise to 260 KB, reason kept); context primed in the gesture
  handlers (the hold fires from a timer); master gain + ramps to 0.0001; observer `attributes: true` +
  `attributeFilter: ['href']`; decoded once per href (bounded cache); JSON media types for MistProof;
  case-insensitive scheme/type/base64; tests for each.

## As built (2026-11-06)
- Plan review 6.8 → 8.0; code review 8.0 (pass). Fixed after it: data-link letters captured only when they
  change; the decoded-link cache cleared on stop; the per-play master gain disconnected after its notes; a
  context closed while waking isn't played on. Kept: the first 5 `data:` links in page order (documented).
- Data-link letters are captured on their own, before the page text (so another PGP block on the page can't
  spoil a verified one); the page text is captured only when it changed.
- content.js 252.4 KB (both browsers) under the raised 260 KB budget. Tests 1483/1483.
