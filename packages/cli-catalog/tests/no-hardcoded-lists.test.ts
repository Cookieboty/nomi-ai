import fs from 'node:fs';
import path from 'node:path';

import { repoPath } from '@nomi-ai/repo-paths';
import { describe, expect, it } from 'vitest';

import { BUILTIN_CLI_IDS, BUILTIN_CLI_ORDER } from '../src';

/**
 * 允许出现内置 CLI 名单的地方（文件 → 那一行里的片段）：不是「每加一个助手都要登记」的名单，
 * 而是某几个 CLI 各自的实现（额度查询、品牌图标……）。Go 侧同样的守卫在 internal/cliplugins/builtin/hardcoded_test.go。
 */
const ALLOW: Record<string, string[]> = {
  'packages/ai-chat/src/services/usageClient.ts': ['UsageQuotaTool'], // 额度：只有实现了额度查询的
  'packages/contract/src/app/shell/schemas.ts': ['UsageQuotaTool'],
  'packages/ui/src/brand/endpointGlyphs.ts': ['EndpointGlyphKey', "'nomi' | 'claude'"], // 品牌图标：每个都要画
  'packages/ai-chat/src/components/ModelControls/index.tsx': ['NO_REASONING_BACKENDS'],
};

const lit = new RegExp(`['"](${BUILTIN_CLI_IDS.join('|')})['"]`, 'g');

function* sources(dir: string): Generator<string> {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== 'node_modules' && e.name !== 'dist') yield* sources(p);
    } else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) yield p;
  }
}

describe('内置 CLI 的名单只在 cli-catalog 里', () => {
  it('BUILTIN_CLI_ORDER 列出每个内置 id 恰好一次', () => {
    expect([...BUILTIN_CLI_ORDER].sort()).toEqual([...BUILTIN_CLI_IDS]);
  });

  it('其它包不写 3 个及以上内置 id 的名单（用 BUILTIN_CLI_ORDER / cliCapability）', () => {
    const root = repoPath('');
    const bad: string[] = [];
    for (const pkg of fs.readdirSync(repoPath('packages'))) {
      if (pkg === 'cli-catalog') continue;
      const src = repoPath(`packages/${pkg}/src`);
      if (!fs.existsSync(src)) continue;
      for (const file of sources(src)) {
        const rel = path.relative(root, file).split(path.sep).join('/');
        fs.readFileSync(file, 'utf8')
          .split('\n')
          .forEach((line, i) => {
            const ids = new Set([...line.matchAll(lit)].map((m) => m[1]));
            if (ids.size < 3) return;
            if ((ALLOW[rel] ?? []).some((frag) => line.includes(frag))) return;
            bad.push(`${rel}:${i + 1}: ${line.trim()}`);
          });
      }
    }
    expect(bad).toEqual([]);
  });
});
