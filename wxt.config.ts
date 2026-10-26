import { readFileSync } from 'node:fs';
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
  // visible in Finder, unlike the default .output
  outDir: 'output',
  // Firefox defaults to MV2; MAIN-world scripting and the same code path need MV3 (Firefox 140+)
  manifestVersion: 3,
  manifest: {
    name: 'XMRadar',
    // 4-part version so about:addons and chrome://extensions show the CI build: 0.1.0.142
    version: env.WXT_BUILD_NUMBER ? `${pkg.version}.${env.WXT_BUILD_NUMBER}` : pkg.version,
    description: 'Monero on the pages you use: tip badges on X, burner email, and copying posts to Nostr. Holds no keys and no funds.',
    permissions: ['contextMenus', 'storage', 'activeTab', 'scripting', 'notifications'],
    host_permissions: ['<all_urls>'],
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
