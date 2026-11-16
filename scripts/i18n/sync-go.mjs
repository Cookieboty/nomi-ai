#!/usr/bin/env node
/**
 * 把 TS 侧的词典同步到 Go 内核那一份（`dict_test.go` 会比对两份，手抄必然会漂）。
 *
 *   node scripts/i18n/sync-go.mjs           写入 Go 侧（TS 是唯一数据源）
 *   node scripts/i18n/sync-go.mjs --check   只检查，有差异时退出 1（CI 用）
 *
 * 只做逐字节复制：两份内容必须完全一致，Go 侧不留任何本地改动。
 */
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const SRC = join(root, 'packages/i18n/src/locales');
const DST = join(root, 'apps/desktop-go/internal/core/i18n/locales');
const check = process.argv.includes('--check');

/** @returns {string[]} 相对路径，排序后返回 */
function walk(dir, base = dir, out = []) {
  for (const name of readdirSync(dir).sort()) {
    const file = join(dir, name);
    if (statSync(file).isDirectory()) walk(file, base, out);
    else out.push(relative(base, file).replaceAll('\\', '/'));
  }
  return out.sort();
}

const srcFiles = walk(SRC);
const dstFiles = walk(DST);
const onlySrc = srcFiles.filter((f) => !dstFiles.includes(f));
const onlyDst = dstFiles.filter((f) => !srcFiles.includes(f));
const differ = srcFiles
  .filter((f) => dstFiles.includes(f))
  .filter((f) => readFileSync(join(SRC, f), 'utf8') !== readFileSync(join(DST, f), 'utf8'));

if (check) {
  if (onlySrc.length || onlyDst.length || differ.length) {
    console.error('i18n: Go 侧词典与 packages/i18n/src/locales 不一致，跑 `pnpm i18n:sync`：');
    for (const f of onlySrc) console.error(`  缺 ${f}`);
    for (const f of onlyDst) console.error(`  多 ${f}`);
    for (const f of differ) console.error(`  内容不同 ${f}`);
    process.exit(1);
  }
  console.log(`i18n: Go 侧 ${dstFiles.length} 个词典文件与 TS 一致`);
} else {
  for (const f of onlyDst) rmSync(join(DST, f));
  for (const f of srcFiles) {
    const target = join(DST, f);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(SRC, f), target);
  }
  console.log(
    `i18n: Go 侧已按 TS 同步 ${srcFiles.length} 个文件（新增 ${onlySrc.length}、更新 ${differ.length}、删除 ${onlyDst.length}）`,
  );
}
