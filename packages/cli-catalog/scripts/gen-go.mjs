#!/usr/bin/env node
/**
 * 生成 Go 内核读的 apps/desktop-go/internal/cliplugins/catalog/catalog.json（清单只在本包写一份）。
 * 跑 tests/go-catalog.test.ts 并让它写文件：测试能直接读 TS 源码，不用先构建。
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const r = spawnSync(
  process.execPath,
  [path.resolve(root, '../../scripts/run-bin.mjs'), 'vitest', 'run', 'tests/go-catalog.test.ts'],
  { cwd: root, stdio: 'inherit', env: { ...process.env, NOMI_WRITE_GO_CATALOG: '1' } },
);
process.exit(r.status ?? 1);
