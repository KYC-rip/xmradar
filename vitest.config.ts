import { defineConfig } from 'vitest/config';
import { WxtVitest } from 'wxt/testing/vitest-plugin';

export default defineConfig({
  plugins: [WxtVitest()],
  // openpgp's lightweight build is browser-only; tests use its Node build, which has the same API
  resolve: { alias: { 'openpgp/lightweight': 'openpgp' } },
  test: { environment: 'happy-dom' },
});
