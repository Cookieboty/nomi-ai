#!/usr/bin/env node
/* eslint-disable no-console -- CI 脚本 */
/**
 * macOS 自动更新载荷检查（#21）：tag 构建打包后运行。
 *
 * electron-updater 的 MacUpdater 只会从 latest-mac.yml 的 files 里挑 zip；漏了某个架构的 zip、
 * 文件名 / 大小 / sha512 对不上，已安装的版本就会在「下载」一步失败。这里逐项核对：
 * - latest-mac.yml 存在，version 与 apps/desktop-electron/package.json 一致；
 * - files 里 x64 与 arm64 各有一个 .zip；
 * - 每个列出的文件都在 dist/ 里，大小与 sha512（base64）都对得上。
 * 另外：未签名的 macOS 构建 Squirrel.Mac 不会接受，打印 ::warning::（不让发布失败，与 signing-env 一致）。
 *
 * 用法：node scripts/release/check-mac-update.mjs [distDir]   有错误时退出码 1
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** 只解析 electron-builder 写出的 latest-mac.yml 结构：顶层标量 + files 列表（url / sha512 / size） */
export function parseUpdateInfo(text) {
  const info = { version: undefined, files: [] };
  let inFiles = false;
  let cur = null;
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    const top = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(raw);
    if (top) {
      inFiles = top[1] === 'files';
      if (top[1] === 'version') info.version = unquote(top[2]);
      continue;
    }
    if (!inFiles) continue;
    const item = /^\s*-\s+([A-Za-z0-9_]+):\s*(.*)$/.exec(raw);
    const field = /^\s+([A-Za-z0-9_]+):\s*(.*)$/.exec(raw);
    if (item) {
      cur = {};
      info.files.push(cur);
      cur[item[1]] = unquote(item[2]);
    } else if (field && cur) {
      cur[field[1]] = unquote(field[2]);
    }
  }
  return info;
}

const unquote = (v) => v.trim().replace(/^(['"])(.*)\1$/, '$2');

const isArm = (url) => /arm64/i.test(url);

/** @returns {{ errors: string[], warnings: string[] }} */
export function checkMacUpdate(distDir, expectedVersion, env = {}) {
  const errors = [];
  const warnings = [];
  const yml = path.join(distDir, 'latest-mac.yml');
  if (!existsSync(yml)) return { errors: [`missing ${yml}`], warnings };
  const info = parseUpdateInfo(readFileSync(yml, 'utf8'));
  if (expectedVersion && info.version !== expectedVersion)
    errors.push(`latest-mac.yml version ${info.version} != package version ${expectedVersion}`);
  const zips = info.files.filter((f) => /\.zip$/i.test(f.url ?? ''));
  if (!zips.some((f) => isArm(f.url))) errors.push('latest-mac.yml lists no arm64 .zip');
  if (!zips.some((f) => !isArm(f.url))) errors.push('latest-mac.yml lists no x64 .zip');
  for (const f of info.files) {
    if (!f.url) {
      errors.push('latest-mac.yml has a files entry without url');
      continue;
    }
    const file = path.join(distDir, decodeURIComponent(f.url));
    if (!existsSync(file)) {
      errors.push(`${f.url} is listed but not in ${distDir}`);
      continue;
    }
    const size = statSync(file).size;
    if (f.size !== undefined && Number(f.size) !== size)
      errors.push(`${f.url}: size ${size} != ${f.size}`);
    if (!f.sha512) errors.push(`${f.url}: no sha512`);
    else if (createHash('sha512').update(readFileSync(file)).digest('base64') !== f.sha512)
      errors.push(`${f.url}: sha512 mismatch`);
  }
  if (!env.CSC_LINK)
    warnings.push(
      'macOS build is unsigned (no CSC_LINK): Squirrel.Mac rejects unsigned updates, so auto-update will fail for this release',
    );
  return { errors, warnings };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const dist = path.resolve(process.argv[2] ?? path.join(root, 'dist'));
  const { version } = JSON.parse(
    readFileSync(path.join(root, 'apps/desktop-electron/package.json'), 'utf8'),
  );
  const { errors, warnings } = checkMacUpdate(dist, version, process.env);
  for (const w of warnings) console.log(`::warning::${w}`);
  for (const e of errors) console.log(`::error::${e}`);
  console.log(`[mac-update] ${errors.length ? 'FAILED' : 'ok'} (${dist})`);
  if (errors.length) process.exit(1);
}
