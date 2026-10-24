import { defineConfig } from 'wxt';

export default defineConfig({
  srcDir: 'src',
  // Firefox defaults to MV2; MAIN-world scripting and the same code path need MV3 (Firefox 140+)
  manifestVersion: 3,
  manifest: {
    name: 'XMRadar',
    description: 'Copy your posts from X, Mastodon, Bluesky, LinkedIn, Facebook or any page to Nostr.',
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
