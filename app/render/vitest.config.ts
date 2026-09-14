import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vitest/config';

/**
 * Unit tests for the renderer live in `<repo>/tests/frontend/unit` (next to
 * the backend tests) but are driven from this package:
 *
 *     cd app/render && npm run test:unit
 */
const renderRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(renderRoot, '..', '..');
const unitTestsDir = path.join(repoRoot, 'tests', 'frontend', 'unit');

const toPosix = (p: string) => p.replace(/\\/g, '/');

/**
 * Vite resolves bare specifiers by walking up from the importing file, so a
 * test in `tests/frontend/unit` cannot see `vitest`, `react`,
 * `@testing-library/*`, … in `app/render/node_modules`. Re-resolve bare
 * imports that originate outside this package as if they were imported from
 * here. Relative, absolute, `@/` and virtual ids are left alone.
 */
function resolveFromRenderRoot(): Plugin {
  const anchor = path.join(renderRoot, 'package.json');
  const renderPosix = toPosix(renderRoot);
  return {
    name: 'tissuelab:resolve-from-render-root',
    enforce: 'pre',
    async resolveId(source, importer, options) {
      if (!importer || toPosix(importer).startsWith(renderPosix)) return null;
      if (/^(\.|\/|\0|@\/|[a-zA-Z]:[\\/]|node:|virtual:)/.test(source)) return null;
      return this.resolve(source, anchor, { ...options, skipSelf: true });
    },
  };
}

export default defineConfig({
  plugins: [resolveFromRenderRoot()],
  resolve: {
    alias: { '@': renderRoot },
  },
  esbuild: { jsx: 'automatic' },
  // The test files sit outside this package; let Vite serve them.
  server: { fs: { allow: [repoRoot] } },
  test: {
    environment: 'jsdom',
    dir: unitTestsDir,
    include: ['**/*.test.{ts,tsx}'],
    setupFiles: [toPosix(path.join(unitTestsDir, 'setup.ts'))],
    clearMocks: true,
    unstubEnvs: true,
    unstubGlobals: true,
    css: false,
    testTimeout: 15_000,
    // Node >= 25 ships an experimental global localStorage that shadows jsdom's
    // (and is undefined without --localstorage-file); turn it off in the workers.
    poolOptions: { forks: { execArgv: ['--no-experimental-webstorage'] } },
  },
});
