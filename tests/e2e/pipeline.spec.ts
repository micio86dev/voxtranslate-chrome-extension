/**
 * End-to-end tests against a fake VoxTranslate backend.
 *
 * The extension is built against a local origin, loaded unpacked, and driven through the
 * real side-panel page — so this covers the genuine wiring: storage → service worker →
 * HTTP client → Vue.
 *
 * ## What cannot be tested here, and why
 *
 * Tab capture is NOT automatable. `chrome.tabCapture.getMediaStreamId` requires the
 * extension to have been invoked by the user on that tab (the `activeTab` grant), and
 * Chrome refuses otherwise with the verbatim error:
 *
 *   "Extension has not been invoked for the current page (see activeTab permission)."
 *
 * Playwright drives page content, not browser chrome, so it cannot click the extension
 * action to produce that grant. Requesting `<all_urls>` instead would make these tests
 * pass while making the shipped product worse — so the capture-dependent cases are
 * skipped here on purpose and covered two other ways:
 *
 *   - `tests/unit/capture-pipeline.test.ts` injects the browser APIs and asserts the
 *     audio graph, encoder settings, backpressure, and teardown.
 *   - `docs/manual-testing.md` covers the parts only a human can confirm.
 *
 * Note also that `chrome.runtime.sendMessage` does not deliver to listeners in the SAME
 * context, so the service worker cannot message itself — commands go through the panel.
 */

import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect, test, type BrowserContext, type Page } from '@playwright/test';
import { startFakeBackend, type FakeBackend } from './fixtures/fake-backend';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const DIST = resolve(ROOT, 'dist');

interface PanelState {
  session: string;
  sessionId: string | null;
  errorCode: string | null;
  account: { user: { email: string }; balance: number; engines: { id: string }[] } | null;
  preferences: { targetLanguage: string; originalAudioVolume: number };
  usage: { remaining: number; sessionSpent: number };
}

let backend: FakeBackend;
let context: BrowserContext;
let panel: Page;
let extensionId: string;

test.describe.configure({ mode: 'serial' });

async function command(kind: string, extra: Record<string, unknown> = {}): Promise<void> {
  await panel.evaluate(([k, e]) => chrome.runtime.sendMessage({ kind: k, ...(e as object) }), [
    kind,
    extra,
  ] as const);
}

async function state(): Promise<PanelState> {
  return panel.evaluate(
    async () => (await chrome.runtime.sendMessage({ kind: 'GET_STATE' })) as PanelState,
  );
}

test.beforeAll(async () => {
  backend = await startFakeBackend();

  // Rebuild pointing at the fake backend. Origins are build-time config, so this is the
  // only way to redirect the extension without patching the bundle.
  execSync('bun run build', {
    cwd: ROOT,
    stdio: 'pipe',
    env: { ...process.env, VITE_API_ORIGIN: backend.origin, VITE_APP_ORIGIN: backend.origin },
  });
  if (!existsSync(resolve(DIST, 'manifest.json'))) throw new Error('build produced no manifest');

  context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    args: [
      `--disable-extensions-except=${DIST}`,
      `--load-extension=${DIST}`,
      '--autoplay-policy=no-user-gesture-required',
    ],
  });

  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker');
  extensionId = new URL(sw.url()).host;

  // Seed a session token, bypassing launchWebAuthFlow (which needs a real IdP). A
  // syntactically valid unsigned JWT with a far-future exp is all the client checks.
  await sw.evaluate(async () => {
    const b64 = (o: unknown) =>
      btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const jwt = `${b64({ alg: 'HS256' })}.${b64({
      sub: 'usr_test',
      email: 'tester@example.com',
      exp: Math.floor(Date.now() / 1000) + 86_400,
    })}.sig`;
    await chrome.storage.session.set({ 'vox.session.token': jwt });
  });

  panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel/index.html`);
});

test.afterAll(async () => {
  await context?.close();
  await backend?.stop();
});

test('restores a session from a stored token and syncs the account', async () => {
  await command('REFRESH_ACCOUNT');

  await expect.poll(async () => (await state()).account !== null, { timeout: 15_000 }).toBe(true);

  const s = await state();
  expect(s.account?.user.email).toBe('tester@example.com');
  expect(s.account?.balance).toBe(5.0);
  expect(s.account?.engines.map((e) => e.id)).toContain('standard');
  // The backend preference (`it`) must win over the browser UI language.
  expect(s.preferences.targetLanguage).toBe('it');
  // A valid stored token IS a session — the machine must leave logged_out, or the panel
  // would show the account while refusing to start.
  expect(s.session).toBe('ready');
});

test('renders the synced account in the side panel', async () => {
  await expect(panel.getByText('tester@example.com')).toBeVisible({ timeout: 10_000 });
  await expect(panel.locator('.balance .figure')).toHaveText('$5.00');
  await expect(panel.getByRole('button', { name: /start translating/i })).toBeVisible();
  // The tier picker is populated from the backend catalogue, not hard-coded.
  await expect(panel.locator('select').first()).toContainText('Standard');
});

test('offers every tier the extension can deliver, and marks the ones with a natural voice', async () => {
  const options = await panel.locator('select').first().locator('option').allTextContents();
  const text = options.join(' | ');
  expect(text).toMatch(/Standard/);
  // Enhanced is supported again now that the in-browser pipeline exists.
  expect(text).toMatch(/Enhanced/);
  // Standard's voice is synthesised on the device, so it must not claim a natural one.
  expect(text).not.toMatch(/Standard[^|]*natural voice/);
});

test('a client-direct tier requires the spoken language before it can start', async () => {
  // Cartesia has no auto-detect — `reconcile` refuses a peer whose language is 'auto' —
  // so Start must be blocked with a reason rather than opening a session that can never
  // produce anything.
  await panel.locator('select').first().selectOption('cartesia');
  await panel.waitForTimeout(200);

  await expect(panel.getByText(/cannot detect the spoken language/i)).toBeVisible();
  await expect(panel.getByRole('button', { name: /start translating/i })).toBeDisabled();

  // Choosing a language unblocks it.
  await panel.locator('select').nth(1).selectOption('en');
  await panel.waitForTimeout(200);
  await expect(panel.getByRole('button', { name: /start translating/i })).toBeEnabled();

  // Restore for the tests that follow.
  await panel.locator('select').first().selectOption('standard');
  await panel.waitForTimeout(200);
});

test('offers only languages the selected tier can produce', async () => {
  const options = await panel.locator('select').nth(2).locator('option').allTextContents();
  expect(options.length).toBeGreaterThan(0);
  // The fake tier advertises en + it, and the catalogue must be filtered to them.
  expect(options.join(' ')).toMatch(/Italiano|English/);
});

test('persists a preference change through the background', async () => {
  await command('UPDATE_PREFERENCES', { patch: { originalAudioVolume: 0.75 } });
  await expect
    .poll(async () => (await state()).preferences.originalAudioVolume, { timeout: 10_000 })
    .toBe(0.75);
});

test('resets the usage counter without touching the balance', async () => {
  const before = (await state()).usage.remaining;
  await command('RESET_USAGE_COUNTER');
  const after = await state();
  // The reset moves a display baseline only — it must never alter the balance.
  expect(after.usage.remaining).toBe(before);
});

test('returns to a logged-out state on logout', async () => {
  await command('LOGOUT');
  await expect.poll(async () => (await state()).session, { timeout: 10_000 }).toBe('logged_out');
  expect((await state()).account).toBeNull();

  const tokenGone = await panel.evaluate(async () => {
    const s = await chrome.storage.session.get('vox.session.token');
    return s['vox.session.token'] === undefined;
  });
  expect(tokenGone).toBe(true);

  await expect(panel.getByRole('button', { name: /log in with voxtranslate/i })).toBeVisible();
});

test('refuses to start a session with no account, and says why', async () => {
  await command('START_SESSION');
  await expect
    .poll(async () => (await state()).errorCode, { timeout: 10_000 })
    .toBe('auth_expired');
  // The important part: it does NOT report `already_running`, which would send the user
  // hunting for a phantom second session.
  expect((await state()).session).toBe('logged_out');
});

// --- capture-dependent cases (see the file header for why these cannot run) ---

test.skip('captures tab audio and streams encoded frames to the backend', () => {
  // Blocked by activeTab: Chrome returns "Extension has not been invoked for the current
  // page". Covered by tests/unit/capture-pipeline.test.ts and docs/manual-testing.md §3.
});

test.skip('renders subtitles over the page and removes the overlay on stop', () => {
  // Requires a live session, which requires capture. See docs/manual-testing.md §4.
});

test.skip('restores original audio when the spoken language matches the target', () => {
  // Requires a live session. Logic covered by tests/unit/language-mode.test.ts and
  // tests/integration/session-flow.test.ts; audible behaviour in manual testing §5.
});
