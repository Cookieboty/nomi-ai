// @vitest-environment happy-dom
/** 待发列表里自动发送失败的可见提示与「重试」（不是只在 state 里记着） */
import { cleanup, fireEvent, render } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PendingDock } from '../src/components/PendingDock';

afterEach(cleanup);

const items = [
  { id: 'p1', text: '第一条', mode: 'queue' as const },
  { id: 'p2', text: '第二条', mode: 'queue' as const },
];

describe('PendingDock failure', () => {
  it('shows the reason next to the retained item and retries on click', () => {
    const onRetry = vi.fn();
    const onRemove = vi.fn();
    const { getByTestId, getAllByTestId } = render(
      <PendingDock
        items={items}
        onWithdraw={vi.fn()}
        onRemove={onRemove}
        failure="这个会话还没有选择模型"
        failedText="第一条"
        onRetry={onRetry}
      />,
    );
    const alert = getByTestId('pending-send-error');
    expect(alert.getAttribute('role')).toBe('alert');
    // key 与原因都在提示里（文案随语言切换，这里只认 key 与原因不丢）
    expect(alert.textContent).toContain('ui.session-workspace.pending-send-failed');
    expect(alert.textContent).toContain('这个会话还没有选择模型');
    expect(alert.textContent).toContain('第一条');
    // 失败的那条仍排在最前，后面的那条也在（不丢、不乱序）
    const rows = getAllByTestId('pending-item');
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining('第一条'),
      expect.stringContaining('第二条'),
    ]);
    expect(rows[0]!.getAttribute('data-state')).toBe('failed');
    fireEvent.click(getByTestId('pending-retry'));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('shows no failure banner without a failure', () => {
    const { queryByTestId } = render(
      <PendingDock items={items} onWithdraw={vi.fn()} onRemove={vi.fn()} />,
    );
    expect(queryByTestId('pending-send-error')).toBeNull();
    expect(queryByTestId('pending-retry')).toBeNull();
  });
});
