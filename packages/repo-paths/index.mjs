/**
 * 仓库根目录与仓库内路径：从本文件所在位置往上找 pnpm-workspace.yaml。
 * 测试与脚本里通往别的包 / 仓库根目录的路径都用它拼，不数 `../`：包挪了位置也不会悄悄指错。
 * index.cjs 是同一份逻辑的 CommonJS 版（Jest 用），两份一起改。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let cached;

export function repoRoot() {
  if (cached) return cached;
  for (let d = path.dirname(fileURLToPath(import.meta.url)); ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, 'pnpm-workspace.yaml'))) return (cached = d);
    if (path.dirname(d) === d) throw new Error('repo-paths: pnpm-workspace.yaml not found');
  }
}

/** 仓库根目录下的路径，如 `repoPath('characters/nomi')` */
export function repoPath(...segments) {
  return path.join(repoRoot(), ...segments);
}
