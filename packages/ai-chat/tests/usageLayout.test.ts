/**
 * 用量面板响应式布局的回归保护（happy-dom 不做布局，所以直接断言 CSS 里承载布局的关键声明）。
 * 真实宽度验证见 /workspace/icon-shots/usage-fix-*.png（700 / 900 / 1024 / 1280 无横向截断）。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const read = (p: string) => readFileSync(resolve(__dirname, '../src/components', p), 'utf8');
const block = (css: string, sel: string) => {
  const m = new RegExp(`(^|\\n)${sel.replace('.', '\\.')}\\s*\\{([^}]*)\\}`).exec(css);
  return m?.[2] ?? '';
};

describe('usage panel layout', () => {
  const settings = read('SettingsView/index.module.css');
  const usage = read('UsagePanel/index.module.css');

  it('设置页外层 flex 容器 min-width:0，内容不会把它撑出窗口（概览被右侧裁掉的根因）', () => {
    expect(block(settings, '.settings')).toMatch(/min-width:\s*0/);
    expect(block(settings, '.content')).toMatch(/min-width:\s*0/);
    expect(block(settings, '.content')).toMatch(/overflow-x:\s*hidden/);
    expect(block(settings, '.inner')).toMatch(/min-width:\s*0/);
  });

  it('摘要卡 4 列 → 窄屏 2 列，且列宽 minmax(0,1fr)', () => {
    expect(block(usage, '.cards')).toMatch(/repeat\(4,\s*minmax\(0,\s*1fr\)\)/);
    expect(usage).toMatch(/@media \(max-width: 900px\)\s*\{\s*\.cards\s*\{[^}]*repeat\(2/);
  });

  it('热力图自适应：不再用横向滚动容器，格子随容器收缩', () => {
    expect(usage).not.toMatch(/\.heatScroll/);
    expect(block(usage, '.heatGrid')).toMatch(/display:\s*grid/);
    expect(usage).toMatch(/\.heatGrid \.heatCell\s*\{[^}]*aspect-ratio:\s*1/);
  });

  it('明细表按容器宽度收起次要列，而不是横向滚动', () => {
    expect(usage).toMatch(
      /@container \(max-width: 700px\)\s*\{\s*\.colCache\s*\{\s*display:\s*none/,
    );
    expect(usage).toMatch(
      /@container \(max-width: 640px\)\s*\{\s*\.colTotal\s*\{\s*display:\s*none/,
    );
  });

  it('卡片内统一用 gap 排垂直间距（预算与隐私底部提示条不再紧贴）', () => {
    const panel = block(usage, '.panel');
    expect(panel).toMatch(/display:\s*flex/);
    expect(panel).toMatch(/flex-direction:\s*column/);
    expect(panel).toMatch(/gap:\s*12px/);
  });
});
