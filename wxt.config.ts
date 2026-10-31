import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'wxt';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

// Set only by .github/workflows/release.yml; local builds are "dev builds". The UI reads them as import.meta.env.WXT_*.
const env = process.env;
if (env.WXT_BUILD_NUMBER && !/^\d{1,5}$/.test(env.WXT_BUILD_NUMBER)) throw new Error(`bad WXT_BUILD_NUMBER ${env.WXT_BUILD_NUMBER}`);
if (env.WXT_COMMIT && !/^[0-9a-f]{40}$/.test(env.WXT_COMMIT)) throw new Error(`bad WXT_COMMIT ${env.WXT_COMMIT}`);
if (env.WXT_RELEASE_URL && !env.WXT_RELEASE_URL.startsWith('https://github.com/KYC-rip/xmradar/releases/tag/')) {
  throw new Error(`bad WXT_RELEASE_URL ${env.WXT_RELEASE_URL}`);
}

export default defineConfig({
  srcDir: 'src',
  // openpgp exports its lightweight build for browsers only; WXT also loads entrypoints in Node to read
  // their options, so the import is pointed at the file itself (the same file a browser build picks)
  vite: () => ({
    resolve: { alias: { 'openpgp/lightweight': fileURLToPath(new URL('./node_modules/openpgp/dist/lightweight/openpgp.min.mjs', import.meta.url)) } },
  }),
  // visible in Finder, unlike the default .output
  outDir: 'output',
  // Firefox defaults to MV2; MAIN-world scripting and the same code path need MV3 (Firefox 140+)
  manifestVersion: 3,
  manifest: {
    name: 'XMRadar',
    // 4-part version so about:addons and chrome://extensions show the CI build: 0.1.0.142
    version: env.WXT_BUILD_NUMBER ? `${pkg.version}.${env.WXT_BUILD_NUMBER}` : pkg.version,
    description: 'Monero on the pages you use: tip badges on X, burner email, and copying posts to Nostr. Holds no keys and no funds.',
    // declarativeNetRequestWithHostAccess: no extra prompt given <all_urls>; sends a copy of a listed site to the guard page before it loads (PLAN-PRELOAD)
    permissions: ['contextMenus', 'storage', 'activeTab', 'scripting', 'notifications', 'alarms', 'declarativeNetRequestWithHostAccess'],
    host_permissions: ['<all_urls>'],
    // the guard page is reached by a redirect; use_dynamic_url so sites can't probe for it at a fixed address
    web_accessible_resources: [{ resources: ['guard.html'], matches: ['<all_urls>'], use_dynamic_url: true }],
    commands: {
      'open-composer': {
        suggested_key: { default: 'Alt+Shift+N' },
        description: 'Copy the hovered post or selection to Nostr',
      },
    },
    browser_specific_settings: {
      gecko: {
        id: 'xmradar@local',
        strict_min_version: '140.0',
        data_collection_permissions: { required: ['none'] },
      },
    },
  },
});
