#!/usr/bin/env node

/**
 * 远程角色目录：把 characters/* 里声明为远程（manifest `assets.remote`）的素材整理成可上传的文件。
 *
 *   node scripts/character/remote-catalog.mjs --out <dir> [--base-url <url>]
 *
 * 产出（全部上传到 GitHub Release `characters`，见 .github/workflows/characters-publish.yml）：
 *   - 素材文件，按内容命名 `<id>-<kind>-<sha256 前 12 位><扩展名>`：内容不变文件名就不变，覆盖上传也不会影响
 *     已经下载过的客户端；
 *   - catalog.json（schemaVersion 1）：
 *       { schemaVersion, generatedAt,
 *         packs: [{ id, version, assets: { rive: { file, url, size, sha256 } } }] }
 * 客户端（Go internal/core/characterassets、Node core/src/character/CharacterAssets.ts）切到 Rive 时读它，
 * 本地缓存的 sha256 不一致就下载新的。以后角色商店在这份目录里加条目。
 */
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { extname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { loadPack, remoteFilesOf } from './pack.mjs';
import { CHARACTERS_DIR } from './paths.mjs';

export const DEFAULT_BASE_URL =
  'https://github.com/Cookieboty/nomi-ai/releases/download/characters';

/** @returns {Promise<{ catalog: object, files: Array<{ src: string, name: string }> }>} */
export async function buildCatalog({
  baseUrl = DEFAULT_BASE_URL,
  charactersDir = CHARACTERS_DIR,
} = {}) {
  const packs = [];
  const files = [];
  // 有 manifest.json 的目录才是角色包；读不出来就报错，不能静默产出缺角色的目录
  const dirs = readdirSync(charactersDir)
    .map((name) => join(charactersDir, name))
    .filter((d) => statSync(d).isDirectory() && existsSync(join(d, 'manifest.json')))
    .sort();
  for (const dir of dirs) {
    const { pack } = await loadPack(dir);
    const remote = remoteFilesOf(pack);
    if (remote.length === 0) continue;
    const assets = {};
    for (const { kind, rel } of remote) {
      const src = join(dir, ...rel.split('/'));
      const buf = readFileSync(src);
      // 大文件走 Git LFS：没拉取时这里只是指针文本（CI checkout 要 lfs: true，本地 git lfs pull）
      if (buf.subarray(0, 40).toString('utf8').startsWith('version https://git-lfs.github.com/')) {
        throw new Error(
          `${src} is a Git LFS pointer; fetch LFS files first (checkout lfs: true / git lfs pull)`,
        );
      }
      const sha256 = createHash('sha256').update(buf).digest('hex');
      const name = `${pack.manifest.id}-${kind}-${sha256.slice(0, 12)}${extname(rel)}`;
      files.push({ src, name });
      assets[kind] = { file: name, url: `${baseUrl}/${name}`, size: buf.length, sha256 };
    }
    packs.push({ id: pack.manifest.id, version: pack.manifest.version ?? '0.0.0', assets });
  }
  return {
    catalog: { schemaVersion: 1, generatedAt: new Date().toISOString(), packs },
    files,
  };
}

async function main() {
  const { values } = parseArgs({
    options: {
      out: { type: 'string' },
      'base-url': { type: 'string' },
      // 打包用：列出某个角色包里声明为远程的文件（包内相对路径，每行一个），不随安装包发
      'list-remote': { type: 'string' },
    },
  });
  if (values['list-remote']) {
    const { pack } = await loadPack(values['list-remote']);
    for (const { rel } of remoteFilesOf(pack)) console.info(rel);
    return;
  }
  if (!values.out) {
    console.error(
      'usage: remote-catalog.mjs --out <dir> [--base-url <url>] | --list-remote <packDir>',
    );
    process.exit(2);
  }
  const { catalog, files } = await buildCatalog({
    baseUrl: values['base-url'] ?? DEFAULT_BASE_URL,
  });
  mkdirSync(values.out, { recursive: true });
  for (const f of files) copyFileSync(f.src, join(values.out, f.name));
  writeFileSync(join(values.out, 'catalog.json'), `${JSON.stringify(catalog, null, 2)}\n`);
  console.info(JSON.stringify(catalog, null, 2));
}

// Windows 上 argv[1] 是 D:\\… 形式，要转成 file:///D:/… 再比
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
