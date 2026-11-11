// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { act, cleanup, fireEvent, render, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SidebarSplitter } from '../src/app/SidebarSplitter';
import { useSplitWidths } from '../src/app/useSplitWidths';
import {
  readSidebarWidth,
  SIDEBAR_W_DEFAULT,
  SIDEBAR_W_KEY,
  SIDEBAR_W_MAX,
  SIDEBAR_W_MIN,
} from '../src/utils/sidebarWidth';

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const resize = { width: 300, onPointerDown: vi.fn(), onDoubleClick: vi.fn() };

describe('会话面板拖动调整宽度（#333）', () => {
  it('手柄是竖向分隔条，按下 / 双击交给 App 的宽度状态', () => {
    const view = render(<SidebarSplitter split={resize} />);
    const handle = view.getByTestId('sidebar-splitter');
    expect(handle.getAttribute('role')).toBe('separator');
    expect(handle.getAttribute('aria-orientation')).toBe('vertical');
    expect(handle.getAttribute('aria-valuenow')).toBe('300');
    expect(handle.getAttribute('aria-valuemin')).toBe(String(SIDEBAR_W_MIN));
    expect(handle.getAttribute('aria-valuemax')).toBe(String(SIDEBAR_W_MAX));
    expect(handle.getAttribute('aria-label')).toBeTruthy();
    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 10 });
    expect(resize.onPointerDown).toHaveBeenCalledTimes(1);
    fireEvent.doubleClick(handle);
    expect(resize.onDoubleClick).toHaveBeenCalledTimes(1);
  });

  it('样式：col-resize 光标、不占宽度、悬停与拖动时高亮；面板跟着 --sidebar-panel-w', () => {
    const css = readFileSync(resolve(__dirname, '../src/App.css'), 'utf8');
    const rule = /\.sidebar-splitter\s*\{([^}]*)\}/.exec(css)![1]!;
    expect(rule).toMatch(/cursor:\s*col-resize/);
    expect(rule).toMatch(/width:\s*6px/);
    expect(rule).toMatch(/margin:[^;]*-3px/);
    expect(css).toMatch(/\.sidebar-splitter:hover::after,\s*\.sidebar-splitter:active::after\s*\{/);
    // 手柄夹在侧栏和卡片之间，拼卡片的选择器不能再用相邻兄弟 +
    expect(css).toContain("[data-panel='open'] ~ .workspace-card");
    const sb = readFileSync(
      resolve(__dirname, '../src/components/Sidebar/index.module.css'),
      'utf8',
    );
    expect(sb).toMatch(/\.panel\s*\{[^}]*width:\s*var\(--sidebar-panel-w, 260px\)/);
  });

  it('拖动按范围夹住并记住；Esc / pointercancel 恢复；双击回默认', () => {
    const { result } = renderHook(() => useSplitWidths());
    const el = document.createElement('div');
    const down = (x: number) =>
      act(() =>
        result.current.sidebar.onPointerDown({
          preventDefault: () => undefined,
          clientX: x,
          pointerId: 1,
          currentTarget: el,
        } as never),
      );
    expect(result.current.sidebar.width).toBe(SIDEBAR_W_DEFAULT);

    down(100);
    act(() => void window.dispatchEvent(new PointerEvent('pointermove', { clientX: 1000 })));
    expect(result.current.sidebar.width).toBe(SIDEBAR_W_MAX);
    act(() => void window.dispatchEvent(new PointerEvent('pointerup')));
    expect(readSidebarWidth()).toBe(SIDEBAR_W_MAX);

    down(100);
    act(() => void window.dispatchEvent(new PointerEvent('pointermove', { clientX: -1000 })));
    expect(result.current.sidebar.width).toBe(SIDEBAR_W_MIN);
    act(() => void window.dispatchEvent(new PointerEvent('pointercancel')));
    expect(result.current.sidebar.width).toBe(SIDEBAR_W_MAX);

    act(() => result.current.sidebar.onDoubleClick());
    expect(result.current.sidebar.width).toBe(SIDEBAR_W_DEFAULT);
    expect(localStorage.getItem(SIDEBAR_W_KEY)).toBe(String(SIDEBAR_W_DEFAULT));
  });

  it('读本地偏好：没存过用默认，越界的值夹回范围', () => {
    expect(readSidebarWidth()).toBe(SIDEBAR_W_DEFAULT);
    localStorage.setItem(SIDEBAR_W_KEY, '9999');
    expect(readSidebarWidth()).toBe(SIDEBAR_W_MAX);
    localStorage.setItem(SIDEBAR_W_KEY, 'abc');
    expect(readSidebarWidth()).toBe(SIDEBAR_W_DEFAULT);
  });
});
