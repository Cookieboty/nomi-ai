#!/usr/bin/env node
/**
 * 生成 Go 内核读的 apps/desktop-go/internal/cliplugins/catalog/catalog.json（清单只在本包写一份）。
 * 跑 tests/go-catalog.test.ts 并让它写文件（写完按仓库 prettier 规则格式化）：测试能直接读 TS 源码，不用先构建。
 * 只跑这一个文件，单文件跑不满整包的覆盖率阈值，覆盖率在这里没有意义，关掉；生成完再单独查一次与清单一致。
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { repoPath } from '@nomi-ai/repo-paths';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function vitest(args, env) {
  return spawnSync(process.execPath, [repoPath('scripts/run-bin.mjs'), 'vitest', 'run', ...args], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, ...env },
  });
}

const write = vitest(['tests/go-catalog.test.ts', '--coverage.enabled=false'], {
  NOMI_WRITE_GO_CATALOG: '1',
});
if (write.status !== 0) process.exit(write.status ?? 1);

// 读回刚生成的 JSON 与清单比一次：格式化没改坏内容、文件确实落盘。
const check = vitest(['tests/go-catalog.test.ts', '--coverage.enabled=false']);
process.exit(check.status ?? 1);
