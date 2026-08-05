// Chrome Web Store promotional tiles.
//
//   small marquee : 440 × 280
//   large marquee : 1400 × 560
//
// Written as JPEG, not PNG: the store requires 24-bit with NO alpha channel, and a
// Playwright PNG is always RGBA. JPEG is one of the two accepted formats and is 24-bit
// by definition, so the constraint is satisfied by construction rather than by a
// conversion step that could quietly leave an alpha channel behind.
//
// Every claim on the tiles is checkable: 84 languages is the served catalogue size, and
// "any tab that plays audio" is what tabCapture actually does.

import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const ICONS = process.argv[2];
const OUT = process.argv[3];

const icon = `data:image/png;base64,${(await readFile(join(ICONS, 'icon-128.png'))).toString('base64')}`;

const BASE = `
  * { box-sizing: border-box; margin: 0; }
  html, body { background: #0b0d14; }
  body {
    font: 16px/1.4 -apple-system, "Segoe UI", system-ui, sans-serif;
    color: #eef0f6; -webkit-font-smoothing: antialiased;
  }
  .tile { position: relative; overflow: hidden; background: #0b0d14; }
  .glow { position: absolute; inset: 0; }
  .brand { display: flex; align-items: center; gap: 14px; }
  .brand img { display: block; border-radius: 22%; }
  .word { font-weight: 700; letter-spacing: -.02em; }
  em { font-style: normal; color: #a5b4fc; }
  .sub { color: #a8b0c7; }
  /* A stylised subtitle pair — the product's actual output shape, not decoration. */
  .cap { border-radius: 10px; background: rgba(10,12,18,.86); border: 1px solid rgba(255,255,255,.07); }
  .cap b { display: block; font-weight: 700; }
  .cap span { display: block; color: #b6bed4; font-weight: 500; }
`;

const TILES = [
  {
    name: 'promo-small-440x280',
    width: 440,
    height: 280,
    html: `
      <div class="tile" style="width:440px;height:280px;padding:34px 32px;">
        <div class="glow" style="background:
          radial-gradient(78% 96% at 88% 8%, rgba(99,102,241,.40) 0%, transparent 62%),
          radial-gradient(70% 80% at 4% 100%, rgba(56,189,248,.20) 0%, transparent 60%);"></div>
        <div style="position:relative">
          <div class="brand">
            <img src="${icon}" width="52" height="52">
            <div class="word" style="font-size:29px">VoxTranslate</div>
          </div>
          <div class="word" style="font-size:31px;line-height:1.14;margin-top:26px">
            Live subtitles on<br><em>any tab</em>
          </div>
          <div class="sub" style="font-size:15px;margin-top:14px">
            Translated as it is spoken · 84 languages
          </div>
        </div>
      </div>`,
  },
  {
    name: 'promo-marquee-1400x560',
    width: 1400,
    height: 560,
    html: `
      <div class="tile" style="width:1400px;height:560px;padding:0 92px;display:flex;align-items:center;gap:76px">
        <div class="glow" style="background:
          radial-gradient(52% 86% at 74% 12%, rgba(99,102,241,.38) 0%, transparent 62%),
          radial-gradient(46% 70% at 6% 96%, rgba(56,189,248,.18) 0%, transparent 58%);"></div>

        <div style="position:relative;flex:1 1 0;min-width:0">
          <div class="brand">
            <img src="${icon}" width="66" height="66">
            <div class="word" style="font-size:36px">VoxTranslate</div>
          </div>
          <div class="word" style="font-size:60px;line-height:1.08;margin-top:34px;letter-spacing:-.028em">
            Live subtitles on<br><em>any tab that talks</em>
          </div>
          <div class="sub" style="font-size:22px;margin-top:22px;max-width:560px">
            Talks, lectures, podcasts, meetings — translated as they are spoken,
            in 84 languages.
          </div>
        </div>

        <div style="position:relative;flex:0 0 470px">
          <div class="cap" style="padding:18px 22px">
            <span style="font-size:19px;line-height:1.35">What actually matters is understanding
              each other, not speaking the same language.</span>
          </div>
          <div class="cap" style="padding:18px 22px;margin-top:12px">
            <b style="font-size:21px;line-height:1.35">Quello che conta davvero è capirsi,
              non parlare la stessa lingua.</b>
          </div>
        </div>
      </div>`,
  },
];

const browser = await chromium.launch();
for (const tile of TILES) {
  const page = await browser.newPage({
    viewport: { width: tile.width, height: tile.height },
    deviceScaleFactor: 1, // the store wants these EXACT pixel sizes, not 2x
  });
  await page.setContent(`<style>${BASE}</style>${tile.html}`);
  await page.waitForLoadState('networkidle');
  await page.screenshot({ path: join(OUT, `${tile.name}.jpg`), type: 'jpeg', quality: 95 });
  console.info(`${tile.name}.jpg (${tile.width}×${tile.height})`);
  await page.close();
}
await browser.close();
