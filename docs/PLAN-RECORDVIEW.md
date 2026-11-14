# PLAN-RECORDVIEW: open the order page and view the guarantee from a swap record card (round 2)

## Why
Options → Swap receipts cards (src/ui/receipts-panel.ts) offer Export / Check public record / Delete only.
Users want to (a) go back to the order page and (b) read the guarantee without exporting JSON.

Facts:
- A saved record keeps `page` = origin + path only (privacy; kyc.rip's /swap keeps the order in `?id=`, so
  `page` is just https://kyc.rip/swap). We don't start storing queries.
- The xmr.club feed gives listings an `orderUrl` template (validated by `templateUrl`: https, one `{order}`,
  host in the listing's hosts), e.g. `https://kyc.rip/track/{order}`; kyc.rip's /track/:sn takes the KR-…
  reference (= receipt.order_id). By design (`publicSite`) templates and letter keys stay in the background.
- `checkPageReceipt` saves receipts even when the manifest was unreachable or the signature check warned;
  `SavedReceipt.manifest` is optional and no verdict is stored.

## Changes
1. `src/receipts/order-link.ts` (pure):
   - `orderLink(template, orderId, hosts) → string | null`: orderId must be 1–128 chars of
     `[\x21-\x7e]` (ASCII printable, no space) and not `.`/`..`; `encodeURIComponent`; replace the one
     `{order}`; parse; require `https:`, hostname (normalizeHost) in `hosts`, no user/pass/port/hash, and the
     encoded id still present in `pathname + search` (catches any path normalisation). Else null.
   - `receiptOrderLink(feed, issuer, orderId, now)`: null unless `feed && feed.expiresAt > now`.
     Candidates = `sitesFor(feed, issuer)` (normalises www./trailing dot) that have `orderUrl` and issue
     receipts (`nkip01` or `log.format === 'nkip01'`). Distinct templates: exactly one → `orderLink`;
     none or several different ones → null (no guessing).
   - `letterOrderLink(feed, siteId, orderId, now)`: same feed gate; the listing with that `id`; its template.
2. `src/receipts/check.ts`: export `signatureLine(r, manifest | undefined)`: the existing `signedLine` when a
   manifest was saved; else `{ level: 'caution', text: 'Not checked: the exchange’s key list wasn’t
   reachable when it was saved.' }`.
3. Background messages (extension pages only, like receipt-export):
   - `record-link` `{ kind: 'receipt', commitment } | { kind: 'letter', id }` → `string | null`; uses the
     stored feed, `siteInfoOn(xmrSettings)` must be on (else null).
   - `receipt-signature` `{ commitment }` → `Line` (re-checked now against the manifest saved with it; no fetch).
4. Receipts panel:
   - **Open order** `<a target="_blank" rel="noopener noreferrer">` per card when `record-link` gives one;
     title "Opens <host>. The exchange sees you looking at this order." Re-asked on render; the panel
     watches the feed item and xmrSettings and re-renders.
   - **View** toggle (aria-expanded, aria-controls) per card; open state kept per record across re-renders
     (Set of keys). Built with textContent only:
     - receipt: Order, Issuer, You send (amount asset, deposit address), You get (amount asset, payout
       address), Refund address (if any), Rate, Created, Expires, Policy hash, Key id, Signature, and the
       `receipt-signature` line as **Signature check** (its level as the colour). Salt row only when
       `r.salt` exists: "kept, not shown (Export includes it)".
     - letter: format label, fingerprint (if any), the text in `<pre>` (pre-wrap), "Verified with the key
       in xmr.club's feed when saved" (letters are saved only after verifying — `log/service.ts` "saves it
       only if it verified").
5. Tests (tests/order-link.test.ts + panel tests):
   orderLink: encoded id, `.`/`..`/space/control/non-ASCII/129-char ids refused, off-host/http template
   refused; receiptOrderLink: www. issuer, several listings with the same template → link, different
   templates → null, listing without nkip01 ignored, expired feed → null; letterOrderLink by id;
   signatureLine: no manifest → caution, valid → ok, tampered → warn; panel: Open order only with a
   link, View fields, salt row only with salt, hostile text stays text, View stays open across re-render.
6. README: one line under swap receipts.

## Out of scope
Storing full order URLs; fetching anything when the panel opens.
