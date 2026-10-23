// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { LayoutDensitySettings } from '../src/components/SettingsView/LayoutDensitySettings';
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
