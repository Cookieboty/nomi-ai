// @vitest-environment happy-dom
import { cleanup, fireEvent, render } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AppTitleBar, hasAppTitleBar } from '../src/components/TitleBar';

afterEach(() => {
  cleanup();
  delete document.documentElement.dataset.platform;
});

describe('窗口标题栏', () => {
  it('红绿灯旁固定一个收起 / 展开侧栏按钮，文案随状态切换', () => {
    const onToggle = vi.fn();
    const view = render(<AppTitleBar sidebarCollapsed={false} onToggleSidebar={onToggle} />);
    expect(view.getByTestId('app-titlebar').textContent).toBe('Nomi');
    const btn = view.getByTestId('titlebar-sidebar-toggle');
    expect(btn.getAttribute('aria-label')).toBe('收起侧边栏');
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(btn);
    expect(onToggle).toHaveBeenCalledTimes(1);
    view.rerender(<AppTitleBar sidebarCollapsed onToggleSidebar={onToggle} />);
    expect(view.getByTestId('titlebar-sidebar-toggle').getAttribute('aria-label')).toBe(
      '展开侧边栏',
    );
  });

  it('只有桌面应用（html[data-platform]）才算有标题栏', () => {
    expect(hasAppTitleBar()).toBe(false);
    document.documentElement.dataset.platform = 'darwin';
    expect(hasAppTitleBar()).toBe(true);
  });
});
