# PLAN-SIWM: XMRadar as a Sign-In with Monero (NKIP-0003) helper — no keys

## Why
NKIP-0003 (~/Projects/nkips/nkips/nkip-0003.md, vectors in nkip-0003/vectors/v1.json) is implemented by
one verifier (kyc.rip / xmr.bio) and one wallet (Ripley Terminal). In a browser a `monero-signin:` link does
nothing unless a wallet app registered the scheme, so most users can't use it. XMRadar can do the wallet's
browser half, and do it better than a separate app, because it knows the page that opened the challenge
(wallet rule 6 / R10). It never holds a key: the signature comes from the user's own wallet.

## Roles in XMRadar
- Parse and check the challenge (R2), build the v1 message byte for byte (R1), show the consent (R6),
  refuse a page on another site (R10), check the pasted signature locally (spend mode only), then POST
  the callback. The signing itself: the user's wallet (any wallet's "sign message", or Ripley Terminal).
- XMRadar holds no spend or view key, stores no nonce, signature or challenge, and logs none.

## 1. Catching the challenge
- Content script (the existing one on all pages): a capture-phase click listener on links whose href scheme
  is `monero-signin:` (case-insensitive). Only a real user click (`isTrusted`), left button, no modifier.
  It prevents the navigation and sends `{ uri, page: location.href }` to the background, which opens the
  consent window. `ripley:` links are left alone (they belong to Ripley Terminal).
- Popup → **Sign in with Monero** → "Paste a sign-in link": for QR / copy-paste (R7). The opening page is
  then unknown, which the consent says.
- Navigations by script (`location = 'monero-signin:…'`) are not caught in v1 (they'd need a MAIN-world
  hook); xmr.bio uses a link.
- Setting `siwmHelper` (on unless switched off), Options → Monero identity: "Help with Sign in with Monero
  links". Off → links behave as without XMRadar.

## 2. Checking (pure, `src/siwm/challenge.ts`)
- `parseChallenge(uri): { ok: true, c } | { ok: false, reason }`: every NKIP-0003 rule: the scheme
  `monero-signin:` with `?query` (or without `?`), `monero-signin://` refused; form-urlencoded decoding with
  `+` → space; every parameter once and none unknown; no control characters; address mainnet standard or
  subaddress (existing `validateMoneroAddress`, integrated refused); nonce 22–128 `[A-Za-z0-9_-]`; session
  1–128 of the same; origin `[a-z0-9.-]+(:port)?`; purpose 1–32 `[a-z0-9_-]`, absent → `login`, present
  but empty → refused; handle 1–64 code points, NFC, no `\p{C}`/`\p{Z}`, no Default_Ignorable, no
  U+115F/U+1160/U+3164/U+FFA0/U+2800; dk 16 lowercase hex; times in the exact format, real calendar dates,
  `issued_at < expires_at ≤ issued_at + 15 min`; return_url https (http only to localhost/127.0.0.1/[::1]),
  no user info, no fragment; v = 1.
- `canonicalMessage(c)`: the v1 text, LF-joined, no trailing newline.
- `sameSite(a, b)`: registrable domain via tldts with the private PSL section, ports ignored.
- Default_Ignorable: a fixed list of ranges from the Unicode data (as the spec references), in the module.
- Tests: all 2 valid vectors (message bytes and SHA-256 equal), all 25 invalid vectors refused, plus the
  scheme forms above. The vectors file is copied to `tests/fixtures/nkip0003-v1.json` (CC0).

## 3. Consent (an extension page, never in the page)
- `siwm.html`, opened by the background with `windows.create({ type: 'popup', width, height })`, so the
  site can't draw over it or click it for the user. The challenge travels to it in `session:` storage
  under a random id (the URL carries only that id); it's deleted when the window closes or the
  challenge expires.
- Shows (R6): origin (punycode as is), `@handle`, the address (and "one of your addresses" when it equals
  the Monero identity XMRadar knows), the callback host with "the site's own" or "**a different site**",
  the expiry as a countdown, the full message, and the warning "Approve only a sign-in you started
  yourself, just now, on <origin>".
- R10: when the opening page is known and its registrable domain differs from `origin`, the window shows
  only the refusal ("This link came from <page host>, not <origin>. XMRadar won't help sign it.") —
  nothing to copy, nothing to sign.
- Expired, or issued more than 5 minutes in the future → refused.
- Signing paths (each an explicit click; nothing automatic):
  - **Sign in your wallet**: Copy message; how-to lines (Feather: Tools → Sign/verify; CLI `sign`;
    wallet-rpc `sign` with `signature_type: spend` and the address's indices); a box for the `SigV…`.
  - **Open in Ripley Terminal**: `ripley://sign?<the same query>` (Ripley shows its own consent).
  - **Open in my wallet app**: the original `monero-signin:` URI, for a wallet registered with the OS.
- Text only (textContent), no HTML from the challenge.

## 4. The signature check (pure, `src/siwm/signature.ts`)
- Decode `SigV1`/`SigV2` + Monero base58 → c ‖ r (32 + 32 bytes, both reduced scalars, else refused).
- Keys from the address (spend and view public keys).
- Hash: V1 = keccak256(message); V2 = keccak256("MoneroMessageSignature\0" ‖ spend ‖ view ‖ mode 0 ‖
  varint(len) ‖ message), mode 0 = spend. A view-mode signature therefore never verifies.
- Check (Monero `check_signature`): R = r·G + c·P (P = spend public key, a valid point not of small
  order), c' = H_s(hash ‖ P ‖ R) mod ℓ; good when c' = c. `@noble/curves` ed25519 points and
  `@noble/hashes` keccak, both already in the dependencies.
- Tests: the vectors' SigV1 and both SigV2 (primary, subaddress 0/1) verify; the view-mode signature
  and the primary-address signature checked against the subaddress fail; a flipped byte fails; garbage,
  wrong prefix, wrong length fail.

## 5. Sending
- Background `siwm-submit`: only from the consent page (sender is the extension page), only for the
  stored challenge, and only after the signature verified against the stored address and the message
  rebuilt from the stored challenge. `POST return_url` with
  `{"session","address","signature"}`, `credentials: 'omit'`, no referrer, 15 s timeout, follows the
  browser's proxy. Shows the verifier's answer: ok → "Signed in. Go back to <origin>." and the window
  closes after a moment; else its error text (truncated, textContent).
- One successful submit per challenge; then the stored challenge is deleted.

## 6. Docs
README "Sign in with Monero": what it does, that XMRadar holds no key, the same-site refusal, what the
callback reveals (your IP to the verifier). A note to add XMRadar to NKIP-0003's Implementations table as
"wallet helper (signing by the user's wallet)" is left to the nkips repo (not changed here).

## Out of scope
Holding keys or signing; monero-wallet-rpc on localhost; script navigations; `ripley:` links; any change
to kyc.rip, xmr.bio, Ripley or the nkips repo.

## Live check
On xmr.bio: Sign in with Monero → click the link → consent window with the right fields → sign in Feather
or monero-wallet-cli → paste → signed in. A link copied to another site → refused. A view-key signature →
refused locally.
