# PLAN-SHOTOVERLAYS: the quoted post's picture caught XMRadar's own publish pill

## Why
A copy's quoted-post picture showed the "Published to 6 relays · View · Copy" pill of the previous copy.
`hideOverlays` (src/entrypoints/content/quote-shot.ts) sets `visibility:hidden !important` inline on each
overlay host. The pill (`xmradar-ui`) and the tip popup (`xmradar-tip`) are WXT shadow-root UIs, whose
shadow root holds `:host{all:initial !important;}` (wxt/dist/utils/content-script-ui/shadow-root.mjs).
For `!important`, a shadow tree's `:host` rule beats the page's styles, inline included, so the host
stays visible. Checked live in Chrome: inline only → `visible`; plus a shadow `<style>` →
`hidden` (children too); style removed → `visible` again. `xmradar-site` / `xmradar-receipt` use our own
closed shadow roots without the reset, so the inline style works for them.

## Change
- `hideOverlays`: for every overlay host, keep the inline style (works for the closed ones) and, when the
  host has an open `shadowRoot`, also append `<style>:host{visibility:hidden !important}</style>` to it
  (last in the tree, so it wins over the earlier reset with the same specificity). The undo removes that
  style and puts back the inline style, as today; the existing try/finally and pagehide restore apply.
- No change to which elements count as overlays.

## Tests (tests/quote-shot.test.ts, happy-dom)
- An open-shadow host gets the style while hidden, and loses it (and the inline style) on undo; a host
  without a shadow root gets only the inline style; an existing inline style is restored exactly.
  (happy-dom doesn't compute the shadow cascade; the cascade itself was checked live, above.)
- Export `hideOverlays` for the test.

## Live check
Copy a tweet that quotes another while a previous copy's pill is still showing: the picture has no pill;
the pill is back afterwards.
