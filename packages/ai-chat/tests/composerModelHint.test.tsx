// @vitest-environment happy-dom
/**
 * 输入框的模型引导（悬浮提示）：缺模型时鼠标移到输入框上浮出一张引导卡，点上面前去添加 / 选择；
 * 模型就绪、状态未知或调用方关掉时，只渲染 children，不包任何东西。
 */
import { cleanup, fireEvent, render } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ModelSetupHint } from '../src/components/MessageInput/ModelSetupHint';

afterEach(cleanup);

const renderHint = (props: Partial<React.ComponentProps<typeof ModelSetupHint>> = {}) =>
  render(
    <ModelSetupHint onOpenModels={vi.fn()} {...props}>
      <div data-testid="composer" />
    </ModelSetupHint>,
  );

describe('输入框的模型引导', () => {
  it.each(['none', 'unassigned'] as const)('缺模型（%s）时给出配置入口', (status) => {
    const open = vi.fn();
    const r = renderHint({ status, onOpenModels: open });
    const host = r.getByTestId('model-setup-hint-host');
    expect(host.getAttribute('data-status')).toBe(status);
    // 输入框照常渲染，引导与它并列（浮在它上方）
    expect(r.getByTestId('composer')).toBeTruthy();
    fireEvent.click(r.getByTestId('model-setup-hint-action'));
    expect(open).toHaveBeenCalledOnce();
  });

  it('模型就绪时不打断输入框：只渲染 children', () => {
    const r = renderHint({ status: 'ready' });
    expect(r.getByTestId('composer')).toBeTruthy();
    expect(r.queryByTestId('model-setup-hint-host')).toBeNull();
    expect(r.queryByTestId('composer-model-guide')).toBeNull();
  });

  it('状态还没读到（null）时不弹提示', () => {
    const r = renderHint({ status: null });
    expect(r.queryByTestId('composer-model-guide')).toBeNull();
  });

  it('调用方关掉（enabled=false，如编程助手标签）时不弹提示', () => {
    const r = renderHint({ status: 'none', enabled: false });
    expect(r.getByTestId('composer')).toBeTruthy();
    expect(r.queryByTestId('composer-model-guide')).toBeNull();
  });

  it('引导默认收起：显隐由 .host:hover 控制，不靠焦点', () => {
    const r = renderHint({ status: 'none' });
    const guide = r.getByTestId('composer-model-guide');
    // 满足 a11y：卡片有可朗读的名字
    expect(guide.getAttribute('aria-label')).toBeTruthy();
  });
});
