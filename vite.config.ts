import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import vue from '@vitejs/plugin-vue';
import { buildManifest } from './manifest.config';

/**
 * Emits manifest.json from manifest.config.ts at build time, so the manifest can read
 * the package version and the environment origins instead of being a hand-maintained
 * copy that silently drifts.
 */
function manifestPlugin(env: { apiOrigin: string; appOrigin: string; dev: boolean }): Plugin {
  return {
    name: 'voxtranslate-manifest',
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'manifest.json',
        source: JSON.stringify(buildManifest(env), null, 2),
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const dev = mode === 'development';
  // Origins are configuration, never hard-coded literals in source. `.env.example`
  // documents them; production values come from `.env.production`.
  const apiOrigin = process.env.VITE_API_ORIGIN ?? 'https://api.voxtranslate.app';
  const appOrigin = process.env.VITE_APP_ORIGIN ?? 'https://voxtranslate.app';

  return {
    plugins: [vue(), manifestPlugin({ apiOrigin, appOrigin, dev })],
    resolve: {
      alias: { '@': resolve(__dirname, 'src') },
    },
    define: {
      __API_ORIGIN__: JSON.stringify(apiOrigin),
      __APP_ORIGIN__: JSON.stringify(appOrigin),
      __DEV_BUILD__: JSON.stringify(dev),
      // Stamped at build time so a running extension can say exactly which build it is.
      // "Did you rebuild?" cost real diagnostic time more than once.
      __BUILD_STAMP__: JSON.stringify(new Date().toISOString().replace('T', ' ').slice(0, 19)),
    },
    // NOTE: the content script is NOT built here — it needs an IIFE wrapper so repeated
    // injection cannot redeclare top-level bindings. See vite.content.config.ts.
    //
    // Root is `src` so HTML entries emit at `dist/sidepanel/index.html` — the exact
    // paths the manifest declares. With the project root instead, Vite mirrors the
    // source tree and produces `dist/src/sidepanel/index.html`, which Chrome cannot load.
    root: resolve(__dirname, 'src'),
    build: {
      outDir: resolve(__dirname, 'dist'),
      emptyOutDir: true,
      sourcemap: dev ? 'inline' : false,
      minify: !dev,
      target: 'chrome116',
      rollupOptions: {
        input: {
          'background/index': resolve(__dirname, 'src/background/index.ts'),
          'offscreen/index': resolve(__dirname, 'src/offscreen/index.ts'),
          'sidepanel/index': resolve(__dirname, 'src/sidepanel/index.html'),
          'offscreen/document': resolve(__dirname, 'src/offscreen/document.html'),
        },
        output: {
          // Chrome loads these by exact path from the manifest, so no content hashing.
          entryFileNames: '[name].js',
          chunkFileNames: 'chunks/[name]-[hash].js',
          assetFileNames: 'assets/[name].[ext]',
        },
      },
    },
    publicDir: resolve(__dirname, 'public'),
  };
});
