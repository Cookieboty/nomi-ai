/**
 * 窗口窄于约 1240px 时四栏（侧栏 | 对话 | 中栏 | 右栏文件）不能横向溢出。
 * happy-dom 没有布局引擎，这里按 App.css 里声明的最小宽度公式算：每个窗口宽度下，
 * 侧栏（导航 52 + 会话面板，可拖 200–420，窄窗口封顶）+ 各栏最小宽度 + 分割线 / 边框，必须 ≤ 窗口宽度（对话窗最小宽度 760）。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  SIDEBAR_WIDTH_DEFAULT,
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_MIN,
} from '../src/utils/sidebarWidth';

const css = readFileSync(resolve(__dirname, '../src/App.css'), 'utf8');
// 对话列在 App.tsx，右栏在 app/FilesRail.tsx
const app = ['../src/App.tsx', '../src/app/FilesRail.tsx']
  .map((f) => readFileSync(resolve(__dirname, f), 'utf8'))
  .join('\n');

/** 导航 52 + 对话卡片右外边距 8 + 左右边框 2（再加会话面板宽度） */
const SIDEBAR_FIXED = 62;
/** 两条分割线（各 5px）+ 中栏 / 右栏左边框（各 1px） */
const CHROME = 12;
const MIN_WINDOW = 760;

function decl(name: string): string {
  const m = new RegExp(`${name}:\\s*([^;]+);`).exec(css);
  if (!m) throw new Error(`App.css 缺少 ${name}`);
  return m[1]!.trim();
}

/** 会话面板实际宽度：min(用户值, max(Apx, 100vw - Bpx)) */
function panelOf(user: number, vw: number): number {
  const m =
    /min\(var\(--sidebar-panel-w-user, \d+px\),\s*max\((\d+)px,\s*calc\(100vw - (\d+)px\)\)\)/.exec(
      decl('--sidebar-panel-w'),
    );
  if (!m) throw new Error('无法解析 --sidebar-panel-w');
  return Math.min(user, Math.max(Number(m[1]), vw - Number(m[2])));
}

/** 只支持 App.css 里用到的 clamp(Apx, calc(var(--cd-pane-avail) * k), Bpx) */
function minOf(name: string, vw: number, user = SIDEBAR_WIDTH_DEFAULT): number {
  const fixed = /calc\(100vw - (\d+)px - var\(--sidebar-panel-w\)\)/.exec(decl('--cd-pane-avail'));
  if (!fixed) throw new Error('无法解析 --cd-pane-avail');
  const avail = vw - Number(fixed[1]) - panelOf(user, vw);
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

  const total = (w: number, user: number) =>
    SIDEBAR_FIXED +
    panelOf(user, w) +
    minOf('--cd-chat-col-min', w, user) +
    minOf('--cd-center-pane-min', w, user) +
    minOf('--cd-files-rail-min', w, user) +
    CHROME;

  it.each([760, 800, 900, 1000, 1100, 1200, 1240, 1300, 1440])(
    '窗口 %ipx：各栏最小宽度之和放得下',
    (w) => {
      expect(total(w, SIDEBAR_WIDTH_DEFAULT)).toBeLessThanOrEqual(w);
    },
  );

  it.each([SIDEBAR_WIDTH_MIN, SIDEBAR_WIDTH_DEFAULT, SIDEBAR_WIDTH_MAX])(
    '会话面板拖到 %ipx：最小窗口起整段区间都放得下',
    (user) => {
      for (let w = MIN_WINDOW; w <= 1600; w += 10) {
        expect(total(w, user), `w=${w}`).toBeLessThanOrEqual(w);
      }
    },
  );

  it('默认宽度下与原来的布局一致：最小窗口里会话面板仍是 260', () => {
    expect(panelOf(SIDEBAR_WIDTH_MAX, MIN_WINDOW)).toBe(SIDEBAR_WIDTH_DEFAULT);
    expect(panelOf(SIDEBAR_WIDTH_MAX, 1600)).toBe(SIDEBAR_WIDTH_MAX);
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
  it('右栏和主区都在卡片里撑满，卡片扣掉标题栏高度（否则底部固定的提交区被裁掉）', () => {
    expect(css).toMatch(
      /html\[data-platform\] \.workspace-card \{[^}]*height:\s*calc\(100vh - var\(--cd-titlebar-h\)/,
    );
    expect(css).toMatch(/\.main-content \{[^}]*height:\s*100%/s);
    expect(css).toMatch(/\.files-rail \{[^}]*height:\s*100%/s);
  });
});
