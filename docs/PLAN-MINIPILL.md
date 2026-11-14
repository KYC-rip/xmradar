# Copy to Nostr: publish in a small status pill, not a blocking modal

User ask: "when copying to Nostr, I don't want the modal to block my X page, it should be minimized as
an icon with status text somewhere and maybe a retry relays if some fail. a dismiss icon to hide it."

## Today
`src/entrypoints/content/composer.ts` mounts one shadow-root UI with WXT `position: 'modal'` (a fixed
full-screen wrapper) and a dimmed `.backdrop`. Publishing (Blossom uploads → NIP-07 sign → relays) runs
inside that modal and can take many seconds (signer prompt, slow relays). The page is blocked the
whole time. Results and "Retry N failed relays" are listed inside the modal.

## Change (round 2: answers MINIPILL-1..6)

### One instance at a time (MINIPILL-1, -3, -5)
There is at most one composer instance per page, either expanded or shown as its pill. No stacking.
A new Copy to Nostr while an instance exists is decided by a pure `claimSlot(current)` in
`publish-pill.ts`:
- no instance → open;
- instance expanded → ignored (as today), and the new session is closed (`close-session`);
- instance minimised and not busy (draft, published, failed) → the old one is closed as by ×, the new opens;
- instance minimised and busy → ignored, the new session is closed, and the old pill flashes
  "Still publishing the last post" for 3 s before its own status comes back.
The module `open` boolean becomes `current: { busy(): boolean; expanded(): boolean; dismiss(): void; notice(text): void } | null`,
cleared in `onRemove` only if it is still this instance.

### Hide and show without removing (MINIPILL-2)
The WXT UI is mounted with `position: 'inline'` (no wrapper styles; the host covers nothing) and stays
mounted for the instance's whole life. Inside its one shadow root (so style.css applies to both):
`container` holds the `.backdrop` (fixed, inset 0, z-index 2147483647) and the `.pill` (fixed,
bottom-right `right: 96px; bottom: 24px` beside X's round Grok and Chat buttons, full width above X's tab bar under 600px, z-index 2147483646, `max-width: min(420px, calc(100vw - 32px))`).
- `minimise()`: `backdrop.remove()`, pill appended/shown, focus back to `previousFocus`.
- `expand()`: pill removed, backdrop re-appended, focus to the textarea (the focus-trap and keydown
  listeners live on the dialog element and survive detaching).
- Only `close()` calls `ui.remove()` (session closed, blob URLs freed, `current` cleared).

### States and the pill (MINIPILL-6)
One state drives both the composer's status line and the pill, via a pure
`pillView(state, kind: 'note' | 'article') → { text, tone: 'info'|'ok'|'error', retry: number, view?: {href, label}, copy?: string, open: boolean }`:
| state | text | buttons |
|---|---|---|
| draft (minimised before Publish) | "Draft not published" | Open, × |
| uploading i/n | "Uploading image i of n…" | Open, × |
| signing | "Waiting for signer…" | Open, × |
| publishing | "Publishing…" | Open, × |
| published, all ok | "Published to N relays" | View, Copy, Open, × |
| published, some failed | "Published to k of N relays" | Retry (r) if r>0, View, Copy, Open, × |
| none accepted | "No relay accepted the note/article" | Retry (r) only if r>0, Open, × |
| error (signer, upload, session…) | the message (textContent) | Open, × |
`r` is the count of `retryable()` failures; "1 relay" singular. Retry in the pill and the existing link
in the composer call the same handler with the same `shown` list; while it runs the pill says
"Retrying r relays…". View keeps `target=_blank rel=noopener`.

### When it minimises
- Publish (after the existing checks pass) → minimise, then the steps show in the pill.
- New "–" button in the composer header (`aria-label="Minimise"`) → minimise; the draft stays.
- Backdrop click → minimise (today it closes and loses the draft). Esc and Cancel still close.
- × on the pill (`aria-label="Dismiss"`): not busy → `close()`. Busy → the pill hides at once,
  the work finishes (a hide does not set `closed`), and `close()` runs when it ends.
- The image-upload fallback stays the native `confirm()` (it is the user's own publish asking a
  yes/no; rare). The pill shows "Image upload failed…" behind it.
- Pill markup: icon is an inline SVG (the radar arcs used in the share-menu item), text span with
  `role="status" aria-live="polite"`, then buttons. Everything set with textContent.

## Tests (`tests/publish-pill.test.ts`, happy-dom) (MINIPILL-4)
- `pillView`: every row above, note vs article wording, singular counts, zero retryable → no Retry.
- `claimSlot`: the four cases.
- `createPill(doc, handlers)`: renders a view, buttons call handlers, update replaces content,
  hidden/visible.
- `composerShell(container, backdrop, pill)` (the minimise/expand/focus part, extracted so it can be
  tested without WXT): minimise detaches the backdrop and shows the pill, expand reverses it and
  focuses the textarea, minimise restores the previous focus, the dialog's Esc listener still fires
  after a detach/re-attach.
- The busy-dismiss rule as a small `dismissal(busy)` → 'close' | 'hide-then-close' function.

## Live check (Chrome, extension reloaded)
Copy a post on x.com → Publish → scroll and click the page while the pill shows the steps; Retry
on a failed relay; Open shows the list; × hides; minimise a draft and reopen it; a second Copy while
publishing shows the notice; a second Copy after it's done replaces the pill.
