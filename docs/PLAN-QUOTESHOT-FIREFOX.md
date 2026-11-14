# PLAN-QUOTESHOT-FIREFOX: the quoted post's picture fails in Firefox

## Why
In Firefox the composer says "Couldn't take a picture of the quoted post (NetworkError when attempting to
fetch resource.)" every time. The background returns the crop as `data:image/png;base64,…`; the content
script turns it into a Blob with `fetch(dataUrl)` (`src/entrypoints/content/quote-shot.ts:74`). Firefox
applies the page's CSP to content-script fetches, and x.com's `connect-src` has no `data:`, so the fetch
is blocked. Chrome exempts content scripts, so it works there.

## Change
- `src/capture/quote-shot.ts` (pure, already holds the shot helpers): `pngBlob(dataUrl): Blob | null`.
  Accepts only `^data:image/png;base64,([A-Za-z0-9+/]+={0,2})$`; decodes with `atob` into a
  `Uint8Array` → `new Blob([bytes], { type: 'image/png' })`. Anything else (wrong type, bad base64,
  empty) → null. No network, no CSP involved.
- Content `takeQuoteShot`: replace the `startsWith` check + `fetch` with `pngBlob`; null → `{ error: 'not a
  picture' }` (same message as today).
- The background's own `fetch(dataUrl)` (`bitmapOf`) stays: extension pages aren't under x.com's CSP.

## Tests (tests/quote-shot.test.ts)
- `pngBlob` of a real 1×1 PNG data URL → Blob of type image/png with the exact bytes.
- null for `data:image/jpeg;base64,…`, a non-base64 payload, an empty payload, and a non-data string.

## Docs / release
No README change (a bug fix). Ships as 0.6.8 when the user says so.
