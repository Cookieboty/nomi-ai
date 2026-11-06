/**
 * 滚动条不常驻（Codex 式）：全局只在 @nomi-ai/ui 的 theme.css 定义一次——平时透明，悬停可滚动区域才显示；
 * 各组件不要再写自己的滑块颜色（会盖掉「不常驻」，一直显示）。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { repoPath } from '@nomi-ai/repo-paths';
import { describe, expect, it } from 'vitest';

const theme = readFileSync(repoPath('packages/ui/src/styles/theme.css'), 'utf8');

function cssFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return cssFiles(p);
    return p.endsWith('.css') ? [p] : [];
  });
}

describe('滚动条', () => {
  it('theme.css：滑块平时透明，悬停可滚动区域时才显示', () => {
    expect(theme).toMatch(/::-webkit-scrollbar-thumb,[^{]*\{[^}]*background:\s*transparent/s);
    expect(theme).toMatch(/\*:hover::-webkit-scrollbar-thumb/);
  });

  it('ai-chat 的样式不再自己给滚动条滑块上色', () => {
    const offenders = cssFiles(resolve(__dirname, '../src')).filter((f) =>
      /::-webkit-scrollbar-thumb[^{]*\{[^}]*background(?:-color)?:\s*(?!transparent)/s.test(
        readFileSync(f, 'utf8'),
      ),
    );
    expect(offenders).toEqual([]);
  });
});
