// @vitest-environment happy-dom
/**
 * 左侧导航栏图标的悬停标题提示。
 * 这些入口常年只显示图标（收起侧栏 / 左侧窄导航栏），光有 aria-label 看不出是什么，
 * 所以悬停 / 键盘聚焦时要有可见提示；同时保持项目惯例：不写原生 title（全局 installTitleTooltips 会接管）。
 */
import { cleanup, render } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AppEntries } from '../src/components/AppEntries';
import { SideNavItem } from '../src/components/Sidebar/SideNavItem';

afterEach(() => cleanup());

const icon = (() => null) as never;

const item = (over: Partial<React.ComponentProps<typeof SideNavItem>> = {}) => (
  <SideNavItem
    icon={icon}
    label="任务"
    collapsed
    active={false}
    onOpen={vi.fn()}
    testId="tasks-open"
    {...over}
  />
);

describe('左侧导航栏图标悬停提示', () => {
  it('鼠标悬浮 / 键盘聚焦时显示标题气泡', () => {
    const r = render(item({ title: '任务：2 项待处理' }));
    const btn = r.getByTestId('tasks-open');
    const bubble = r.getByRole('tooltip');
    // 纯 CSS 提示：靠 data 属性与 class 切换显隐，不靠 JS 状态
    expect(bubble.textContent).toBe('任务：2 项待处理');
    expect(bubble.className).toContain('cd-tooltip__bubble--right');
    // 通过 aria-describedby 与触发元素关联
    expect(btn.getAttribute('aria-describedby')).toBe(bubble.getAttribute('id'));
  });

  it('没有传 title 时，用 label 兜底，气泡不会空着', () => {
    const r = render(item());
    expect(r.getByRole('tooltip').textContent).toBe('任务');
    expect(r.getByTestId('tasks-open').getAttribute('aria-label')).toBe('任务');
  });

  it('读屏名称走 aria-label，不写原生 title', () => {
    const r = render(item({ title: '工坊：1 个运行中' }));
    const btn = r.getByTestId('tasks-open');
    expect(btn.getAttribute('aria-label')).toBe('工坊：1 个运行中');
    expect(btn.getAttribute('title')).toBeNull();
  });

  it('气泡放右侧：侧栏祖先有 overflow: hidden，放内侧会被裁掉', () => {
    const r = render(item({ title: '素材' }));
    expect(r.getByRole('tooltip').className).toContain('--right');
  });

  it('点击仍然打开对应页面（提示不挡交互）', () => {
    const onOpen = vi.fn();
    const r = render(item({ onOpen }));
    r.getByTestId('tasks-open').click();
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('设置入口：收起时（只剩图标）才有提示，展开时已有文字不重复弹', () => {
    const r = render(<AppEntries collapsed onSettings={vi.fn()} />);
    expect(r.getByRole('tooltip').textContent).toBe('设置');

    r.rerender(<AppEntries collapsed={false} onSettings={vi.fn()} />);
    expect(r.queryByRole('tooltip')).toBeNull();
    // 展开时文字已经说明了用途
    expect(r.getByTestId('open-settings').textContent).toContain('设置');
  });
});
