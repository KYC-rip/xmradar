# PLAN-RELAYDEFAULTS: say which relays are used, and post to two more when you have no list

## Why
Options → Posting shows an empty relay box with a "wss://…" input. Users who don't know Nostr think they
must fill it. They don't: empty means "your NIP-65 write relays, else XMRadar's defaults" — but the page
never says which relays are actually used.

The defaults are also only 3 (primal, damus, nos.lol). A user with no NIP-65 list is found by readers only
on those big relays, so reach matters more than speed; but if one is down (damus answered 1 of 3 probes
in a test on 2026-11-03), a post rests on two.

Measured on 2026-11-03 (stats.andotherstuff.org reach, 3-round probe from one location): nostr.mom (#11 by
reach, 3/3) and relay.ditto.pub (#9, 3/3) are popular, free to write to and answered every time. Not taken:
mostr/momostr (bridges; momostr demands AUTH), shitforce (self-signed cert), relay.nostr.band (timed out),
purplepag.es (refuses notes), nostr.wine (paid writes). Speed isn't the criterion: it varies by user
location, and posts go to all relays in parallel.

## 1. Post relays (publishing only)
- `src/settings.ts`: `POST_FALLBACK_RELAYS = [...DEFAULT_RELAYS, 'wss://nostr.mom', 'wss://relay.ditto.pub']`.
  `DEFAULT_RELAYS` stays the same 3: every lookup (Xap totals, Xap notifications, badge discovery, NIP-65
  lookup, public-record checks) keeps using only them, so the privacy notes ("3 public relays: damus,
  nos.lol, primal") stay true and no new relay sees which npubs this browser asks about.
- Pure helper `pickPostRelays(manual: string[], nip65: string[]): { relays: string[]; source: 'manual' |
  'nip65' | 'default' }`: manual (without index relays) if any, else NIP-65 write relays (without index
  relays) if any, else `POST_FALLBACK_RELAYS`.
- Background: `postRelays(pubkey)` = the existing resolution (manual → cached/fetched NIP-65), passed through
  `pickPostRelays`. Used by `publish` and `republish` (its allowed set must match what publish used).
  `resolveRelays` keeps returning `DEFAULT_RELAYS` as its last step for every read path, unchanged.
- Xap receipts keep their current relays (unchanged).

## 2. Options: "In use"
- New message `relays-in-use` (extension pages only) → `{ relays, source }`. It never makes a network
  request: manual list; else the cached NIP-65 list for the saved pubkey (any age); else the fallback.
  Opening Options doesn't ask relays about the user's npub. "Load from NIP-65" stays the explicit lookup.
- Under the empty box, a line: "In use: relay.primal.net, relay.damus.io, nos.lol, nostr.mom,
  relay.ditto.pub (XMRadar's picks). If you have a NIP-65 relay list, it's used instead when you post." or
  "In use: … (your NIP-65 relay list)". Hidden when the user has their own list (the chips say it).
  Re-rendered when settings change. Built with textContent only.
- Hint changes to: "Nothing to fill in: XMRadar picks relays for you. Add relays here only to choose your own."

## Tests
- `pickPostRelays`: manual wins; NIP-65 next; fallback last; index relays dropped from manual and NIP-65;
  all-index manual list falls through.
- `POST_FALLBACK_RELAYS`: contains every `DEFAULT_RELAYS` entry, all `wss://`, no index relay, no duplicates;
  `DEFAULT_RELAYS` still the 3 named in the Xap privacy note.
- Options text for each source.

## Docs
README "Relays": what's used when the box is empty, and that lookups use only the 3 defaults.

## Not in scope
Picking relays by measured speed per user; publishing a NIP-65 list for users who have none.

## Amendment after plan review round 1 (6.7, failed) — these rules replace the matching ones above
1. **One source-aware resolver.** Pure `resolvePostRelays(deps) → { relays, source: 'manual' | 'nip65' |
   'fallback' }` in `src/nostr/post-relays.ts`, with injected `manual()`, `cached(pubkey)`, `fetch(pubkey)`,
   `saveCache(pubkey, relays)`, `now()`. Branches, in order:
   - manual list without index relays, non-empty → `manual` (an all-index manual list falls through);
   - cached NIP-65 for this pubkey, younger than 1 h, non-empty after dropping index relays → `nip65`;
   - fetched NIP-65 write relays, non-empty after dropping index relays → cached, `nip65`;
   - anything else (no pubkey, fetch failed, no list, empty list, all-index list, only a stale cache) →
     `fallback` with `POST_FALLBACK_RELAYS`. A stale cache is never used: same as today.
   `resolveRelays` (reads) becomes a wrapper: `source === 'fallback' ? DEFAULT_RELAYS : relays`. One
   implementation, so a NIP-65 list equal to the defaults is still `nip65`.
2. **Retry uses what publish used.** `publish` stores the relays it sent to, per composer session, in
   `session:publishRelays` (`Record<sessionId, string[]>`, at most 50 sessions, removed with the session
   on `close-session`). `republish` allows only relays in that stored set; it never recomputes. No stored
   set → "No relays to retry".
3. **Options line never claims more than it knows.** `relays-in-use` (extension pages only, no network)
   returns the resolver's answer with `fetch` disabled, plus `known: boolean`:
   - `manual` → no line (the chips say it);
   - `nip65` (fresh cache) → "In use: a, b, c (your NIP-65 relay list).";
   - `fallback` with no fresh cache for a saved pubkey → "When you post, XMRadar uses your NIP-65 relay list
     if you have one, otherwise relay.primal.net, relay.damus.io, nos.lol, nostr.mom, relay.ditto.pub.";
   - an all-index manual list → the same line, prefixed "purplepag.es keeps profiles only, so notes go
     elsewhere:" (index relay names from `INDEX_RELAYS`, not hard-coded).
   Text from a pure `relaysInUseText(answer)`; DOM by textContent only.
4. **Kept current.** The NIP-65 cache item moves to `src/settings.ts` (`nip65CacheItem`, same storage key
   `local:nip65Cache`, so nothing is lost). Options re-asks on changes to `settingsItem`, `pubkeyItem` and
   `nip65CacheItem`, and on `visibilitychange` to visible (a cache that went stale while open).
5. **Tests.**
   - `resolvePostRelays`: every branch above, incl. stale cache + failed fetch → fallback, all-index manual,
     all-index NIP-65, NIP-65 equal to the defaults stays `nip65`, fetch disabled never calls fetch.
   - read wrapper: fallback → exactly `DEFAULT_RELAYS` (lookups stay on 3).
   - `republishAllowed(stored, requested)`: only stored relays; none stored → empty.
   - `relaysInUseText` for every case; `POST_FALLBACK_RELAYS` invariants as before.
