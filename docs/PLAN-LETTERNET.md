# Letters of guarantee: Solana and TON addresses, and an honest card when an address can't be read

## What happened (live, 2026-10-30)
BitcoinVN order BVCEPT4P: send USDC on Solana, receive USDT on TON. The signed letter (BitcoinVN's
`format_version: 1` key/value letter) has
`deposit_destination: {"address":"GCfZNmQkwLpSs78NVTLtqfRw2agKytEbiJm5HdCV5p3g"}` (network `sol`) and
`payout_destination: {"address":"UQB2TZ2sxXXcBE3FMeKqV_HGY0oc2vR-9hM44opSY6KeCgxX","memo":null}`
(network `ton`), plus `token_identifier: "EPjFWdd5…Dt1v"` (USDC mint) and
`payout_token_identifier: "EQCxE6mU…_sDs"` (USDT jetton master).
`letterAddresses` reads only XMR/BTC/Tron/EVM, so it found nothing and the card said "The signed
letter names no deposit address" (false), and its fixed footer "Before you send, check that your
wallet shows the same address as above" pointed at an address the card does not show.

## Change (round 2: answers LETTERNET-1..7)

### Families (`src/log/families.ts`)
- **SOL**: a base58 token of 32–44 chars that decodes (@scure/base `base58`) to exactly 32 bytes and
  is not a valid BTC or Tron address. No checksum exists, so SOL is read only where noted below.
- **TON**: user-friendly 48 chars, base64 or base64url, decoding to 36 bytes: flag 0x11 or 0x51
  (testnet 0x91/0xd1 rejected: no testnet swaps), workchain 0x00 or 0xff, 32-byte hash, and
  CRC16-XMODEM of the first 34 bytes equal to the last 2. Raw `0:<64 hex>` / `-1:<64 hex>` too.
- `letterKey(a)`: the canonical key. TON → `ton:<workchain>:<hash hex>` (so EQ…, UQ…, standard and
  url base64 and raw forms of one account are one key); bc1/0x → lower case; else as is.
  `sameLetterAddress(a, b)` = `letterKey(a) === letterKey(b)`. `letterAddresses` dedupes by
  `letterKey`, and so do the page's role map and signed lookups (LETTERNET-4).

### Roles (`src/log/check.ts`)
- `AddressRole` gains `'token'`: a label naming a token, contract, mint or identifier
  (`token_identifier`, `payout_token_identifier`, `contract`, `mint`) is `'token'`, checked before
  the deposit/payout rules. The existing BitcoinVN Tron fixture's `TR7NH…` (USDT contract) becomes
  `'token'` instead of null.
- `letterAddresses` reads all six families from the signed text (it is verified, trusted input).
- `LetterCheck`, the background's `LetterReply` (`src/log/service.ts`), the content side
  (`src/entrypoints/content/letter.ts`) and `CardLetter` all gain
  `unreadDeposit?: { network: string | null }`: set when a deposit-role label's value holds no
  address XMRadar reads; `network` from the letter's `network_name`, else `network`, else null
  (LETTERNET-3).

### Page check (`src/log/page.ts`)
- Families searched on the page: XMR, BTC, TRON, EVM always (as today), plus SOL and/or TON only when
  the letter signs a deposit, payout or refund address of that family. Token-role addresses never
  switch a family on (LETTERNET-1).
- An unsigned **SOL or TON** address on the page is reported ("doesn't name… Don't send") only when
  `roleOf` places it in the deposit or payout slot; elsewhere (mints, program ids, token accounts,
  jetton masters, explorer links) it is ignored. XMR/BTC/TRON/EVM keep today's rule (any unsigned one).
- Shortened tokens (LETTERNET-7): `ADDRESS_START` adds TON's `EQ|UQ|Ef|Uf|0:|-1:`; with SOL in play,
  a shortened token whose two parts are base58 (≥4 chars each) and fits nothing signed or in
  `notAddresses` gives the existing "shortened address that doesn't fit the signed letter" caution.
- No readable deposit: with `unreadDeposit` → caution "The signed letter's deposit address is on a
  network XMRadar can't check yet (<network>, or 'this network'). Compare the address in your
  wallet with the signed text yourself." Without → today's "names no deposit address" line.
- `letterCopyWarning` uses the page's families for that letter.

### Card (`src/entrypoints/content/receipt-card.ts`)
- Token rows: label "Token contract (not a send address)", no Copy button (LETTERNET-2).
- Footer "Before you send, check that your wallet shows the same address as above." only when the
  card shows a signed deposit address **and** no entry has a `warn` line (LETTERNET-5).

## Tests (LETTERNET-6)
- families: SOL valid (BVCEPT4P deposit), 31/33-byte decodes rejected, BTC legacy and Tron not SOL;
  TON: EQ, UQ, url and standard base64, raw 0: and -1: valid and all one key; testnet flag,
  bad workchain, bad CRC rejected; duplicate forms in one letter give one address.
- `letterAddresses` on the BVCEPT4P signed body (fixture; the payout address is the user's own and
  already on the page they shared; no keys or secrets): deposit GCfZ…, payout UQB2…, both token ids
  'token'; the Tron fixture with `TR7NH…` as 'token'.
- page: full Solana deposit shown as the deposit → ok; shortened as BitcoinVN shows it → the fits
  caution; TON payout shown shortened → no warning; a SOL letter page that also shows the USDC mint
  and an unrelated SOL account outside the deposit slot → no warning; an unrelated SOL address in the
  deposit slot → warn; an unrelated TON jetton master on a TON page → no warning; shortened unsigned
  TON in the page → the shortened caution; an XMR-only letter page with a random 44-char base58 → nothing.
- unreadDeposit: with network "Lightning" and with no network → the two caution texts.
- card: token row has no Copy and the token label; footer shown with a deposit and no warn; hidden
  with a warn line; hidden with no deposit.

## Live
Reload bitcoinvn.io/orders/BVCEPT4P in Chrome: the card verifies the letter, matches the Solana
deposit and TON payout, and lists the two token ids as token contracts.
