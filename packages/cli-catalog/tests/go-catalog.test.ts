import fs from 'node:fs';

import { repoPath } from '@nomi-ai/repo-paths';
import { describe, expect, it } from 'vitest';

import { goCatalog } from '../src';

/**
 * Go 内核读的 catalog.json 由本包的清单生成（清单只写在这里一份）。
 * 更新：pnpm -F @nomi-ai/cli-catalog gen:go（= 带 NOMI_WRITE_GO_CATALOG=1 跑本测试）。
 * 按内容比较：提交时 prettier 会重排 JSON。
 */
const FILE = repoPath('apps/desktop-go/internal/cliplugins/catalog/catalog.json');

describe('Go 内核的 catalog.json', () => {
  const want = JSON.parse(JSON.stringify(goCatalog())) as unknown;
  if (process.env.NOMI_WRITE_GO_CATALOG === '1') {
    fs.writeFileSync(FILE, `${JSON.stringify(want, null, 2)}\n`);
  }

  it('与清单一致（不一致就跑 pnpm -F @nomi-ai/cli-catalog gen:go）', () => {
    expect(JSON.parse(fs.readFileSync(FILE, 'utf8'))).toEqual(want);
  });
});
