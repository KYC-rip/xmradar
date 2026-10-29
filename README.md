# XMRadar

A browser extension for Chrome and Firefox that brings Monero to the pages you already use. It holds no keys and no funds.

- **Tip with Monero:** XMR badges on X for people who published a Monero address (via xmr.bio or Nostr), and a tip dialog that opens your own wallet.
- **Your Monero identity:** publish your address on Nostr and link it to your X account, step by step.
- **Burner email:** a throwaway GhostMail address in one click, for sign-ups.
- **Swap receipts and letters of guarantee:** on an exchange's order page that carries a signed NKIP-0001 receipt, or whose operator signs a letter of guarantee (PGP or MistProof), a check of the signature and the page's addresses, and a copy saved in your browser for disputes.
- **Copy posts to Nostr:** from X, Bluesky, Mastodon, LinkedIn, Facebook, or any page.

Free software under the GNU GPL v3 or later (see `LICENSE`). Releases: https://github.com/KYC-rip/xmradar/releases

### Copy posts to Nostr

Right-click a post → **Copy post to Nostr** → edit in the preview → **Publish**. You can also hover a post and press `Alt+Shift+N`, or on X pick **Copy to Nostr** in a tweet's share menu (turn it off under Options → Posting to Nostr → Behaviour).

- Signing goes through your NIP-07 extension (Alby, nos2x…), so your key never touches this extension.
- Images are re-uploaded to a Blossom server (default `https://blossom.primal.net`) and tagged with NIP-92 `imeta`.
- Relays: whatever is set in the options page. If none are set, your NIP-65 write relays are used, and if those can't be found, damus/nos.lol/primal.

## Build

```sh
pnpm install
pnpm build        # → output/chrome-mv3 and output/firefox-mv3
pnpm test
pnpm dev          # Chrome with hot reload; `pnpm dev:firefox` for Firefox
```

## Releases

Releases are made only by CI: push a tag `vX.Y.Z` that matches `package.json` on a commit in `main`, and `.github/workflows/release.yml` builds, tests and attaches `xmradar-<version>-{chrome,firefox,sources}.zip` and `SHA256SUMS` to a GitHub release. The 4th version part is the CI run number (`0.1.0.142`), shown in the options sidebar as `v0.1.0 · build 142 · <commit>`. Local builds say "dev build".

`scripts/build-release.sh [dist/…]` makes the same zips from a committed tree (it refuses uncommitted changes and untracked files under `src/` or `public/`). The zips are byte-identical for the same commit on the same OS, Node and zip tool; CI's Ubuntu 24.04 build is the canonical one. To check a release byte for byte:

```sh
TAG=v0.1.0 RUN=142   # the release's tag and build number (the 4th version part)
git checkout "$TAG"
gh release download "$TAG" -p SHA256SUMS -O release-SHA256SUMS
docker run -e TAG -e RUN --rm -v "$PWD":/w -w /w ubuntu:24.04 bash -c '
  apt-get update -qq && apt-get install -y -qq curl git zip ca-certificates >/dev/null &&
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash - >/dev/null && apt-get install -y -qq nodejs >/dev/null &&
  git config --global --add safe.directory /w && corepack enable &&
  pnpm install --frozen-lockfile && WXT_BUILD_NUMBER="$RUN" WXT_COMMIT=$(git rev-parse HEAD) \
  WXT_RELEASE_URL="https://github.com/KYC-rip/xmradar/releases/tag/$TAG" scripts/build-release.sh dist'
diff dist/SHA256SUMS release-SHA256SUMS
```

## Install

Until XMRadar is in the stores, install a release zip (or build it yourself):

**Chrome / Brave / Edge:** unzip `xmradar-<version>-chrome.zip`, open `chrome://extensions`, turn on Developer mode, click *Load unpacked*, and pick the unzipped folder (or `output/chrome-mv3` after `pnpm build`).

**Firefox (140+):**
- Quick test: open `about:debugging#/runtime/this-firefox`, click *Load Temporary Add-on*, and pick `xmradar-<version>-firefox.zip` (or `output/firefox-mv3/manifest.json`). Temporary add-ons are removed when Firefox restarts. Firefox Developer Edition and Nightly can keep it installed with `xpinstall.signatures.required` set to `false`.
- Permanent: run `pnpm zip` and submit the Firefox zip to AMO as **unlisted** (self-distribution; include the source zip, since the build is bundled). Install the signed `.xpi` you get back.
- Firefox MV3 doesn't grant site access at install time. Open the extension's options page and click **Grant access**, or enable it under *about:addons → XMRadar → Permissions*.

## Options

- **Test signer**: opens example.com, asks your NIP-07 signer for your pubkey, and shows your npub.
- **Relays**: enter them manually, or use *Load from my NIP-65 list*.
- **Blossom server**.
- **Append link to original** (default off).
- **Debug**: shows the unsigned event JSON before signing.

## X Articles (long-form)

Open an X Article on its own page (it has a normal `/status/<id>` link), right-click anywhere in it → **Copy to Nostr**. XMRadar turns the article into Markdown (headings, bold and italic, lists, links, images, separators) and publishes it as a NIP-23 long-form article (kind 30023) with its title, summary, cover image and original date. The cover and inline images are re-uploaded to your Blossom server unless you untick them; an unticked image is removed from the text. The article's ID on Nostr is the tweet ID, so publishing it again replaces the earlier version instead of making a copy. Selecting text first shares just that selection as a normal note. A tweet that only shares an article card still becomes a note, with a hint to open the article.

## Tip with Monero (Phase 2a)

On x.com, right-click a tweet or profile → **Tip with Monero (look up on xmr.bio)**. XMRadar asks xmr.bio about that one handle (only on this click), checks the response signature against the pinned xmr.bio key, rejects stale or replayed responses, and validates the address (mainnet, Keccak checksum). The popup shows a `monero:` QR code, the address, an optional amount, an "Open in wallet" link and where the data came from. XMRadar never sends or holds funds. Badges on X come in later phases (see PLAN-PHASE2.md).

## Monero badges on X (Phase 2b)

With **Discover X badges via relays** turned on under **Options → Badges on X** (off by default), XMRadar marks authors whose npub has published a Monero address (NIP-A3, kind 10133) and links the X handle (NIP-39, kind 10011) with a proof tweet that XMRadar checks itself, through X's oEmbed API and then syndication. Their tweets get a **Xap** button (the Monero symbol) in the action bar, next to X's share button; their profile header and hover card get an orange badge (the Monero symbol and **XMR** by default; change the icon or hide the label there). Relays and X can see which accounts you're looking at while discovery is on. Clicking either opens the tip popup with every source. Without discovery, badges need the xmr.bio directory, which comes in Phase 2d.

## Xap (NKIP-0002)

A Xap is a Monero tip recorded on Nostr the way [NKIP-0002](https://github.com/nkips/nkips/blob/main/nkips/nkip-0002.md) (Verifiable Monero Tips on Nostr) describes; "Xap" is just the name in the UI.

- **It needs the recipient's Nostr key.** Authors known only through xmr.bio get a plain tip with nothing recorded.
- **The unique amount.** XMRadar adds 1–999,999 random piconero to the amount you type (at most 0.000001 XMR), so the last digits look odd: `0.010000437215`. That exact amount goes into the `monero:` link and the QR code, and it is what lets the recipient's wallet match your transfer to your receipt.
- **The receipt.** After you click **I sent it** and agree, XMRadar asks your signer to sign a public kind 9042 receipt and publishes it to your relays, the recipient's relays and the defaults. It shows your npub, the recipient's npub, the amount and the address you paid. It never contains your transaction id, tx key or a payment proof. Turn the question off under **Options → Badges on X**.
- **Per post.** A Xap from a tweet tips that tweet: the receipt names it with NKIP-0002's external post tag, `["i", "https://x.com/i/status/<id>"]` and `["k", "web"]` (never `e`, which is for Nostr notes). The confirm step says the post is named.
- **The author binding.** A receipt counts toward a tweet only when it pays the key the tweet's author proves through NIP-39 (kind 10011, or kind 0 from older clients): a proof tweet by that handle, containing the npub, that XMRadar checked. Only the key behind the author's badge counts for their tweets, and an author with a proof but no valid address gets no tweet figures. A tweet without a status link gets a profile Xap.
- **Post and person.** Every post Xap also counts toward the person's total. The button shows the tweet's figure; the badge tooltip and the popup's "All Xaps to @handle" line show the person's. The two are never added.
- **Three states, never added together:**
  - **verified:** the recipient confirmed it (kind 9044) from their wallet;
  - **verifying:** your own Xap from the last 30 minutes, while the transfer gets its confirmations (only you see this);
  - **claimed:** a receipt nobody has confirmed. Claims are free to make, so each tipper counts once, with their smallest receipt, and only if it paid the recipient's current address.
- The action-bar number is the tweet's verified total (the person's, for a tweet without a status link); with none, the claimed total marked "~" (what tippers say they sent, not confirmed). The two are never added. The popup shows all three.
- XMRadar doesn't send payment proofs (kind 9043) yet, so its Xaps are confirmed when the recipient's wallet matches the unique amount.

## Swap receipts (NKIP-0001)

[NKIP-0001](https://github.com/nkips/nkips/blob/main/nkips/nkip-0001.md) (Verifiable Deposit Receipts) has exchanges sign a receipt for every order and witness a commitment to it on Nostr before showing the deposit address. XMRadar takes the spec's browser-extension role:

- **On the order page** (top frame, any site but X), a `<script type="application/nkip01+json">` receipt gets a short note at the top right ("<site> supports NKIP-0001 · Receipt checked and saved ✓") that shrinks to a small chip you can drag or close; a warning stays open in red. Its details:
  - **Signed:** checked against the key in `https://<that site>/.well-known/nkip01.json`, so the card says "Signed by example.swap". The receipt's issuer must be the page's exact host (or `www.`); a receipt for another host isn't checked. That is "the key this site publishes", not a key a verifier pinned, so a clone on its own domain passes only under its own name.
  - **Expiry**, the policy text (fetched by its hash and archived), and the receipt format: an old v1 receipt for a public-chain deposit is linkable to your payout address, and an unsalted v2 one breaks R16.
  - **Addresses:** the page's addresses (XMR and BTC) are compared with the signed ones, by role where the page labels them. An address the exchange didn't sign, on the page or in what you copy, is a red warning.
  - **Public record:** the event id the page shows, if any. XMRadar doesn't ask relays from the order page: a relay would see your IP asking about your own order (the spec's trust model).
- **Saved in this browser only** (IndexedDB), with the manifest, the policy bytes and the salt a dispute needs. **Options → Swap receipts** lists them, with Export (JSON; it contains your swap's addresses and salt), Delete, and **Check public record**, which asks up to 6 relays for the attestation, only when you press it and only an hour after the order.
- **Not covered:** a page script that writes the clipboard directly, or other software that rewrites it (compare the address in your wallet); exchanges that embed their order page in an iframe from another host; the log-root check for receipts signed with a key that was revoked later (shown as △). XMRadar creates no orders, so it never sends a `recovery_pubkey` (R19).
- **Missing-receipt warning (R12):** on an order page that xmr.club's signed list says carries an NKIP-0001 receipt (kyc.rip today), a caution if the page shows a deposit address but no receipt for 15 s.

## Letters of guarantee

Some exchanges sign a letter of guarantee for each order instead of an NKIP-0001 receipt: a PGP clear-signed text (0trace, Bitania, BitcoinVN, SageSwap, StereoSwap, Pablo Cash) or a MistProof (Mistex, an Ed25519-signed JSON). xmr.club's signed list says, for each of them, what an order page's address looks like, where the letter is, and the operator's key.

- **On an order page** the list names, XMRadar asks that same site for the order's letter: one request to the page's own origin, with the page's cookies (0trace and Bitania give the letter only to the browser that created the order), no redirects, 10 s, 256 KB. Nothing goes to any other host. With **Fetch letters of guarantee on order pages** off, or where the list names no letter URL, a letter is still checked when the page shows it or you copy it.
- **Checked** in the background with the operator's key from xmr.club's list, after asserting the key's fingerprint matches the one listed. A key the page or the letter offers is never used, and no key is downloaded from the operator. PGP: OpenPGP.js 6.3.2, with MD5, RIPEMD-160 and SHA-1 refused and RSA under 2048 bits refused; every signed block must name this order. MistProof: the `key_id` must match the key, and the payload must be for this order.
- **The page's addresses** (XMR, BTC, Tron, EVM) are compared with the signed ones, as for receipts: ✓ only when the signed deposit address is shown as the deposit and nothing unsigned is shown. A shortened address (`bc1q…gtx9`) that fits is only △, with the full signed address in the card. An address the letter doesn't name, on the page or in what you copy, is a red warning.
- **Saved in this browser only**, only when it verified: the exact text and the key it was checked with. **Options → Swaps and sites** lists letters with receipts (tagged "Letter"), with Export: the letter, the key, the date of the xmr.club list it came from, and how to check it yourself with `gpg --verify`. The file contains your order id and addresses.
- **What a verified letter proves:** the operator's key, as xmr.club lists it, signed this text for this order. Amounts and rates are shown as signed, not checked. The key is pinned by xmr.club's list, not by an independent source; a revocation the operator publishes arrives with the next list (about every 12 hours).

## Site info (xmr.club)

XMRadar downloads xmr.club's signed site list (`https://xmr.club/api/v1/swap-sites.json`) at startup and every 12 hours. It's the same file for everyone, fetched without cookies or identifiers, and the download follows the browser's proxy or Tor settings. The site you're on is matched against it inside the browser; its address is never sent anywhere.

- **Toolbar icon:** the site's grade, in xmr.club's colour for it (red with an open incident). On an order page the receipt check adds to it: a receipt warning (red !) comes first, then a site incident, then a receipt caution (amber !), then a checked receipt (green ✓), then the plain grade.
- **Menu → This site:** every listing for the current host (kyc.rip has three), with its grade, NKIP-0001 level (verified receipts / attesting / manifest only / letter of guarantee only / no verifiable receipts yet), any open incident and a link to the listing.
- **In-page warning:** only for an open incident or a D–F grade, bottom centre; × hides it on that site for 7 days.
- **Platforms** (GitHub, YouTube, Reddit, X, …) never get a badge, even though some listings link to pages there.
- **Trust:** the list must be signed with xmr.club's pinned key, unexpired and newer than the copy kept; an older or expired one is refused and the menu says when the list is out of date. The key comes from xmr.club itself: there's no independent second source for it yet. xmr.club is run by the same team as XMRadar.
- Switch it off under **Options → Swaps and sites**: no download, no badge, no warnings.

## Your Monero identity (Phase 2c)

In the options page, under **Monero identity**, a four-step tracker walks you through it: connect your signer, confirm your X handle, publish your Monero address, then post the proof tweet and paste its link. Done steps collapse to one line with Change, Replace, Remove or Unlink. Each change reads your current Nostr list from every relay, keeps all other tags, shows a diff, and is signed once in a temporary tab (your signer still asks first). Relays that can't be read are skipped, and you have to confirm before publishing without them. Your badge is live for other XMRadar users with discovery on once both steps are done.

## Security notes

- The bridge to `window.nostr` runs in the page's own JavaScript world. Page scripts can see and imitate those messages, so the real security boundary is your signer's approval prompt.
- The bridge only signs kind 1 (notes) and kind 24242 (Blossom upload auth).
- Every signed event is checked before use: correct pubkey, unchanged content, valid signature.
- The background only uploads or publishes for a composer session that you opened in that same tab. Sessions end when the composer closes, or after 15 minutes at most.
- A session starts from the browser's right-click menu, the keyboard shortcut, or a real (trusted) click on **Copy to Nostr** in X's share menu, in the top frame of an x.com tab, at most once every 2 s per tab. The tweet is the one whose share button you clicked, checked by its status ID. A page can't start a session by itself, and you still review the composer and approve in your signer.
- A Xap receipt is signed only after a real click on **Publish receipt** in the popup, from the top frame of an x.com tab, at most once every 10 s, and only for a standard address or subaddress that the recipient's newest NIP-A3 list (or kind 0, without one) names right now, read fresh from relays. Your signer still asks first.
- The tip and Xap popups' dollar shortcuts ($1, $5, $10, $20) need the XMR/USD price. It is fetched from `api.kyc.rip/v1/price/XMR` only when a tip popup opens, without cookies, at most once every 5 minutes (once a minute while it fails); nothing about you or the recipient is sent. If it fails, the shortcuts don't show.
- Before uploading, the background checks that the Blossom auth event matches the image hash and is signed.
- Letters of guarantee: the order page is matched from the browser's record of the tab, never from the page; the page learns the order id and letter URL, never a key. The letter request goes only to the page's own origin. OpenPGP.js is in the background only, never in the scripts that run on pages.
- Swap receipts: the page URL a receipt is checked for comes from the browser's record of the tab, never from the page; only the top frame counts. The manifest and policy come from that host only, without cookies, referrer or redirects, at most 256 KB. Manifest relays used by the public-record check must be public `wss://` hosts on port 443; a public name that resolves to a private address isn't caught. Receipts are parsed strictly (duplicate keys, fractions and oversized numbers are refused).
- Image URLs taken from the page are only fetched over http(s) or as `data:image`. Literal local and private addresses are refused, both for the original URL and for where any redirect ends up. A DNS name that resolves to a private IP is not caught; that's accepted for a personal tool.
- **Remaining risk:** a hostile page can impersonate the signer's replies, for example by returning a fake pubkey. The worst it can do is get your text published under someone else's key, or block publishing. It can't use your key without your signer's prompt. Check the "Posting as npub…" line in the composer.

## First-run checklist (real browser)

Not yet verified in a browser. Check each of these in Chrome and in Firefox:

1. Options → **Test signer** shows your npub. **Load from my NIP-65 list** fills in your relays.
2. On x.com, right-click your tweet that has an image. The modal looks styled (if it shows up unstyled, the page's CSP is blocking the shadow-root CSS). Text and image are correct. Publish, and the note shows up on njump. Clicking **Done** closes the modal.
3. The same on bsky.app, a Mastodon instance, LinkedIn, and Facebook.
4. Select text on any http:// or https:// page, right-click, and publish.
5. Hover a post and press `Alt+Shift+N`.

## When a site changes its layout

Each site has its own file in `src/extractors/` with a matching HTML fixture in `tests/fixtures/`. Save the new post HTML as a fixture, then fix the selectors until `pnpm test` passes. If a site extractor stops matching, select the text and right-click: the selection is always used.

## Third-party assets

- Letters of guarantee are checked with OpenPGP.js 6.3.2 (LGPL-3.0, lightweight build, unmodified), bundled in the background script.
- The UI font is Manrope (SIL Open Font License 1.1), bundled from `@fontsource-variable/manrope`. Nothing is loaded from a font CDN.
- The Monero symbol on the badge is © The Monero Project, from `monero-project/monero-gui` (`images/monero-vector.svg`, commit 5265e52), BSD-3-Clause, and licensed CC BY-SA 4.0 on getmonero.org. The default look recolours it white. Monero and its symbol are trademarks of their owners; XMRadar is not affiliated with or endorsed by The Monero Project. Full notices: `public/THIRD_PARTY_NOTICES.txt` (shipped in the extension).
