# XMRadar Android — GrapheneOS, Obtainium & Custom F-Droid Repo

## Why a custom F-Droid repo (not official F-Droid main)?
The official F-Droid repository forbids pulling prebuilt `org.mozilla.geckoview` artifacts from `maven.mozilla.org` and requires compiling `mozilla-central` from scratch. Like IronFox and other GeckoView apps, XMRadar Android ships signed `arm64-v8a` APKs built in public CI from tagged commits:

1. **GitHub Releases + Obtainium** (recommended on GrapheneOS):
   - Point Obtainium at `https://github.com/KYC-rip/xmradar` matching `xmradar-*-arm64-v8a.apk`.
   - Verify SHA-256 against `SHA256SUMS` attached to each release.
2. **Custom F-Droid repository on Cloudflare R2** (e.g. `https://fdroid.xmradar.app/repo`):
   - **Important:** Do NOT host the APK on Cloudflare Pages (Pages enforces a 25 MiB per-file limit, while a GeckoView `arm64-v8a` APK is ~55–65 MiB). Host the static `fdroidserver` output (`repo/` + `index-v2.json` + APKs) on Cloudflare R2 (or another static host without a 25 MiB cap).
   - App metadata lives in `metadata/rip.kyc.xmradar/en-US/` (`summary.txt`, `description.txt`, `changelogs/<versionCode>.txt`).
   - F-Droid AntiFeatures to declare in the repo metadata: `NonFreeNet` (connects to X, xmr.bio, xmr.club, GhostMail).

## Versioning & Signing
- `versionName` comes from `../package.json`.
- `versionCode = major * 10_000_000 + minor * 100_000 + patch * 1_000 + XMRADAR_BUILD_OFFSET` (tagged releases use `XMRADAR_BUILD_OFFSET=0` so `versionCode` matches `metadata/rip.kyc.xmradar/en-US/changelogs/<versionCode>.txt`; PR/branch builds set `XMRADAR_BUILD_OFFSET` from `github.run_number`).
- CI release signing secrets (required on tag builds; workflow fails closed if missing): `XMRADAR_KEYSTORE_BASE64`, `XMRADAR_KEYSTORE_PASSWORD`, `XMRADAR_KEY_ALIAS`, `XMRADAR_KEY_PASSWORD`. Download the signed `xmradar-android-apk` artifact and attach it to the GitHub Release (or wire `gh release upload` in `release.yml` once secrets are configured). Keep the APK signing keystore and the F-Droid repo signing key backed up offline; never rotate them between releases.
- Note on permissions: only `INTERNET` is declared (no `POST_NOTIFICATIONS`, location, camera, or storage permissions); Xap/xo inbox items remain viewable in-app under Options without requiring OS notification permissions.
- Note on reproducibility: APKs disable Google dependency metadata (`includeInApk = false`) and are built from tagged commits in CI, but APKs are signed and not claimed to be bit-for-bit reproducible across machines.

## GeckoView Security Updates
- `geckoview-arm64-v8a` is pinned to an exact version in `android/app/build.gradle.kts`.
- Because GeckoView ships inside the APK, updating Gecko for Firefox security advisories requires cutting a new APK release.

## Local Build
```sh
pnpm install --frozen-lockfile
pnpm build
cd android
./gradlew testDebugUnitTest assembleDebug
```
Or build from a clean checkout in one step:
```sh
cd android
./gradlew -PbuildExtension testDebugUnitTest assembleRelease
```
