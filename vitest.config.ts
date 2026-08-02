import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: { '@': resolve(__dirname, 'src') },
  },
  // The same build-time constants vite.config.ts defines. Without them any module that
  // imports shared/config throws at import time under Vitest.
  define: {
    __API_ORIGIN__: JSON.stringify('http://localhost:0'),
    __APP_ORIGIN__: JSON.stringify('http://localhost:0'),
    __DEV_BUILD__: 'true',
    __BUILD_STAMP__: JSON.stringify('test'),
  },
  test: {
    environment: 'happy-dom',
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // Chrome-adapter layers are covered by e2e/manual testing, not unit tests —
      // mocking the whole extension API surface would test the mock, not the code.
      exclude: ['src/**/*.d.ts', 'src/sidepanel/**', 'src/background/**', 'src/offscreen/**'],
    },
  },
});
