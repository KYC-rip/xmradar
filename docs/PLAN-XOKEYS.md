# PLAN-XOKEYS: xo for xmr.bio-listed authors, and a faded heart where no key is known

## Why
The user saw an XMR pill and a Xap button but no xo heart on a reply by @R3st4rtY0urL1f3. His pill comes
from xmr.bio's signed directory (handle + address only); xo needs the author's Nostr key (`xapEntry`), so
the heart is hidden. The user asked for both: (1) xmr.bio's directory carries the linked npub, (2) a faded
heart with an explanation where no key is known.

## Facts
- kyc-rip `api/src/libs/bio/directory.ts`: `buildDirectoryPayload` selects `handle, address, verified_at`
  from `bio_profiles` (verified, `directory_listed = 1`), signed by the cron into KV; v 1.
- `bio_proofs (handle, type='nostr', identifier=npub, proof=signed event JSON)`; `proofMethod()` in
  `routes/bioTrust.ts` re-checks a nostr proof at read time (verifyEvent, npub matches, content has
  `xmr.bio:<handle>`) and `/resolve` returns only proofs with a method.
- XMRadar `src/identity/directory.ts` parses entries, ignores unknown fields (K2–K4, K6), and
  `directoryIndex` makes `source: 'xmrbio'` BadgeEntries (no pubkey). `xapEntry` only takes `nostr` entries.

## Changes
### kyc-rip (private repo, user approved; deploy only after asking)
1. `buildDirectoryPayload`: also read the listed handles' `bio_proofs` rows of type `nostr` (one SELECT with
   a JOIN), and add `nostr_pubkey` (64 lowercase hex, from the verified event's pubkey) to an entry only when
   `proofMethod` says the proof holds (`nostr-signed-event`). Absent otherwise. `v` stays 1 (additive
   optional field). Unit test: valid proof → field; tampered/mismatched/other-handle proof → no field.
2. `docs/xmr-bio-api.md`: document the optional field.

### XMRadar
3. `directory.ts`: keep `nostr_pubkey` when it is 64 lowercase hex (`DirectoryEntry.pubkey?`);
   `directoryIndex` puts it on the xmrbio BadgeEntry as `pubkey`.
4. `resolve.ts`: `xoKey(badge)` = `xapEntry(badge)?.pubkey ?? first verified xmrbio entry's pubkey`.
   Xap keeps `xapEntry` (its R14 binding is unchanged).
5. x-badges: xo uses `xoKey`; when a post has an XMR pill but no key at all, place a **faded** heart
   (opacity 0.45, no count) with the tooltip "@handle hasn't linked a Nostr key, so an xo can't reach them.
   Hold to like on X." Click: nothing but the tooltip; hold (or Shift+Enter): presses X's like only.
6. Tests: parse keeps/drops `nostr_pubkey`; xoKey order; faded heart placement, no send on click, hold
   likes on X only.

## Out of scope
Changing Xap's recipient rule; per-handle lookups to xmr.bio.
