#!/usr/bin/env node
/**
 * 替身角色构建（docs/design/core-host-decoupling.md §11.3）：`CHARACTER_PACK=characters/test-dummy pnpm build`
 * 的跨平台写法。产物里的内置角色是 characters/test-dummy，用来跑 e2e-headed 的 G5.stand-in-character；
 * 跑完用 `pnpm build` 换回官方构建（turbo 按 CHARACTER_PACK 分开缓存，换回来很快）。
 *
 * 用法：pnpm build:stand-in [-- 其它 turbo 参数]
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const r = spawnSync(
  process.execPath,
  [path.join(root, 'scripts/run-bin.mjs'), 'turbo', 'run', 'build', ...process.argv.slice(2)],
  {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, CHARACTER_PACK: 'characters/test-dummy' },
  },
);
process.exit(r.status ?? 1);
