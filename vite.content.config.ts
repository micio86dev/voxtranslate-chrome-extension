import { resolve } from 'node:path';
import { defineConfig } from 'vite';

/**
 * The content script is built SEPARATELY, as an IIFE.
 *
 * `chrome.scripting.executeScript` re-evaluates the file in the SAME isolated world on
 * every injection — and a page can be injected more than once (SPA navigation, a second
 * session, a manual retry). An ES-module/plain-script bundle puts its top-level bindings
 * in that shared scope, so the second injection dies with
 *
 *     Uncaught SyntaxError: Identifier 'f' has already been declared
 *
 * before a single statement runs. The in-file re-injection guard cannot help: the failure
 * happens at evaluation time, not at run time. Wrapping everything in an IIFE keeps the
 * shared scope empty, so re-injection is harmless and the guard can do its job.
 *
 * The other entries stay ESM (the service worker is `type: module`, and the panel and
 * offscreen document are real HTML pages), which is why this cannot be one build.
 */
export default defineConfig(({ mode }) => {
  const dev = mode === 'development';
  const apiOrigin = process.env.VITE_API_ORIGIN ?? 'https://api.voxtranslate.app';
  const appOrigin = process.env.VITE_APP_ORIGIN ?? 'https://voxtranslate.app';

  return {
    resolve: { alias: { '@': resolve(__dirname, 'src') } },
    define: {
      __API_ORIGIN__: JSON.stringify(apiOrigin),
      __APP_ORIGIN__: JSON.stringify(appOrigin),
      __DEV_BUILD__: JSON.stringify(dev),
    },
    build: {
      // Runs after the main build, so it must not wipe it.
      emptyOutDir: false,
      outDir: resolve(__dirname, 'dist/content'),
      sourcemap: dev ? 'inline' : false,
      minify: !dev,
      target: 'chrome116',
      lib: {
        entry: resolve(__dirname, 'src/content/overlay.ts'),
        formats: ['iife'],
        // An IIFE needs a name; it becomes a `var`, and `var` redeclaration is legal —
        // which is precisely the property that makes re-injection safe.
        name: 'VoxTranslateOverlay',
        fileName: () => 'overlay.js',
      },
    },
  };
});
