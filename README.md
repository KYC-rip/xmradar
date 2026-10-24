# XMRadar

A personal browser extension that copies your posts from X, Bluesky, Mastodon, LinkedIn, Facebook (or any page) to Nostr.

Right-click a post → **Copy post to Nostr** → edit in the preview → **Publish**. You can also hover a post and press `Alt+Shift+N`.

- Signing goes through your NIP-07 extension (Alby, nos2x…), so your key never touches this extension.
- Images are re-uploaded to a Blossom server (default `https://blossom.primal.net`) and tagged with NIP-92 `imeta`.
- Relays: whatever is set in the options page. If none are set, your NIP-65 write relays are used, and if those can't be found, damus/nos.lol/primal.

## Build

```sh
pnpm install
pnpm build        # → .output/chrome-mv3 and .output/firefox-mv3
pnpm test
pnpm dev          # Chrome with hot reload; `pnpm dev:firefox` for Firefox
```

## Install

**Chrome / Brave / Edge:** open `chrome://extensions`, turn on Developer mode, click *Load unpacked*, and pick `.output/chrome-mv3`.

**Firefox (140+):**
- Quick test: open `about:debugging#/runtime/this-firefox`, click *Load Temporary Add-on*, and pick `.output/firefox-mv3/manifest.json`. Temporary add-ons are removed when Firefox restarts.
- Permanent: run `pnpm zip` and submit the Firefox zip to AMO as **unlisted** (self-distribution; include the source zip, since the build is bundled). Install the signed `.xpi` you get back.
- Firefox MV3 doesn't grant site access at install time. Open the extension's options page and click **Grant access**, or enable it under *about:addons → XMRadar → Permissions*.

## Options

- **Test signer**: opens example.com, asks your NIP-07 signer for your pubkey, and shows your npub.
- **Relays**: enter them manually, or use *Load from my NIP-65 list*.
- **Blossom server**.
- **Append link to original** (default off).
- **Debug**: shows the unsigned event JSON before signing.

## Tip with Monero (Phase 2a)

On x.com, right-click a tweet or profile → **Tip with Monero (look up on xmr.bio)**. XMRadar asks xmr.bio about that one handle (only on this click), checks the response signature against the pinned xmr.bio key, rejects stale or replayed responses, and validates the address (mainnet, Keccak checksum). The popup shows a `monero:` QR code, the address, an optional amount, an "Open in wallet" link and where the data came from. XMRadar never sends or holds funds. Badges on X come in later phases (see PLAN-PHASE2.md).

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
