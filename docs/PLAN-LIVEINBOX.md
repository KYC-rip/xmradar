# PLAN-LIVEINBOX: xos and Xaps within seconds while X is open

User (2026-11-06): an xo from mnr_network to XBToshi took until the next 30-minute check to show. "half an hour
for a Xo seems like forever or nothing at all." Agreed design: a live relay subscription while an X tab is open;
the 30-minute check stays as the fallback.

## Why not always-on
MV3 background workers sleep after ~30 s idle (Firefox's event pages likewise); an always-open socket would need
a keepalive forever, hold connections all day, and tell relays continuously that this IP watches the npub. Live
only while the user is on X, where a heart or a notification matters.

## Design

L1. Content (x.com, top frame, inside startBadges, only with the inbox switch on): a heartbeat message
  `{ type: 'x-live' }` to the background on start, when the tab becomes visible, and every 25 s while it stays
  visible (none while hidden). Extension messages keep the background awake in Chrome and Firefox, so no
  WebSocket-activity rule is relied on. Sender-checked like other x.com messages (`isXContentScript`).
L2. Background `liveInbox` (new `src/nostr/live.ts` for the socket part, wiring in background.ts):
  - on a heartbeat: remember `lastSeen`; if not running and the inbox switch is on and a key is known, start;
    if the last full check (xo or Xap `checkedAt`) is over 2 minutes old, run the checks now (catching up after
    the tab was away).
  - running: one WebSocket per relay to the inbox relays (the xo keeper's relays ∪ the Xap keeper's, at most 6),
    one REQ with three filters, `since` = now − 60 s: `{kinds:[17], #p:[me]}`, `{kinds:[17], #X:[twitter:<proven
    handle>]}` (when proven), `{kinds:[9042], #p:[me]}`.
  - an EVENT that's validly signed and matches a filter → after a 3 s debounce, `xoInbox.check()` (kind 17) or
    `xapInbox.check()` (kind 9042). The keepers do everything else as today (verdicts, counts, notification,
    floating hearts via the counts item); the live part only says "look now". At most one check per kind per
    20 s; a burst waits for the next slot.
  - stop: no heartbeat for 70 s (a 30 s timer while running), the switch off, the key or proven handle changed
    (restart with the new filters), or the worker shutting down. CLOSE then close each socket.
  - a dropped socket reconnects after 5 s, doubling to 60 s, while running; a relay sending CLOSED/NOTICE on the
    REQ is left closed until the next start.
L3. No new data leaves the browser: the same relays and filters the 30-minute check already sends, just held
  open while X is visible. The Options hint for "Tell me when I get a Xap or an xo" says so.
L4. Firefox: messages keep the event page alive as in Chrome; if the page is torn down anyway, the next heartbeat
  starts it again (≤ 25 s gap) and the 2-minute catch-up check covers the gap.

## Tests
- live.ts with a fake WebSocket: REQ with the three filters and `since`; EVENT with a bad signature or a
  non-matching filter ignored; a matching one calls back; reconnect backoff 5 → 10 → … 60 s; stop sends CLOSE
  and closes; CLOSED leaves the relay closed.
- controller (fake timers): heartbeat starts it; no heartbeat 70 s stops it; switch off stops it; a burst of
  events → one check after 3 s, the next not before 20 s; stale checkedAt (> 2 min) → a catch-up check on
  heartbeat; key change → restart with the new filters; no key / switch off → nothing opened.
- content: heartbeat on start and visibility, every 25 s while visible, none hidden, none with the switch off.

## Budget
background.js 954.8/960 KB: live.ts is small (~2 KB); if it passes 960, raise to 970 KB with the reason.

## Rollout
0.6.15, with the DEX.fo label fix. Commit/release on the user's OK.

## As built (2026-11-06)
- Plan review 7.4 (pass); code review 7.8 (pass). Fixed after it: a reconnect asks from 2 minutes back, not
  from the session's start; the backoff starts over on EOSE (a served subscription), not on connect; nothing
  is handed on after stop; no relays → nothing opens and the next heartbeat retries. Catch-up runs when the live
  subscription opens (after the tab was away 70 s+), per kind, not on every heartbeat. AUTH drops a relay for
  the session (the 30-minute check still reads it). A throttled check already queued may still run once after
  stop (harmless).
- background.js 958.x/960 KB, content.js 256.8/260 KB.
- Live test (2026-11-06, XBToshi ← mnr_network): every xo arrived without the 30-minute wait, but a burst waited
  for the 20 s gap (up to ~20 s). Tightened to 2 s debounce, at most one check every 5 s per kind.
