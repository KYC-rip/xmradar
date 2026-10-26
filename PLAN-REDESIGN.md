# PLAN-REDESIGN: new look for the popup and options page (R1)

Design: `Extension redesign planning.zip` → `XMRadar Popup and Options.dc.html` (turns 3 and 4) and `handoff/README.md`; logo 2a from `logo.zip`.

The handoff asks for a reskin plus four new features. They ship in phases, each with its own plan and review:

| Phase | What | Handoff § |
|---|---|---|
| **R1 (this plan)** | Theme, logo, popup shell and Monero/Burner tabs, options sidebar with autosave, identity stepper, settings migration | 1, 2, 3 |
| R2 | Badges and tip dialog on Nostr clients (primal, njump, snort, coracle), tip presets, in-page UI restyle | 4 |
| R3 | Kind 9042 tip receipts, RipleyOS-compatible | 5 |
| R4 | Swap tab, NKIP-0001 alerts, Swap receipts section | 6 |
| R5 | Burner inbox, mail polling, notifications, unread count | 7 |

R1 shows only controls that work. The Swap tab and Swap receipts section arrive with R4, the "Nostr clients" and "Tip receipts" switches with R2 and R3, the burner inbox and "Notify me" switch with R5.

## 1. Theme and fonts

- `src/ui/base.css` holds the tokens from the design's `themes` array as CSS variables: `--bg --surface --fg --muted --border --chip --track --accent --accent-soft --ok --warn --danger`, light by default, dark under `@media (prefers-color-scheme: dark)`. Every rule in base.css, popup and options CSS uses only the tokens (no hard-coded colours).
- Font: Manrope (the design's UI font), bundled from `@fontsource-variable/manrope` (OFL-1.1), imported once in base.css. No request to Google Fonts: extension pages make no network calls for styling. Addresses, npubs and relay URLs use `ui-monospace, SFMono-Regular, Menlo, monospace`.
- Shared components in base.css, used by both pages: `.card` (surface, 1 px border, 12 px radius), `.switch` (a styled `<input type="checkbox" role="switch">`, so keyboard and screen readers work unchanged), `.seg` (segmented tab bar), `.btn`, `.btn.primary`, `.btn.danger` (armed burn), `.link`, `.chip`, `.row-title` + `.row-hint`, `.mono`.

## 2. Logo

- `public/icon/{16,32,48,96,128}.png` replaced by the 2a set. The zip's PNGs are used as-is.
- Header mark: `xmradar-small.svg` inlined into both pages' HTML, with its C2PA `<metadata>` block stripped (it is ~15 KB of base64 and not needed for rendering). The SVG has no scripts or external references; that is checked when it's copied.

## 3. Popup (design 4c, 3h without the inbox)

- Fixed 340 × 560 px. Header (logo, "XMRadar", segmented tabs) and footer stay put; only the middle scrolls (`display: grid; grid-template-rows: auto 1fr auto`).
- Tabs: Monero, Burner (Swap in R4). ARIA tabs, `popupTab` and lazy panel loading unchanged (`src/ui/tabs.ts`).
- Footer: "Signed in as npub1x7k…4qmz" (from `pubkeyItem`; "No signer yet" with a link to options `#posting` when unset) and "All settings".
- **Monero tab:**
  - Card "Show badges on": X (hint "Needs the author's proof tweet"), and "Discover X badges via relays" (hint "Relays and X see which accounts you view"). Both are switches that save on change (`src/ui/xmr-toggles.ts`, restyled).
  - Card "Your tip badge" with a one-line summary and an arrow; the whole card opens options `#identity`. The summary comes from a new pure function `badgeSummary(status)` next to `statusLines` in `src/identity/status.ts`, from the stored last status (`setupStatusLast`): e.g. "Live on Nostr · xmr.bio verified", "Address on Nostr · X needs the proof tweet", "Not set up yet". No status stored yet → "Not checked yet". The popup no longer runs Check status itself; options does.
- **Burner tab:** card with the address (mono), "Free · 42 min left" and Copy; "Get a 60-minute address" when there's none. Burn and Forget stay in the card (two-step burn, as today; see §8). The panel logic stays in `src/ui/burner-panel.ts`; only markup and CSS change, so the keepalive and creating/error states keep working.

## 4. Options page (design 1a and 3b layout)

- Two columns: a sidebar (logo, nav: Posting to Nostr, Monero identity with "3/4", Burner email; footer note "Changes save as you make them. Follows your system's light or dark mode.") and one section shown at a time. The hash picks the section (`#posting`, `#identity`, `#burner`; no or unknown hash → `#posting`). Nav items are links to the hash, so back/forward and the popup's links work. Below 720 px the sidebar becomes a top row.
- The "Grant access" banner (Firefox) stays above the sections.
- **Autosave, no Save button:**
  - Behaviour checkboxes save on change.
  - Relays: chips with × to remove, an input that adds a relay on Enter or blur, and "Load from NIP-65" which replaces the list and saves. Validation on add: `wss://` (or `ws://` for localhost) and a parseable URL; invalid input stays in the field with an error under it. Empty list = use NIP-65 then defaults, as today (hint unchanged).
  - Blossom server: validated on blur (`https://` URL); valid → saved, invalid → error under the field and the old value kept.
  - A small "Saved" note appears next to the field for 1.5 s after each save.
- **Posting to Nostr:** Signer row (status dot, npub, "Test again"), Relays, Images, Behaviour, as in 1a.
- **Burner email:** two cards side by side: "Free, 60 minutes" (the panel) and "Paid inbox from kyc.rip/mail" (the import form); stacked under 720 px.

### Identity stepper

Four steps: 1 Signer, 2 X handle, 3 Monero address, 4 Link X. A pure function `identitySteps({npub, handle, status})` (new, `src/identity/steps.ts`) returns each step's state: `done` / `current` / `todo`, plus the one-line value for done steps. Rules:
- 1 done when `pubkeyItem` is set.
- 2 done when `myHandleItem` is set.
- 3 done when the last status shows a valid published address; the value is the short address.
- 4 done when the last status shows the X link verified.
- The first step not done is `current` and expanded; later ones are `todo` and collapsed; done steps collapse to one line with actions: 1 "Test again", 2 "Change", 3 "Replace" / "Remove", 4 "Unlink". "Change"/"Replace" expand that step again.
- No status checked yet: step 3 (the open one) shows "Not checked yet" and a "Check status" button instead of guessing; one check covers steps 3 and 4. Step 4 shows the same row if it is opened first.
- The review box (diff, "This is my key", Sign) opens inside the step that asked for it. The raw tag diff goes behind a "Show the tags" disclosure; the summary line stays visible. Per-relay results also go behind a disclosure, with a one-line count ("Published to 4 of 5 relays").
- Below the steps, "Where your badge comes from": `statusLines` grouped as rows xmr.bio / Nostr / Relays, with "Checked 3 min ago" and "Check again". The sidebar's "n/4" counts done steps.
- `src/entrypoints/options/identity.ts` keeps all the setup, prepare, sign and retry logic; it renders into the stepper instead of the flat list.

## 5. Settings migration

`xmrSettingsItem` (`sync:xmrSettings`) becomes `{ badgesX, badgesNostr, nostrDiscovery, tipReceipts }` with WXT storage versioning (`version: 2`, `migrations: { 2: ({badges, nostrDiscovery}) => ({ badgesX: badges, badgesNostr: badges, nostrDiscovery, tipReceipts: true }) }`). Fallback `{ badgesX: true, badgesNostr: true, nostrDiscovery: false, tipReceipts: true }`. Readers (`x-badges.ts`, `background.ts`, `xmr-toggles.ts`) switch from `badges` to `badgesX`. `badgesNostr` and `tipReceipts` are stored now but read only from R2/R3.

## 6. Tests

- Migration: v1 `{badges:false, nostrDiscovery:true}` → `{badgesX:false, badgesNostr:false, nostrDiscovery:true, tipReceipts:true}`; fresh install gets the fallback.
- `identitySteps`: every combination of signer/handle/address/link, including no status yet and an invalid published address.
- `badgeSummary`: the user's own case (xmr.bio verified, Nostr address, X linked), Nostr only, nothing.
- Relay chips: add valid, reject invalid (error shown, not saved), remove, Enter and blur both add, NIP-65 load replaces and saves.
- Blossom: valid saves on blur, invalid keeps the old value.
- Options routing: each hash shows its section and selects its nav item; unknown hash → Posting.
- Existing tests updated for the new markup: burner panel, xmr toggles, tabs, token-boundary import walk (no new imports of `token-store.ts`).
- Build: both manifests reference the new icons; base.css has no hard-coded colours outside the token block (a source scan).
- Manual: popup and options in light and dark, Chrome and Firefox 140; popup is exactly 340 × 560 with only the middle scrolling; keyboard through tabs, switches and stepper.

## 7. Out of scope here

- In-page UI (badges, tip dialog, composer) restyle: R2, together with the new tip dialog.
- The burner notification design shows "Open" for links in mail. XMRadar doesn't open links from mail (burner rule); R5's plan will propose showing the link's domain with Copy instead, for the owner to confirm.

## 8. Plan review (7.6, pass) items, folded in

- BURNER-PANEL-ROOT, POPUP-BURNER-FORGET-IMPORT: Burn now and Forget stay inside the Burner card's action row (not the footer), so `mountBurnerPanel` keeps one root and its required parts. The popup keeps "Use a paid inbox…" (options `#burner`). Imported inbox in the popup: address, "Imported, <tier> · expires in …", Copy and Forget. Tests cover the popup markup with a free and an imported inbox.
- STATUS-PER-PUBKEY: `badgeSummary` and `identitySteps` use the stored status only when `status.pubkey` equals `pubkeyItem`; otherwise they treat it as not checked. Tested with a signer switch.
- SETTINGS-MIGRATION-READERS: `x-badges.ts` (`setEnabled(s.badges)`), `background.ts` (`const { badges: enabled, nostrDiscovery }`), `xmr-toggles.ts` (read and write) all switch to `badgesX`; the migration is tested through the real WXT storage item on `fakeBrowser`.
- AUTOSAVE-RELAY-EDGE: Enter or blur on the relay input: empty → nothing; valid → chip added, input cleared, list saved; already listed → input cleared, nothing saved; invalid → text kept, error shown under the field, nothing saved, chips unchanged. Typing clears the error.
- THEME-TOKEN-VALUES: light `bg #f6f7f9, surface #ffffff, fg #151821, muted #5d6273, border #e3e6ec, chip #e6e8ee, track #cfd3dc, accent #7b3fe4, accent-soft #ece4fb, ok #2e9d5a, warn #b26a00, danger #c62828`; dark `bg #131418, surface #1c1d23, fg #ecedf1, muted #9a9fae, border #2c2e36, chip #262830, track #3a3d47, accent #9b6bff, accent-soft #2a2140, ok #5cc98a, warn #f0b429, danger #ff6b5e`. The source scan allows hex colours only inside the two token blocks of base.css.
- FONT-PACKAGE: the build check asserts the Manrope woff2 is in the output and no CSS references `fonts.googleapis.com`; the package's OFL licence ships in `node_modules` and is noted in README.
- LOGO-C2PA: a test asserts the inlined logo markup has no `<script`, `href`, `foreignObject` or `http` (other than the SVG namespace).
- IDENTITY-STEPPER-STATUS: step 3 with an invalid published address → `current` with a warning; step 4 with a failing or unreachable proof → `current` with the reason; "couldn't read some relays" doesn't change step states.
- PLAN-POPUP-SUPERSESSION: R1 supersedes PLAN-POPUP for the popup shell, settings shape and options layout. Carried over unchanged: ARIA tabs and `popupTab`, the token boundary checks, the burner create keepalive and its stored states, two-step burn.

## 9. Design update 26 Oct (recorded for later phases)

- R4: the Swap tab is "Swap by kyc.rip", labelled as our own service, with fee and spread next to the quote. kyc.rip orders get the same NKIP-0001 checks as any exchange (no allowlist). Options → Swap receipts gets "Show Swap by kyc.rip in the popup" (default on).
- R3: NKIP-0002 draft (in the design bundle, `nkips/nkip-0002.md`): recipient confirmation is kind 9044; the optional payment proof goes to the recipient only, as a NIP-59 gift wrap (kind 9043).
- CI, release zips and build info: PLAN-RELEASE.md.
