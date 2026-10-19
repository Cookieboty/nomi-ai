import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

// 回归 #22：自定义 inputs 会替换 turbo 默认文件集；漏掉 index.html / public / scripts/*.mjs /
// jest.config.js 会让缓存（含 CI restore-keys 恢复的跨提交缓存）重放旧产物。
const turbo = JSON.parse(readFileSync(join(__dirname, '../../turbo.json'), 'utf8')) as {
  globalDependencies: string[];
  tasks: Record<string, { inputs?: string[] }>;
};

describe('turbo.json inputs', () => {
  it.each(['build', 'typecheck', 'lint', 'test'])('%s 保留默认文件集', (task) => {
    expect(turbo.tasks[task].inputs).toContain('$TURBO_DEFAULT$');
  });

  it('依赖外部文件的 vite 包把它们显式列入 build 输入', () => {
    for (const t of ['@nomi-ai/renderer#build', '@nomi-ai/ai-chat#build']) {
      const inputs = turbo.tasks[t].inputs ?? [];
      expect(inputs).toContain('$TURBO_DEFAULT$');
      expect(inputs).toContain('$TURBO_ROOT$/scripts/ports.mjs');
      expect(inputs).toContain('$TURBO_ROOT$/packages/electron/src/security/csp.ts');
    }
  });

  it('根 run-bin 脚本参与所有任务的 hash', () => {
    expect(turbo.globalDependencies).toContain('scripts/run-bin.mjs');
  });
});
