// @vitest-environment happy-dom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AppTitleBar, hasAppTitleBar } from '../src/components/TitleBar';

const host = vi.hoisted(() => ({ go: false }));
vi.mock('../src/services/api', () => ({ isGoHost: () => host.go }));

afterEach(() => {
  cleanup();
  host.go = false;
  delete document.documentElement.dataset.platform;
  delete (window as unknown as { wails?: unknown }).wails;
});

describe('窗口标题栏', () => {
  it('红绿灯旁固定一个收起 / 展开侧栏按钮，文案随状态切换', () => {
    const onToggle = vi.fn();
    const view = render(<AppTitleBar sidebarCollapsed={false} onToggleSidebar={onToggle} />);
    // 不再显示产品名：会话名由调用方放进 title
    expect(view.getByTestId('app-titlebar').textContent).toBe('');
    const btn = view.getByTestId('titlebar-sidebar-toggle');
    expect(btn.getAttribute('aria-label')).toBe('收起侧边栏');
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(btn);
    expect(onToggle).toHaveBeenCalledTimes(1);
    const openIcon = btn.innerHTML;
    view.rerender(<AppTitleBar sidebarCollapsed onToggleSidebar={onToggle} />);
    expect(view.getByTestId('titlebar-sidebar-toggle').getAttribute('aria-label')).toBe(
      '展开侧边栏',
    );
    // 图标随状态变（收起 / 展开两种）
    expect(view.getByTestId('titlebar-sidebar-toggle').innerHTML).not.toBe(openIcon);
  });

  it('标题与右侧按钮放进标题栏主体', () => {
    const view = render(
      <AppTitleBar
        sidebarCollapsed={false}
        onToggleSidebar={() => {}}
        title={<span>Review 当前项目代码</span>}
        trailing={<button type="button">tools</button>}
      />,
    );
    expect(view.getByTestId('titlebar-title').textContent).toBe('Review 当前项目代码');
    expect(view.getByText('tools')).toBeTruthy();
    expect(view.getByTestId('app-titlebar').getAttribute('data-sidebar')).toBe('expanded');
  });

  it('只有桌面应用（html[data-platform]）才算有标题栏', () => {
    expect(hasAppTitleBar()).toBe(false);
    document.documentElement.dataset.platform = 'darwin';
    expect(hasAppTitleBar()).toBe(true);
  });

  it('Electron 不画窗口按钮（系统 overlay 画）', () => {
    const view = render(<AppTitleBar sidebarCollapsed={false} onToggleSidebar={() => {}} />);
    expect(view.queryByTestId('window-controls')).toBeNull();
  });

  it('Go 宿主：自绘最小化 / 最大化 / 关闭，调 Wails 当前窗口；双击空白处最大化', async () => {
    host.go = true;
    document.documentElement.dataset.platform = 'win32';
    let max = false;
    const win = {
      Minimise: vi.fn(async () => {}),
      ToggleMaximise: vi.fn(async () => {
        max = !max;
      }),
      IsMaximised: vi.fn(async () => max),
      Close: vi.fn(async () => {}),
    };
    (window as unknown as { wails: unknown }).wails = { Window: win };
    const view = render(<AppTitleBar sidebarCollapsed={false} onToggleSidebar={() => {}} />);
    fireEvent.click(view.getByTestId('window-minimize'));
    expect(win.Minimise).toHaveBeenCalledTimes(1);
    expect(view.getByTestId('window-maximize').getAttribute('aria-label')).toBe('最大化');
    fireEvent.click(view.getByTestId('window-maximize'));
    await Promise.resolve();
    window.dispatchEvent(new Event('resize'));
    await waitFor(() =>
      expect(view.getByTestId('window-maximize').getAttribute('aria-label')).toBe('还原'),
    );
    fireEvent.click(view.getByTestId('window-close'));
    expect(win.Close).toHaveBeenCalledTimes(1);
    // 双击按钮不算；双击空白处切换最大化
    fireEvent.doubleClick(view.getByTestId('window-minimize'));
    expect(win.ToggleMaximise).toHaveBeenCalledTimes(1);
    fireEvent.doubleClick(view.getByTestId('app-titlebar'));
    expect(win.ToggleMaximise).toHaveBeenCalledTimes(2);
  });
});
