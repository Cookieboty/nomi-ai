// @vitest-environment happy-dom
import { cleanup, fireEvent, render } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AppTitleBar, hasAppTitleBar } from '../src/components/TitleBar';

afterEach(() => {
  cleanup();
  delete document.documentElement.dataset.platform;
});

describe('标题栏里的侧栏开关', () => {
  it('收起 / 展开文案跟随状态，点击切换', () => {
    const onToggle = vi.fn();
    const r = render(<AppTitleBar sidebarCollapsed={false} onToggleSidebar={onToggle} />);
    const btn = r.getByTestId('sidebar-toggle');
    expect(btn.getAttribute('aria-label')).toBe('收起侧边栏');
    fireEvent.click(btn);
    expect(onToggle).toHaveBeenCalledTimes(1);
    r.rerender(<AppTitleBar sidebarCollapsed onToggleSidebar={onToggle} />);
    expect(r.getByTestId('sidebar-toggle').getAttribute('aria-label')).toBe('展开侧边栏');
  });

  it('只有桌面应用（html[data-platform]）才算有标题栏', () => {
    expect(hasAppTitleBar()).toBe(false);
    document.documentElement.dataset.platform = 'darwin';
    expect(hasAppTitleBar()).toBe(true);
  });
});
