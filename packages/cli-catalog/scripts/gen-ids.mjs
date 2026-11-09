#!/usr/bin/env node
/**
 * 生成 src/generated/ids.ts：内置插件的 id 列表与 BuiltinCliId 类型（P9.4）。
 * 内置插件 = src/ 下含 manifest.ts 的目录（目录名就是 id）。
 * 用法：node scripts/gen-ids.mjs        写入
 *       node scripts/gen-ids.mjs --check 只检查是否最新（测试 / CI 用）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'src');
const out = path.join(src, 'generated', 'ids.ts');

/** 与 prettier（printWidth 100）的排版一致：放得下就一行，否则每个 id 一行（提交时 prettier 不再改它） */
function idsLine(ids) {
  const one = `export const BUILTIN_CLI_IDS = [${ids.map((i) => `'${i}'`).join(', ')}] as const;`;
  if (one.length <= 100) return one;
  return ['export const BUILTIN_CLI_IDS = [', ...ids.map((i) => `  '${i}',`), '] as const;'].join(
    '\n',
  );
}

export function render() {
  const ids = fs
    .readdirSync(src, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(src, d.name, 'manifest.ts')))
    .map((d) => d.name)
    .sort();
  return [
    '// 由 scripts/gen-ids.mjs 生成，不要手改（pnpm -F @nomi-ai/cli-catalog gen:ids）',
    '',
    '/** 内置插件的 id（目录名） */',
    idsLine(ids),
    '',
    'export type BuiltinCliId = (typeof BUILTIN_CLI_IDS)[number];',
    '',
  ].join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const text = render();
  if (process.argv.includes('--check')) {
    const cur = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : '';
    if (cur !== text) {
      console.error(
        'src/generated/ids.ts is out of date: run pnpm -F @nomi-ai/cli-catalog gen:ids',
      );
      process.exit(1);
    }
  } else {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, text);
  }
}
