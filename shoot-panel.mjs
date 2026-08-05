// Screenshot the REAL built side panel, not a mockup: serve dist/ over http, stub the
// chrome.* surface the panel talks to, and let the actual Vue app render itself.
//
// The engine catalogue and the language catalogue are the LIVE production payloads
// (fetched from api.voxtranslate.app), so every rate, tier and language on screen is a
// fact rather than a plausible-looking invention.

import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const DIST = process.argv[2];
const OUT = process.argv[3];
const DATA = process.argv[4];

const engines = JSON.parse(await readFile(join(DATA, 'engines.json'), 'utf8')).engines;
const catalogue = JSON.parse(await readFile(join(DATA, 'languages.json'), 'utf8'));

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
};

const server = createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(req.url.split('?')[0]));
  try {
    const body = await readFile(join(DIST, path));
    res.writeHead(200, { 'content-type': MIME[extname(path)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;

const PREFERENCES = {
  targetLanguage: 'it',
  sourceLanguage: 'auto',
  engineId: 'standard',
  subtitlesEnabled: true,
  translatedAudioEnabled: true,
  originalAudioVolume: 0.2,
  subtitleFontSize: 22,
  subtitleBottomOffset: 80,
  dualLanguageSubtitles: false,
};

// A demo account. Deliberately an example.com address and a generic display name: a
// store screenshot must not put a real person's identity on a public listing.
const ACCOUNT = {
  user: { id: 'usr_demo', email: 'demo@example.com', name: 'Demo Account', avatar_url: null },
  balance: 4.82,
  engines,
  preferences: PREFERENCES,
};

function state(overrides = {}) {
  return {
    session: 'idle',
    sessionId: null,
    error: null,
    errorCode: null,
    account: ACCOUNT,
    preferences: PREFERENCES,
    usage: { remaining: 4.82, sessionSpent: 0, sessionSeconds: 0, sinceReset: 0 },
    audioMode: 'translating',
    detectedLanguage: null,
    lowBalance: false,
    tabTitle: null,
    ...overrides,
  };
}

const SHOTS = [
  {
    name: 'panel-idle',
    state: state(),
  },
  {
    name: 'panel-streaming',
    state: state({
      session: 'streaming',
      sessionId: 'sess_demo',
      usage: { remaining: 4.7, sessionSpent: 0.12, sessionSeconds: 1620, sinceReset: 0.34 },
    }),
    crops: { 'usage-card': 'section.usage', 'panel-header': '.header' },
  },
  {
    name: 'panel-loggedout',
    state: state({ session: 'logged_out', account: null }),
  },
];

const browser = await chromium.launch();

for (const shot of SHOTS) {
  const page = await browser.newPage({ viewport: { width: 420, height: 900 }, deviceScaleFactor: 2 });
  await page.addInitScript(
    ({ panelState, cat }) => {
      const listeners = [];
      globalThis.chrome = {
        runtime: {
          sendMessage: async (msg) => {
            if (msg?.kind === 'GET_STATE') return panelState;
            if (msg?.kind === 'GET_CATALOGUE') return cat;
            return undefined;
          },
          onMessage: { addListener: (fn) => listeners.push(fn) },
        },
        tabs: { create: () => {} },
        storage: { local: { get: async () => ({}), set: async () => {} } },
      };
    },
    { panelState: shot.state, cat: catalogue },
  );
  await page.goto(`${base}/sidepanel/index.html`);
  await page.waitForSelector('.panel');
  // The catalogue arrives on a second, non-awaited message; give the pickers a tick.
  await page.waitForFunction(
    () => document.querySelectorAll('select').length === 0 ||
          document.querySelectorAll('select')[document.querySelectorAll('select').length - 1].options.length > 1,
    { timeout: 5000 },
  ).catch(() => {});
  await page.screenshot({ path: join(OUT, `${shot.name}.png`), fullPage: true });
  // Element crops as well as the full panel: framing a section by pixel offset is
  // guesswork that breaks the moment the layout shifts.
  for (const [file, selector] of Object.entries(shot.crops ?? {})) {
    const el = await page.$(selector);
    if (el) await el.screenshot({ path: join(OUT, `${file}.png`) });
  }
  const selects = await page.$$eval('select', (els) =>
    els.map((e) => `${e.options.length} options`).join(' | '));
  console.info(`${shot.name}: selects → ${selects || '(none — logged out)'}`);
  await page.close();
}

await browser.close();
server.close();
