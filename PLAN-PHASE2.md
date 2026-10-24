# XMRadar Phase 2 — Monero badges and tips on X

Goal: while you browse X, tweets from accounts that accept Monero get a small XMR badge. Clicking it opens a tip popup with a `monero:` link, a QR code and the address. XMRadar users can also set up their own account so others see a badge on it.

> Revision 2. It addresses OpenCode round-1 review (6.5): BRIDGE-1, MERGE-1, TRUST-1/2/3, PRIV-1, RATE-1, NIP39-1, K2-1, STORE-1, SYND-1, SETUP-1, PERF-1, XSS-1, PHASE-1, MONERO-1, FALLBACK-1, TEST-1, LEGACY-1. B′ and K5 are deferred, as suggested.

## 1. What "accepts Monero" means

An X handle **accepts Monero** if at least one of these sources gives it a valid mainnet address:

| # | Source | Keyed by | How the handle is linked | Who verifies |
|---|---|---|---|---|
| A | **xmr.bio** profile | X handle | xmr.bio proof tweet | xmr.bio. The entry arrives signed with the pinned ed25519 key |
| B | **NIP-A3** kind `10133` `["payto","monero",addr]` | npub | **NIP-39** kind `10011` `["i","twitter:<handle>",<proof>]`. The proof tweet contains the npub | XMRadar (opt-in, client-side) **or** xmr.bio's indexer (K6, carried in the signed directory) |

### Merge rules
- **Primary address**, the one used for the QR code and `monero:` link: A if present, otherwise the newest verified B claim.
- **Several B claims for one handle** (key rotation, an old key, or someone falsely claiming the handle): every verified claim is kept. The newest verified claim, by proof check time and then `created_at`, is primary. All others are listed in the popup with their npub and address.
- **Different addresses:** the popup always shows every distinct address with its source and an "addresses differ" note. It never silently picks one without telling the user.
- **Unverified B claims** (proof check failed, or no proof): no badge. The popup lists them as "unverified", only if the user opens it via another source.

### What the badge means
"This account published this address." We don't claim the account owns the address, which doesn't matter for a tip. The popup always shows the source, the verification method and the date.

### Address validation (`src/xmr/address.ts`)
- **Mainnet only.** Accepted: standard (prefix 18, 95 chars), subaddress (42, 95 chars), integrated (19, 106 chars, with the payment ID shown).
- **Checks:** Monero's base58 (8-byte blocks), the prefix varint, and the **Keccak-256** checksum. `@noble/hashes` becomes an **explicit pinned dependency**.
- **Rejected addresses:** testnet, stagenet, or a bad checksum get no badge. If such an address shows up in a popup source panel, it's displayed as "invalid address (reason)", never dropped silently.

## 2. Privacy model

What each party can learn:

| Party | Default (badges on, Nostr discovery off) | Opt-in Nostr discovery |
|---|---|---|
| xmr.bio (`api.kyc.rip`) | One directory download every 6h: your IP and timing, **not which handles you view**. Per-handle `/resolve` happens **only** when you click "check xmr.bio" in a popup | same |
| Nostr relays | nothing | The batch of handles on screen (kind 10011 `#i` queries) |
| X (syndication/oEmbed CDN) | nothing beyond normal X browsing | Your IP and timing for **proof-tweet IDs of handles found through relays**. These may not be tweets in your timeline |

Rules:
1. **Passive badges from source A need a verified directory** (K1). Without one, the x-badges pipeline **never** calls `/resolve`. This is enforced in `resolveHandles`, with a test.
2. **Passive badges from source B** come from the directory once K6 ships, with no relay or X traffic. Until then they come only from the **opt-in** relay discovery, which carries a warning that "relays and X can see which accounts you're looking at". Queries are batched (up to 50 handles per REQ), deduplicated and cached.
3. **On-demand checks** (the popup's "verify this entry" button) are user-initiated. They may contact X's CDN and relays, and say so.

## 3. Trust model

- **Pinned key.** The xmr.bio service key ships in full: `fb9c9025822ed260821a09121fbf97a8e1bf6321749feb834d6740ce516dff94`, ed25519.
  - It's stored as a **set** `PINNED_XMRBIO_KEYS` so a key rotation can ship both keys.
  - A unit test asserts the set is non-empty and each key is 64 hex characters.
  - Any key mismatch is rejected.
- **No SDK convenience calls.** XMRadar verifies with its own `verifySignedEnvelope<T>(env, pinnedKeys): T`, using `@noble/curves` ed25519 (already in the dependency tree; it becomes an explicit pinned dependency).
  - It never calls the SDK's `resolve()`, which falls back to `/meta` when no `trustedKey` is passed.
  - The SDK is not a dependency, so the risky API can't be called by accident.
  - Proposal for kyc-rip, separately: add a generic `verifySignedPayload<T>` to the SDK and make `trustedKey` required.
- **Wire format** (same for resolve and directory): `{payload: string(JSON), signature: hex, public_key: hex, alg: "ed25519"}`. The signature covers the UTF-8 bytes of `payload`.
- **Rollback guard.** The directory payload carries `generated_at`. XMRadar stores the last accepted `generated_at` and rejects older ones, so a valid but old directory can't be replayed. Entries also carry `address_updated_at` (K4) for display.
- **Key override (advanced setting).** Changing the key is presented as a **trust reset**: a warning, the new key's fingerprint, and the cached directory and rollback guard get cleared. The options page always shows the active key fingerprint.
- **Default policy for passive badges:** trust the pinned-key-signed directory. xmr.bio is the verifier for passive A and K6-sourced B.
  - The popup offers **"verify this entry"**. It re-checks the raw proofs on demand: the Nostr event signature and content, and the proof tweet via syndication/oEmbed.
  - Documented: a compromised xmr.bio key can add false badges until users re-check. That's why the popup always names its source.
- **Proof method shown.** Every entry shows how it was verified: `x-post:grok`, `x-post:tweet-url`, `nostr:legacy-substring`, `nostr:exact-v1`, `nip39:client`, `nip39:indexer` (see K2, K3, K6).

## 4. Components (extension)

### 4.1 `src/xmr/address.ts`
`validateMoneroAddress(addr) → {ok:true, type, paymentId?} | {ok:false, reason}`, and `moneroUri(addr, {amount?, description?})`.
- `amount` must match `^\d{1,9}(\.\d{1,12})?$`.
- `description` goes through `encodeURIComponent`.

### 4.2 `src/identity/envelope.ts`
`verifySignedEnvelope<T>()` plus a type-specific check for each payload kind: `ResolvedIdentity` for resolve, `Directory` for the directory. Each payload is checked field by field before it's typed. Nothing is cast blindly.

### 4.3 `src/identity/directory.ts` (passive A, plus passive B after K6)
- Fetches `GET /v1/bio/directory` every 6h (`alarms`), and at startup if stale. It then verifies the signature, checks the rollback guard, and validates each entry's address (invalid entries are dropped and logged).
- Storage: `storage.local` holds **plain JSON** `{generatedAt, keyId, entries: Entry[]}`. On load it builds an in-memory `Map<handleLower, Entry[]>`. A storage round-trip test covers this.

### 4.4 `src/identity/nostr.ts` (opt-in B, and the popup's "verify this entry")
- `findClaims(handles[])`: a batched query for kind 10011 `#i`.
  - The `i` proof value may be a **bare tweet ID or a tweet URL** (`x.com|twitter.com/<h>/status/<id>`); both are parsed to an ID.
  - Takes the newest 10011 per pubkey, and returns every pubkey that claims the handle.
- `fetchPayto(pubkeys[])`: kind 10133, newest per pubkey, the first **valid** `monero` payto.
- `verifyTwitterProof(handle, tweetId, npub)` has two paths, behind a feature flag:
  1. **oEmbed (primary, X's official embed API):**
     - `author_url` path segment must equal the handle (case-insensitive).
     - Text is extracted from `html` with a small tag-strip and entity-decode function. No DOMParser in the service worker, and the function is unit-tested.
  2. **Syndication (best effort):** `tweet-result?id=…&token=…`. The token formula is reverse-engineered. It requires `user.screen_name` equal to the handle and `text` containing the npub.
  - Either path passing counts as verified. Errors are reported as "could not verify" and never as verified.
  - Cache: verified for 7d, failed for 24h, network errors not cached.

### 4.5 `src/identity/resolve.ts`
`resolveHandles(handles[]) → Record<handle, Badge>` applies the merge rules from §1. Sources: the directory, plus opt-in relay B, plus the per-handle cache (TTL 6h). It **never** calls `/resolve`.

### 4.6 Content script `x-badges` (matches `x.com`, `twitter.com`)
- A `MutationObserver` on the timeline root that looks **only at `addedNodes`**. It finds `article[data-testid="tweet"]` (and profile header `[data-testid="UserName"]`, both checked with fixtures).
- A `WeakSet` of processed nodes. Badges are inserted into processed nodes only, and the observer ignores mutations inside our own badge hosts, so inserting a badge never re-triggers processing.
- The handle comes from `[data-testid="User-Name"] a[href^="/"]`, first path segment, matching `^[A-Za-z0-9_]{1,15}$`.
- Batching: new handles are collected for 750ms and deduplicated against a local result cache, then sent as one `resolve-handles` message.
- The observer **disconnects while `document.hidden`** and rescans the visible articles when the tab is shown again.
- The badge is a button with a **closed shadow root**, styled with `adoptedStyleSheets` and falling back to `<style>` (this doubles as the Phase-1 R6 CSP check), with `aria-label="Accepts Monero — tip @handle"`.
- No badge on the user's own **confirmed** handle (§4.8).

### 4.7 Tip popup (Phase-1 Shadow-DOM modal shell)
- **All untrusted strings** (handle, address, npub, labels, reasons) are inserted with `textContent` only.
- Links are built only from allowlisted templates: `https://xmr.bio/<handle>`, `https://x.com/<handle>/status/<id>`, and `https://njump.me/<npub>`. Each value is validated (handle regex, numeric ID, `npub1` bech32 decode) before it goes into a URL.
- Contents:
  - The primary address, with a copy button.
  - A QR code of the `monero:` link (vendored `qrcode-generator`, MIT, pinned).
  - An optional amount field: an invalid value disables the QR code and the link, with an error message.
  - An "Open in wallet" button.
  - The source panel, showing every source, method, date, and the differing-address list.
  - The "verify this entry" button (§3).
- It never sends, holds or confirms funds.

### 4.8 Own-account setup (one-shot exact-event signing)
**The generic bridge allowlist stays {1, 24242}.** Setup never goes through `callBridge`.

Flow, started from the options page "Monero identity", which opens an `x.com` tab and creates a setup session:
1. **Confirm the handle.** The handle is prefilled from the tab's profile URL if it's a profile page, otherwise typed. The user confirms it. It's only treated as **proven** after step 3's proof tweet passes the author check. It's stored as `confirmedHandle` and used to hide the user's own badge.
2. **Monero address → kind 10133.** The background:
   - validates the address
   - runs the **merge algorithm** below
   - shows the before/after tag diff in the setup modal
   - injects a one-shot MAIN-world function with `scripting.executeScript({world:'MAIN', func: signExact, args:[event]})`, which calls `window.nostr.signEvent(event)` once and returns the result
   - checks the result with `checkSigned` (same kind, content, tags, `created_at`; valid signature; pubkey equal to the session's pubkey)
   - publishes it and shows the result for each relay.

   The page can watch this happen, but it can't get any other 10011/10133 event signed.
3. **Link X ↔ npub (NIP-39) → kind 10011.**
   - Open the X compose intent with `Verifying that I control the following Nostr public key: <npub>`.
   - The user pastes the tweet URL. `verifyTwitterProof` must pass, with the author equal to the confirmed handle.
   - Then the merge algorithm, diff, one-shot sign and publish, as in step 2. The proof value is stored as the **tweet URL**, which other NIP-39 clients read most commonly.
4. **Removal.** "Remove my Monero address" or "Unlink X" publishes a new merged event without that tag, with the same diff and one-shot signing.
5. **xmr.bio.** A link out to claim or refresh the profile and use its "Link Nostr" button.

**Error handling for each step:**
- Merge fetch timeout or no relays → stop, and don't publish blind.
- Signer refused → the step stays retryable.
- Some relays reject → show which ones, with "retry failed relays".
- Tweet author doesn't match → explain what went wrong.

**Merge algorithm (kinds 10011 and 10133 are replaceable):**
```
relays   = union(user NIP-65 write relays, read relays, settings relays) || DEFAULT_RELAYS
current  = newest event of <kind> by pubkey across ALL `relays` (querySync, 5s);
           if every relay errored → abort("can't read current list")
tags     = current ? current.tags.filter(t => !isTarget(t)) : []   // keep EVERY other tag, in order
if adding: tags.push(newTag)                                        // 10133: ["payto","monero",addr]
                                                                    // 10011: ["i","twitter:<h>",<tweetUrl>]
content  = current?.content ?? ""
created_at = max(now, (current?.created_at ?? 0) + 1)
event    = {kind, content, tags, created_at}
show diff(current?.tags, tags)  → user confirms → one-shot sign → verify → publish to the same `relays`
```
`isTarget` matches tag[0..1]: `payto/monero` for 10133, and `i` with `twitter:<confirmedHandle>` for 10011. An `i` tag for a different twitter handle is kept.

### 4.9 Background additions
- `resolve-handles`, from x-badges:
  - Requires `sender.id === runtime.id` and a sender URL on x.com/twitter.com, with at most 200 handles per call.
  - **Token bucket per tab**, for relay (source B) lookups only: burst 50, refills 2 per second (superseded by RATE-2 in §7b). **Cache hits cost no tokens.** When the bucket is empty, handles carry over and are never silently dropped.
- `refresh-directory` (alarm).
- `setup-*` messages: session-gated, as in Phase 1.
- New permission: `alarms`. Host access already covers `publish.twitter.com`, `cdn.syndication.twimg.com` and `api.kyc.rip`.

### 4.10 Options
- Show badges on X (default on).
- Discover via Nostr relays (default off, with the privacy warning).
- xmr.bio base URL and key (advanced, as a trust reset).
- The active key fingerprint.
- "Monero identity" setup.

## 5. kyc-rip / xmr.bio changes
These are in the separate repo `~/Projects/kyc-rip`, a live production API. **Nothing there changes until it's explicitly approved.** It will get its own plan and review.

- **K1 `GET /v1/bio/directory`.**
  - Envelope as in §3. Payload: `{v:1, generated_at, entries:[{handle, address, verified_at, address_updated_at, x_proof?:{method, tweet_id?}, nostr?:{npub, method, event?}}]}`.
  - Cached at the edge for 10 min. Past roughly 5k entries, switch to a sharded or bloom-filter variant.
- **K2 Deterministic X proof.**
  - `POST /verify` accepts `tweet_url`. **If it's given, the deterministic check (oEmbed/syndication: author equals handle, text contains token) is mandatory.** If it fails, the request fails, with **no Grok fallback**.
  - Grok runs only when no URL is given. The result records `x_proof.method` (`tweet-url` | `grok`), plus `tweet_id` when known.
- **K3 Nostr proof transparency.**
  - resolve and directory include the stored signed `event` and `method`.
  - New proofs must use the exact content `Linking my Monero identity: xmr.bio:<handle>` (`exact-v1`). Existing proofs stay valid as `legacy-substring` and are shown that way.
- **K4 `address_updated_at`:** a schema column, set on create and on `/update`. Exposed in resolve and directory.
- **K6 Nostr indexer.**
  - A cron Worker reads kind 10011 `twitter:` claims and kind 10133 events from a fixed relay set, then verifies proof tweets server-side (oEmbed, then syndication).
  - Verified entries go into the directory as `nip39:indexer`, with the raw `{event, tweet_url}`.
  - Passive B then needs no client relay or X traffic.
- Deferred: B′ (using xmr.bio's linked npub's 10133) and K5 (address mismatch flags in xmr.bio).

## 6. Phases

| Phase | Scope | Backend needed | Default badges after this phase |
|---|---|---|---|
| 2a | `address.ts`, `envelope.ts`, tip popup + QR; manual "check xmr.bio" (per-handle resolve **on click only**) | — | none (popup only) |
| 2b | x-badges content script + `resolveHandles` + token bucket; opt-in relay B with client-side proof checks | — | B, only if opt-in |
| 2c | Own-account setup: one-shot signing, merge algorithm, 10133/10011, removal | — | — |
| 2d | Passive A from the signed directory, plus the rollback guard | **K1** | **A** |
| 2e | Proof methods, raw-proof "verify this entry", `address_updated_at` in the popup | K2–K4 | A (richer details) |
| 2f | Passive B from the directory (K6 entries); opt-in relay discovery becomes a fallback | **K6** | **A + B** |

The extension stays fully usable with no backend: popup checks, plus opt-in B.

## 7. Testing
No live network in automated tests. Syndication, oEmbed, relays and xmr.bio are mocked from recorded fixtures, with a fake `browser` runtime.

**Unit tests:**
- **Monero addresses:** valid standard, subaddress and integrated mainnet vectors; testnet and stagenet rejected; corrupted checksum; wrong length. `monero:` link building with invalid amounts and unicode in the description.
- **Envelope:** valid; tampered payload; tampered `entries`; wrong key; key-set rotation. Pinned-key format test.
- **Directory:** rollback rejected; storage round-trip (plain JSON → Map); invalid entries dropped.
- **Privacy:** no `/resolve` calls from `resolveHandles` without a directory or with discovery off. Relay mock receives nothing when discovery is off.
- **Merge rules:** A vs B; several B claims (rotation and false claims); differing addresses shown.
- **NIP-39:** `i` proof as a bare ID and as a URL (x.com and twitter.com); several pubkeys; non-twitter `i` tags ignored.
- **Proof check:** oEmbed html → text (entities, links, long tweets, replies); author mismatch; npub missing; case differences; syndication shape; both paths failing → unverified.
- **Replaceable merge:**
  - every unrelated tag kept, in order; an `i` tag for a different handle kept
  - `created_at` when the clock is behind
  - relays disagree on the current list → the newest wins
  - all relays fail → abort
  - removal
- **One-shot signing:** event returned with modified tags, wrong pubkey or bad signature → rejected, nothing published.
- **Token bucket:** a fast-scroll simulation shows no dropped requests; cache hits are free.
- **Popup:** labels with quotes, `<script>` and RTL unicode render as text; links only from validated templates.
- **x-badges:** handle extraction from timeline and profile fixtures; badge insertion doesn't re-process the article.

**Manual checks:**
- Badge on @xbtoshi after 2d.
- No badge on accounts without a source.
- The QR code opens in Feather and Cake.
- Setup publishes 10133/10011, visible with `nak`.
- Removal works.
- With discovery off there's no relay or `cdn.syndication` traffic while scrolling (DevTools network panel).
- Fast scrolling keeps the badges.
- Hidden tab → the observer pauses.

## 7b. Conditions from review round 2 (passed 7.3). These must be done in the phase listed.
- **MERGE-2, before 2c.**
  - Read each relay individually and track its EOSE or error; don't use `querySync`.
  - A relay that couldn't be read is **dropped from both the merge and the publish set**, with a warning listing it. If no publish-target relay could be read, abort.
  - Test: one relay is down and holds a newer event.
- **SYND-2, before 2b.** oEmbed text extraction takes **only the tweet's own first `<p>`**, never quoted, card or embedded content. Test: npub appears only in a quoted tweet → fails.
- **BRIDGE-2.**
  - Wording fix: one-shot signing stops *the extension* from signing other identity events, but the page can still call `window.nostr` directly. The signer prompt is the real boundary.
  - The setup modal shows the npub and asks the user to confirm it. The session pubkey is taken from the first verified signed event, not from `getPublicKey`.
- **RATE-2.**
  - Source A lookups (local directory) are never throttled. Only relay B traffic goes through the bucket: burst 50, refills 2/s.
  - When the bucket is empty, handles carry over to the next batch (the queue holds at most 500 handles; the oldest are dropped first, and they get re-queued if they scroll back into view).
  - Test: a fast scroll past 200 handles.
- **NIP39-2.** The primary claim is chosen by the event's `created_at` (then the proof tweet's date). Local check time is only used for cache TTL.
- **RESOLVE-1.** The on-demand `/resolve` response is accepted only if `resolved_at` is less than 10 min old. The last accepted value per handle is stored, and older responses are rejected. The source panel shows the resolution time.
- **DIR-1.** A directory with `generated_at` more than 10 min in the future is rejected and treated as a trust event (logged, warning shown in options).
- **PERF-2.** Re-attach the observer on SPA navigation (`popstate`/`pushState` hook plus a check that the root still exists). Processed state is keyed by **tweet ID + handle**, not node identity. Visible articles are rescanned when the tab is shown again.
- **TRUST-4.** Entries without a tweet ID (`x-post:grok`) are shown as "not re-checkable (Grok-only)". K6 entries must carry the raw event.
- **MERGE-3.** `isTarget` and the claim parser normalize handles (lowercase, strip leading `@`).
- **SETUP-2.** Setup shows two independent states, "address published" and "handle proven", and says "your badge is live once both are done".
- **TEST-2.** Every case above is added to §7. Also record a **real** signed resolve and directory fixture from the live key, to check the envelope validator against real bytes.

## 8. Risks
- **Syndication is undocumented, and the token is reverse-engineered.** oEmbed is the primary path, and K6 moves the checks server-side. If both fail, B shows as unverified with no badge.
- **X DOM churn.** Selectors live in one file with fixtures; at worst the badges disappear and posting is unaffected.
- **Badge spoofing in the page.** The page can draw fake badges but can't change our popup, which always shows its sources.
- **A compromised xmr.bio key** can add false A or K6 badges. Mitigations: the pinned key set, the rollback guard, the popup's source panel, and "verify this entry".
- **NIP-A3 and NIP-39 are drafts.** Parsing is tolerant: we take the first valid `monero` payto, and accept both ID and URL proofs.
