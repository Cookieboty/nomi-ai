import { execFileSync } from 'node:child_process';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { BUILTIN_CLI_IDS, BUILTIN_MANIFESTS, BUILTIN_RENDERER, validateManifest } from '../src';

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
});
