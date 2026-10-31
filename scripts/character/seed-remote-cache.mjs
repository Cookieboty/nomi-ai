#!/usr/bin/env node

/**
 * 测试 / 测量用：把仓库里角色包的远程素材（manifest assets.remote，如官方角色的 .riv）按内核缓存的格式放进
 * 某个 userData，等同于用户已经下载过（docs/design/remote-character-assets.md）。内核启动即就绪，
 * 不依赖外网与 GitHub Release `characters`；联网检查失败时内核也继续用这份缓存。
 *
 *   node scripts/character/seed-remote-cache.mjs <userData> [packDir=characters/nomi]
 *
 * 写出 <userData>/character-assets/<packId>/<file> 与 current.json（文件名与 remote-catalog.mjs 相同）。
 */
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

import { loadPack, remoteFilesOf } from './pack.mjs';
import { DEFAULT_PACK_DIR } from './paths.mjs';

export async function seedRemoteCache(userData, packDir = DEFAULT_PACK_DIR) {
  const { pack } = await loadPack(packDir);
  const id = pack.manifest.id;
  const dir = join(userData, 'character-assets', id);
  const current = {};
  for (const { kind, rel } of remoteFilesOf(pack)) {
    const src = join(packDir, ...rel.split('/'));
    const buf = readFileSync(src);
    const sha256 = createHash('sha256').update(buf).digest('hex');
    const file = `${id}-${kind}-${sha256.slice(0, 12)}${extname(rel)}`;
    mkdirSync(dir, { recursive: true });
    copyFileSync(src, join(dir, file));
    current[kind] = { file, sha256, size: buf.length };
  }
  if (Object.keys(current).length) {
    writeFileSync(join(dir, 'current.json'), JSON.stringify(current));
  }
  return current;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [userData, packDir] = process.argv.slice(2);
  if (!userData) {
    console.error('usage: seed-remote-cache.mjs <userData> [packDir]');
    process.exit(2);
  }
  const seeded = await seedRemoteCache(resolve(userData), packDir ? resolve(packDir) : undefined);
  console.info(JSON.stringify(seeded));
}
