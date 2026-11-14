# Signer tab on xmradar.app instead of example.com

## Today
`withSignerTab` (background.ts) opens `https://example.com/`, waits for it to load, checks the tab is
still on `https://example.com/`, and runs `window.nostr.getPublicKey()` (Test signer) or one
`signEvent` (`signExact`, identity events) in the page's MAIN world. Extension pages have no
`window.nostr`, so a web page is needed. example.com is IANA-reserved (RFC 2606): it can't be taken, but
it is a stranger's page, and the user's signer approval ("remember for this site") is filed under it.

## Change
1. **Page** `site/signer.html` → served as `https://xmradar.app/signer` (Cloudflare Pages drops `.html`).
   Static, **no script, no images, no links out**: title "XMRadar · signer check", one paragraph:
   "XMRadar opened this tab to ask your Nostr signer (Alby, nos2x…) for your public key or one signature
   you started from XMRadar. This page runs no code of its own and closes by itself." Uses the site's
   style.css and fonts.
   `site/build.py`: copy it (in ASSETS), and `_headers` gains a stricter block for it:
   `/signer` and `/signer.html`: `Content-Security-Policy: default-src 'none'; style-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`
   (no script-src at all: only the extension's injected function and the signer's own content script run).
2. **Extension** (`background.ts`): `SIGNER_PAGE = 'https://xmradar.app/signer'`; the tab is opened there;
   the "still our page" check becomes `u.origin === 'https://xmradar.app' && (u.pathname === '/signer' ||
   u.pathname === '/signer.html')` on the parsed tab URL (not a prefix test). Everything else unchanged
   (15 s load timeout, tab closed in `finally`).
   If the page can't load (offline, blocked): the existing "Signer page did not load" error, plus
   "(xmradar.app)" so the user knows which site.
3. **Order of release**: the site page is deployed first (it only adds a file; the landing page is
   rebuilt from the same release as now), then the extension change ships in the next release. A user
   on an older version keeps using example.com until they update.
4. Wording: Options → "Test signer" hint mentions "a tab on xmradar.app opens and closes"; the user's
   signer asks once more for xmradar.app.

## Tests
- `isSignerPage(url)`: `https://xmradar.app/signer` and `/signer.html` true; `https://xmradar.app/`,
  `https://xmradar.app/signer/x`, `https://xmradar.app.evil.com/signer`, `http://xmradar.app/signer`,
  `https://evil.com/?https://xmradar.app/signer`, `https://example.com/` false.
- site build test: `signer.html` is in the output, has no `<script`, `<img`, `http` link; `_headers` has the
  `/signer` block with no `script-src`.

## Live
Deploy the site; reload the extension; Options → Test signer: a tab on xmradar.app/signer opens, the signer
asks, the npub shows, the tab closes.
