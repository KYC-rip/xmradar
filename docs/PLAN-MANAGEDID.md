# PLAN-MANAGEDID: an XMRadar-managed Nostr identity when there's no signer

## Why
Many accounts with a Monero badge on X have no Nostr key, so xo, Xap receipts and the Monero identity steps
can't work for them. The user: XMRadar should manage a Nostr identity for users without a NIP-07 signer,
**on by default when no signer is found**.

## Facts
- Every background signature goes through the xmradar.app signer tab: `testSigner` (key), `signExact`
  (Xap receipts, Monero identity setup `setup-sign`), `signQuietly` (xo). With no `window.nostr` they fail
  "No NIP-07 signer found".
- Posting copies to Nostr signs in the X tab through the page bridge (allowlist {1, 24242}); out of scope here.
- Extension-origin IndexedDB (`idbTokenStore` for the burner) isn't reachable from content scripts or pages.

## Design
1. **Key store** `src/identity/managed.ts`: one secp256k1 key made with `generateSecretKey`, kept in the
   background's own IndexedDB (`xmradar-identity`, extension origin; never in `storage.local`, which content
   scripts can read). API: `managedKey()` (create on first use), `managedPubkey()`, `forgetManaged()`,
   `exportNsec()` (Options only, behind a confirm step).
2. **Signer choice** `signerModeItem` (`local:signerMode`: `'auto' | 'signer' | 'managed'`, default `auto`):
   - `auto`: try the NIP-07 signer as today; when the signer page reports **no signer at all** ("No NIP-07
     signer found"), create/use the managed key and set the mode to `managed`, so later signatures skip the
     tab. A signer that refuses or errors is never replaced by the managed key.
   - `signer`: never use the managed key (user's choice). `managed`: always it.
3. **One signing entry** `signAs(template, purpose)` in background used by `testSigner`, `signExact` and
   `signQuietly`: picks the mode; the managed key signs only an allowlist of kinds: 17 and 5 (xo), the Xap
   receipt kind, 10133 (payto), 10011 (identities), 0 (profile name only if the setup needs it). Anything
   else → error. The result is checked like today (`checkSigned`).
4. **Options → Monero identity**, top: "Your Nostr identity": *Your signer (npub…)* or *XMRadar identity
   (npub…), made because no signer was found*, with:
   - **Use my signer instead** (mode `signer`; the managed key is kept until deleted),
   - **Export key** (shows the nsec once, after a confirm that says anyone with it can act as you),
   - **Delete XMRadar identity** (two-step, like Burn), which also resets the mode to `auto`.
   A short note: it's kept in this browser profile only; a signer (Alby, nos2x) is safer for a main identity.
5. The Monero identity steps work with either: with the managed key, publishing the Monero address and the
   X proof makes it a verified Monero person (so its xos count).
6. **Never**: sent anywhere, shown in a page, used for posting copies, synced.

## Tests
Key store (create once, same key after reload, forget); mode transitions (no signer → managed; signer refusal
stays an error; `signer` never falls back); allowlist refuses other kinds; signAs output verifies and matches
the template; Options texts and the two-step delete; export only after confirm.

## Out of scope
Posting copies with the managed key; encrypting the key with a password; multiple managed keys.
