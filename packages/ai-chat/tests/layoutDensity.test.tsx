// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { LayoutDensitySettings } from '../src/components/SettingsView/LayoutDensitySettings';
import { useLayoutDensity } from '../src/hooks/useLayoutDensity';
import { getLayoutDensity, setLayoutDensity } from '../src/services/chatPrefs';

afterEach(() => {
  cleanup();
  setLayoutDensity('full');
  localStorage.clear();
});

describe('界面模式（精简 / 全量）', () => {
  it('默认全量；存储里的非法值也回退到全量', () => {
    expect(getLayoutDensity()).toBe('full');
    localStorage.setItem('ai-chat:layoutDensity', 'weird');
    expect(getLayoutDensity()).toBe('full');
  });

  it('设置 → 外观：切到精简即时保存，说明跟着变', () => {
    render(<LayoutDensitySettings />);
    const row = screen.getByTestId('settings-layout-density');
    expect(row.textContent).toContain('顶部显示对话标签');
    fireEvent.click(screen.getByTestId('layout-density-compact'));
    expect(getLayoutDensity()).toBe('compact');
    expect(localStorage.getItem('ai-chat:layoutDensity')).toBe('compact');
    expect(row.textContent).toContain('隐藏顶部对话标签与侧栏底部的信息卡');
    fireEvent.click(screen.getByTestId('layout-density-full'));
    expect(getLayoutDensity()).toBe('full');
  });
});

describe('界面模式跨窗口同步', () => {
  const Probe: React.FC = () => {
    const { density } = useLayoutDensity();
    return <span data-testid="probe">{density}</span>;
  };

  it('别的窗口改了偏好（storage 事件）：本窗口的订阅者立即跟着变', () => {
    render(<Probe />);
    expect(screen.getByTestId('probe').textContent).toBe('full');
    // 另一个窗口写了 localStorage，本窗口只收到 storage 事件
    localStorage.setItem('ai-chat:layoutDensity', 'compact');
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: 'ai-chat:layoutDensity' }));
    });
    expect(screen.getByTestId('probe').textContent).toBe('compact');
  });

  it('无关 key 的 storage 事件不触发；卸载后移除监听', () => {
    const { unmount } = render(<Probe />);
    localStorage.setItem('ai-chat:layoutDensity', 'compact');
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: 'other' }));
    });
    expect(screen.getByTestId('probe').textContent).toBe('full');
    unmount();
    // 卸载后不应抛错 / 泄漏
    window.dispatchEvent(new StorageEvent('storage', { key: 'ai-chat:layoutDensity' }));
  });
});
