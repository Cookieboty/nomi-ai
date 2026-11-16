/**
 * 标题栏右端：会话详情按钮紧挨文件栏开关（隔一个图标按钮间距），不再空出一大段（mac 上曾 ~40px）；
 * Windows / Linux 的开关排在自绘窗口按钮左边，同一个式子不会压到最小化 / 最大化 / 关闭。
 * happy-dom 没有布局，这里按 panels.css 的声明核对式子（真实排版用 Chrome 量过：间距 4px）。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const css = readFileSync(resolve(__dirname, '../src/components/TitleBar/panels.css'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\s+/g, ' ');

function rule(selector: string): string {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`(?:^|\\}|,)\\s*${esc}\\s*(?:,[^{]*)?\\{([^}]*)\\}`).exec(css);
  if (!m) throw new Error(`panels.css 缺少 ${selector}`);
  return m[1]!;
}

describe('titlebar right edge spacing', () => {
  it('places the rail toggle by platform: normal inset on macOS, left of the window controls elsewhere', () => {
    expect(rule('.app-titlebar')).toContain('--cd-titlebar-rail-toggle-right: var(--cd-space-1)');
    expect(rule("html[data-platform]:not([data-platform='darwin']) .app-titlebar")).toContain(
      '--cd-titlebar-rail-toggle-right: var(--cd-titlebar-window-controls-w, 140px)',
    );
    expect(rule('.app-titlebar-rail-toggle')).toContain(
      'right: var(--cd-titlebar-rail-toggle-right)',
    );
  });

  it('the main column ends one icon gap left of the toggle, without stacking it on the column edge', () => {
    const right = rule("html[data-platform]:not([data-platform='darwin']) .app-titlebar-main");
    // 取较大者（更靠左），不是相加
    expect(right).toMatch(/right: max\( var\(--titlebar-main-right, 0px\), calc\(/);
    expect(right).toContain(
      'var(--cd-titlebar-rail-toggle-right) + var(--cd-titlebar-rail-toggle-w, 0px) + var(--cd-space-1)',
    );
    // 同一条也作用于 macOS（选择器并列），且不再有 space-8 的右内边距
    expect(css).toMatch(
      /\.app-titlebar-main, html\[data-platform\]:not\(\[data-platform='darwin'\]\) \.app-titlebar-main \{/,
    );
    expect(rule('.app-titlebar-main')).toContain('padding-inline: var(--cd-space-3) 0');
    expect(css).not.toMatch(/\.app-titlebar-main \{[^}]*var\(--cd-space-8\)/);
  });

  it('the side tab strip in the center slot stops one icon gap left of the toggle / window controls', () => {
    const pad = rule('.app-titlebar[data-center]:not([data-files]) .app-titlebar-center');
    // 让出的宽度扣掉中栏右边到窗口右边已有的距离，不叠加；至少 space-2（Chrome 实测：mac / Windows 都隔 4px）
    expect(pad).toMatch(/padding-inline-end: max\( var\(--cd-space-2\), calc\(/);
    expect(pad).toContain(
      'var(--cd-titlebar-rail-toggle-right) + var(--cd-titlebar-rail-toggle-w, 0px) + var(--cd-space-1) - (100vw - var(--titlebar-center-left, 0px) - var(--titlebar-center-w, 0px))',
    );
    expect(pad).not.toContain('space-8');
  });
});
