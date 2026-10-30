/* eslint-disable no-console -- standalone CI reporter */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const maxLines = 1200;
const sourceRoots = [
  'packages/ui/src',
  'packages/ai-chat/src',
  'packages/renderer/src',
  'packages/avatar-runtime/src',
];
const allowed = new Map([
  [
    'packages/avatar-runtime/src/layeredRig.ts',
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

// 设计令牌：引用的 var(--cd-*) 必须有定义，否则样式永远落到写死的回退值、不跟主题
// （定义处：tokens.css / 主题 / 组件里的 `--cd-x:`；运行时由代码设置的变量列在 runtimeTokens）
const runtimeTokens = /^--cd-chat-bg-/;
const defined = new Set();
const uses = [];
for (const sourceRoot of sourceRoots) {
  for (const file of walk(sourceRoot)) {
    if (file.endsWith('.json')) continue;
    const text = readFileSync(join(root, file), 'utf8');
    for (const m of text.matchAll(/(--cd-[\w-]+)\s*:/g)) defined.add(m[1]);
    text.split(/\r?\n/).forEach((line, i) => {
      for (const m of line.matchAll(/var\((--cd-[\w-]+)/g))
        uses.push({ file, line: i + 1, name: m[1] });
    });
  }
}
const undefinedTokens = uses.filter((u) => !defined.has(u.name) && !runtimeTokens.test(u.name));
if (undefinedTokens.length) {
  console.error('frontend standard: var(--cd-*) must reference a defined design token');
  for (const u of undefinedTokens) console.error(`  ${u.file}:${u.line}: ${u.name}`);
  process.exit(1);
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
console.log(
  `frontend standard: ${sourceRoots.length} source roots checked; max ${maxLines} lines; ${uses.length} token references defined`,
);
