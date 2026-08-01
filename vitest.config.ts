import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: { '@': resolve(__dirname, 'src') },
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
