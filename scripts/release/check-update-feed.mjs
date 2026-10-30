#!/usr/bin/env node
/* eslint-disable no-console -- CI 脚本 */
/**
 * 2.0.4 → Go 版的更新元数据检查：用 2.0.4 自带的 electron-updater（6.8.9，apps/desktop-electron 的依赖）
 * 自己的解析与选包逻辑读 latest.yml / latest-mac.yml / latest-linux.yml，确认每个平台挑中的就是 Go 版的安装包，
 * 且 sha512 / size 与目录里的文件一致（不一致时 2.0.4 下载后校验失败，更新卡住）。
 *   - Windows：NsisUpdater → findFile(files, 'exe')
 *   - macOS：MacUpdater.filterFilesForArch（arm64 / x64）→ findFile(files, 'zip', ['pkg', 'dmg'])
 *   - Linux：AppImageUpdater → findFile(files, 'AppImage', ['rpm', 'deb', 'pacman'])
 *
 * 用法：node scripts/release/check-update-feed.mjs <dir> <version>   有错误时退出码 1
 */
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const req = createRequire(path.join(root, 'apps/desktop-electron/package.json'));
const { parseUpdateInfo, resolveFiles, findFile } = req(
  'electron-updater/out/providers/Provider.js',
);
const { MacUpdater } = req('electron-updater/out/MacUpdater.js');

const sha512 = (p) =>
  new Promise((resolve, reject) => {
    const h = createHash('sha512');
    createReadStream(p)
      .on('data', (b) => h.update(b))
      .on('end', () => resolve(h.digest('base64')))
      .on('error', reject);
  });

/** @returns {Promise<string[]>} errors */
export async function checkUpdateFeed(dir, version) {
  const base = new URL('https://github.com/Cookieboty/nomi-ai/releases/download/v' + version + '/');
  const cases = [
    {
      yml: 'latest.yml',
      label: 'windows',
      want: `Nomi-Setup-${version}.exe`,
      pick: (f) => findFile(f, 'exe'),
    },
    {
      yml: 'latest-mac.yml',
      label: 'mac arm64',
      want: `Nomi-${version}-arm64-mac.zip`,
      pick: (f) => findFile(MacUpdater.filterFilesForArch(f, true), 'zip', ['pkg', 'dmg']),
    },
    {
      yml: 'latest-mac.yml',
      label: 'mac x64',
      want: `Nomi-${version}-mac.zip`,
      pick: (f) => findFile(MacUpdater.filterFilesForArch(f, false), 'zip', ['pkg', 'dmg']),
    },
    {
      yml: 'latest-linux.yml',
      label: 'linux',
      want: `Nomi-${version}.AppImage`,
      pick: (f) => findFile(f, 'AppImage', ['rpm', 'deb', 'pacman']),
    },
  ];
  const errors = [];
  for (const c of cases) {
    const p = path.join(dir, c.yml);
    if (!existsSync(p)) {
      errors.push(`${c.label}: missing ${c.yml}`);
      continue;
    }
    let info;
    try {
      info = parseUpdateInfo(readFileSync(p, 'utf8'), c.yml, new URL(c.yml, base));
    } catch (e) {
      errors.push(`${c.label}: ${c.yml} does not parse: ${e.message}`);
      continue;
    }
    if (info.version !== version)
      errors.push(`${c.label}: ${c.yml} version ${info.version} != ${version}`);
    const file = c.pick(resolveFiles(info, base));
    const name = file ? decodeURIComponent(path.posix.basename(file.url.pathname)) : null;
    if (name !== c.want) {
      errors.push(`${c.label}: updater would download ${name ?? '(nothing)'}, expected ${c.want}`);
      continue;
    }
    const local = path.join(dir, name);
    if (!existsSync(local)) {
      errors.push(`${c.label}: ${name} is listed but not in ${dir}`);
      continue;
    }
    if (Number(file.info.size) !== statSync(local).size)
      errors.push(`${c.label}: ${name} size ${file.info.size} != ${statSync(local).size}`);
    if (file.info.sha512 !== (await sha512(local)))
      errors.push(`${c.label}: ${name} sha512 mismatch`);
  }
  return errors;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [dir, version] = process.argv.slice(2);
  if (!dir || !version) {
    console.error('usage: check-update-feed.mjs <dir> <version>');
    process.exit(2);
  }
  const errors = await checkUpdateFeed(dir, version);
  for (const e of errors) console.log(`::error::${e}`);
  if (errors.length) process.exit(1);
  console.log(
    `update feed OK: 2.0.4 (electron-updater) picks the Go ${version} installers on every platform`,
  );
}
