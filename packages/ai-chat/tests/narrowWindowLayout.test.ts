/**
 * 窗口窄于约 1240px 时四栏（侧栏 | 对话 | 中栏 | 右栏文件）不能横向溢出。
 * happy-dom 没有布局引擎，这里按 App.css 里声明的最小宽度公式算：每个窗口宽度下，
 * 侧栏 296 + 各栏最小宽度 + 分割线 / 边框，必须 ≤ 窗口宽度（Electron 对话窗最小宽度 760）。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const css = readFileSync(resolve(__dirname, '../src/App.css'), 'utf8');
const app = readFileSync(resolve(__dirname, '../src/App.tsx'), 'utf8');

const SIDEBAR = 296;
/** 两条分割线（各 5px）+ 中栏 / 右栏左边框（各 1px） */
const CHROME = 12;
const MIN_WINDOW = 760;

function decl(name: string): string {
  const m = new RegExp(`${name}:\\s*([^;]+);`).exec(css);
  if (!m) throw new Error(`App.css 缺少 ${name}`);
  return m[1]!.trim();
}

/** 只支持 App.css 里用到的 clamp(Apx, calc(var(--cd-pane-avail) * k), Bpx) */
function minOf(name: string, vw: number): number {
  const avail = vw - Number(/calc\(100vw - (\d+)px\)/.exec(decl('--cd-pane-avail'))![1]);
  const m = /clamp\((\d+)px,\s*calc\(var\(--cd-pane-avail\) \* ([\d.]+)\),\s*(\d+)px\)/.exec(
    decl(name),
  );
  if (!m) throw new Error(`无法解析 ${name}`);
  const [lo, k, hi] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return Math.min(hi, Math.max(lo, avail * k));
}

describe('窄窗口四栏不横向溢出', () => {
  it('宽屏仍沿用原来的 360 / 360 / 200 最小宽度', () => {
    expect(minOf('--cd-chat-col-min', 1600)).toBe(360);
    expect(minOf('--cd-center-pane-min', 1600)).toBe(360);
    expect(minOf('--cd-files-rail-min', 1600)).toBe(200);
  });

  it.each([760, 800, 900, 1000, 1100, 1200, 1240, 1300, 1440])(
    '窗口 %ipx：各栏最小宽度之和放得下',
    (w) => {
      const total =
        SIDEBAR +
        minOf('--cd-chat-col-min', w) +
        minOf('--cd-center-pane-min', w) +
        minOf('--cd-files-rail-min', w) +
        CHROME;
      expect(total).toBeLessThanOrEqual(w);
    },
  );

  it('最小窗口以下的整段区间都放得下', () => {
    for (let w = MIN_WINDOW; w <= 1300; w += 10) {
      const total =
        SIDEBAR +
        minOf('--cd-chat-col-min', w) +
        minOf('--cd-center-pane-min', w) +
        minOf('--cd-files-rail-min', w) +
        CHROME;
      expect(total, `w=${w}`).toBeLessThanOrEqual(w);
    }
  });

  it('各栏确实用这些变量，且右栏允许收缩、主区有自己的最小宽度', () => {
    expect(css).toMatch(/min-width:\s*var\(--cd-center-pane-min\)/);
    expect(css).toMatch(/min-width:\s*var\(--cd-files-rail-min\)/);
    expect(css).toMatch(
      /\.main-content--with-changes\s*\{[^}]*min-width:\s*calc\(var\(--cd-chat-col-min\)/s,
    );
    expect(css).toMatch(/\.files-rail\s*\{[^}]*flex-shrink:\s*1/s);
    expect(app).toContain("minWidth: 'var(--cd-chat-col-min)'");
    expect(app).toContain("minWidth: 'var(--cd-files-rail-min)'");
    // 不再有写死的 360 / 200 最小宽度
    expect(css).not.toMatch(/min-width:\s*360px/);
    expect(css).not.toMatch(/\.files-rail\s*\{[^}]*min-width:\s*200px/s);
  });
});

describe('一体化标题栏下的高度', () => {
  it('右栏和主区一样扣掉标题栏高度（否则底部固定的提交区被裁掉）', () => {
    const rule =
      /html\[data-platform\] \.main-content,\s*html\[data-platform\] \.files-rail \{[^}]*height:\s*calc\(100vh - var\(--cd-titlebar-h\)\)/;
    expect(css).toMatch(rule);
  });
});
