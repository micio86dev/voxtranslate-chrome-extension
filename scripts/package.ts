/**
 * Produce the Chrome Web Store upload ZIP from `dist/`.
 *
 * Refuses to package a build that is missing a manifest-declared file, because the
 * store rejects those after upload — much later, and much more annoyingly.
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { $ } from 'bun';

const DIST = 'dist';
const OUT_DIR = 'release';

if (!existsSync(DIST)) {
  console.error('dist/ not found — run `bun run build` first.');
  process.exit(1);
}

const manifestPath = join(DIST, 'manifest.json');
if (!existsSync(manifestPath)) {
  console.error('dist/manifest.json not found — the build did not emit a manifest.');
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
  version: string;
  background?: { service_worker?: string };
  side_panel?: { default_path?: string };
  icons?: Record<string, string>;
};

// Every path the manifest promises Chrome must actually exist in the bundle.
const required = [
  manifest.background?.service_worker,
  manifest.side_panel?.default_path,
  ...Object.values(manifest.icons ?? {}),
  'content/overlay.js',
  'offscreen/document.html',
  'offscreen/index.js',
].filter((p): p is string => typeof p === 'string');

const missing = required.filter((p) => !existsSync(join(DIST, p)));
if (missing.length > 0) {
  console.error('Refusing to package — files referenced by the manifest are missing:');
  for (const p of missing) console.error(`  - ${p}`);
  process.exit(1);
}

mkdirSync(OUT_DIR, { recursive: true });
const zipName = `voxtranslate-chrome-${manifest.version}.zip`;
const zipPath = join(OUT_DIR, zipName);

await $`rm -f ${zipPath}`;
// -r recurse, -X drop macOS resource forks the store flags as junk.
await $`cd ${DIST} && zip -rXq ../${zipPath} .`;

console.warn(`Packaged ${zipPath}`);
console.warn(
  'Upload manually at https://chrome.google.com/webstore/devconsole — nothing is published automatically.',
);
