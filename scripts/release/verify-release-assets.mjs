#!/usr/bin/env node
/* eslint-disable no-console -- CI 脚本 */
/**
 * 发布前核对 GitHub Release 的自动更新载荷（#146）。
 *
 * tag 构建的三端 job 把安装包 + latest*.yml 上传到 **draft** Release；全部成功后由
 * ci.yml 的 `publish-release` job 运行本脚本，确认：
 * - latest.yml（Windows）/ latest-mac.yml / latest-linux.yml 三个清单都在；
 * - 每个清单的 version 与 tag 一致；
 * - 清单 files[].url 与 path 列出的文件都已作为 asset 上传。
 * 通过后才 `gh release edit <tag> --draft=false`，已安装的客户端此时才看得到新版本——
 * 避免「Release 已可见但本平台 latest.yml 还没上传」导致检查更新 404。
 *
 * 用法：node scripts/release/verify-release-assets.mjs <tag> [--repo owner/name]
 *   需要 gh（GH_TOKEN）。有缺失时打印 ::error:: 并退出码 1。
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { parseUpdateInfo } from './check-mac-update.mjs';

/** 三端 electron-updater 读取的清单（GitHubProvider：win=latest.yml，mac/linux 带后缀） */
export const REQUIRED_MANIFESTS = ['latest.yml', 'latest-mac.yml', 'latest-linux.yml'];

/** 顶层 path:（老版本 electron-updater 仍会读） */
function topLevelPath(text) {
  const m = /^path:\s*(.+)$/m.exec(text);
  return m ? m[1].trim().replace(/^(['"])(.*)\1$/, '$2') : undefined;
}

/**
 * @param {string[]} assetNames Release 上已有的 asset 名
 * @param {Record<string, string>} manifests 已下载的清单内容（文件名 → 文本）
 * @param {string | undefined} expectedVersion 不带 v 的版本号
 * @returns {{ errors: string[] }}
 */
export function verifyReleaseAssets(assetNames, manifests, expectedVersion) {
  const errors = [];
  const have = new Set(assetNames);
  for (const name of REQUIRED_MANIFESTS) {
    if (!have.has(name) || manifests[name] == null) {
      errors.push(`missing ${name}`);
      continue;
    }
    const text = manifests[name];
    const info = parseUpdateInfo(text);
    if (expectedVersion && info.version !== expectedVersion) {
      errors.push(`${name}: version ${info.version ?? '(none)'} != ${expectedVersion}`);
    }
    const listed = info.files.map((f) => f.url).filter(Boolean);
    if (listed.length === 0) errors.push(`${name}: no files listed`);
    const p = topLevelPath(text);
    for (const url of new Set([...listed, ...(p ? [p] : [])])) {
      if (!have.has(url)) errors.push(`${name}: listed file not uploaded: ${url}`);
    }
  }
  return { errors };
}

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const argv = process.argv.slice(2);
  const tag = argv.find((a) => !a.startsWith('--'));
  const ri = argv.indexOf('--repo');
  const repoArgs = ri >= 0 && argv[ri + 1] ? ['--repo', argv[ri + 1]] : [];
  if (!tag) {
    console.error('usage: verify-release-assets.mjs <tag> [--repo owner/name]');
    process.exit(2);
  }
  const view = JSON.parse(gh(['release', 'view', tag, ...repoArgs, '--json', 'assets']));
  const assetNames = (view.assets ?? []).map((a) => a.name);
  const dir = mkdtempSync(path.join(tmpdir(), 'release-assets-'));
  const manifests = {};
  for (const name of REQUIRED_MANIFESTS) {
    if (!assetNames.includes(name)) continue;
    gh(['release', 'download', tag, ...repoArgs, '--pattern', name, '--dir', dir, '--clobber']);
    manifests[name] = readFileSync(path.join(dir, name), 'utf8');
  }
  const { errors } = verifyReleaseAssets(assetNames, manifests, tag.replace(/^v/, ''));
  console.log(`assets on ${tag}: ${assetNames.length}`);
  for (const e of errors) console.log(`::error::${e}`);
  if (errors.length) process.exit(1);
  console.log(`OK: ${REQUIRED_MANIFESTS.join(', ')} present and complete`);
}
