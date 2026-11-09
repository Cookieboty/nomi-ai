import fs from 'node:fs';

import { repoPath } from '@nomi-ai/repo-paths';
import { describe, expect, it } from 'vitest';

import { BUILTIN_CLI_IDS, BUILTIN_MANIFESTS, BUILTIN_RENDERER } from '../src';

/**
 * 视图侧清单与 Go 内核的 internal/cliplugins 一致：两边都和同一份 testdata/b7s2-plugins.json 比
 * （Go 侧是 internal/cliplugins/builtin/manifest_parity_test.go）。改清单时两边一起改，再更新这份文件。
 */
describe('清单与 Go 内核一致', () => {
  const fixture = JSON.parse(
    fs.readFileSync(
      repoPath('apps/desktop-go/internal/cliplugins/builtin/testdata/b7s2-plugins.json'),
      'utf8',
    ),
  ) as { ids: string[]; manifests: unknown; renderers: unknown };
  // JSON 往返：去掉 undefined 字段，与 Go 序列化后的形状一致
  const json = (v: unknown): unknown => JSON.parse(JSON.stringify(v));

  it('id、清单、界面信息都和基准一样', () => {
    expect([...BUILTIN_CLI_IDS]).toEqual(fixture.ids);
    expect(json(BUILTIN_MANIFESTS)).toEqual(fixture.manifests);
    expect(json(BUILTIN_RENDERER)).toEqual(fixture.renderers);
  });
});
