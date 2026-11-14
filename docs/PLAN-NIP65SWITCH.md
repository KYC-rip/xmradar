# PLAN-NIP65SWITCH: post to my NIP-65 list, or only to XMRadar's picks

## Why
With the relay box empty, posts go to the user's NIP-65 write relays. Many users' lists hold dead or
members-only relays, which they may not want to fix right now. They asked for a choice: their NIP-65
list, or just the defaults.

## Setting
- `Settings.useNip65?: boolean`, read with `useNip65On(s)` (on unless switched off, like the others), so
  every existing user keeps today's behaviour.
- Options → Posting → Relays, under the hint: a checkbox "Post to my NIP-65 relay list when the box above
  is empty". Off: XMRadar's picks (the 5 `POST_FALLBACK_RELAYS`). Saved on change, disabled until loaded,
  like the Behaviour boxes.

## Behaviour
- Order for posts: your own list (if any) → NIP-65 (only if the switch is on) → XMRadar's picks.
- `resolvePostRelays(pubkey, deps)` gets `deps.useNip65(): Promise<boolean>`. When false it skips the
  cache and the fetch (no relay is asked for the user's list) and returns `{ source: 'fallback',
  nip65Off: true }`.
- **Posts only.** Lookups (`resolveRelays`: Xap totals/notifications, public-record checks) and Xap
  receipts keep reading your NIP-65 list, since Xaps sent to you land on your relays; they call the
  resolver with `useNip65` always true. Badge discovery and setup are unchanged.
- The "In use" line: with the switch off and the box empty, "In use: relay.damus.io, nos.lol,
  relay.primal.net, nostr.mom, relay.ditto.pub (XMRadar's picks)." The relay-health skip (PLAN-DEADRELAYS)
  applies as before.
- "Load from NIP-65" keeps working (it fills the box, which wins over the switch).

## Tests
- `useNip65On`: missing → on; false → off.
- `resolvePostRelays` with `useNip65` false: fallback with `nip65Off`, never reads the cache or fetches,
  even with a fresh cache; manual list still wins.
- Lookups: `readRelaysOf` of a resolve with the switch ignored still returns the NIP-65 list.
- `relaysInUseText` for `nip65Off`.

## Docs
README "Relays": the switch, and that it changes where posts go only.
