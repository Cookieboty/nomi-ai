#!/usr/bin/env node
/**
 * 角色名扫描（CI，docs/design/core-host-decoupling.md §11.2）：官方角色名只能在官方角色包
 * `characters/nomi` 与产品品牌模块里出现。产品名统一用 `brand.appName`（`@nomi-ai/types`）；
 * 角色名、人设、台词从当前角色包读。判定规则（`诺米`、角色语境下的 `Nomi`）见 ./lib/characterLeak.mjs。
 *
 * 扫描范围：会进产物的源码与文案——`packages/<pkg>/src`、`packages/<pkg>/config`、`packages/<pkg>/public`、
 * `packages/<pkg>/index.html`、`packages/host-electron/electron-builder.yml`、其它角色包
 * `characters/<id>`（`nomi` 除外；那里任何 `Nomi` 都算，包里没有产品语境）。
 * 测试、文档、构建产物不扫（测试里需要写官方名来断言它不出现）。
 *
 * 允许清单写在下面的 ALLOW 里，每一条都要写理由；只放确实不能改的地方。
 *
 * 用法：node scripts/check-character-leak.mjs [--root <dir>]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { findCharacterLeaks } from './lib/characterLeak.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 官方角色包与产品品牌模块：本来就该有官方名 */
export const OWNERS = ['characters/nomi/', 'packages/types/src/brand.ts'];

/**
 * 允许清单：`file`（相对仓库根）+ `match`（命中的片段，字符串全等）+ `reason`。
 * @type {{ file: string; match: string; reason: string }[]}
 */
export const ALLOW = [];

const SCAN_DIRS = ['src', 'config', 'public'];
const SCAN_PKG_FILES = ['index.html'];
const SCAN_FILES = ['packages/host-electron/electron-builder.yml'];
const TEXT_EXT = /\.(?:[cm]?[jt]sx?|json|ya?ml|html|css|md|txt)$/;
const SKIP_DIR = /^(?:node_modules|dist|coverage|tests?|__tests__|__mocks__|\.turbo)$/;
const SKIP_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;

function walk(dir, out) {
  if (!fs.existsSync(dir)) return out;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (!SKIP_DIR.test(ent.name)) walk(p, out);
    } else if (TEXT_EXT.test(ent.name) && !SKIP_FILE.test(ent.name)) {
      out.push(p);
    }
  }
  return out;
}

/** 要扫的文件（绝对路径） */
export function scanTargets(root) {
  const files = [];
  const pkgs = path.join(root, 'packages');
  if (fs.existsSync(pkgs)) {
    for (const pkg of fs.readdirSync(pkgs).sort()) {
      for (const d of SCAN_DIRS) walk(path.join(pkgs, pkg, d), files);
      for (const f of SCAN_PKG_FILES) {
        const p = path.join(pkgs, pkg, f);
        if (fs.existsSync(p)) files.push(p);
      }
    }
  }
  for (const f of SCAN_FILES) if (fs.existsSync(path.join(root, f))) files.push(path.join(root, f));
  const chars = path.join(root, 'characters');
  if (fs.existsSync(chars)) {
    for (const id of fs.readdirSync(chars).sort()) {
      if (id !== 'nomi') walk(path.join(chars, id), files);
    }
  }
  return files;
}

const rel = (root, file) => path.relative(root, file).split(path.sep).join('/');

/**
 * @param {{ root: string; allow?: typeof ALLOW }} opts
 * @returns {{ leaks: { file: string; line: number; match: string; text: string }[]; unusedAllow: typeof ALLOW }}
 */
export function checkCharacterLeak({ root, allow = ALLOW }) {
  const leaks = [];
  const used = new Set();
  for (const file of scanTargets(root)) {
    const r = rel(root, file);
    if (OWNERS.some((o) => (o.endsWith('/') ? r.startsWith(o) : r === o))) continue;
    const anyNomi = r.startsWith('characters/');
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((text, i) => {
      for (const match of findCharacterLeaks(text, { anyNomi })) {
        const a = allow.find((x) => x.file === r && x.match === match);
        if (a) {
          used.add(a);
          continue;
        }
        leaks.push({ file: r, line: i + 1, match, text: text.trim().slice(0, 160) });
      }
    });
  }
  return { leaks, unusedAllow: allow.filter((a) => !used.has(a)) };
}

function main() {
  const i = process.argv.indexOf('--root');
  const root = i > 0 ? path.resolve(process.argv[i + 1]) : path.resolve(HERE, '..');
  const { leaks, unusedAllow } = checkCharacterLeak({ root });
  for (const l of leaks) {
    console.error(`${l.file}:${l.line}: 角色名「${l.match}」 → ${l.text}`);
  }
  for (const a of unusedAllow) {
    console.error(`允许清单里的条目没有命中（删掉它）：${a.file} 「${a.match}」`);
  }
  if (leaks.length || unusedAllow.length) {
    console.error(
      `\n✗ ${leaks.length} 处官方角色名出现在 characters/nomi 与品牌模块之外。` +
        '产品名用 brand.appName（@nomi-ai/types）；角色名、人设、台词从当前角色包读' +
        '（docs/design/core-host-decoupling.md §10.1、§11.2）。确实不能改的，加进 scripts/check-character-leak.mjs 的 ALLOW 并写理由。',
    );
    process.exit(1);
  }
  console.info('✓ character leak check passed');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
