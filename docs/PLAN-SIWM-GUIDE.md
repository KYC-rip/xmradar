# PLAN-SIWM-GUIDE: per-wallet signing guide in the SIWM consent window

## Why
Most users have no wallet registered for `monero-signin:`, so they sign by hand. The consent window
(src/entrypoints/siwm/index.html) has a 4-line hint list today. Replace it with a step-by-step guide per
wallet, checked against each wallet's source (Nov 2026):

| Wallet | Where | Facts from source |
|---|---|---|
| Feather | Tools → Sign/verify message | QPlainTextEdit message (toPlainText, not trimmed); editable Address field prefilled with account 0 / index 0; spend key (WalletImpl::signMessage) |
| Monero GUI | Advanced → Sign/verify (Advanced menu only in Advanced mode; change via Close wallet → Change wallet mode → Advanced mode) | `signMessage(text, false)` with no address → always primary address, spend key; LineEditMulti text; also "File" mode → Sign file |
| Cake Wallet | Settings → Other settings → Sign / Verify | message field is a single-line AddressTextField (maxLines 1): typed/long-press paste turns newlines into spaces; its paste icon sets controller.text directly (keeps them; our message has no `=`, so the URI branch isn't hit). Address field with "wallet addresses" picker |
| monero-wallet-cli | `sign [<account>,<index>] [--spend] <file>` | file contents signed exactly; default main address + spend; refuses watch-only, multisig, hardware |
| monero-wallet-rpc | `sign` {data, account_index, address_index, signature_type:"spend"} | "" also means spend |

## Changes
1. `index.html`: replace `ul.howto` with `<div class="guide">` holding one `<details>` per wallet (Feather,
   Monero GUI, Cake Wallet, monero-wallet-cli, monero-wallet-rpc) with numbered steps, plus a short
   "Can't sign?" note (view-only, multisig and hardware wallets can't; XMRadar never sees keys).
   Static text only; nothing from the link goes into HTML (fields filled with textContent as now).
2. New buttons in step 1 row: **Copy address** and **Save message as file** (`xmr-signin.txt`, exact
   canonical bytes, UTF-8, no trailing newline) via Blob + `<a download>` from the extension page; the
   object URL is revoked after the click.
3. Subaddress awareness: consent.ts knows the address type (`validateMoneroAddress` → 'subaddress').
   When it's a subaddress, the GUI section shows "The GUI signs only with the wallet's main address; this
   is a subaddress, so use Feather, Cake Wallet or the CLI with its index" (data-f toggled via `hidden`),
   and the CLI line shows the `<account>,<index>` form as needed (we don't know the index; tell them
   `address all` lists it).
4. The `<details>` matching nothing is open by default? No: all closed; the first (Feather) open.
5. ConsentDeps gets `save(name, text)` (main.ts implements the Blob download) so tests stay DOM-only.
6. Tests (tests/siwm.test.ts): save gets the exact canonical message; copy address; subaddress note
   shown only for subaddresses; guide has the five wallets; no link value ends up in innerHTML.
7. README SIWM section: one line pointing to the guide in the window.

## Out of scope
Changing xmr.bio; auto-detecting wallets (browsers don't expose protocol handlers).
