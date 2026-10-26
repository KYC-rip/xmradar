# PLAN-RELEASE: CI, verifiable release zips, build info, landing privacy section

> Implemented (plan review 7.4, code review 8.0). Where this plan and the code differ, the code and README "Releases" win. Review changes made after it: the build refuses untracked *and* ignored files under `src/` and `public/` (other untracked files are fine); the outdir must be a plain path under `dist/`; the Docker check uses `ubuntu:24.04` (README); release notes give the bare asset name for `gh attestation verify`; a rerun deletes the old assets before uploading.

Source: design bundle update (handoff/README.md §8, handoff/ci/, XMRadar Landing.dc.html). The rest of that update (Swap by kyc.rip, NKIP-0002 kinds 9043/9044) belongs to R3/R4 and is only recorded in PLAN-REDESIGN.md here.

No store uploads yet. Until there are store listings, users install the GitHub release zips: Chrome via "Load unpacked", Firefox via about:debugging (temporary) or Developer Edition/Nightly with signing off.

## 1. Files copied from handoff/ci, with these changes

- `.nvmrc` = `24`. `package.json` gets `"packageManager": "pnpm@10.33.2"` (pnpm/action-setup reads it).
- `scripts/build-release.sh <outdir>` (executable):
  - Output goes under `dist/`, which is ignored: `dist/` by default, `dist/a` and `dist/b` in the CI double build. `.gitignore` gets `dist/`.
  - **Dirty-tree check:** the script fails if `git status --porcelain --untracked-files=no` is not empty. Tracked changes would make the source zip (`git archive HEAD`) differ from the built code. Untracked files (local notes, `dist/`) don't affect the build or `git archive`, so they're allowed. This is what lets Build B run after Build A.
  - **Timestamps:** `touch -d @epoch` is GNU-only, so the script uses `touch -h -t <CCYYMMDDhhmm.SS>`, computed in UTC by `node -e`.
  - **Checksums:** the script writes `SHA256SUMS` into `<outdir>` using `sha256sum` if present, else `shasum -a 256`, with the same line format.
  - **Node version:** the script prints `node -v` and `zip -v | head -2`, and warns (doesn't fail) when Node's major version differs from `.nvmrc`.
  - **Zip names:** `xmradar-<version>-{chrome,firefox,sources}.zip`.
- **Which build counts:** the canonical build is CI's: Ubuntu 24.04, Node from `.nvmrc`, Info-ZIP. A local rebuild proves the zips are reproducible only on the same OS, Node and zip tool. The README says so and gives the Docker one-liner (`docker run --rm -v "$PWD":/w -w /w node:24 …`) for checking a release byte for byte. On macOS, local zips are for installing, not for matching CI hashes.
- `.github/workflows/ci.yml`:
  - compile and test on every push to main and every PR.
  - **reproducible job:** Build A into `dist/a`, then `git clean -xdf -e dist/` and a fresh install, then Build B into `dist/b`, then `diff dist/a/SHA256SUMS dist/b/SHA256SUMS`. The file names inside are identical because they're relative.
  - **Local check already done:** two `wxt build` runs of the current tree gave identical hashes for all 50 output files.
- `.github/workflows/release.yml`:
  - Runs on a `vX.Y.Z` tag.
  - **Checks before building:** the tag must equal `package.json`'s version, and the commit must be on `origin/main` (`fetch-depth: 0`).
  - **Build:** compile and test, then build with `WXT_BUILD_NUMBER=run_number`, `WXT_COMMIT=github.sha` and `WXT_RELEASE_URL`.
  - **Attestation** runs only when `github.event.repository.visibility == 'public'`. KYC-rip is on the free plan, and private repos can't use artifact attestations.
  - **Release notes:** written to `dist/NOTES.md` by a shell step. The step always gives the commit, the run, SHA256SUMS and how to rebuild. It adds the `gh attestation verify dist/xmradar-<v>-chrome.zip -R KYC-rip/xmradar` line only when the repo is public.
  - **Rerunnable:** if `gh release view $TAG` succeeds, the step uploads with `gh release upload --clobber`. Otherwise it runs `gh release create --notes-file dist/NOTES.md`. A rerun after a partial failure therefore finishes the same release; the build number changes, and the notes say which run made the files.
  - **Store uploads:** the commented-out steps use the versioned zip paths.
  - **Permissions:** `contents: write`. `id-token`/`attestations: write` are scoped to the job and needed only for the attestation step. `environment: release` stays; adding a required reviewer is a repo setting for the owner.
- **Pinning:** every action is pinned to a full commit SHA, with the tag in a comment. `.github/dependabot.yml` covers github-actions and npm, weekly.
- **`wxt.config.ts`:**
  - Manifest `version` is `<pkg.version>.<build>` when `WXT_BUILD_NUMBER` is set (1–5 digits, else the build throws), and `pkg.version` otherwise.
  - `package.json` is read with `readFileSync` + `JSON.parse`.
  - Bad `WXT_COMMIT` values (not 40 hex) and bad `WXT_RELEASE_URL` values (not `https://github.com/KYC-rip/xmradar/releases/tag/…`) make the build throw. Unset is fine (dev build).

## 2. Build info in the UI

- **`src/build-info.ts`:** `buildInfo({version, build, commit, url})` returns `{label, url | null}`.
  - CI: label `v0.1.0 · build 142 · a1b2c3d`.
  - Dev: `v0.1.0 · dev build`, no url.
  - The version comes from `browser.runtime.getManifest().version` (first 3 parts). Build, commit and url come only from `import.meta.env.WXT_*`.
  - A bad value is ignored instead of shown: a non-hex commit, or a url that isn't a KYC-rip release.
- **Options:** a `#build-info` line in the sidebar note, linking with `target=_blank rel=noopener`.
- **Popup:**
  - The footer stays one row (signer line, All settings).
  - The build label goes in the "All settings" button's `title`, so it's shown on hover and doesn't take space.
  - The options page is the visible place for it, one click away.
  - A layout test checks the popup footer has no new element. The `title` is set from `buildInfo`.
- **Tests:** `buildInfo` for CI, dev, a bad commit and a bad url, plus a markup test for both slots.

## 3. Local zips now

Run `scripts/build-release.sh dist` on the committed tree. It's a dev build with no build number. Then check:

- Chrome: unzip, then load unpacked.
- Firefox: about:debugging, Load Temporary Add-on, the zip.

Give the user the paths and the SHA256SUMS. No GitHub release is cut by hand. The first real release is a `v0.1.0` tag, pushed by the owner or by me when asked.

## 4. Landing page: data and privacy

The landing page (`XMRadar Landing.dc.html`) is a design file, and hosting is not part of this plan. It gets a "Data and privacy" section, written from the code: every `fetch`, `tabs.create`/`window.open`, `defineItem` and IndexedDB use. The existing copy that would contradict it is fixed in the same edit. This section is also the privacy policy the stores will ask for later.

**Existing copy that changes**

- The intro "It has no account and no server of its own." becomes: "No account, no analytics, no telemetry. The two kyc.rip services below are only contacted when you use their feature."
- The card "Burner mail stays local" becomes "Burner mail is yours to burn". Body: "GhostMail (run by kyc.rip) receives and stores the mail sent to your burner address until you burn it or it expires. XMRadar never sends it the page you are on."
- In the donate heading and footer, "no tracking" becomes "no analytics". Discovery, the opt-in feature that shows accounts to relays and X, is spelled out in the table.

**Table: who receives what, when, and whether it's on by default**

- **Nostr relays** (yours; or your NIP-65 list; or damus, nos.lol and primal; plus purplepag.es for reading lists):
  - Posts you choose to copy, as signed events.
  - Your public key, when reading your relay, address and identity lists.
  - Your address list (kind 10133) and identity list (kind 10011), when you publish them in setup.
  - With discovery on (off by default): the X handles of accounts on pages you view, and their pubkeys.
- **Blossom server** (default blossom.primal.net): images of posts you copy, plus a signed upload authorization (your pubkey, the image hash, a short expiry).
- **The site's image hosts:** a post's images are downloaded from where the page shows them, when you copy that post.
- **xmr.bio (api.kyc.rip):** one X handle per request, sent when you:
  - right-click "Tip with Monero" or "Look up on xmr.bio",
  - open a tip for a detected handle,
  - check your identity status (your own handle).

  Your pubkey is not sent. The proofs that come back are checked against it locally.
- **X** (publish.twitter.com oEmbed, cdn.syndication.twimg.com): a proof-tweet URL, checked during your own setup, or for badges with discovery on.
- **GhostMail (mail-api.kyc.rip):**
  - Creating an address: a proof-of-work answer (free tier) or your paid inbox token.
  - Reading and burning it: the address and its token.
  - Only when you ask for a burner. GhostMail can read the mail sent to that address, as any mail provider can.
- **Pages XMRadar opens for you:**
  - A temporary https://example.com/ tab, where your Nostr signer approves a signature. That page's own scripts can see the request and the signed event, which would be public on relays anyway.
  - The X post composer with the proof text and your npub, when you click "Post the proof tweet".
- **Everyone above** sees your IP address, like any web request.

**Stored in your browser.** Nothing leaves it except as listed above, and uninstalling removes all of it.

- Settings and badge switches, in sync storage, so your browser's sync can copy them to your other devices.
- Your public key, your X handle, the popup's last tab, and hashes of posts already copied (so a post isn't copied twice).
- Caches:
  - badges and proof checks for accounts seen with discovery on (handles, pubkeys, Monero addresses);
  - recent xmr.bio lookups (handles and times), against replays;
  - your NIP-65 relay list.
- The active burner inbox: address, tier, expiry and the ids of mail already seen. Its token is in IndexedDB.
- Until the browser closes (session storage): the last identity check, a pending setup change awaiting your signature, open composer sessions, and burner creation state.

**Never sent**

- Private keys, wallet seeds or funds (XMRadar holds none).
- Transaction ids in public events.
- Text or images from a page you didn't choose to copy. With discovery on, only the handles of accounts you view are sent.

**Firefox note** (for the later store step, not this plan): the manifest declares `data_collection_permissions: none`. Mozilla's taxonomy likely wants `websiteContent` and `personalCommunications` declared before an AMO listing. This changes the install prompt, so it's a store-step decision.

**Output:** an updated copy of the design bundle, with only `XMRadar Landing.dc.html` edited, in the scratchpad. The user's Downloads file is not touched.

## 5. Tests and checks

- tsc, vitest, `pnpm build`.
- `build-release.sh` run twice locally into `dist/a` and `dist/b`, with an untracked file present, and the two `SHA256SUMS` compared. This covers the Build B dirty-check case.
- `actionlint` if available, otherwise a YAML parse.
- The workflows are first exercised on GitHub by the push (CI) and by the first tag (release). That is stated, not claimed as tested.
