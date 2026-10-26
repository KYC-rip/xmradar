/** Set only in release builds (.github/workflows/release.yml), checked in wxt.config.ts. */
interface ImportMetaEnv {
  readonly WXT_BUILD_NUMBER?: string;
  readonly WXT_COMMIT?: string;
  readonly WXT_RELEASE_URL?: string;
}
