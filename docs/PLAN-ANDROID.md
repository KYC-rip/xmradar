# PLAN-ANDROID: XMRadar on Android & GrapheneOS (AMO Android + Standalone GeckoView App)

## Goal
Ship XMRadar from one codebase across three targets:
1. **Chrome Web Store** (Chromium MV3 — unchanged, zero regressions).
2. **Firefox Add-ons (AMO)** — Desktop **and** Firefox for Android / IronFox / Fennec (`gecko_android >= 140.0`).
3. **Standalone GrapheneOS / Android App (`rip.kyc.xmradar`)** — a thin Kotlin + **Mozilla GeckoView** app that bundles `output/firefox-mv3/` as a built-in WebExtension and opens straight into `https://x.com`, so GrapheneOS users never need the proprietary X APK.

## Distribution & F-Droid Reality
- **Official F-Droid main repository** bans prebuilt Maven artifacts from `maven.mozilla.org` (`org.mozilla.geckoview`), requiring a multi-hour build of `mozilla-central` from scratch.
- **Cloudflare Pages has a 25 MiB per-file limit**, so a ~55 MiB `geckoview-arm64-v8a` APK cannot be hosted on Pages.
- Therefore Android distribution targets:
  1. **Custom F-Droid repository hosted on Cloudflare R2** (e.g., `https://fdroid.xmradar.app/repo` backed by R2, with no 25 MiB cap; usable in F-Droid / Droid-ify / Neo Store with one repo URL + signing fingerprint) + proper F-Droid `metadata/rip.kyc.xmradar/en-US/` and `fdroiddata` recipe docs.
  2. **GitHub Releases signed APK + `SHA256SUMS` + Obtainium** (the standard GrapheneOS install/update flow).
  3. **AMO Android** for users who already run IronFox / Fennec / Firefox on Android.

---

## Part 1 — Extension Android & Mobile Readiness (`src/`, `wxt.config.ts`)

### 1.1 Manifest (`wxt.config.ts`)
- Add `gecko_android: { strict_min_version: '140.0' }` under `browser_specific_settings`.
- Keep `gecko.id: 'xmradar@local'` unchanged here (the current AMO listing ID must be checked by the maintainer before any AMO Android upload; changing `gecko.id` breaks existing extension storage). Also note `data_collection_permissions` in `PLAN-RELEASE.md:115` as a store-listing decision before AMO Android submission.
- Chrome manifest hook continues to strip `browser_specific_settings` completely.
- `sidebar_action` is unsupported on Firefox Android / GeckoView; Chat on Android opens as a tab (or dedicated Chat compartment in the standalone app).

### 1.2 Platform Capability & Compatibility Layer (`src/platform/compat.ts`)
Pure, dependency-injected helpers covering every `browser.*` namespace that is absent or partial on Android / GeckoView:
- `openExtensionPage(url, apis)`:
  - When `apis.windows?.create` exists (desktop), calls `windows.create({ url, type: 'popup', width: 520, height: 720 })` → `{ kind: 'window', id }`.
  - Otherwise (Android / GeckoView), falls back to `tabs.create({ url })` → `{ kind: 'tab', id }`.
- `closeCurrentPage(apis)`:
  - Calls `browser.tabs?.getCurrent?.()` — if running inside a tab (Android/GeckoView), closes it with `browser.tabs.remove(tab.id)`; otherwise calls `window.close()` (desktop popup/window). Fixes dead pages when `window.close()` is a no-op in a GeckoView tab.
- `safeNotify(notifications, idOrOpts, opts?)` and `safeClearNotice(notifications, id)`:
  - No-op cleanly if `notifications?.create` / `notifications?.clear` is missing or rejects.
- `safeAlarmListener(alarms, fn)` / safe `alarms` guard:
  - Tolerates missing `browser.alarms` gracefully without crashing background startup.
- `safePermissionsContains(permissions, perms)` / `safePermissionsRequest(permissions, perms)`:
  - Guards `browser.permissions` when absent (returns `false`).
- `resolveActiveSiteTabId(tabsApi, search)`:
  - Used by `popup/main.ts`: if `?tabId=<int>` was passed by the native Android shell (because in the standalone app the popup opens in its own tab), uses that tab id directly; otherwise queries `tabs.query({ active: true, currentWindow: true })`, and if that tab is an extension page, falls back to querying the active/most-recent `https://` tab.
- **Storage fallback (`src/platform/storage-compat.ts`):**
  - Before any `storage.defineItem` call executes, checks if `globalThis.browser?.storage` is missing `sync` or `session` (partial GeckoView/mobile environments) and installs a safe shim delegating missing `sync` or `session` area calls to `browser.storage.local` under a namespaced prefix (`__sync_fallback__:` / `__session_fallback__:`), keeping desktop browsers completely untouched.
  - Note: On Firefox Android / GeckoView 140+, `storage.sync` exists locally (just unsynced) and `storage.session` exists, so this shim only activates if an environment lacks them, preventing a hard startup crash.

### 1.3 Desktop-Only API Guards & Security Tightening
1. **`browser.contextMenus`** (`src/entrypoints/background.ts`):
   - Guard `onInstalled` menu creation and `onClicked.addListener` behind `if (browser.contextMenus)`.
   - Also pass `frameId: 0` when delivering `open-tip` on x.com so `openTip` always runs in the top frame.
2. **`browser.commands`** (`src/entrypoints/background.ts`):
   - Guard `browser.commands?.onCommand?.addListener(...)`.
3. **`browser.windows`** (`background.ts`, `popup/main.ts`, `options/main.ts`, `sidepanel/main.ts`):
   - `src/siwm/service.ts`: change `SiwmEntry` to track a tagged target `{ kind: 'window' | 'tab'; id: number }` (preserving backward-compatible `windowClosed(windowId)` and adding `tabClosed(tabId)`).
   - `background.ts`: guard `browser.windows?.onRemoved?.addListener(...)`; wire `tabs.onRemoved` to `siwm.tabClosed(tabId)`.
   - `popup/main.ts`: guard `browser.windows?.getCurrent?.()` so `#chat-open` immediately enables on Android; use `openExtensionPage` for `#siwm-open`; use `closeCurrentPage` instead of bare `window.close()`; use `resolveActiveSiteTabId` for `#this-site`.
   - `options/main.ts`: use `openExtensionPage` for `#siwm-paste`; guard `browser.permissions?.contains` / `request`.
   - `sidepanel/main.ts`: guard `browser.windows?.onFocusChanged?.addListener(refresh)`.
   - `siwm/main.ts`: use `closeCurrentPage` for `close`.
4. **`browser.notifications`, `browser.alarms`, `browser.action`, `tabs.captureVisibleTab`**:
   - Guard `browser.notifications?.onClicked?.addListener(...)`, `create`, `clear` via `src/platform/compat.ts`.
   - Guard `browser.alarms?.onAlarm?.addListener(...)`.
   - `src/update/badge.ts`: accept `BadgeAction | null | undefined` and guard `if (!action) return` + optional chaining on `setBadgeText`, `setBadgeBackgroundColor`, `setTitle`.
   - `background.ts`: `captureVisibleTab` already checks `!browser.tabs?.captureVisibleTab`; additionally wrap `captureVisibleTab` errors gracefully so quote-shot falls back cleanly without breaking post copying on GeckoView.
5. **Tighten `isXContentScript` (`src/sender.ts`, `src/entrypoints/background.ts`)**:
   - Replace loose `isXUrl(sender.url) || isXUrl(sender.tab?.url)` with pure `isXTopFrameSender(sender, runtimeId)` requiring `sender.id === runtimeId && sender.frameId === 0 && isXUrl(sender.url) && isXUrl(sender.tab?.url)`.
   - Prevents third-party iframes/ads embedded in an X tab from invoking `ai-write` (user's API key), `resolve-handles`, `xap-post-totals`, `xmr-price`, or `x-claims-seen`.

### 1.4 Mobile Responsive UI
- `src/entrypoints/popup/style.css`: add `@media (max-width: 480px), (pointer: coarse)` so `html, body` use `width: 100%; height: 100dvh;` instead of fixed `340px × 560px`.
- `src/entrypoints/content/style.css`: `max-height: calc(100dvh - 24px)` on `.dialog` and `min-height: 40px` touch-friendly buttons on `@media (pointer: coarse)`.

---

## Part 2 — Standalone GrapheneOS / Android App (`android/`)

### 2.1 Project, Versions & Reproducible-Friendly Build
- Directory: `android/` (Gradle 8.14.3 Kotlin DSL, AGP 8.9.1, Kotlin 2.1.20, Java 17 target).
- Application ID: `rip.kyc.xmradar` (GPL-3.0-or-later).
- SDK targets: `compileSdk = 36`, `targetSdk = 35`, `minSdk = 26`.
- **Pinned GeckoView:** `org.mozilla.geckoview:geckoview-arm64-v8a:151.0.20260608154138` from `https://maven.mozilla.org/maven2/`. (Pinned exact version compatible with AGP 8.9.1 / Android API 36; update cadence documented in `android/FDROID.md` because Gecko security fixes require cutting a new APK).
- **`versionCode` scheme:** monotonic integer derived from `package.json` semver + optional build number: `major * 1_000_000 + minor * 10_000 + patch * 100 + buildOffset` (e.g., `0.6.17` → `61700`, `0.6.17` build 1 → `61701`). `versionName` read directly from `../package.json`.
- Zero Google Play Services, zero Firebase, zero analytics, zero crash reporting.
- **Asset sync (`syncExtensionAssets`):**
  - Declared with proper Gradle `inputs.dir("../output/firefox-mv3")` and `outputs.dir("src/main/assets/xmradar")`.
  - Computes a deterministic SHA-256 of the copied extension bundle and exposes it as `BuildConfig.EXTENSION_SHA256`.
  - Provides an optional `-PbuildExtension=true` (or `prebuild` script) that runs `pnpm install --frozen-lockfile && pnpm wxt build -b firefox` from a clean checkout, and otherwise fails with a clear message if `../output/firefox-mv3/manifest.json` is absent.
- **AMO `sources.zip` hygiene (`.gitattributes`):**
  - Mark `android/ export-ignore` and `metadata/ export-ignore` in `.gitattributes` so `git archive HEAD` in `scripts/build-release.sh` keeps `xmradar-*-sources.zip` focused on the Firefox extension sources for AMO review (no Android Gradle/Kotlin clutter).

### 2.2 Built-In Extension Lifecycle & MV3 Host Permissions
- **Install / upgrade logic:**
  - Compare stored `ext_sha256` in `SharedPreferences` against `BuildConfig.EXTENSION_SHA256`.
  - If missing or changed (first install OR any APK update that touched extension JS/CSS, regardless of whether manifest `version` changed), call `runtime.webExtensionController.installBuiltIn("resource://android/assets/xmradar/")`.
  - If unchanged on normal boot, call `runtime.webExtensionController.ensureBuiltIn("resource://android/assets/xmradar/", "xmradar@local")`.
- **MV3 `<all_urls>` host permission grant (critical):**
  - Register `WebExtensionController.PromptDelegate` on `runtime.webExtensionController`:
    - Only auto-allow `onOptionalPrompt` / `onInstallPromptRequest` / `onUpdatePrompt` when `extension.id == "xmradar@local"` (deny any unexpected extension ID).
  - Immediately after `installBuiltIn` / `ensureBuiltIn` resolves, call `runtime.webExtensionController.addOptionalPermissions("xmradar@local", emptyArray(), arrayOf("<all_urls>"), emptyArray())` so content scripts, `declarativeNetRequest`, and the swap guard are active on first launch without requiring `about:addons`.
- Store `extension.metaData.baseUrl` (the `moz-extension://<uuid>/` origin) in memory for opening `popup.html`, `options.html`, `setup.html`, and enforcing own-origin checks in `NavigationPolicy`.
- Register delegates:
  - `WebExtension.TabDelegate` (`onNewTab`, `onCloseTab`, `onUpdateTab`) wired to the app's session manager.
  - `WebExtension.ActionDelegate` (`onBrowserAction`) updating the native XMRadar button's badge indicator.

### 2.3 Cookie-Jar Isolation (`contextId`) & Multi-Session Shell
To prevent cross-site cookie/storage sharing between X and other sites, `GeckoSession` instances use **GeckoView Contextual Identities (`GeckoSessionSettings.Builder().contextId(...)`)**:
1. **`x` compartment (`contextId = "x"`)**: persistent `https://x.com/home` session. Only X hosts (`x.com`, `twitter.com`, `twimg.com`) + X login auth flows (scoped) + own `moz-extension://` are allowed here.
2. **`chat` compartment (`contextId = "chat"`)**: `https://chat.xmr.club/?room=x` — completely isolated cookies/localStorage from X.
3. **`swap` compartment (`usePrivateMode(true)`)**: ephemeral private session for user-opened swap/ecosystem sites (`xmr.club`, `xmr.bio`, or a user-entered HTTPS swap URL via the **Open URL** dialog). Zero cookies shared with X, cleared when closed.
4. **`ext` compartment (`contextId = "ext"`)**: XMRadar extension pages (`popup.html?tabId=...`, `options.html`, `setup.html`, `siwm.html`, `guard.html`). `popup.html` receives the active site tab's ID via query string so `#this-site` inspects the right tab!

Full-bleed `GeckoView` with a draggable, edge-snapping floating XMRadar radar orb (avoiding a double bottom bar over X's own tab bar). Tapping the orb opens a Material3 BottomSheet with:
- **X** (focuses `x` session)
- **XMRadar menu** (opens `popup.html?siteUrl=...` with active X/swap context; live action badge shown on the orb)
- **Chat** (focuses `chat` session)
- **Swap** (opens HTTPS URL dialog → launches in private `swap` session with Swap Guard active)
- **Options** (opens `options.html`)
Long-pressing the orb quick-toggles between X and the XMRadar menu.

Also wired on every session:
- `ContentDelegate`: `onCloseRequest` (closes secondary session cleanly), `onFullScreen`, `onExternalResponse` (downloads / `<a download>` for SIWM message save & receipt/letter exports via Android `ACTION_CREATE_DOCUMENT` or Downloads).
- `PromptDelegate`: alert, confirm, prompt, choice, and `onFilePrompt` backed by `ActivityResultLauncher` so X photo uploads work.
- `PermissionDelegate`: denies location/mic/camera by default; prompts via Android runtime permission only when user explicitly triggers media capture.

### 2.4 Default-Deny Security & Navigation Policy (`NavigationPolicy.kt`)
Pure Kotlin policy enforced identically in **both** `NavigationDelegate.onLoadRequest` (including `isRedirect`) **and** `NavigationDelegate.onNewSession` (`window.open` / `target=_blank`):
- **Default decision:** `DENY` for any unknown scheme or unlisted host.
- **Explicitly blocked schemes:** `javascript:`, `intent:`, `file:`, `content:`, `data:`, `blob:`, `filesystem:`, `ws:`, `wss:`, `tel:`, `sms:`, `geo:`, `market:`, `http:` (HTTPS-Only).
- **No `t.co` in-app:** `t.co` is **NOT** in the in-app allowlist — clicking a `t.co` link on X hands it straight to the system browser (Vanadium on GrapheneOS) via `ACTION_VIEW` with zero X cookies and zero `Referer`, preventing open-redirect cookie-jar leaks.
- **No `nostrsigner:` auto-dispatch:** Removed until Phase 2b (NIP-55 native bridge). Web pages cannot fire `nostrsigner:` intents.
- **`monero:` URI handling (hardened):**
  - Requires `hasUserGesture == true` (in `onLoadRequest`) AND a strict parser (`MoneroUriParser.kt`): validates mainnet Monero address (95-char standard/subaddress starting `4`/`8`, or 106-char integrated starting `4`, Base58 alphabet only) and optional safe query params (`tx_amount` numeric, `tx_description` / `recipient_name` plain text ≤ 200 chars). Rejects malformed/control-char URIs.
  - Shows a **native Android confirmation dialog** displaying the parsed recipient address (highlighted first/last 12 chars + full address) and amount before launching `Intent.createChooser(Intent(ACTION_VIEW, uri), ...)`! Never auto-launches silently.
- **`mailto:`:** Requires user gesture; opens via `Intent.createChooser`.
- **In-app HTTPS allowlist (per compartment):**
  - `x` compartment: exact/subdomain match on `x.com`, `twitter.com`, `twimg.com`, plus explicitly scoped login/auth challenge hosts needed for X sign-in (`accounts.google.com`, `appleid.apple.com`, `arkoselabs.com`, `funcaptcha.com`, `cloudflare.com` challenges — only on `x` login/auth flows or documented auth allowlist).
  - `chat` compartment: `chat.xmr.club`.
  - `swap` compartment: `xmr.club`, `xmr.bio`, `nkips.org`, `kyc.rip`, `xmradar.app`, plus the exact host explicitly typed by the user in the **Swap / Open URL** dialog.
  - Own extension origin: `moz-extension://<own-uuid>/` ONLY (foreign `moz-extension://` denied; web content cannot navigate top-level to `popup.html` or `options.html` except `guard.html` redirect from DNR).
  - `about:blank`: allowed only for initial/new session bootstrap.
- **All other `https://` URLs (including `t.co`):** Denied in GeckoView and opened in the system browser (Vanadium) via `ACTION_VIEW` when `hasUserGesture == true` (silently denied if background/non-gesture redirect!).

### 2.5 Android & GeckoView Hardening
- `AndroidManifest.xml`:
  - `android:allowBackup="false"`
  - `android:fullBackupContent="@xml/backup_rules"` (API 26–30, excludes all)
  - `android:dataExtractionRules="@xml/data_extraction_rules"` (API 31+, disables cloud & device-transfer)
  - `android:usesCleartextTraffic="false"`
  - `MainActivity`: `android:exported="true"` with ONLY `ACTION_MAIN` / `CATEGORY_LAUNCHER` intent-filter; ignores any incoming `intent.data` so external apps cannot push URLs into the trusted session.
  - Permissions: `INTERNET`, plus `POST_NOTIFICATIONS` (opt-in runtime permission on Android 13+ for live XMRadar Xap/xo notifications via `browser.notifications` and allowlisted X / Chat PWA web notifications via GeckoView `WebNotificationDelegate` — zero Google Play Services / zero FCM).
- `GeckoRuntimeSettings`:
  - `allowInsecureConnections(GeckoRuntimeSettings.HTTPS_ONLY)`
  - `crashHandler(null)`
  - `telemetryDelegate(null)`
  - `experimentsDelegate(null)`
  - `aboutConfigEnabled(false)`
  - `remoteDebuggingEnabled(BuildConfig.DEBUG)`
  - `consoleOutput(BuildConfig.DEBUG)`
- Reproducibility note: APKs use deterministic packaging options where supported (`includeInApk = false` for dependency metadata); exact byte-for-byte APK reproducibility depends on signing key/zipalign and is stated honestly in `android/FDROID.md` (signed APK + SHA256SUMS + open CI build logs).

### 2.6 Packaging, F-Droid Metadata & CI
- `metadata/rip.kyc.xmradar/en-US/`: `summary.txt`, `description.txt`, `changelogs/61700.txt` (F-Droid native metadata format), plus `android/FDROID.md` documenting R2-hosted custom F-Droid repo setup, anti-features (`NonFreeNet` for X / xmr.bio / xmr.club), GeckoView update cadence, `versionCode` mapping, and Obtainium config.
- `.github/workflows/android.yml`: SHA-pinned GitHub Actions (`checkout`, `pnpm`, `setup-node`, `setup-java` 17, `setup-android`), builds `output/firefox-mv3/`, runs `./gradlew testDebugUnitTest assembleRelease` (unsigned on PR; signed + `SHA256SUMS` on release tags when keystore secrets are present).

---

## Tests & Verification
1. **Extension unit tests (`pnpm compile`, `pnpm build`, `pnpm test`)**:
   - `tests/android-compat.test.ts`:
     - Built Firefox manifest has `browser_specific_settings.gecko_android.strict_min_version = '140.0'`; Chrome manifest omits `browser_specific_settings`.
     - `openExtensionPage` (desktop window vs Android tab fallback) & `closeCurrentPage` (tab removal vs `window.close()`).
     - `resolveActiveSiteTabId` (explicit `?tabId=`, active non-extension tab, extension-tab fallback).
     - `siwmService`: cleans up window-backed entries on `windowClosed` and tab-backed entries on `tabClosed`.
     - `safeNotify`, `safeClearNotice`, `setTabBadge`, `setGlobalBadge`: tested with `undefined` and throwing APIs.
     - `storage-compat`: tested with `browser.storage.sync === undefined` and `browser.storage.session === undefined` falling back cleanly to `local`.
     - `isXTopFrameSender`: rejects subframe (`frameId: 1`) even when `tab.url` is `https://x.com/home`, rejects non-X origin, accepts top-frame X sender.
     - Static capability audit test across `src/entrypoints/{background,popup/main,options/main,sidepanel/main}.ts` verifying no unguarded desktop-only calls (`contextMenus`, `commands`, `windows`, `notifications`, `alarms`, `permissions`).
2. **Android JVM unit tests (`./gradlew testDebugUnitTest`)**:
   - `NavigationPolicyTest.kt`: default-deny on unknown schemes, `t.co` → external browser, `monero:` gesture + validation, `nostrsigner:` → denied, blocked schemes (`javascript:`, `intent:`, `file:`, `content:`, `data:`, `blob:`, `http:`), compartment isolation (`x` vs `chat` vs `swap`), own vs foreign `moz-extension://`, `onNewSession` & redirect enforcement, user-entered swap host scoping.
   - `MoneroUriParserTest.kt`: valid mainnet primary/subaddress/integrated addresses, invalid checksum/length/prefix, amount validation, control-character rejection.
3. **Live emulator test (`emulator-5554`, `arm64-v8a`, Android 15 / API 35)**:
   - Build Firefox extension (`pnpm build`) + Android debug APK (`./gradlew assembleDebug`).
   - Install via `adb install -r`, launch `rip.kyc.xmradar`.
   - Verify via `adb logcat`: `xmradar@local` installed, `<all_urls>` optional permission granted, ZERO uncaught exceptions in `background.js`, `https://x.com` loads, bottom bar switches cleanly between X, XMRadar Popup, Chat, Swap, Options, and `monero:` confirmation dialog renders cleanly.
   - Capture screenshots via `adb exec-out screencap -p` for visual confirmation.

## Out of Scope
- Official F-Droid main-repo `mozilla-central` source compilation recipe.
- Updating `xmradar.app` portal with APK/F-Droid links (wait until first signed release APK and manual confirmation).
- Pushing to remote or deploying without manual confirmation.

---

## Part 3 — Phase 2b: Native Android Nostr Signer (NIP-55 / Amber) & Zero-Flash Signing

### 3.1 Eliminating `xmradar.app/signer` & Fixing Tab/Focus Lifecycle
- On desktop browsers, `background.ts` opens `https://xmradar.app/signer` in a throwaway tab to reach a NIP-07 browser extension (`window.nostr`). Inside the standalone Android app (`rip.kyc.xmradar`), NIP-07 browser extensions do not exist, so opening `xmradar.app/signer` visibly hijacks GeckoView for 3 seconds (`30 × 100ms` polling) before failing.
- Fix:
  1. **Zero `xmradar.app/signer` in standalone Android:** when `background.ts` probes the native GeckoView bridge (`xmradar_android`) and learns `androidApp === true`, `background.ts` **never opens `https://xmradar.app/signer` at all** (not even hidden).
     - If an Android NIP-55 signer app (e.g., **Amber**) is installed, signing routes directly through NIP-55.
     - If no NIP-55 app is installed, `signerPubkey` / `signerSign*` immediately throws `NoSignerError`, so `bySignerMode` falls back instantaneously to XMRadar's built-in managed Nostr identity (`IndexedDB`) with zero page flash and zero network trip to `xmradar.app/signer`.
  2. **Tab focus & compartment fixes in `MainActivity.kt`:**
     - `closeTab(entry)`: ONLY refocus a fallback tab when `entry == activeTab` (`wasActive`). Fixes popup launchers (`Your tip badge`, `Badges on X`, `SIWM`, `All settings`), which call `tabs.create(setup.html)` followed immediately by `tabs.remove(popupTab)` — previously `closeTab(popupTab)` clobbered the newly focused `setup.html` tab and jumped back to X.
     - `TabDelegate.onNewTab`:
       - Only focus the new tab when `createDetails.active != false` (an `active == false` tab must NEVER steal focus).
       - Classify `url == null` or `about:blank` as `Compartment.EXTENSION` (NOT `Compartment.SWAP`), so `tabs.create({})` followed by loading an extension page runs in the default extension context rather than private Swap mode.

### 3.2 GeckoView Native Messaging Channel (`xmradar_android`)
- **Zero permission bloat on Chrome & AMO:**
  - `wxt.config.ts` stays untouched (`output/chrome-mv3/` and `output/firefox-mv3/` do NOT gain `geckoViewAddons` or `nativeMessaging`).
  - `android/app/build.gradle.kts` (`syncExtensionAssets`) parses the copied `android/app/src/main/assets/xmradar/manifest.json` as JSON (`JsonSlurper` / `JsonOutput`), appends ONLY `"geckoViewAddons"` and `"nativeMessaging"` (NEVER `"nativeMessagingFromContent"`), preserves `browser_specific_settings.gecko_android`, and computes `ext-sha256.txt` **after** patching. Unit-tested to verify Chrome/AMO manifests are untouched and Android asset manifest gains only those two permissions.
- **Android Manifest (`AndroidManifest.xml`):**
  - Add `<queries>` for `nostrsigner:` (both with and without `CATEGORY_BROWSABLE`) so Android 11+ `queryIntentActivities` detects Amber and any NIP-55 signer without `QUERY_ALL_PACKAGES`:
    ```xml
    <queries>
        <intent>
            <action android:name="android.intent.action.VIEW" />
            <category android:name="android.intent.category.BROWSABLE" />
            <data android:scheme="nostrsigner" />
        </intent>
        <intent>
            <action android:name="android.intent.action.VIEW" />
            <data android:scheme="nostrsigner" />
        </intent>
    </queries>
    ```
  - Web content STILL cannot navigate to `nostrsigner:` (`NavigationPolicy.kt` keeps `nostrsigner:` strictly DENIED).
- **Strict background-only sender check (`MainActivity.kt`):**
  - Register `ext.setMessageDelegate(nativeBridgeDelegate, "xmradar_android")` inside `attachExtensionDelegates(ext)`.
  - Reject any message unless `nativeApp == "xmradar_android" && sender.webExtension.id == EXT_ID && sender.environmentType == ENV_TYPE_EXTENSION && sender.session == null`. Requiring `sender.session == null` restricts the bridge strictly to the extension **background script** (blocking content scripts AND visible extension pages including `guard.html`).

### 3.3 NIP-55 Protocol & Security Hardening (`Nip55Bridge.kt`)
Pure, unit-testable Kotlin module (`Nip55Bridge.kt` + `Nip55BridgeTest.kt`) handling kind allowlists, Bech32 `npub` decoding, intent construction, and response parsing:
1. **Split event kind allowlists (defense-in-depth on native side):**
   - `IDENTITY_KINDS = { 0, 5, 17, 9042, 9044, 10002, 10011, 10133, 27235 }` (matches `MANAGED_KINDS` in `src/identity/managed.ts`).
   - `COMPOSER_KINDS = { 1, 24242, 30023 }` (matches `ALLOWED_KINDS` in `src/bridge.ts`).
   - Any kind outside `IDENTITY_KINDS ∪ COMPOSER_KINDS` is rejected natively.
   - `get_public_key` `permissions` JSON requests ONLY `IDENTITY_KINDS` (`[{"type":"sign_event","kind":N}, ...]`), NEVER `COMPOSER_KINDS` — so posts, articles, and Blossom auth are never silently pre-authorized.
   - For `COMPOSER_KINDS`, the native bridge ALWAYS skips `ContentResolver` and requires foreground interactive approval in the signer app.
2. **Anti-spoofing package pinning:**
   - Never trust the response `Intent`'s `package` string as proof of signer identity.
   - Instead, enumerate installed `nostrsigner:` handlers via `PackageManager.queryIntentActivities` (excluding self). If 1 handler is installed, pin that exact `activityInfo.packageName`; if multiple are installed, show a native Android picker dialog listing each app's label and package name. Explicitly call `intent.setPackage(chosenPackage)` on BOTH `get_public_key` and `sign_event`, and persist `chosenPackage` in `SharedPreferences` only after `RESULT_OK`.
3. **Requests:**
   - `{ "type": "probe" }` → `{ "androidApp": true, "nip55Available": Boolean, "signerPackage": String? }` (always queries `PackageManager` live so installing/removing Amber takes effect without restarting).
   - `{ "type": "get_public_key" }`:
     - If no NIP-55 handler installed → `{ "noSigner": true, "error": "No Android Nostr signer (e.g. Amber) installed" }`.
     - Serialized interactive `ActivityResultLauncher` (rejects concurrent interactive requests cleanly rather than clobbering callbacks).
     - Accepts 64-char lowercase hex OR Bech32 `npub1...` (verified & decoded to 64-hex in pure Kotlin `Nip55Bridge.kt`).
     - `RESULT_CANCELED` or `rejected == true` returns `{ "error": "..." }` WITHOUT `noSigner: true` (so `bySignerMode` never replaces an explicit user refusal with a managed key).
   - `{ "type": "sign_event", "event": { kind, content, tags, created_at }, "pubkey": "<64-hex>" }`:
     - Validates event schema, kind allowlist, and 64-hex `pubkey`.
     - For `IDENTITY_KINDS` with a pinned, still-installed `signerPackage`: first tries NIP-55 `ContentResolver` on a background executor thread (`content://$signerPackage.SIGN_EVENT`, projection `[eventJson, "", pubkey]`), wrapped in `try/catch (SecurityException | IllegalArgumentException | IllegalStateException)` with `cursor.use { ... }`.
       - If cursor has `rejected` column → returns explicit refusal error immediately (NEVER falls back to Intent).
       - If cursor returns valid `event` JSON (or 128-hex `result`/`signature` when `event` is absent) → returns `{ "event": JSONObject }` or `{ "sig": "<128-hex>" }`.
     - If ContentResolver returns null/empty (or kind is in `COMPOSER_KINDS`): launches interactive `Intent(ACTION_VIEW, Uri.parse("nostrsigner:" + Uri.encode(eventJson)))` targeted explicitly via `setPackage(pinnedPackage)` with `type = "sign_event"`, `current_user = pubkey`, and `id = reqId`.
     - Verifies echoed `id` (if returned by signer) matches `reqId`; parses `event` JSON (or 128-hex `result`/`signature` fallback); extension still enforces `checkSigned(template, event, pubkey)` (BIP-340 Schnorr signature + exact template + pubkey equality).
   - `{ "type": "clear_signer" }`: clears cached `signerPackage` in `SharedPreferences`.

### 3.4 Extension Integration (`src/nostr/native-signer.ts`, `background.ts`, `composer.ts`)
- New pure module `src/nostr/native-signer.ts` (unit-tested in `tests/android-compat.test.ts`):
  - `probeAndroidSigner(runtime)`: checks `typeof runtime?.sendNativeMessage === 'function'`, calls `{ type: 'probe' }` with a 5 s timeout. Caches `androidApp === false` on desktop/AMO (zero overhead), while on Android always probes `nip55Available` live so newly installed Amber is detected immediately.
  - `nativeGetPublicKey(runtime)` (120 s timeout) and `nativeSignEvent(runtime, template, pubkey)` (120 s timeout; reconstructs signed event via `getEventHash` if a NIP-55 signer returns `{ sig }` without full `event` JSON, then caller verifies with `checkSigned`).
- `background.ts`:
  - `signerPubkey()`, `signerSignExact()`, `signerSignQuietly()` check `probeAndroidSigner`. When `androidApp === true`, route strictly through NIP-55 (or throw `NoSignerError` immediately if `!nip55Available`) — never calling `withSignerTab`.
  - **Copy to Nostr (`composer.ts`):** preserves XMRadar's strict `MANAGED_KINDS` guarantee ("XMRadar's built-in identity never signs your posts"). When `androidApp === true`, `openComposer` sets `useBackgroundSigner: true` on `OpenComposerMsg`; `composer.ts` calls session-authenticated (`checkSessionSender`) `composer-pubkey` and `composer-sign` handlers restricted to `COMPOSER_KINDS = [1, 24242, 30023]` and routed **exclusively** to the NIP-55 signer (Amber) — never falling back to `managedIdentity`. If no NIP-55 app is installed, the composer shows a clear message to install Amber.
- `metadata/rip.kyc.xmradar/en-US/description.txt`: honestly states that Monero identity / Xaps / xos work out of the box (with built-in key or Amber NIP-55) and Copy-to-Nostr works with an external NIP-55 signer such as Amber.

---

## Amendment after Claude Plan Review Round 2 (7/10) — all 12 items resolved
1. **Full Monero Keccak-256 Base58 checksum (`MoneroUriParser.kt`):** Pure Kotlin port of `src/xmr/address.ts` (Monero 8-byte-block Base58 decode + network prefix 18/42/19 + Keccak-256 4-byte checksum verification). Unit-tested with a real mainnet address and a single-bit checksum flip.
2. **Live emulator proof of `<all_urls>` grant:** `WebExtensionController.PromptDelegate` + `addOptionalPermissions("xmradar@local", emptyArray(), arrayOf("<all_urls>"), emptyArray())` will be verified live on `emulator-5554` by asserting `browser.permissions.contains({ origins: ['<all_urls>'] }) === true` in logs. If GeckoView declines it for `host_permissions`, fall back cleanly to manifest/optional permission handling.
3. **App-created `GeckoSession` ↔ WebExtension tab identity:** Call `runtime.webExtensionController.setTabActive(session, true/false)` when switching compartments so GeckoView exposes the active session to `browser.tabs.query({ active: true })`. When opening `popup.html`, pass `?tabId=` if known and fall back in `resolveActiveSiteTabId` to the active non-extension `https://` tab so `#this-site` always inspects X or the active swap site rather than the popup tab itself.
4. **Exact GeckoView 161 builder APIs:** Use `experimentDelegate(null)`, `crashHandler(null)`, `aboutConfigEnabled(false)`, `allowInsecureConnections(GeckoRuntimeSettings.HTTPS_ONLY)`, `remoteDebuggingEnabled(BuildConfig.DEBUG)`, `consoleOutput(BuildConfig.DEBUG)` (verified against GeckoView 161 compiled JAR). Document GeckoView's own network behavior honestly in `android/FDROID.md`.
5. **Deterministic `EXTENSION_SHA256` without Gradle ordering bug:** `syncExtensionAssets` computes the SHA-256 of the copied `assets/xmradar/` tree and writes `assets/xmradar/ext-sha256.txt` (no leading dot, since Android AAPT strips dotfiles from `assets/`). At runtime `MainActivity` reads `assets.open("xmradar/ext-sha256.txt")` to decide between `installBuiltIn` (first boot or changed bundle) and `ensureBuiltIn` (unchanged boot).
6. **Private `swap` session extension access:** Call `runtime.webExtensionController.setAllowedInPrivateBrowsing(extension, true)` after install so Swap Guard and receipt/letter verification run inside the ephemeral private `swap` compartment.
7. **Storage compat verified on real `@wxt-dev/storage`:** Patch the actual `browser.storage` binding WXT imports (`wxt/browser`), delegating missing `sync` → `local` (prefixed) and missing `session` → in-memory `Map` (never persisting guard tokens / SIWM challenges across app restarts). Unit-tested directly through `wxt/utils/storage`.
8. **`installBuiltIn` upgrade verification:** Verified on `emulator-5554` by testing asset replacement when `.ext-sha256` changes.
9. **AMO `data_collection_permissions`:** Flagged explicitly for maintainer sign-off before submitting an AMO Android update (do not silently alter the live AMO listing's `gecko.id` or permission declarations without maintainer confirmation).
10. **Copy-to-Nostr honesty on Android:** Android F-Droid metadata (`metadata/rip.kyc.xmradar/en-US/description.txt`) does not advertise Copy-to-Nostr as live in v1; explicitly notes it awaits Phase 2b (NIP-55 Amber bridge).
11. **Scoped X login/auth allowlist:** Auth/challenge hosts (`accounts.google.com`, `appleid.apple.com`, `arkoselabs.com`, `funcaptcha.com`) are allowed ONLY while the X session is actively in a login/auth flow (`/i/flow/login`, `/login`, `/account/access`, `/i/flow/signup` or user-initiated login mode), never globally during normal timeline browsing.
12. **Default context for extension pages:** Extension pages (`popup.html`, `options.html`, `setup.html`, `siwm.html`, `guard.html`) run in GeckoView's default context (`contextId = null`) so they share IndexedDB (`managedIdentity`) and extension storage seamlessly with the background script. Only `x` (`contextId = "x"`), `chat` (`contextId = "chat"`), and `swap` (`usePrivateMode(true)`) are partitioned.
