/**
 * Re-sync the language catalogue from the main VoxTranslate repo.
 *
 * `server/src/engine/languages.json` is the single source of truth shared by the Rust
 * backend and the web client. Copying it (rather than re-typing a list) is what keeps
 * the extension's picker from drifting away from what the engines can actually produce.
 */

import { copyFileSync, existsSync } from 'node:fs';

const SOURCE = '../server/src/engine/languages.json';
const DEST = 'src/types/languages.json';

if (!existsSync(SOURCE)) {
  console.error(
    `Source catalogue not found at ${SOURCE}.\n` +
      'Run this from inside the VoxTranslate workspace, where the extension is a submodule ' +
      'alongside `server/`.',
  );
  process.exit(1);
}

copyFileSync(SOURCE, DEST);
console.warn(`Synced ${SOURCE} → ${DEST}`);
console.warn('Run `bun run test` — the tier/legacy-language invariants are asserted there.');
