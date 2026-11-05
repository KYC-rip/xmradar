import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

/**
 * The Ripley builds (ripley-os plans/x-app-xmradar.md, R9): not WXT — plain vite library builds of
 *   --mode x        → output/ripley/xmradar-x.js       one IIFE injected into X's page by Ripley Terminal
 *   --mode service  → output/ripley/xmradar-service.js one ES module RipleyOS imports (the lookups)
 * each with a banner naming the commit it was built from, and a .sha256 next to it.
 */
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };
const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

function commit(): string {
  try {
    const sha = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
    const dirty = execSync('git status --porcelain -- src package.json pnpm-lock.yaml vite.ripley.config.ts', { encoding: 'utf8' }).trim();
    return dirty ? `${sha}-dirty` : sha;
  } catch {
    return 'unknown';
  }
}

const banner = (file: string, sha: string) =>
  `/*! XMRadar ${pkg.version} — ${file} for RipleyOS. Copyright KYC-rip. Built from https://github.com/KYC-rip/xmradar commit ${sha}.\n` +
  ` *  Licensed to RipleyOS under a separate grant (see NOTICE in RipleyOS); the XMRadar repository is GPL-3.0-or-later. */\n`;

/** The banner goes on after minifying, then the file's sha256 is written beside it. */
function finish(file: string, sha: string): Plugin {
  return {
    name: 'ripley-finish',
    writeBundle(opts, bundle) {
      const out = Object.keys(bundle).find((f) => f.endsWith('.js'));
      if (!out) throw new Error('no js output');
      const path = `${opts.dir}/${out}`;
      const code = banner(file, sha) + readFileSync(path, 'utf8');
      writeFileSync(path, code);
      writeFileSync(path.replace(/\.js$/, '.sha256'), `${createHash('sha256').update(code).digest('hex')}  ${out}\n`);
    },
  };
}

export default defineConfig(({ mode }) => {
  if (mode !== 'x' && mode !== 'service') throw new Error('build with --mode x or --mode service');
  const file = mode === 'x' ? 'xmradar-x' : 'xmradar-service';
  const sha = commit();
  return {
    configFile: false,
    publicDir: false,
    define: { __XMRADAR_VERSION__: JSON.stringify(pkg.version), 'import.meta.env.WXT_BUILD_NUMBER': 'undefined', 'import.meta.env.WXT_COMMIT': JSON.stringify(sha), 'import.meta.env.WXT_RELEASE_URL': 'undefined' },
    resolve: {
      alias: [
        { find: /^wxt\/utils\/storage$/, replacement: here('./src/ripley/storage.ts') },
        { find: /^wxt\/browser$/, replacement: here('./src/ripley/browser.ts') },
        { find: /^wxt\/utils\/content-script-ui\/shadow-root$/, replacement: here('./src/ripley/shadow-root.ts') },
        { find: /^wxt\/utils\/content-script-context$/, replacement: here('./node_modules/wxt/dist/utils/content-script-context.mjs') },
        { find: /^nostr-tools\/(pool|relay|abstract-pool|abstract-relay)$/, replacement: here('./src/ripley/no-relays.ts') },
        { find: 'openpgp/lightweight', replacement: here('./node_modules/openpgp/dist/lightweight/openpgp.min.mjs') },
      ],
    },
    build: {
      outDir: 'output/ripley',
      emptyOutDir: false,
      target: 'es2022',
      minify: true,
      sourcemap: false,
      copyPublicDir: false,
      lib: {
        entry: here(mode === 'x' ? './src/ripley/x.ts' : './src/ripley/service.ts'),
        formats: [mode === 'x' ? 'iife' : 'es'],
        name: 'XMRadarRipley',
        fileName: () => `${file}.js`,
      },
      rollupOptions: { output: { codeSplitting: false } },
    },
    plugins: [finish(file, sha)],
  };
});
