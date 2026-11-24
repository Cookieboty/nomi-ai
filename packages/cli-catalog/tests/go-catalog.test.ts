import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

import { repoPath, repoRoot } from '@nomi-ai/repo-paths';
import { describe, expect, it } from 'vitest';

import { goCatalog } from '../src';

/**
 * Go 内核读的 catalog.json 由本包的清单生成（清单只写在这里一份）。
 * 更新：pnpm -F @nomi-ai/cli-catalog gen:go（= 带 NOMI_WRITE_GO_CATALOG=1 跑本测试，再按仓库 prettier 规则格式化）。
 * 按内容比较：提交时 prettier 会重排 JSON，生成后也走同一个格式化，手改只会被下一次 gen:go 冲掉。
 */
const FILE = repoPath('apps/desktop-go/internal/cliplugins/catalog/catalog.json');

describe('Go 内核的 catalog.json', () => {
  const want = JSON.parse(JSON.stringify(goCatalog())) as unknown;
  if (process.env.NOMI_WRITE_GO_CATALOG === '1') {
    fs.writeFileSync(FILE, `${JSON.stringify(want, null, 2)}\n`);
    // 仓库根 .prettierrc 会压缩短数组；不格式化的话生成的内容与提交的格式不一致。
    execFileSync(process.execPath, [repoPath('scripts/run-bin.mjs'), 'prettier', '--write', FILE], {
      cwd: repoRoot(),
      stdio: 'inherit',
    });
  }

  it('与清单一致（不一致就跑 pnpm -F @nomi-ai/cli-catalog gen:go）', () => {
    expect(JSON.parse(fs.readFileSync(FILE, 'utf8'))).toEqual(want);
  });
});
