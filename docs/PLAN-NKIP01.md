# PLAN-NKIP01: swap receipts (NKIP-0001) in XMRadar

Spec: https://nkips.org/nkip-0001/ (Verifiable Deposit Receipts, Draft). Vectors: `nkips/nkip-0001/vectors/v1.json`.

Round 2 is revised after plan review round 1 (OpenCode 5.6). It fixes:
- address matching for both addresses;
- JCS that handles rotation entries;
- detection that runs for the page's lifetime;
- revocation states;
- the missing-receipt warning, now gated on a live check;
- exact-host issuer binding;
- the non-blocking points, plus a conformance matrix (§10).

XMRadar takes the spec's **browser extension** role:
- R4: read the machine-readable receipt on the order page.
- R12 (SHOULD): save receipts locally only, and warn before deposit when one is missing.
- The clipboard-hijack control: compare the page's addresses with the signed receipt.

A copy kept by the extension is **not** a counted witness. XMRadar never calls anything "witnessed"; it reports what it saw on relays.

**Issuer status.** kyc.rip publishes `https://kyc.rip/.well-known/nkip01.json` (issuer `kyc.rip`, `adopted_at` 2026-10-26, one key, five relays, one policy) and signs v1 receipts at order creation. It is **not yet fully NKIP-0001 compliant**: its order pages don't carry the receipt markup yet, and attestation publishing isn't confirmed. So:
- this plan is built and tested against the spec's vectors and local fixtures;
- kyc.rip goes into XMRadar's adopter list only after a live check of its order pages passes (§1.4).

## 1. What the user sees

### 1.1 The card

The card is a non-modal panel, fixed bottom-right in its own shadow root, so it's separate from the tip modal.

- **Collapsed:** a single pill, "Receipt ✓" or "Receipt ⚠". Warnings never collapse away: a warning pill is red and stays visible.
- **Expanded:** the lines below, then the details: issuer host, order id, deposit and payout amounts, rate type, expiry, the policy link, and "Saved ✓".
- **Amounts:** XMR has 12 decimals and BTC 8, shown with the ticker. Other assets show the raw base-unit string, labelled "base units".
- **Accessibility:** the panel is `role="region"` with `aria-label="XMRadar receipt check"`. A new warning is announced through an `aria-live="assertive"` line. The collapse button has `aria-expanded`.

| Line | States |
|---|---|
| **Signed** | ✓ "Signed by kyc.rip" (the key is in kyc.rip's manifest, Level 1, §2) · ⚠ bad signature · ⚠ key not in the manifest · ⚠ key revoked before this order · △ "Signed by a key that was revoked later; its public log wasn't checked" · ⚠ unrotated new key (§3.3) · ⚠ "Receipt is for X, but this page is Y" · △ "Manifest unreachable: signature not checked" · △ "XMRadar needs access to check this site" (a Grant button opens Options, the same flow as the existing permission banner) |
| **Expiry** | ✓ "Valid until 14:32" · ⚠ "Expired at 14:32. Don't deposit to this address now; check the exchange's policy." |
| **Addresses** | ✓ "The deposit and payout addresses on this page are the ones the exchange signed" · ✓ "Deposit address matches; payout address not shown on this page" · △ "Shown as QR only: check that your wallet shows `<first 8>…<last 8>`" · ⚠ "This page shows an address the exchange didn't sign: `<short>`. Don't send." · ⚠ "This page shows more than one deposit-type address" |
| **Public record** | ✓ "Seen on N of M relays (event `<id>`)" · △ "Not found on relays yet, rechecking…" (every 20 s for 2 min) · ⚠ "No public record found" (after 2 min) · ○ "Lookup off" (setting) |

✓ means good, △ means caution, ⚠ means warning, ○ means not checked.

### 1.2 Copy check

The copy check is limited to what an extension can see reliably.

- When a `copy` event fires on the page, XMRadar reads the selection. If it is an address of the deposit's or payout's family and equals none of the receipt's `deposit_address`, `payout_address` or `refund_address`, a warning shows: "You copied an address the exchange didn't sign".
- **Not covered:**
  - a page script that calls `navigator.clipboard.writeText` directly;
  - malware that rewrites the OS clipboard.

  An extension can't intercept these reliably. A MAIN-world wrapper installed after detection would be too late, because the page may hold the original function. The card's defence for these cases is to show the signed address and the instruction to compare it in the wallet. The card and README say this plainly.

### 1.3 Options → Receipts

- Saved receipts are listed with issuer, order id, pair, date, check results, and "Expired" or "Historical" where it applies.
- **Export** produces JSON: the receipt, the attestation event if seen, a manifest snapshot and the policy text. There's also **Delete** and **Export all**.
- Switches:
  - "Check receipts on swap pages" (default on);
  - "Look up the public record on Nostr" (default on, per the owner's decision).
- The host-permission state is shown, with Grant.

### 1.4 Missing-receipt warning (R12), gated on a live check

The bundled adopter list, `src/receipts/issuers.ts`, has entries like:

`{ host: 'kyc.rip', receipts_live_at: <unix>, order_paths: ['/…'] }`

- `receipts_live_at` is **not** the manifest's `adopted_at`. It's the date XMRadar confirmed, in a live check, that the issuer's order pages carry receipts. An entry is only added in the release after that check passes. **kyc.rip is not in the list until then.**
- The warning appears only when all of these hold:
  1. the page host is an adopter, and the URL path matches one of its `order_paths`;
  2. now is at least `receipts_live_at`;
  3. no receipt has appeared within 10 s of the page showing a deposit-type address (§4.3).
- **Wording:** "kyc.rip has published signed receipts since <date>, but this order page has none. If you deposit, keep a dated screenshot of this page." It doesn't claim when this order was created, because it can't know.
- The list moves to the verifier feed once the spec defines one.

## 2. Trust levels

- **Level 1 (built now): "signed by the key this site publishes".**
  - **Binding is the exact host.** `receipt.issuer` (lowercase ASCII; IDNs as punycode via `new URL`) must equal the top-level page's host, or the page host must be `www.` plus the issuer. No Public Suffix List: `evil.kyc.rip` showing an `issuer: kyc.rip` receipt fails, and an issuer `orders.kyc.rip` needs its pages on `orders.kyc.rip`.
  - The manifest comes from `https://<issuer>/.well-known/nkip01.json`, and the key must be in it (§3.3).
  - **What it catches:**
    - forged or edited receipts;
    - a page showing an address other than the signed one;
    - a clone on another host, because the card names the host it's checking: "Signed by kyc.rip".

    A clone that serves its own manifest from its own host passes only under its own name.
- **Level 2 (later): "key pinned by a verifier".** This comes when a signed verifier feed format exists. Not built now.
- **Receipts for another host** ("issued by X, shown on Y") are shown as a warning and **not verified**. XMRadar doesn't fetch X's manifest, so no new party is contacted.
- **Iframes:** only the top-level frame counts. Aggregator pages that embed an issuer's order page in a cross-host iframe are **not supported** in v1, and the README says so. Same-host frames count as top-level.

## 3. Verification (pure functions, background)

### 3.1 JCS (RFC 8785)

- Supported: `null`, `true`/`false`, strings, integers in `[-(2^53-1), 2^53-1]`, arrays and objects, recursively.
- Refused: non-integer numbers, `NaN`/`Infinity`, and duplicate keys. The JSON is parsed by a small strict parser that rejects duplicate keys; `JSON.parse` silently keeps the last one.
- Keys are sorted by UTF-16 code units, and strings are escaped as RFC 8785 requires.
- It covers receipts, attestations and manifest key entries, including their `null` fields.

### 3.2 Receipt

- **Fields** per `receipt.schema.json`:
  - `v === "nkip01/1"`;
  - `rate_type ∈ {fixed, float}`;
  - integer seconds with `created_at < expires_at`;
  - amounts as `^[0-9]+$` strings;
  - `key_id` 16 lowercase hex characters;
  - `sig` base64url with no padding;
  - `issuer` lowercase ASCII.
- **Signature:** Ed25519 (`@noble/curves`, already a dependency) over the JCS without `sig`. `key_id` must equal `sha256(raw public key)[:8]`.
- **Size:** the content script refuses receipt text over 64 KB before sending, and the background checks again.

### 3.3 Manifest

- **Fields:** required fields per `manifest.schema.json`, and `issuer` equal to the receipt's.
- **Keys:**
  - The first key (the one without `rotated_from`) is accepted.
  - Each later key needs `rotated_from` naming an earlier key and a valid `rotation_sig`: the old key's signature over the JCS of the new entry without `rotation_sig`.
  - A later key without a valid rotation is **"unrotated: not trusted"** (⚠). The spec makes it valid only after a verifier re-checks domain control, which Level 1 can't do.
  - The receipt's `key_id` selects the key, and `not_before ≤ created_at` must hold.
- **Revocation:**
  - `created_at >= revoked_at` makes the receipt invalid (⚠).
  - `created_at < revoked_at` is **△ "signed by a key revoked later; log not checked"**. The spec requires a log root before `revoked_at` for such a receipt to stay valid. Checking kind 3712 roots and `leaves_url` is deferred to a later version, so XMRadar never shows these as fully valid.
- **Freshness:** fetched again for every new receipt, with no cross-page cache. One fetch is reused only for repeat renders of the same receipt on the same page. A key revoked a minute ago is seen.

### 3.4 Commitment

`sha256("nkip01/1" ‖ 0x00 ‖ issuer ‖ 0x00 ‖ deposit_address ‖ 0x00 ‖ payout_address)`, as lowercase hex.

### 3.5 Attestation event

All of these must hold:

- `kind === 3711`, `pubkey === manifest.nostr_pubkey`, and `verifyEvent` passes;
- tags: exactly one `c` equal to the commitment, one `i` equal to `receipt.issuer`, one `v` equal to `"nkip01/1"`;
- `content` parses (strict JCS parser) as an attestation with:
  - `v` correct;
  - `issuer` equal to the receipt's;
  - `commitment` equal to ours;
  - `key_id` selecting a manifest key that is trusted under §3.3;
- its Ed25519 `sig` verifies over the JCS of the other five fields;
- `|event.created_at - attestation.created_at| ≤ 300`.

Events that fail are ignored. One valid event is enough for "Seen".

### 3.6 Policy

- The URL is the manifest's entry for the receipt's `policy_hash`. It's fetched only if its host equals the issuer host.
- The body's SHA-256 must equal `policy_hash`; a mismatch is a △ on the card.
- The text is archived with the receipt.

## 4. Where things run

### 4.1 Content script

The content script is already on `<all_urls>` and in all frames, but the receipt logic only runs in the top frame.

- **Detection:**
  - A `querySelector('script[type="application/nkip01+json"]')` runs at `document_idle`, and again on `wxt:locationchange`.
  - For dynamic pages, a MutationObserver on `document` (childList, subtree) **schedules** that same query at most once every 2 s, using `requestIdleCallback`. It runs for the page's lifetime, until a receipt is found; after that it watches only for a different receipt.
  - It's skipped on `x.com`/`twitter.com`. XMRadar's heaviest page isn't a swap site.
- **Cost:** measured, not assumed. A manual check records the observer's script time over 60 s on a busy single-page app (x.com is excluded, so a news site and a swap site are used) and confirms the time stays under 1 ms per second of page activity. The test suite has a spy test that a burst of 1,000 mutations triggers at most one query per 2 s.
- **Message:** sends `{ text }` only (capped at 64 KB).

### 4.2 Background

- **Origin:** the page origin comes **from the sender**, never from the message. It uses `sender.tab.url` together with `sender.frameId === 0`, or `sender.url` for same-host frames. Anything else is dropped.
- **Host permission:** checked with `browser.permissions.contains({ origins: ['https://<issuer>/*'] })`. Without it the card shows the Grant state. This matters for Firefox MV3, where `<all_urls>` isn't granted at install.
- **Fetches** (manifest and policy):
  - `credentials: 'omit'`, `referrerPolicy: 'no-referrer'`, `redirect: 'error'`;
  - 10 s timeout and 256 KB limit;
  - content type `application/json` for the manifest, `text/*` for the policy.
- **Relays:**
  - Which relays: the manifest's `relays` plus the user's read relays (or the defaults), deduplicated, at most 6.
  - The filter is `{"kinds":[3711],"#c":[commitment]}`, through `readEach`, with a 5 s timeout per relay.
  - Rechecks follow §1.1 and stop when the tab closes or navigates.
- **Results** are stored, then pushed to the tab as `receipt-status`.

### 4.3 Address matching (content script, on the receipt's families)

- **Families:**
  - XMR: `validateMoneroAddress`, already in `src/xmr/address.ts`, with its checksum.
  - BTC: base58check (P2PKH/P2SH) and bech32/bech32m (`@scure/base`, already present through nostr-tools).
  - Any other asset: no matching. The card says "Addresses not checked for <asset>".
- **Scanning:** visible text nodes and `input`/`textarea` values in the top document are scanned for address-shaped tokens, then validated. The scan is repeated when the page changes, on the same 2 s schedule.
- **Rules:**
  - The deposit address must be found (or the QR-only state applies). The payout address is reported as found or not shown.
  - **Any valid address of the deposit's or payout's family that isn't one of the receipt's three addresses** gives ⚠ "address the exchange didn't sign". This also covers a page that shows the signed address somewhere and a different one in the deposit box.
  - Two or more distinct addresses of the deposit family, other than the receipt's, give ⚠ "more than one".

## 5. Network: who learns what

These additions go into the landing page's "Who gets what" section in the same release:

- **The issuer's own site** (the page you're on; for example kyc.rip): when a receipt is found, XMRadar fetches the issuer's manifest and policy text. The issuer sees your IP and learns that an extension checked the receipt. That's a request to the issuer itself, the same party whose page you have open.
- **Nostr relays:**
  - Which relays: up to 6, from the manifest and your read relays.
  - What they receive: the filter with the commitment hash, plus your IP. The hash contains no addresses or amounts. Anyone who later learns the order's two addresses could link that lookup to your IP.
  - On by default, only on pages with a receipt. It can be switched off.
- **No XMRadar server, and no third party** besides those two. Receipts are stored only in the browser (IndexedDB), and leave it only through Export.
- **Store disclosure, decided now:**
  - Receipts with payment addresses and amounts **stay on the device**.
  - The only transmissions are the issuer fetch, which is the page you're on, and the relay lookup by hash.
  - So `data_collection_permissions` stays `none` for this feature, and the AMO and Chrome listings describe local receipt storage in their privacy text.
  - If Mozilla's review reads local storage of payment data as collection, the fallback is to declare `financialAndPaymentInfo`, recorded in PLAN-RELEASE's store list.

## 6. Code layout

- `src/receipts/jcs.ts` (strict parser and canonicalizer).
- `src/receipts/verify.ts` (receipt, manifest, rotation, revocation, attestation, commitment).
- `src/receipts/addresses.ts` (family detection, matching rules).
- `src/receipts/fetch.ts` (manifest and policy with the limits above).
- `src/receipts/witness.ts`, `src/receipts/store.ts` (IndexedDB), `src/receipts/issuers.ts` (adopter list, empty at first).
- `src/entrypoints/content/receipt.ts` (detection, scan, copy check), `src/ui/receipt-card.ts`, `src/entrypoints/options/receipts.ts`.
- `messaging.ts`: `receipt-found` and `receipt-status`.
- **Settings:** two flat fields, `receiptsCheck` and `receiptsWitnessLookup` (both `true`), in `settingsItem` through the existing patcher. Flat fields, so a shallow patch can't drop a sibling. This needs a version bump with a migration that sets the defaults.

## 7. Tests (vitest)

- **Vectors:**
  - JCS bytes exact;
  - signatures valid or invalid as marked;
  - commitment and attestation;
  - `key_id`.
- **JCS:** nulls, booleans and nested objects canonicalize per RFC 8785 examples. Duplicate keys, floats and unsafe integers are refused.
- **Manifest:**
  - a valid two-key rotation (with nulls);
  - a broken rotation signature;
  - an unrotated second key;
  - a key used before `not_before`;
  - revoked before vs after `created_at` (⚠ vs △).
- **Binding:**
  - the `kyc.rip` receipt on `kyc.rip`: ok; on `www.kyc.rip`: ok; on `evil.kyc.rip`: "for X, shown on Y", no fetch;
  - the `orders.kyc.rip` receipt on `kyc.rip`: mismatch, no fetch;
  - a punycode host.
- **Origin:** a message that claims an origin is ignored, and a sender from a cross-host frame is dropped.
- **Attestation** (each refused):
  - wrong kind, pubkey, `c`, `i` or `v`;
  - a duplicate `c` tag;
  - a `key_id` not in the manifest or not trusted;
  - a bad Ed25519 signature;
  - `created_at` off by more than 300 s.
- **Addresses:**
  - matching deposit and payout;
  - a wrong payout;
  - a wrong deposit while the signed one appears elsewhere;
  - two deposit-family addresses;
  - QR-only;
  - an unsupported asset;
  - BTC bech32 and base58.
- **Copy:**
  - copying the wrong payout or deposit address warns;
  - copying a receipt address (any of the three) doesn't;
  - a `clipboard.writeText` by a page script isn't claimed: the test asserts the card's wording says so.
- **Fetch limits, for both the manifest and the policy:**
  - another host;
  - a redirect;
  - the wrong content type;
  - over 256 KB;
  - a timeout;
  - a policy hash mismatch.
- **Detection:**
  - a receipt present at load;
  - a receipt inserted after 90 s;
  - after an SPA navigation (`wxt:locationchange`);
  - a mutation burst gives at most one query per 2 s;
  - over 64 KB is refused;
  - x.com is skipped.
- **Expiry:** an expired receipt gives the ⚠ line, and it's saved as historical.
- **Missing-receipt warning:**
  - a non-adopter: never;
  - an adopter before `receipts_live_at`: never;
  - an adopter path that isn't an order path: never;
  - an order path with an address and no receipt after 10 s: warns, with the wording above.
- **Permissions:** with the grant missing, the Grant state appears and nothing is fetched.
- **Settings:** toggling one receipts field leaves the other unchanged, and the migration sets the defaults.
- **Store:** save, list, export contents, delete.

## 8. Order of work (after the redesign rounds R2–R5)

1. The pure modules and their tests, against the vectors and fixtures.
2. Background: fetch, witness, store, permission state.
3. Content script: detection, address scan, copy check. Then the card and the Options section.
4. A **local fixture site**: a static page plus a manifest, policy and events from a test relay. It covers the happy path and every warning state, and is tested by hand in Chrome and Firefox.
5. Landing-page data section, README (including the copy-check and iframe limits), and the store text.
6. **Live check on kyc.rip, once it's fully compliant.** That means order pages carry `application/nkip01+json`, attestations are on relays, and the manifest is valid. If it passes, the kyc.rip adopter entry, with `receipts_live_at` and `order_paths`, ships in the next release. Until then, the card works on any compliant issuer, and the missing-receipt warning never fires.

Review gates (plan passed round 2 at 7.4; the follow-ups below are part of the plan): this plan goes to OpenCode plan review, and the code to OpenCode code review, before any commit.

## 9. Owner decisions (2026-10-27)

- **Witness lookup** is on by default, only on pages that carry a receipt, and can be switched off.
- **Missing-receipt warning** ships with the bundled adopter list. An entry is added only after its live check (§1.4), so kyc.rip is added once it is fully compliant.
- **Release slot:** after the remaining redesign rounds R2–R5.

- **2026-10-29, revised:** the public-record check is **manual**, in Options, and available only from 1 hour after the order, to follow the spec's trust model. This replaces the automatic lookup above and clears the §12.1 release gate.

## 10. Conformance matrix (extension role)

| Spec item | Where | Tests |
|---|---|---|
| R4: read the machine-readable receipt | §4.1 detection | Detection tests |
| R12: save locally only | §1.3, §5, §6 store | Store tests |
| R12: warn when one is missing | §1.4 | Missing-receipt tests |
| Clipboard hijack: compare the page with the receipt | §4.3, §1.2 (scope stated) | Address and copy tests |
| Receipt: JCS + Ed25519, `key_id` | §3.1, §3.2 | Vector and JCS tests |
| Manifest: rotation, revocation, `not_before` | §3.3 | Manifest tests |
| Attestation: both signatures, tags, ±300 s | §3.5 | Attestation tests |
| Commitment | §3.4 | Vector test |
| Policy by hash | §3.6 | Policy fetch tests |
| "No first-sight pinning" | §2 (Level 1 is labelled as the site's own key; Level 2 deferred) | Binding tests |
| Not done in v1 | Log-root check for pre-revocation receipts (△ instead); verifier feed (Level 2); cross-host iframes; `clipboard.writeText` interception | Stated on the card and in the README |

## 11. Round 2 follow-ups (folded in; these override the sections above where they differ)

- **Address roles, not just presence (§1.1, §4.3).**
  - **Strongest signal:** fields the issuer marks with `data-nkip01="deposit_address"` or `data-nkip01="payout_address"`. This will be suggested to kyc.rip and as a NKIP-0001 note. When present, only those fields are used for roles.
  - **Otherwise:**
    - The role comes from the nearest label: the text of the element and up to 3 ancestors, at most 200 characters. Deposit labels: `deposit|send (exactly )?to|pay to|send …`. Payout labels: `payout|receive|recipient|destination|you get`.
    - **✓ is shown only when the signed deposit address sits under a deposit label (or the data attribute).**
    - A signed address under the other role's label gives ⚠ "The page shows the payout address where the deposit address should be. Don't send."
    - Signed addresses with no recognizable label give △ "Addresses present; roles not confirmed. Check that your wallet sends to `<deposit short form>`."
  - **Ignored:** hidden inputs (`type=hidden`), elements with no rendered box, `aria-hidden`/`hidden` subtrees, `<script>`/`<template>`/`<noscript>`.
  - **Tests:** swapped roles; a hidden signed address plus a visible wrong one; an unrelated same-family address elsewhere (⚠, as unsigned); data attributes taking priority over labels.
- **Same-host frames: not supported.** The receipt logic runs only in the top frame (`frameId === 0`), and the `sender.url` branch is removed. §2's same-host-frame sentence no longer applies.
- **Relay URL guard.** Manifest relays are untrusted. Each must pass all of these, or it is dropped:
  - `wss:` only;
  - no userinfo;
  - port 443 or none;
  - the host is not `localhost`, not `*.local`, not an IP literal in loopback, private, link-local or CGNAT ranges, and not a single-label name.

  Tests: `wss://127.0.0.1`, `wss://[::1]`, `wss://user:pass@relay.example`, `wss://router.local`, `wss://relay.example:8443`, `ws://relay.example`.
- **Manifest freshness:**
  - fetched with `cache: 'no-store'`;
  - revalidated when the card is expanded, on `visibilitychange` to visible, and every 10 minutes while the page is open.

  A revocation seen later turns the Signed line ⚠, and updates the saved copy too. Tests: a revoked manifest behind an HTTP cache (`no-store` is passed); an open page re-rendering after revocation.
- **`order_paths` matching:**
  - Patterns are path-only, segment-aware: literal segments plus `:id` (one segment of `[A-Za-z0-9_-]+`) or `*` (any remainder).
  - Query and hash are ignored, and trailing slashes are normalized.
  - `/` alone is refused at list-build time.
  - The 10 s timer starts only when a **deposit-labelled** address (or `data-nkip01="deposit_address"`) is visible.

  Tests: a non-order path, a nested order path, a payout-only page.
- **Policy bytes:**
  - the raw response bytes are hashed (`arrayBuffer`);
  - the bytes are archived (base64 in the export);
  - they're decoded (UTF-8, BOM shown) only for display.

  Tests: a BOM policy and a non-UTF-8 policy; the hash is over the bytes either way.
- **The card shows the signed addresses.** The expanded card lists the signed deposit and payout addresses (and refund, if present) in full, with copy buttons and short forms, and the export includes them. A test checks the rendered details.
- **Host permission on Firefox.** If `<all_urls>` isn't granted, the content script doesn't run, so there's no card. The reachable UI is the existing Options banner, plus the popup. The popup's footer shows "Grant access to check swap receipts" when the grant is missing and receipts checking is on. This will be confirmed by hand in Firefox, and the card's Grant state is kept only for partial grants (issuer host not covered).
- **HTTPS only.** Level 1 requires an `https:` page. On `http:` the card shows ⚠ "Page not secure: receipt not checked", and nothing is fetched. Local fixtures use `https://` through the test server, or a build flag that is on only in tests. Test: an http page.
- **Dependency.** `@scure/base` becomes a direct dependency, pinned to the version nostr-tools already uses, so the lockfile doesn't grow. The typecheck covers the import.
- **Multiple receipts on one page:**
  - Each receipt is verified and saved.
  - The card shows the receipt whose `deposit_address` is visible under a deposit label. If several qualify, or none does, it shows a list, one row per receipt with its own lines, and the address checks run per receipt.

  A two-receipt fixture covers it.
- **Storage:**
  - deduplicated by commitment (a re-render updates in place);
  - policy bytes stored once per `policy_hash`;
  - at most 500 receipts, with the oldest historical ones pruned first and a note in Options when that happens;
  - a quota error shows "Couldn't save this receipt (browser storage full)" on the card and in Options.

  Tests: deduplication, pruning, quota error.
- **Conformance matrix additions:**
  - role-aware address matching → §11 (address tests);
  - relay URL guard → §11 (relay guard tests);
  - HTTPS-only Level 1 → §11.

## 12. Round 3: catch up with the spec as of 2026-10-29 (overrides the sections above where they differ)

Spec: `nkips/nkip-0001.md` at nkips `origin/main`. Since Round 2 it added:
- v2 salted commitments (R16);
- the salt box (R17) and `salt_nip44` recovery keys (R17, R19);
- the release-after-witnessing flow (R15) and its trust model;
- vectors `v2.json` and `recovery-key.json`.

- **Both versions.**
  - Receipts with `v: "nkip01/1"` (no `salt`) and `v: "nkip01/2"` (`salt`, 64 lowercase hex) are both verified. Anything else is refused.
  - The commitment follows the receipt's version:
    - v1: `SHA-256("nkip01/1"‖0x00‖issuer‖0x00‖deposit‖0x00‖payout)`;
    - v2: the same with `‖0x00‖salt` (32 raw bytes) and the `nkip01/2` prefix.
  - The attestation's `v`, its `v` tag and its commitment must match the receipt's version.
  - A v2 attestation may carry `salt_box` and/or `salt_nip44`. Both are part of the signed JCS, so verification includes them. XMRadar never tries to open them: it holds no view key, and doesn't create orders.
  - The card notes a v1 receipt with a transparent-chain deposit as △: "Old receipt format: anyone who knows your payout address can link it to this deposit."
- **Vectors:**
  - `v1.json` and `v2.json` drive the verify tests: JCS bytes, both signatures, both commitment forms, standard address and subaddress.
  - The salt-box opening and `recovery-key.json` are issuer and wallet matters, so they're not tested here.
- **No relay lookup on the order page (spec trust model).** The spec says clients SHOULD NOT query relays for their own order's commitment right away, because a relay would see the user's IP asking about it. So §1.1's "Public record" line and §4.2's relay rechecks are replaced:
  - **On the order page**, the Public record line reports only what the page shows, and never contacts a relay. The spec defines no machine-readable witness markup for pages; it says the page SHOULD show the attestation's event id next to the deposit address. So:
    - if a 64-hex or `nevent1…` string labelled as an event id (label rules as in §11, labels `event|attestation|witness|record`) is visible, the line says: "Event `<short id>` shown by the exchange; check it later in Options";
    - otherwise: ○ "No event id shown on this page; check the public record later in Options".

    Neither state is a warning: R2 only says SHOULD show it, and witnessing can't be confirmed from the page. A suggestion to add machine-readable witness markup goes to the nkips repo as a note, not into this plan.
  - **The independent check comes later**, and only when the user starts it. Options → Receipts has "Check public records" per receipt, and "Check all" for receipts saved more than 1 hour ago. It queries the relays by `#c` as in §4.2 (guards, at most 6 relays) and records "Seen on N of M relays" or "Not found". The button's note says relays see your IP asking about that commitment. Nothing runs automatically.
  - The setting "Look up the public record on Nostr" is replaced by this button. **This revises the 2026-10-27 owner decision**, which was an automatic lookup on by default, to follow the spec. It needs the owner's OK.
- **Release flow (R15).**
  - Order pages now show the address and the receipt only once witnessed, so the receipt often appears seconds after the page loads. Detection over the page's lifetime (§4.1) already covers that.
  - The missing-receipt warning (§1.4) starts its 10 s timer only once a deposit-labelled address is visible, which matches R15: an address without a receipt is exactly what the warning is for.
- **The local copy is dispute evidence.**
  - A v2 receipt's `salt` is what a verifier needs to recompute the commitment, and for a non-XMR payout without a recovery key the user may have no other copy. So the saved receipt keeps the salt.
  - Export includes the salt, and the export button says: "Contains your swap's addresses and salt: anyone with this file can link your deposit to your payout."
  - The copy is stored only in this browser (IndexedDB), as before.
- **Recovery keys (R19): not applicable.** XMRadar doesn't create orders, so it never sends a `recovery_pubkey`. The README says so, so nobody assumes XMRadar protects a `salt_nip44` key.
- **R18 (fresh subaddress):** when the receipt's payout is XMR and the payout address is one XMRadar has seen in an earlier saved receipt, the card shows △ "You've used this payout address before (order `<id>`). A fresh subaddress per swap keeps orders unlinkable."
- **Issuer status update:**
  - kyc.rip signs v2 receipts and publishes kind 3711 v2 attestations. It was tested live 2026-10-27 through the API with `X-NKIP01: 1`: create withholds the address, and status releases it after 2 relay OKs.
  - Whether its **web order pages** carry `<script type="application/nkip01+json">` is still to be checked live (§8 step 6). Until that check passes, kyc.rip stays out of the adopter list.
- **Tests added:**
  - both versions;
  - a version mismatch between receipt and attestation;
  - `salt_box`/`salt_nip44` covered by the signature (editing either fails);
  - the v1-transparent-chain △;
  - no relay request from the order page (spy on `readEach`);
  - "Check public records" sends exactly one `#c` filter per receipt to guarded relays;
  - the export contains the salt and the warning text;
  - the R18 reuse note.
- **Order of work:** unchanged (§8), and it now starts after XMRadar 0.3.0.

### 12.1 Round 3 review fixes (plan review 7.1)

- **R16, zero salt.**
  - A v2 receipt whose `salt` is 64 zeros is valid only when `deposit_asset` is XMR, which matches the v2 XMR→BTC vector.
  - With any other deposit asset, the Signed line shows ⚠ "Unsalted receipt for a public-chain deposit: the exchange broke NKIP-0001 R16; your payout address can be linked to this deposit." The signature is still reported, and the warning stays.
- **R17, the salt box.**
  - **Attestation types:**
    - v1 is exactly `{v, issuer, commitment, created_at, key_id, sig}`;
    - v2 adds optional `salt_box: {r: 64 hex, ct: 64 hex}` and optional `salt_nip44: string` (NIP-44 v2 payload, base64).
    - Unknown fields or a malformed shape refuse the attestation, and all present fields are part of the signed JCS.
  - When the receipt's salt is random and `payout_asset` is XMR, a matching attestation without `salt_box` gives ⚠ "The exchange didn't add the salt box NKIP-0001 R17 requires: keep this receipt, it's your only copy of the salt."
  - `salt_nip44` is opaque: XMRadar can't know whether a recovery key was sent.
  - Since §12 does no lookup on the order page, this check runs with the manual public-record check, which is the only time XMRadar sees the attestation.
- **R18 self-exclusion:** the reuse note compares against saved receipts with a different commitment only. Re-rendering or reopening the same receipt never warns.
- **The public-record check, per receipt:**
  - Before a receipt is 1 hour old, its button is disabled and says "Available 1 hour after the order (relays would see your IP asking about it)".
  - "Check all" uses the same 1-hour rule. There's no automatic path.
- **Event id on the page:**
  - A 64-lowercase-hex or `nevent1…` token next to a label matching `event|attestation|witness|record`.
  - A `nevent` is decoded with nostr-tools' nip19 only to get its id and an optional kind. A kind other than 3711 is ignored.
  - It's shown as the first 8 and last 8 characters, and saved with the receipt, so the later check tries `{ids:[id]}` before `#c`.
- **What §12 replaces (deliverables):**
  - **Settings:** `receiptsWitnessLookup` is removed from the planned settings. It never shipped, so there's no migration. `receiptsCheck` stays.
  - **Network copy:** §5's network text becomes:
    - the issuer fetch (manifest, policy) on order pages;
    - relays only when you press "Check public records", at least 1 hour after the order, with the IP note.
  - **Docs:** the README, the landing page's "Who gets what", and the Options → Receipts copy all follow §5 as revised here.
  - **§9 owner decisions:** the witness lookup becomes manual and delayed. **Release gate: the owner's OK to this change, recorded in §9 before implementation of the lookup ships.** The pure modules, verification and order-page card don't depend on it and can be built first.
- **Tests added:**
  - v2 zero salt with an XMR deposit: accepted;
  - v2 zero salt with a BTC deposit: ⚠;
  - XMR payout with random salt and no `salt_box`: ⚠;
  - a malformed `salt_box`: refused;
  - an unknown attestation field: refused;
  - a same-commitment re-render: no R18 note;
  - the lookup button disabled before 1 hour;
  - a `nevent` of another kind ignored;
  - event-id saved and used by the later check (`ids` first).
- **Conformance matrix additions:**
  - R16 → zero-salt rule;
  - R17 → salt-box presence and shape (not opened);
  - R18 → reuse note with self-exclusion;
  - R19 → not applicable (no orders created), stated in the README;
  - spec trust model → no order-page relay lookup, manual check after 1 h.


### 12.2 Implementation status (2026-10-29)

Built, unit-tested and reviewed in steps:
- **Step 1, the pure layer** (`src/receipts/jcs.ts`, `verify.ts`, `addresses.ts`, `guards.ts`): OpenCode 8.5, fixes folded in.
- **Step 2, the background logic** (`fetch.ts`, `store.ts`, `check.ts`, `witness.ts`): OpenCode 8.4, fixes folded in.
- **Step 3, the wiring and UI:**
  - `page.ts`, `issuers.ts`, `export.ts`;
  - `content/receipt.ts`, `content/receipt-card.ts`;
  - `ui/receipts-panel.ts`, the Options section;
  - the background handlers `receipt-found`, `receipts-list`, `receipt-delete`, `receipt-export`, `receipt-record`;
  - `settings.receiptsCheck` (on unless switched off);
  - the README.

  The card renders in a closed shadow root. Its content is tested through a recorder that replaces the card.
- **Step 3 review:** OpenCode 8.1. Fixed:
  - **Roles per address:** the deposit and payout roles are tracked separately. The role search stops at a level that holds another address, and level text is built from spaced text nodes, so neighbouring blocks don't run together.
  - **Stale receipts:** receipts that leave the page go from the card.
  - **Late answers:** a generation guard drops them, and the deposit timer resets on stop and on SPA navigation.
  - **The missing-receipt rule** is based on the receipts the page carries now.
  - **Copy:** the latest copy decides, so copying a signed address clears the warning.
  - **The card:** a warning-forced card has no Hide button; the pill shows ○ for off; the signed addresses get Copy buttons.
  - **Public-record check:** it re-reads the manifest first.
  - **Export:** a standing warning sits next to Export.
- **Not done from that review:**
  - the policy link on the card;
  - the attestation event in the export (only `publicRecord` is saved);
  - per-receipt event ids when a page carries several receipts (one page-wide id is kept);
  - the host Grant row: the existing Options permission banner covers it.

Open:
- the owner's OK to the manual, delayed public-record check (§12.1 release gate);
- the local fixture site, and testing by hand in Chrome and Firefox (§8 step 4);
- the Firefox popup footer for a missing host grant (§11);
- the landing page's "Who gets what" text (§5);
- the live check on kyc.rip's order pages (§8 step 6).
