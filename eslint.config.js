import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import vue from 'eslint-plugin-vue';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'release/**', 'playwright-report/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...vue.configs['flat/recommended'],
  {
    files: ['**/*.vue'],
    languageOptions: {
      parserOptions: { parser: tseslint.parser },
    },
    rules: {
      // False positive in `<script setup>`: top-level bindings are consumed by the
      // template, which this rule does not analyse, so every `computed` looks unused.
      'no-useless-assignment': 'off',

      // Prettier owns formatting. These vue rules disagree with it about attribute
      // wrapping and tag content, so leaving them on means `format` and `lint:fix`
      // undo each other forever. Correctness rules from the plugin stay enabled.
      'vue/max-attributes-per-line': 'off',
      'vue/singleline-html-element-content-newline': 'off',
      'vue/html-self-closing': 'off',
      'vue/html-indent': 'off',
      'vue/html-closing-bracket-newline': 'off',
      'vue/attributes-order': 'off',
    },
  },
  {
    languageOptions: {
      globals: {
        chrome: 'readonly',
        console: 'readonly',
        document: 'readonly',
        window: 'readonly',
        globalThis: 'readonly',
        crypto: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        btoa: 'readonly',
        atob: 'readonly',
        fetch: 'readonly',
        Headers: 'readonly',
        Response: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        TextEncoder: 'readonly',
        WebSocket: 'readonly',
        MediaRecorder: 'readonly',
        AudioContext: 'readonly',
        MediaStream: 'readonly',
        GainNode: 'readonly',
        navigator: 'readonly',
        Intl: 'readonly',
        HTMLDivElement: 'readonly',
        HTMLSelectElement: 'readonly',
        HTMLInputElement: 'readonly',
        ShadowRoot: 'readonly',
        RequestInit: 'readonly',
        MediaStreamConstraints: 'readonly',
        process: 'readonly',
      },
    },
    rules: {
      // `any` defeats the point of validating the network boundary.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      // An empty catch is how errors get swallowed; require a stated reason.
      'no-empty': ['error', { allowEmptyCatch: false }],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always'],
    },
  },
  {
    // Config files run in Node, not the extension sandbox.
    files: ['*.config.ts', '*.config.js', 'scripts/**/*.ts'],
    rules: { 'no-console': 'off' },
  },
  {
    // AudioWorklet processors run in AudioWorkletGlobalScope, which has its own globals
    // and no DOM. These files are copied verbatim from the VoxTranslate web client so
    // both clients encode and drain audio identically — they are deliberately not
    // rewritten to satisfy the main config.
    files: ['public/*-worklet.js'],
    languageOptions: {
      globals: {
        AudioWorkletProcessor: 'readonly',
        registerProcessor: 'readonly',
        sampleRate: 'readonly',
        currentTime: 'readonly',
      },
    },
  },
);
