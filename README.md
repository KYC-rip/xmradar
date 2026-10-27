# XMRadar

A browser extension for Chrome and Firefox that brings Monero to the pages you already use. It holds no keys and no funds.

- **Tip with Monero:** XMR badges on X for people who published a Monero address (via xmr.bio or Nostr), and a tip dialog that opens your own wallet.
- **Your Monero identity:** publish your address on Nostr and link it to your X account, step by step.
- **Burner email:** a throwaway GhostMail address in one click, for sign-ups.
- **Copy posts to Nostr:** from X, Bluesky, Mastodon, LinkedIn, Facebook, or any page.

Free software under the GNU GPL v3 or later (see `LICENSE`). Releases: https://github.com/KYC-rip/xmradar/releases

### Copy posts to Nostr

Right-click a post → **Copy post to Nostr** → edit in the preview → **Publish**. You can also hover a post and press `Alt+Shift+N`.

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

With **Discover X badges via relays** turned on under **Options → Badges on X** (off by default), tweets get an orange badge (the Monero symbol and **XMR** by default; change the icon or hide the label there) when the author's npub has published a Monero address (NIP-A3, kind 10133) and links the X handle (NIP-39, kind 10011) with a proof tweet that XMRadar checks itself, through X's oEmbed API and then syndication. Relays and X can see which accounts you're looking at while discovery is on. Clicking a badge opens the tip popup with every source. Without discovery, badges need the xmr.bio directory, which comes in Phase 2d.

## Your Monero identity (Phase 2c)

In the options page, under **Monero identity**, a four-step tracker walks you through it: connect your signer, confirm your X handle, publish your Monero address, then post the proof tweet and paste its link. Done steps collapse to one line with Change, Replace, Remove or Unlink. Each change reads your current Nostr list from every relay, keeps all other tags, shows a diff, and is signed once in a temporary tab (your signer still asks first). Relays that can't be read are skipped, and you have to confirm before publishing without them. Your badge is live for other XMRadar users with discovery on once both steps are done.

## Security notes

- The bridge to `window.nostr` runs in the page's own JavaScript world. Page scripts can see and imitate those messages, so the real security boundary is your signer's approval prompt.
- The bridge only signs kind 1 (notes) and kind 24242 (Blossom upload auth).
- Every signed event is checked before use: correct pubkey, unchanged content, valid signature.
- The background only uploads or publishes for a composer session that you opened in that same tab. Sessions end when the composer closes, or after 15 minutes at most.
- Before uploading, the background checks that the Blossom auth event matches the image hash and is signed.
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

- The UI font is Manrope (SIL Open Font License 1.1), bundled from `@fontsource-variable/manrope`. Nothing is loaded from a font CDN.
- The Monero symbol on the badge is © The Monero Project, from `monero-project/monero-gui` (`images/monero-vector.svg`, commit 5265e52), BSD-3-Clause, and licensed CC BY-SA 4.0 on getmonero.org. The default look recolours it white. Monero and its symbol are trademarks of their owners; XMRadar is not affiliated with or endorsed by The Monero Project. Full notices: `public/THIRD_PARTY_NOTICES.txt` (shipped in the extension).
