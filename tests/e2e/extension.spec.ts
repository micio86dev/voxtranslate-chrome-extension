/**
 * End-to-end tests against the real unpacked extension.
 *
 * Scope is deliberately narrow. Playwright can load the extension, open its side panel
 * page, and assert what renders — it CANNOT grant tab capture, produce real audio, or
 * measure latency. Those live in docs/manual-testing.md, because a green suite that
 * silently skips the hard parts is worse than an honest gap.
 *
 * Builds the extension if `dist/` is missing, so it is self-sufficient on a clean runner.
 */

import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect, test, type BrowserContext } from '@playwright/test';

// This file is ESM, so `__dirname` does not exist — derive it from import.meta.url.
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const DIST = resolve(ROOT, 'dist');

let context: BrowserContext;
let extensionId: string;

test.beforeAll(async () => {
  // Build if needed rather than assuming a developer already did. A test that depends
  // on a build it does not create passes locally and fails on a clean CI runner — which
  // is exactly what happened the first time this workflow ran.
  if (!existsSync(resolve(DIST, 'manifest.json'))) {
    execSync('bun run build', { cwd: ROOT, stdio: 'pipe' });
  }
  if (!existsSync(resolve(DIST, 'manifest.json'))) {
    throw new Error('build produced no dist/manifest.json');
  }

  context = await chromium.launchPersistentContext('', {
    // Extensions require a headed, persistent context.
    channel: 'chromium',
    args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`],
  });

  // The service worker registers on load; its URL carries the generated extension id.
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker');
  extensionId = new URL(worker.url()).host;
});

test.afterAll(async () => {
  await context?.close();
});

test('side panel renders the logged-out state', async () => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/sidepanel/index.html`);

  await expect(page.getByRole('heading', { name: 'VoxTranslate' })).toBeVisible();
  await expect(page.getByRole('button', { name: /log in with voxtranslate/i })).toBeVisible();

  // The privacy summary is a store requirement, so its absence should fail the build.
  await expect(page.getByText(/nothing is captured until you press start/i)).toBeVisible();

  await page.close();
});

test('logged-out state exposes no session controls', async () => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/sidepanel/index.html`);

  // Start must be unreachable without an account — the guard against an unauthenticated
  // capture attempt.
  await expect(page.getByRole('button', { name: /start translating/i })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /buy more credit/i })).toHaveCount(0);

  await page.close();
});

test('the offscreen document loads without error', async () => {
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));

  await page.goto(`chrome-extension://${extensionId}/offscreen/document.html`);
  expect(errors).toEqual([]);

  await page.close();
});

test('the content script survives repeated injection', async () => {
  // Regression: `executeScript` re-evaluates the file in the SAME isolated world, and a
  // page can be injected more than once (SPA navigation, a retry, a second session). A
  // non-IIFE bundle redeclared its top-level bindings and died with
  // "Identifier 'f' has already been declared" — BEFORE the in-file guard could run, so
  // the guard was no protection at all. This asserts the shipped bundle is safe.
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('data:text/html,<title>overlay reinjection</title><p>hello');

  // A plain page has no extension context. Stub just enough of chrome.runtime for the
  // overlay to install its listener — the point of this test is the shared-scope
  // redeclaration, not the messaging.
  await page.evaluate(() => {
    (globalThis as unknown as { chrome: unknown }).chrome = {
      runtime: { onMessage: { addListener: () => {} } },
    };
  });

  const script = readFileSync(resolve(DIST, 'content/overlay.js'), 'utf8');
  // Two evaluations in one world reproduce exactly what a second injection does.
  await page.evaluate(script);
  await page.evaluate(script);
  await page.evaluate(script);

  expect(errors, `content script threw on re-injection: ${errors.join(' | ')}`).toEqual([]);
  await page.close();
});

test('the built content script declares nothing in the shared scope', () => {
  // The structural guarantee behind the test above: an IIFE, so nothing leaks out.
  const script = readFileSync(resolve(DIST, 'content/overlay.js'), 'utf8');
  expect(script.trimStart()).toMatch(/^\(function\s*\(/);
  // A bare top-level `const`/`let` would reintroduce the redeclaration crash.
  expect(script).not.toMatch(/^\s*(const|let)\s/m);
});
