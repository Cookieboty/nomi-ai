// 侧栏超长会话列表（> 100 条走 react-window 虚拟列表）的高度契约。
// 回归点：容器曾写成 height:100%，把上面分区标题的高度一起占掉、内容被顶出可视区，
// 而外层 .threads 此时 overflow:hidden（滚动交给内部 List），溢出部分既滚不到也点不到。
// happy-dom 不做布局计算，这里对源码做契约断言（与 emptyChatCentering.test.ts 同一手法）。
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const read = (rel: string) => readFileSync(resolve(__dirname, '..', rel), 'utf8');
const threads = read('src/components/Sidebar/SidebarThreads.tsx');
const css = read('src/components/Sidebar/index.module.css');

/** 取某个选择器的规则体（可能有多段，合并后断言） */
function ruleBody(cssText: string, selector: string): string {
  const esc = selector.replace(/[.*+?^${}()|[\]\\>]/g, '\\$&');
  const re = new RegExp(`(?:^|[}/])\\s*${esc}\\s*\\{([^}]*)\\}`, 'g');
  const all = [...cssText.matchAll(re)].map((m) => m[1] ?? '');
  expect(all.length, `找不到规则 ${selector}`).toBeGreaterThan(0);
  return all.join('\n');
}

describe('侧栏虚拟列表：容器高度', () => {
  it('超过 100 条才启用虚拟列表', () => {
    expect(threads).toMatch(/ordered\.length > 100/);
    expect(threads).toMatch(/conversation-list-virtual/);
  });

  it('容器不用 height:100%（会顶掉分区标题的高度）', () => {
    // 只看承载虚拟列表的那个 div（List 自己的 height:100% 是对的：它要占满容器）
    const line = threads
      .split('\n')
      .find((l) => l.includes('data-testid="conversation-list-virtual"'))!;
    expect(line).toBeTruthy();
    expect(line).toContain('styles.virtualHost');
    expect(line).not.toMatch(/height:\s*'100%'/);
  });

  it('容器取剩余高度：flex:1 + min-height:0', () => {
    const host = ruleBody(css, '.virtualHost');
    expect(host).toMatch(/flex:\s*1/);
    expect(host).toMatch(/min-height:\s*0/);
  });

  it('外层 .threads 在虚拟列表下把滚动让给内部 List', () => {
    const outer = ruleBody(css, '.threads:has(.virtualList)');
    expect(outer).toMatch(/overflow:\s*hidden/);
  });
});
