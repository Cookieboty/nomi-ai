/**
 * Load `@nomi-ai/character-contract/node` from its build output.
 *
 * Root scripts (character:check, check:i18n, vite configs) run before `turbo build` in CI, so when
 * dist/ is missing the package is built once with its own build script.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { ROOT } from './paths.mjs';

const PKG = join(ROOT, 'packages/character-contract');
const NODE_ENTRY = join(PKG, 'dist/node.js');

let loaded = null;

/** @returns {Promise<typeof import('../../packages/character-contract/src/node')>} */
export function loadContract() {
  if (!loaded) {
    if (!existsSync(NODE_ENTRY)) {
      execFileSync(process.execPath, [join(ROOT, 'scripts/run-bin.mjs'), 'tsup'], {
        cwd: PKG,
        stdio: ['ignore', 'ignore', 'inherit'],
      });
    }
    loaded = import(pathToFileURL(NODE_ENTRY).href);
  }
  return loaded;
}
