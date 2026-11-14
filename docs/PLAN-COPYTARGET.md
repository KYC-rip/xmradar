# Letter page check: read copy buttons and payment links, not only visible text

## Why
BitcoinVN order pages show addresses shortened (`GCfZNmQkwLpS…HdCV5p3g`), so the letter card can only
say "shortened, it fits … check that your wallet sends to exactly this address" (caution). The full
address is on the page, in what the user actually uses:
- the copy button: `<button data-clipboard-text="GCfZ…V5p3g">`
- the wallet link / QR: `<a href="solana:GCfZ…V5p3g?spl-token=EPjF…">`, `<div data-content="solana:…">`
- an explorer link (`https://solscan.io/account/GCfZ…`): not used (any page can link any account).

## Change (round 2: answers COPYTARGET-1..5)

Principle: a copy button or payment link can only **upgrade** the existing "shortened, it fits" caution
for the signed deposit to ok, and only when it sits in the same deposit box as that shortened text. It
never makes ok on its own, never counts outside the deposit slot, and anything unreadable keeps today's
caution. (A QR image is no more checked than today: the green line names what was checked.)

1. `pageTargets(doc)` (`src/log/page.ts`): shown elements with
   - a copy attribute: name matches `/clipboard|copy/i`, value trimmed; if the value is a payment URI it is
     parsed as one;
   - `href` / `data-content` / `value` holding a payment URI.
   Payment URIs, scheme case-insensitive, percent-decoded once, one recipient each, other parameters never
   read: `bitcoin:` `litecoin:` `monero:` `solana:` `tron:` → path up to `?`; `ethereum:` (EIP-681) →
   `ethereum:<contract>@<chain>/transfer?address=<recipient>` gives `address=`, else the path before `@`/`/`/`?`;
   `ton://transfer/<address>` → the segment after `transfer/`; `ton:<address>` → path.
   Only addresses of `pageFamilies(addresses)`. More than 200 candidate elements → `targetsCut = true`.
2. Roles: each target's role via `roleOf(el, …)` with the same token-aware `holdsOther` as text.
3. Unsigned target (address the letter doesn't name) **in the deposit or payout slot**, any family →
   warn "This page's copy button or payment link in the deposit (payout) box holds an address the signed
   letter doesn't name: X. Don't send." Outside the slots: ignored (support/donation buttons, token
   contracts, explorer links); the copy-event check still catches a copied unsigned address.
4. Upgrade, all must hold:
   - the signed deposit is shown shortened and fits (today's caution path), and that shortened text's
     element has role deposit (`roleOf`) — not just anywhere on the page;
   - at least one target holding the full signed deposit has role deposit **and** shares the nearest
     labelled box with the shortened text (same `closest` ancestor at the level `roleOf` found the label);
   - no target or text in the deposit slot holds any other address (3 found nothing), `!targetsCut`,
     and nothing else blocks (no warn, no other caution).
   Then ok: "The deposit address on this page is the one in the signed letter (shortened on screen; the
   copy button / payment link beside it holds the full address)."
5. Not changed: a signed deposit present only in a copy target or link (no text) stays the "not found
   as text" caution; full-text ok path unchanged; `letterCopyWarning` unchanged.

### Round 3 (answers COPYTARGET-6..9)
- **COPYTARGET-6, fail closed on what isn't read.** `targetsCut` adds a caution line ("This page has more
  copy buttons and payment links than XMRadar checks. Compare the address in your wallet with the
  letter yourself."), which blocks every ok, the full-text ok included. A payment URI that can't be read
  unambiguously (see -9) found in the deposit slot also adds a caution and blocks ok. QR images are not
  decoded; the upgraded ok line says so: "…the copy button/payment link beside it holds the full
  address. The QR code isn't checked: scan only if your wallet shows this address."
- **COPYTARGET-7, element identity.** `roleOf` gains a sibling `roleAt(el, address, holdsOther)` in
  `src/receipts/page.ts` returning `{ role, box }` where `box` is the element at the label level that
  decided the role (`roleOf` becomes `roleAt(...).role`). Shortened tokens are enumerated per visible
  element (`visibleTexts`, plus the split-ellipsis form across sibling spans by checking the parent's
  text), each kept with its element; the upgrade requires shortened element and target to have role
  deposit with the **same** `box`.
- **COPYTARGET-8, Solana/TON copy targets anywhere.** An unsigned SOL/TON address in a copy target or
  payment link outside the send slots (not a signed token) gives no "Don't send" (pages copy mints), but
  blocks the upgrade: the card stays at today's caution. In a send slot it warns as planned.
- **COPYTARGET-9, URIs.** Schemes read: `bitcoin:` `monero:` `solana:` `tron:` `ethereum:` `ton:` /
  `ton://transfer/` only (no `litecoin:`). Address part ends at `?` or `#`. EIP-681: more than one
  `address=` (or `address=` and a different path recipient on a non-`transfer` call) → unreadable. A
  URI with any repeated parameter that names a recipient → unreadable. Unreadable in the deposit slot →
  caution (blocks ok); elsewhere → blocks the upgrade only.

## Tests (`tests/log-copytarget.test.ts`, made-up addresses)
- BitcoinVN shape (shortened deposit + copy button + `solana:…?spl-token=` in one deposit box, TON payout
  box with its own copy button) → ok naming both kinds; spl-token never read.
- Decoy: signed deposit only in a copy button outside the deposit box, deposit box shows another
  (shortened) address → no ok (caution or warn as today).
- Signed copy button in the deposit box but a second copy button there with another address → warn.
- Copy button holding the signed deposit, no text → today's "not found as text" caution.
- Support/donation BTC copy button and a Tron token-contract copy button outside the send boxes → nothing.
- Unsigned BTC in a deposit-box copy button → warn.
- URIs: `BITCOIN:` upper case; `bitcoin:addr?amount=1`; `ethereum:0xToken@1/transfer?address=0xRecipient`
  → recipient only; `ton://transfer/<addr>?amount=…`; percent-encoded address; a copy attribute holding a
  `solana:` URI.
- 201 copy buttons → no upgrade.
- Hidden copy button with another address → ignored.
- Full signed deposit text + 201 copy buttons → caution, no ok (the full-text path is blocked too).
- Shortened deposit in one box, the copy button holding the signed deposit in another box → no upgrade.
- Unsigned Solana copy button outside the send boxes → no warn, no upgrade.
- `ethereum:0xT@1/transfer?address=0xA&address=0xB` → unreadable; `bitcoin:addr#frag` → addr;
  `litecoin:` ignored.
- The upgraded ok line mentions the QR is not checked.

## As built (plan passed 7.1 earlier)
- `src/log/page.ts`: `uriRecipient` (payment URIs), `pageTargets` (copy attributes; href/data-content/value with a
  payment URI; shown only; > 200 candidates → cut), `shortenedHolders` (the elements showing the deposit
  shortened, split spans included); `letterAddressLines` warns on unsigned targets in a send box, cautions on an
  unreadable link in the deposit box or a cut, and upgrades the shortened-deposit caution to ok only when a target
  with the full signed deposit shares the deposit box (`roleAt(...).box`) and nothing blocks.
- `src/receipts/page.ts`: `roleAt(el, holdsOther, depositLabel)` → `{ role, box }`; `roleOf` uses it.
- Two deviations, both found while testing:
  - Letter pages also read **"Single-use address"** as a deposit label (BitcoinVN's wording, as in the existing
    tests); without it the upgrade could never fire on BitcoinVN.
  - The label climb **never uses `body`/`html`**: a copy button near the top of the page climbed to `body`, found
    "Single-use address" somewhere on the page and was taken for a deposit-box button (a donation BTC button
    warned). This applies to receipts and letters alike; all existing tests pass.
- Tests: tests/log-copytarget.test.ts (15). 975 tests pass; both builds pass.
- Live: not run (needs a real BitcoinVN order page of the user's).
- Code review round 1 (6.4) fixes: a copy target in the deposit box holding a signed non-deposit address (payout,
  refund, token) warns; letter pages read "Single-use address" as a deposit label for text addresses too;
  comment nodes in a shortened-address box are skipped; `shortenedHolders` reads each element once and gives up
  past 5,000 (no upgrade); EIP-681 `to=`/`recipient=` is unreadable; a target's label climb is stopped only by
  an unsigned address (the signed deposit as text beside a button no longer ends it). Tests for each; 981 pass.
- Round 2 (reply cut off before scores; its reasoning found HIDDEN-LABEL-TEXT): `spacedText` read hidden text, so
  a hidden unsigned address in the deposit box stopped a copy button's label climb and the signed payout in it
  went unwarned (full-text ok). `spacedText` now skips hidden subtrees (`shown`), for receipts too; hidden text
  neither labels a box nor stops the climb. Test added. 982 tests pass; both builds pass.
- Round 3: 8.1, pass. Its two low notes fixed: hidden copy buttons no longer count toward MAX_TARGETS, and
  `spacedText` stops after 2,000 nodes walked (LEVEL_NODES) as well as 400 characters. Tests for both. 984 tests
  pass; both builds pass.
