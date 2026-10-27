#!/usr/bin/env node
/* eslint-disable no-console -- CLI 脚本 */
/**
 * 发布前校验 GitHub Release 资产齐全（#146）：
 *   node scripts/release/check-release-assets.mjs <dir-with-latest*.yml> <assets.txt>
 * assets.txt 每行一个 Release 资产名。三个 latest*.yml 都必须在；每个 yml 里 url / path 引用的文件都必须在
 * Release 里；Windows 安装包（.exe）和 macOS 更新包（.zip）还必须有对应的 .blockmap（差分更新用）。
 * AppImage 不单独上传 blockmap（内嵌），dmg 的 blockmap 只提示不强制。
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const UPDATE_FILES = ['latest.yml', 'latest-mac.yml', 'latest-linux.yml'];

/** 取出 yml 里所有 url: / path: 的值（electron-builder 生成的格式，单行标量） */
export function referencedFiles(yml) {
  const out = new Set();
  for (const line of yml.split(/\r?\n/)) {
    const m = /^\s*(?:-\s+)?(?:url|path):\s*(.+?)\s*$/.exec(line);
    if (!m) continue;
    let v = m[1].replace(/^['"]|['"]$/g, '');
    try {
      v = decodeURIComponent(v);
    } catch {
      /* keep raw */
    }
    out.add(v);
  }
  return [...out];
}

/** 返回缺失项列表（空数组 = 齐全） */
export function missingAssets(ymlByName, assetNames) {
  const assets = new Set(assetNames);
  const missing = [];
  for (const name of UPDATE_FILES) {
    if (!assets.has(name) || ymlByName[name] == null) {
      missing.push(name);
      continue;
    }
    const refs = referencedFiles(ymlByName[name]);
    if (!refs.length) missing.push(`${name}: no url/path entries`);
    for (const f of refs) {
      if (!assets.has(f)) missing.push(`${f} (listed in ${name})`);
      if (/\.(exe|zip)$/i.test(f) && !assets.has(`${f}.blockmap`)) {
        missing.push(`${f}.blockmap (for ${name})`);
      }
    }
  }
  return [...new Set(missing)];
}

function main() {
  const [dir, assetsFile] = process.argv.slice(2);
  if (!dir || !assetsFile) {
    console.error('usage: check-release-assets.mjs <yml-dir> <assets.txt>');
    process.exit(2);
  }
  const assetNames = readFileSync(assetsFile, 'utf8')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  const yml = {};
  for (const name of UPDATE_FILES) {
    const p = join(dir, name);
    if (existsSync(p)) yml[name] = readFileSync(p, 'utf8');
  }
  const missing = missingAssets(yml, assetNames);
  for (const name of UPDATE_FILES) {
    for (const f of yml[name] ? referencedFiles(yml[name]) : []) {
      if (/\.dmg$/i.test(f) && !assetNames.includes(`${f}.blockmap`)) {
        console.log(`::warning::${f}.blockmap is not attached (optional)`);
      }
    }
  }
  if (missing.length) {
    for (const m of missing) console.log(`::error::Release is missing ${m}`);
    process.exit(1);
  }
  console.log(
    `All update files and the installers they reference are attached (${assetNames.length} assets).`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
