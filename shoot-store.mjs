// Compose the Chrome Web Store screenshots (1280×800) from the real UI captures.
//
// The panel and overlay images are renders of the SHIPPED build driven by the LIVE
// production catalogue — every rate, tier and language on screen is a fact. This step
// only frames them: background, headline, crop. Nothing here invents product behaviour.

import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const SHOTS_DIR = process.argv[2];
const OUT = process.argv[3];

const asDataUri = async (name) =>
  `data:image/png;base64,${(await readFile(join(SHOTS_DIR, name))).toString('base64')}`;

const img = {
  idle: await asDataUri('panel-idle.png'),
  streaming: await asDataUri('panel-streaming.png'),
  loggedout: await asDataUri('panel-loggedout.png'),
  overlay: await asDataUri('overlay.png'),
  usage: await asDataUri('usage-card.png'),
};

const CSS = `
  * { box-sizing: border-box; margin: 0; }
  body {
    width: 1280px; height: 800px; overflow: hidden;
    font: 16px/1.45 -apple-system, "Segoe UI", system-ui, sans-serif;
    color: #eef0f6; background: #0b0d14;
  }
  .wrap { position: relative; width: 1280px; height: 800px; overflow: hidden; }
  .glow {
    position: absolute; inset: 0;
    background:
      radial-gradient(58% 70% at 78% 18%, rgba(99,102,241,.30) 0%, transparent 62%),
      radial-gradient(52% 60% at 12% 88%, rgba(56,189,248,.16) 0%, transparent 60%);
  }
  .copy { position: absolute; left: 76px; top: 168px; width: 480px; }
  h1 {
    font-size: 46px; line-height: 1.1; font-weight: 700; letter-spacing: -.022em;
  }
  h1 em { font-style: normal; color: #a5b4fc; }
  p { margin-top: 20px; font-size: 20px; line-height: 1.5; color: #a8b0c7; }
  .panel {
    position: absolute; right: 84px; top: 92px;
    width: 430px; height: 708px; overflow: hidden;
    border-radius: 16px 16px 0 0;
    box-shadow: 0 34px 90px rgba(0,0,0,.62), 0 0 0 1px rgba(255,255,255,.09);
    background: #fff;
  }
  .panel img { position: absolute; left: 0; width: 430px; display: block; }
  /* A single card lifted out of the panel, shown at a size that actually reads at
     store thumbnail scale. */
  .card {
    position: absolute; right: 84px; top: 268px; width: 470px;
    border-radius: 14px; overflow: hidden; background: #fff;
    box-shadow: 0 30px 80px rgba(0,0,0,.6), 0 0 0 1px rgba(255,255,255,.09);
  }
  .card img { width: 470px; display: block; }
  .full { position: absolute; inset: 0; }
  .full img { width: 1280px; height: 800px; display: block; }
  .band {
    position: absolute; left: 0; right: 0; top: 0; padding: 40px 76px 56px;
    background: linear-gradient(rgba(11,13,20,.94) 55%, transparent);
  }
  .band h1 { font-size: 42px; }
  .band p { margin-top: 12px; font-size: 19px; }
`;

// `offset` scrolls the panel capture inside its frame, so each screenshot shows the part
// of the UI its headline is actually talking about.
const SHOTS = [
  {
    name: '1-subtitles',
    html: `<div class="full"><img src="${img.overlay}"></div>
           <div class="band">
             <h1>Live subtitles on <em>any tab</em></h1>
             <p>Talks, lectures, podcasts, meetings — translated as they are spoken,
                with the original line kept underneath when you want it.</p>
           </div>`,
  },
  {
    name: '2-languages',
    html: `<div class="glow"></div>
           <div class="copy">
             <h1>Pick a tier and <em>two languages</em></h1>
             <p>84 languages in the catalogue. Each tier offers exactly the ones it can
                actually produce — never a language it cannot speak.</p>
           </div>
           <div class="panel"><img src="${img.idle}" style="top:0"></div>`,
  },
  {
    name: '3-usage',
    html: `<div class="glow"></div>
           <div class="copy">
             <h1>Watch the cost <em>as it runs</em></h1>
             <p>Billed by the minute of speech, shown live: this session, since your last
                reset, and what is left. No subscription.</p>
           </div>
           <div class="card"><img src="${img.usage}"></div>`,
  },
  {
    name: '4-privacy',
    html: `<div class="glow"></div>
           <div class="copy">
             <h1>Nothing is captured <em>until you start</em></h1>
             <p>Audio is read only while a session is running, and only from the tab you
                chose. Close the panel and capture stops.</p>
           </div>
           <div class="panel" style="height:272px;top:264px;border-radius:16px">
             <img src="${img.loggedout}" style="top:0">
           </div>`,
  },
];

const browser = await chromium.launch();
for (const shot of SHOTS) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.setContent(`<style>${CSS}</style><div class="wrap">${shot.html}</div>`);
  await page.waitForLoadState('networkidle');
  await page.screenshot({ path: join(OUT, `store-${shot.name}.png`) });
  console.info(`store-${shot.name}.png`);
  await page.close();
}
await browser.close();
