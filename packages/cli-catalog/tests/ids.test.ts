import { execFileSync } from 'node:child_process';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  BUILTIN_CLI_IDS,
  BUILTIN_MANIFESTS,
  BUILTIN_RENDERER,
  cliCapability,
  validateManifest,
} from '../src';

describe('cli-catalog', () => {
  it('生成的 id 列表是最新的', () => {
    const script = path.resolve(__dirname, '../scripts/gen-ids.mjs');
    expect(() => execFileSync(process.execPath, [script, '--check'])).not.toThrow();
  });

  it('每个内置 id 都有通过校验的清单与界面信息', () => {
    for (const id of BUILTIN_CLI_IDS) {
      expect(validateManifest(BUILTIN_MANIFESTS[id])).toEqual([]);
      expect(BUILTIN_RENDERER[id].id).toBe(id);
    }
  });

  // 应用内本机官方登录管理（视图的 cliCapability / 内核的 builtin.Capability 读同一份清单）：
  // 目前只有 Antigravity 实现了（`agy acp --login` + ACP logout），别人不能打开
  it('localAuth 能力位只在 antigravity 上打开', () => {
    expect(cliCapability('antigravity', 'localAuth')).toBe(true);
    for (const id of BUILTIN_CLI_IDS)
      if (id !== 'antigravity') expect(cliCapability(id, 'localAuth')).toBe(false);
    expect(cliCapability('unknown-cli', 'localAuth')).toBe(false);
  });
});
