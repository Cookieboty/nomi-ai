#!/usr/bin/env node
/**
 * Resolve a package CLI from the workspace root and run it.
 *
 * Why: on Windows, pnpm's package-local `.bin/*.cmd` shims often point at
 * `packages/<pkg>/node_modules/<tool>/bin/...` even when the tool is only
 * hoisted to the repo root. That yields:
 *   Error: Cannot find module '...\packages\ai-chat\node_modules\vite\bin\vite.js'
 *
 * Usage (from any packages/* script):
 *   node ../../scripts/run-bin.mjs vite
 *   node ../../scripts/run-bin.mjs vite build
 *   node ../../scripts/run-bin.mjs tsup --watch
 *   node ../../scripts/run-bin.mjs tsc -p tsconfig.json
 *   node ../../scripts/run-bin.mjs vitest run
 *   node ../../scripts/run-bin.mjs rimraf dist
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const requireFromRoot = createRequire(path.join(root, 'package.json'));

/** binName → [npmPackage, binKey] */
const ALIASES = {
  tsc: ['typescript', 'tsc'],
  tsserver: ['typescript', 'tsserver'],
  vite: ['vite', 'vite'],
  tsup: ['tsup', 'tsup'],
  vitest: ['vitest', 'vitest'],
  rimraf: ['rimraf', 'rimraf'],
};

const argv = process.argv.slice(2);
const binName = argv.shift();
if (!binName || binName === '--help' || binName === '-h') {
  console.error(
    'Usage: node scripts/run-bin.mjs <bin> [...args]\n' +
      `Known: ${Object.keys(ALIASES).join(', ')} (or any package whose package.json has "bin")`,
  );
  process.exit(binName ? 0 : 1);
}

function resolveBin(name) {
  const [pkgName, binKey] = ALIASES[name] ?? [name, name];
  let pkgJsonPath;
  try {
    pkgJsonPath = requireFromRoot.resolve(`${pkgName}/package.json`);
  } catch (err) {
    console.error(
      `[run-bin] Cannot resolve package "${pkgName}" from the workspace root.\n` +
        '  → From the repo root: rm -rf node_modules packages/*/node_modules && pnpm install\n' +
        '  → Or: corepack enable && corepack prepare pnpm@9.12.3 --activate && pnpm install',
    );
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
  const pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
  const pkgDir = path.dirname(pkgJsonPath);
  const binField = pkgJson.bin;
  let rel;
  if (typeof binField === 'string') rel = binField;
  else if (binField && typeof binField === 'object') {
    rel = binField[binKey] ?? binField[name] ?? binField[pkgName];
  }
  if (!rel) {
    console.error(
      `[run-bin] Package "${pkgName}" has no bin "${binKey}". bins=${JSON.stringify(binField)}`,
    );
    process.exit(1);
  }
  const abs = path.resolve(pkgDir, rel);
  if (!existsSync(abs)) {
    console.error(`[run-bin] Bin file missing: ${abs}`);
    process.exit(1);
  }
  return abs;
}

const binPath = resolveBin(binName);
const childEnv = { ...process.env };
// Turbo runs package scripts through pnpm. On restricted Windows sandboxes pnpm's
// bundled runtime can fail while realpath-resolving the user temp directory; keep
// the build's transient files inside the workspace instead. Opt-in only
// (NOMI_WORKSPACE_TMP=1): a temp dir inside the repo makes tests' "outside a repo"
// fixtures resolve to this repo, so git worktree / exclude writes hit the real .git.
if (binName === 'turbo' && process.env.NOMI_WORKSPACE_TMP === '1') {
  const workspaceTmp = path.join(root, '.tmp', 'turbo-runtime');
  mkdirSync(workspaceTmp, { recursive: true });
  childEnv.TEMP = workspaceTmp;
  childEnv.TMP = workspaceTmp;
}

const result = spawnSync(process.execPath, [binPath, ...argv], {
  stdio: 'inherit',
  cwd: process.cwd(),
  env: childEnv,
  windowsHide: true,
});
if (result.error) {
  console.error(`[run-bin] Failed to start ${binName}:`, result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
