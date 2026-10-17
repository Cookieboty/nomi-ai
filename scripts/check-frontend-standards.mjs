/* eslint-disable no-console -- standalone CI reporter */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const maxLines = 1200;
const sourceRoots = ['packages/ui/src', 'packages/ai-chat/src', 'packages/renderer/src'];
const allowed = new Map([
  [
    'packages/renderer/src/mascot/layeredRig.ts',
    'Canvas2D rig engine: tightly coupled animation and painting pipeline; split only with a rendering design change.',
  ],
]);
const extensions = new Set(['.ts', '.tsx', '.css', '.json']);

function walk(dir) {
  const files = [];
  for (const name of readdirSync(join(root, dir))) {
    const path = join(dir, name);
    const absolute = join(root, path);
    if (statSync(absolute).isDirectory()) files.push(...walk(path));
    else if (extensions.has(name.slice(name.lastIndexOf('.')))) files.push(path);
  }
  return files;
}

const violations = [];
for (const sourceRoot of sourceRoots) {
  for (const file of walk(sourceRoot)) {
    const lines = readFileSync(join(root, file), 'utf8').split(/\r?\n/).length - 1;
    const normalized = file.replaceAll('\\', '/');
    if (lines > maxLines && !allowed.has(normalized)) violations.push({ file, lines });
  }
}

if (violations.length) {
  console.error(`frontend standard: files must be <= ${maxLines} lines`);
  for (const item of violations) console.error(`  ${item.file}: ${item.lines} lines`);
  process.exit(1);
}

for (const [file, reason] of allowed) {
  const lines = readFileSync(join(root, file), 'utf8').split(/\r?\n/).length - 1;
  if (lines > maxLines)
    console.log(`frontend standard: exception ${file} (${lines} lines) — ${reason}`);
}
console.log(`frontend standard: ${sourceRoots.length} source roots checked; max ${maxLines} lines`);
