/** Where this copy came from: a CI release ("v0.1.0 · build 142 · a1b2c3d", linking to the release) or a local "dev build". */
export interface BuildEnv {
  version: string;
  build?: string;
  commit?: string;
  url?: string;
}

const RELEASES = 'https://github.com/KYC-rip/xmradar/releases/tag/';

export function buildInfo(e: BuildEnv): { label: string; url: string | null } {
  const version = `v${e.version.split('.').slice(0, 3).join('.')}`;
  const build = e.build && /^\d{1,5}$/.test(e.build) ? e.build : null;
  if (!build) return { label: `${version} · dev build`, url: null };
  const commit = e.commit && /^[0-9a-f]{40}$/.test(e.commit) ? ` · ${e.commit.slice(0, 7)}` : '';
  const url = e.url?.startsWith(RELEASES) ? e.url : null;
  return { label: `${version} · build ${build}${commit}`, url };
}

/** This build's info, from the manifest and the values CI set at build time. */
export const currentBuild = () =>
  buildInfo({
    version: browser.runtime.getManifest().version,
    build: import.meta.env.WXT_BUILD_NUMBER,
    commit: import.meta.env.WXT_COMMIT,
    url: import.meta.env.WXT_RELEASE_URL,
  });
