# PLAN-LANDINGS: bring xmradar.app and xmr.bio's home page up to what ships in 0.6.12

Both pages ship with the 0.6.12 release. The user decided that release waits for a self-hosted OpenAlias nameserver
(planned, not built: a delegated subzone, proposed `oa.xmr.bio`, served from a new VPS). Until that exists, XMRadar
listings get no OpenAlias record (`registerNostr.ts` says so); every sentence below about their wallet names is
marked **[NS]** and is written only once the nameserver is live, in its final form. Nothing is deployed before.

## Why
- **xmradar.app** (`site/index.html`, built by `site/build.py`) was last updated at 0.6.1. Missing: xo (0.6.11), Sign in
  with Monero (0.6.9), chat (0.6.8), the Nostr ✓ mark (0.6.10), and the unreleased XMRadar identity and xmr.bio
  listing. Now untrue: "Your signer signs… you approve each one", "Works with any NIP-07 signer" (a signer is
  optional), and the privacy intro "no backend: its own site is asked only for the latest version number" reads as
  if XMRadar talks to nothing (the listing sends data to xmr.bio by default).
- Every proof tweet now ends "try it on: XMRadar.app", so visitors arrive having just seen a "Verifying that I
  control the following Nostr public key" tweet. Nothing on the page explains it.
- **xmr.bio home** (`bio-ui/src/pages/Home.tsx`, kyc-rip) covers the challenge tweet, Nostr and agent keys (step 02).
  Missing: listing from XMRadar (its proof tweet is enough, no challenge tweet), Sign in with Monero for managing a
  profile, and what such a listing gives.

## xmradar.app changes
1. **Hero:** a third slide "Wear a Monero badge on X" (no Nostr signer needed for it): mock of the four identity steps with
   ticks, and an xmr.bio listed line; tab "Badge". Lede of slide 1 adds Monero likes. Slides stay 3 (carousel JS
   already handles N tabs; check).
2. **Features:** grid from 4 to 8 cards, same style (kicker, h3, p, small CSS demo, no new screenshots):
   - 01 Tip badges (kept; text adds "or listed on xmr.bio from XMRadar").
   - 02 **xo, a Monero like** · NIP-25 (kind 17): heart next to Xap, hold (or Shift+Enter) to also like on X,
     counted only from Monero people (a key with a Monero address and a verified X link), notifications. Demo:
     heart with count.
   - 03 **Your Monero identity** · no signer needed for it: when no NIP-07 signer is found, XMRadar makes a Nostr
     key kept in this browser; publish an address, link X with one tweet, and (on by default) get listed on
     xmr.bio's directory, which XMRadar users with badges on download. Demo: 4 ticks.
   - 04 Swap guard (kept, unchanged).
   - 05 **Sign in with Monero** · NKIP-0003: `monero-signin:` links open a checked request window; your wallet
     signs; guides for Feather, GUI, Cake, CLI, RPC.
   - 06 Burner email (kept).
   - 07 Copy posts to Nostr (kept; adds whole threads, quote pictures, the Nostr ✓ mark on copied posts). States
     that copying needs your own NIP-07 signer (the XMRadar identity never signs notes: kind 1 isn't in
     `MANAGED_KINDS`).
   - 08 **Chat** · chat.xmr.club in the side panel/sidebar, a room per X and per listed site.
3. **New section "Seen a 'Verifying that I control…' tweet?"** (anchor `#proof`), right after features: two
   sentences on what it is (an X account linking a Nostr key, NIP-39) and the 3 steps to get your own badge
   (install → Options → Monero identity → 4 steps), with a CTA to install.
4. **Privacy checks:**
   - "No keys, no funds" → **"No Monero keys, no funds"** (tips open in your wallet; the swap guard and SIWM only
     check signatures). The hero's "Holds no keys and no funds" → "Holds no Monero keys and no funds".
   - "Your signer signs" → **"Your Nostr key, your choice"**: your NIP-07 signer asks you per event; or, without
     one, an XMRadar identity: a key kept in the extension's own IndexedDB (pages and content scripts can't read
     it), exportable and deletable in Options, that signs only XMRadar's own events (xo and its deletion, Xap
     receipts, your profile name, relay list, Monero address, X link, the xmr.bio listing request) without asking
     each time, and never your posts.
   - New **"xmr.bio listing is your choice"**: on by default once your X link verifies; sends your X handle, Monero
     address, Nostr key and proof tweet id to xmr.bio, which publishes them on your profile and directory; untick
     in Options → Monero identity; on xmr.bio, unlist hides you, delete removes the profile.
   - New **"What an xo shows"**: a public Nostr event naming the X post (its link) and the author's Nostr key;
     relays see it. Holding the heart (or the "click likes on X too" option) also likes the post on X.
   - Intro: "No account. xmradar.app is asked only for the version number; other services are asked only for the
     features you use, listed below."
5. **NKIPs panel:** add NKIP-0003 Sign in with Monero (nkips.org/nkip-0003/), NKIP-0002 link to /nkip-0002/.
6. **Install:** "A NIP-07 signer such as Alby or nos2x is optional: without one, XMRadar's own identity covers
   badges, xo, Xap receipts and your Monero identity. Copying posts to Nostr needs a signer."
7. **Meta description / og:description:** mention Monero likes and your own badge; no "without a signer" claim in
   the short texts. og.png unchanged.
8. Nav: add "Badge" → `#proof`.
9. **CHANGELOG.md Unreleased** gains the xmr.bio listing ("Also list me on xmr.bio", on by default, what it sends,
   untick) and the proof tweet's last line; the **[NS]** wallet-name line is added with the nameserver.

## xmr.bio home changes (kyc-rip worktree `kyc-rip-bio-register`, branch `feat/bio-register-nostr`)
1. Step 02 "Prove": "…or link it from XMRadar: its proof tweet is enough, no challenge tweet."
2. New section after the steps: **"Already using XMRadar?"** — once your X account is linked there, XMRadar lists
   it here (on by default, you can untick it), free, no challenge tweet: a profile page, a place in the signed
   directory XMRadar users with badges on download (so they see your badge), and xos from you that count. Manage
   it with Sign in with Monero, using the address you published. Link to xmradar.app.
3. Step 03 "an OpenAlias name": true today for xmr.bio sign-ups (`<handle>.xmr.bio`). For XMRadar listings the
   section in 2 says nothing about a wallet name until **[NS]**; then one line with the real name.
   The "Heads-up" line stays.
4. Same visual language (display/italic headings, mono labels, existing Step component).

## Checks
- Claim table in the PR: each new sentence with the code that backs it (`MANAGED_KINDS`, `xoTemplate` tags,
  `listOnXmrbio` + `registerTemplate` payload, `xmrbioListPrefItem` default on, discovery default off, directory
  download gated on badges, `proofTweetText`).
- `python3 -I site/build.py` builds; open the built page in Chrome (light/dark, 400 px width), carousel with 3
  slides and keyboard tabs; no broken anchors; every claim matches the code (MANAGED_KINDS, listing data sent,
  defaults: listing on, discovery off, xo hold).
- bio-ui: `npm run build` (tsc + vite) passes; view locally at 400 px and desktop.
- No deploy until release; copy review by the user with screenshots.

## Out of scope
New screenshots of X (the `shots/` are real ones of @XBToshi); og.png; store listings.
