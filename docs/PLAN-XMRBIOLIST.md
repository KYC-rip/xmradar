# PLAN-XMRBIOLIST: list a Nostr-proven X account on xmr.bio from XMRadar (round 3)

## Why
A badge that comes only from Nostr (key's Monero address + NIP-39 X proof) is shown only to XMRadar users with
"Discover X badges via relays" on, which is off by default; xmr.bio's signed directory is downloaded by every
XMRadar, so a listing there makes the badge visible to all, gives a xmr.bio page and `handle.xmr.bio`, and (with
the deployed `nostr_pubkey` field) makes the person's xos count. xmr.bio's own sign-up needs a separate token
tweet checked through Grok (paid); XMRadar users already have everything needed after step 4.

## Facts
- kyc-rip `POST /v1/bio/verify` (routes/bio.ts): token tweet fetched via Grok, then `upsertProfile` with a device
  `public_key` (ed25519, dashboard login). `bio_profiles.public_key` is nullable; `directory_listed` defaults to 1.
  SIWM login on xmr.bio rotates/installs the device key after a Monero-address signature.
- `bio_proofs` nostr rows are trusted only through `proofMethod` (verifyEvent, npub matches, content includes
  `xmr.bio:<handle>`).
- XMRadar step 4 (`link-x`) publishes a kind 10011 with the proof tweet; `setupStatus` verifies it
  (`verifyTwitterProof`: oEmbed, then syndication).

## Changes
### kyc-rip (deploy only with the user's OK)
1. `POST /v1/bio/register/nostr`, rate-limited per IP (5 / 10 min). Body `{ handle, address, tweet_id, event }`:
   - `handle` X format; `address` passes `isSigninAddress` (standard or subaddress, checksum; round 2);
   - `event`: kind 27235, `verifyEvent`, `created_at` within ±10 min, content exactly
     `xmr.bio:<handle> list <address>` (so `proofMethod` accepts it later as this handle's nostr proof), and
     exactly one tag `["i", "twitter:<handle>", "<tweet_id>"]` matching the body (see round 2 below);
   - the proof tweet: X oEmbed (`publish.twitter.com/oembed?url=https://x.com/<handle>/status/<tweet_id>`), its
     `author_url` must be that handle and its own text (not a quote) must contain the first-person claim
     `I control the following Nostr public key: <the event key's npub>` (round 2); syndication fallback like
     XMRadar's; no Grok;
   - an existing profile for the handle is never overwritten (atomic insert, round 2) → 409, or 200 for the
     same registration retried;
   - the insert creates the profile (address, display_name = handle, `public_key` NULL, `verified_at` now) and the
     `bio_proofs` nostr row (npub, event JSON), sync OpenAlias like `/verify`; the next directory build lists it
     with its `nostr_pubkey`. Response: `{ success, profile_url }`.
2. Tests: good registration; bad signature / stale / wrong content / other handle's tweet / tweet without the
   npub / quoted npub only / existing profile 409 / bad address / rate limit.

### XMRadar
3. Step 4 (Link your X account): a checkbox **"Also list me on xmr.bio (public directory)"**, ticked by
   default, with a one-line hint (it publishes your handle, address and npub on xmr.bio; you can unlist there).
   Ticked: after the link is published and its proof verifies, the background builds the kind-27235 event
   (signed like the setup events: signer or XMRadar identity; 27235 added to the managed allowlist) and POSTs it
   with the handle, the published address and the tweet id. No cookies, no referrer, 15 s, capped answer.
4. The status row "xmr.bio" shows the result: listed (with a link), already there, or the error; a **List me
   on xmr.bio** button retries for someone who unticked or failed earlier.
5. Tests: event content and kind; request built only after a verified proof; 409 shown as "already there";
   untick → nothing sent.

## Round 1 review (6.2) and what changed
1. **Tweet intent (high):** a tweet merely mentioning the key's npub isn't enough. The tweet's own text must
   contain the NIP-39 first-person claim exactly: `I control the following Nostr public key: <npub>` (what
   XMRadar's proof tweet says, and what `verifyTwitterProof` checks the npub in), so only an account that
   claimed the key itself qualifies; tweets naming someone else's npub, lists of npubs, quotes don't. The signed
   event names the tweet: tag `["i", "twitter:<handle>", "<tweet_id>"]`, which must match the body.
2. **Atomic, idempotent (high):** `INSERT ... ON CONFLICT(handle) DO NOTHING` (never `upsertProfile`); changes
   = 0 → if the existing profile has this address and a nostr proof by this key, 200 (a retry after a lost
   answer); else 409 "Already on xmr.bio; manage it there".
3. **Consent (high):** the user decided ticked-by-default. The checkbox hint names what's published ("your X
   handle, Monero address and Nostr key, on xmr.bio's public directory and as <handle>.xmr.bio"); the result row
   links to the profile and says how to remove it (xmr.bio → Sign in with Monero with that address → unlist or
   delete); the choice is remembered.
4. **Listing state (medium):** `xmrbioListItem` keyed by handle + pubkey: `{ address, tweetId, eventId,
   status: 'listed' | 'exists' | 'failed' | 'off', at, error? }`. Sent once per key+handle+address, only when a
   valid address is published and the link proof verified; untick = `off` (nothing sent, kept across reloads);
   a relink with another handle/key/address is a new entry; the retry button resends a `failed` / `off` one.
5. **Address (medium):** server checks with kyc-rip's `isSigninAddress` (standard or subaddress, keccak
   checksum; integrated refused); XMRadar sends only a `validateMoneroAddress`-ok standard/subaddress.
6. **Revalidation (medium):** the tweet id is in the stored signed event (auditable). Re-checking proofs later
   is the same open question as for every xmr.bio profile today; out of scope, noted.
7. **Rate limits (medium):** per IP 5 / 10 min, per handle 3 / day, per key 3 / day, global 200 / day; the
   handle and key limits count before the X fetch.
8. **27235 (low):** the managed identity signs kind 27235 only through this one internal template builder
   (exact content and tags); no message lets a page request one.
9. Tests added: a tweet that only mentions the npub (refused); a tweet listing several npubs; tweet id
   mismatch; concurrent same-handle requests (one wins, the other 409/200); idempotent retry; checksum-bad and
   integrated addresses; existing profile's address unchanged; XMRadar: untick persists, no send without an
   address, one send per key+handle+address.

## Round 2 review (6.7) and what changed
1. **Old tweet reuse (disputed, documented):** a tweet belongs to the X *account*, not the handle: oEmbed and
   syndication give the account's *current* handle, and the plan requires it to equal the handle being listed.
   So after a handle moves to another account, the old account's tweets show its new name (or are gone with it)
   and fail; the transfer case doesn't replay. What remains: someone who stole a key the account itself once
   claimed in a proof tweet, listing that account before its owner does. Documented as a known limit (the same
   as xmr.bio's existing nostr proofs); recovery is xmr.bio support. No tweet-age window: people link once and
   their proof tweet is legitimately old.
2. **Rate limits (agreed):** failures count only in the per-IP bucket (5 / 10 min). The per-handle (3 / day),
   per-key (3 / day) and global (200 / day) budgets count only registrations whose proof verified, checked
   just before the insert, so nobody can use up a target's or everyone's quota with failing attempts.
3. **Atomic write (agreed):** the profile and its nostr proof are written in one D1 `batch` (all or nothing);
   the profile insert uses `ON CONFLICT(handle) DO NOTHING` and, when it inserted nothing, the batch writes no
   proof either (the proof insert is conditioned on the profile's address and NULL public_key matching this
   request, in SQL).
4. **Idempotent 200 (agreed):** only when the existing profile has this address, `directory_listed = 1`, and a
   nostr proof whose stored event has this key, this content and this tweet tag; otherwise 409 with a reason
   (`exists`, or `exists-unlisted`).
5. **Unlist vs delete (agreed):** the hint and result row say it plainly: on xmr.bio, *unlist* only hides you
   from the directory (your page and <handle>.xmr.bio stay); *delete* removes the profile, its proofs and
   <handle>.xmr.bio (as xmr.bio's delete route already does).
6. **Choice and state (agreed):** `xmrbioListPrefItem` (global, default `on`): unticking sets it `off` and it
   stays off for every later key/handle/address until ticked again. The send record is keyed by
   handle + pubkey + address (a map), so each combination is sent at most once.
7. **Proof phrase (agreed):** substring match of `I control the following Nostr public key: <npub>` (the real
   `proofTweetText` contains it; the test uses `proofTweetText` itself), and the tweet's own text must contain
   exactly one npub (any second `npub1…` word → refused).
8. **Status (agreed):** the "xmr.bio" row shows the live `/resolve` answer XMRadar already reads (found, linked to
   this key, or not there); the local record only adds the last send's error, labelled "last try".
9. Tests added: proofTweetText fixture passes; two npubs refused; failing attempts don't consume handle/key/
   global budgets; a batch where the profile exists writes no proof; idempotent 200 refused for an unlisted or
   proof-mismatched profile; unticked stays off across a key change; one send per handle+key+address.

## Out of scope
Updating an existing xmr.bio profile from XMRadar; dashboard login for these profiles (xmr.bio's SIWM covers it).
