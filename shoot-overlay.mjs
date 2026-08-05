// Screenshot the REAL subtitle overlay (dist/content/overlay.js) over a neutral
// placeholder page.
//
// The page underneath is deliberately generic and unbranded — a store screenshot must
// not put another company's site or logo on our listing to sell our product.

import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const DIST = process.argv[2];
const OUT = process.argv[3];

const overlayJs = await readFile(join(DIST, 'content/overlay.js'), 'utf8');

const PAGE = `
<!doctype html><meta charset="utf-8">
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; height: 100vh; background: #0b0d14; overflow: hidden;
    font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; color: #e7e9f0;
    display: flex; flex-direction: column; align-items: center; padding: 118px 32px 0;
  }
  .frame { width: 100%; max-width: 1120px; }
  .stage {
    position: relative; height: 600px; border-radius: 16px; overflow: hidden;
    background:
      radial-gradient(120% 90% at 30% 20%, #2b3350 0%, transparent 60%),
      radial-gradient(100% 80% at 80% 70%, #1d2a44 0%, transparent 55%),
      #11151f;
    border: 1px solid #232a3d;
    display: grid; place-items: center;
  }
  .speaker {
    width: 140px; height: 140px; border-radius: 50%;
    background: linear-gradient(150deg, #3d4668, #232a44);
    border: 1px solid #39425f;
    display: grid; place-items: center; font-size: 52px; opacity: .95;
  }
  .bar {
    position: absolute; left: 0; right: 0; bottom: 0; height: 46px;
    background: linear-gradient(transparent, rgba(0,0,0,.65));
    display: flex; align-items: center; gap: 12px; padding: 0 16px;
  }
  .play { width: 0; height: 0; border-left: 12px solid #e7e9f0;
          border-top: 8px solid transparent; border-bottom: 8px solid transparent; }
  .track { flex: 1; height: 4px; border-radius: 2px; background: rgba(255,255,255,.22); }
  .track i { display: block; width: 42%; height: 100%; border-radius: 2px; background: #6366f1; }
  .time { font-variant-numeric: tabular-nums; font-size: 13px; color: #b9c0d4; }
  .head { width: 100%; max-width: 1120px; margin: 0 0 14px; }
  h1 { font-size: 19px; margin: 0 0 3px; font-weight: 650; }
  p  { margin: 0; color: #8b93ab; font-size: 14px; }
</style>
<!-- No page header: the store composition supplies the caption, and a second title
     underneath it would show through as a ghost. -->
<div class="frame">
  <div class="stage">
    <div class="speaker">🎙️</div>
    <div class="bar"><span class="play"></span><span class="track"><i></i></span><span class="time">14:22 / 33:40</span></div>
  </div>
</div>
`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });

await page.setContent(PAGE);
// Capture the overlay's message listener so we can drive it exactly as the worker does.
// Injected AFTER setContent — an init script does not survive the navigation it performs.
await page.addScriptTag({
  content: `globalThis.__voxListeners = [];
    globalThis.chrome = { runtime: { onMessage: { addListener: (fn) => globalThis.__voxListeners.push(fn) } } };`,
});
await page.addScriptTag({ content: overlayJs });

await page.evaluate(() => {
  const send = (m) => globalThis.__voxListeners.forEach((fn) => fn(m));
  // Clears the player bar: the stage ends at y=718 and its controls occupy the last
  // 46px, so the subtitle block has to sit above y≈660.
  send({ kind: 'OVERLAY_SHOW', options: { fontSize: 26, bottomOffset: 152, dualLanguage: true } });
  send({
    kind: 'OVERLAY_UPDATE',
    main: 'Quello che conta davvero è capirsi, non parlare la stessa lingua.',
    secondary: "What actually matters is understanding each other, not speaking the same language.",
  });
});
await page.waitForTimeout(400);
await page.screenshot({ path: join(OUT, 'overlay.png') });
console.info('overlay.png written');

await browser.close();
