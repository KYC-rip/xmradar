# PLAN-XOLIKE: hold an xo to also like the post on X

## Why
The user: long-press on the xo heart sends the xo **and** likes the post on X, on by default; a plain click
also liking is opt-in.

## Facts
- The xo button (src/entrypoints/content/x-xo.ts) is a clone in the post's action bar; X's own like button
  in the same bar is `[data-testid="like"]` (not liked) / `[data-testid="unlike"]` (liked).
- `toggle()` sends `xo-send` / `xo-undo` on a trusted click; animations via `anim()`, reduced motion respected.

## Changes
1. Gesture on the xo button (not sent yet only; holding a sent heart does nothing special):
   - pointerdown (primary button) starts a 500 ms hold: an orange ring drawn around the heart fills
     (transform scale/opacity only); pointerup/leave/cancel before 500 ms → plain click path.
   - At 500 ms: "charged" — a bigger bloom (scale 1.4, 8 dots), then the xo is sent and X's like is pressed.
     The click that follows the pointerup is swallowed so it doesn't also run as a plain click.
   - Keyboard: Enter/Space = plain; Shift+Enter = xo + like.
   - Tooltip: "Click: xo · Hold: xo + like on X".
2. Like on X: `likeOnX(article)`: the post's own like button (nearest-article ownership like `actionBars`),
   `[data-testid="like"]` only (already liked → nothing); `.click()` on it. Only after the xo was accepted
   (`res.ok`), so a refused xo likes nothing. Un-xo never un-likes.
3. Setting `xoAlsoLike?: boolean` (XmrSettings, off unless switched on): a plain click also likes.
   Options → Badges on X: "Also like on X when I send an xo" under the xo switch. Long-press stays on.
4. Reduced motion: no ring or burst; the hold still works (state change only).
5. Tests: hold < 500 ms = xo only; ≥ 500 ms = xo + like; click after a charged hold not double-sent;
   already-liked post not clicked; refused xo likes nothing; Shift+Enter; setting makes a click like;
   quoted post's like button never pressed.

## Out of scope
Liking on X from anywhere else; un-liking.
