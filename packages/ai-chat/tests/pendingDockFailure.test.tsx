// @vitest-environment happy-dom
/** 待发列表里自动发送失败的可见提示与「重试」（不是只在 state 里记着） */
import { t } from '@nomi-ai/ui';
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
    // 提示标题随语言切换：与组件同样的拼法——词典加载时 t() 插好原因，
    // 词典没加载时 t() 原样返回 key（没有 {0}），组件把原因补在后面
    const failure = '这个会话还没有选择模型';
    const lead = String(t('ui.session-workspace.pending-send-failed', failure));
    const heading =
      lead === 'ui.session-workspace.pending-send-failed' ? `${lead}：${failure}` : lead;
    expect(alert.textContent).toContain(heading);
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
    expect(queryByTestId('pending-attachments-missing')).toBeNull();
  });

  it('队首带附件缺失标记（含正文）：展示重新附上 / 仅发文字 / 删除，不显示重试', () => {
    const onWithdraw = vi.fn();
    const onRemove = vi.fn();
    const onSendTextOnly = vi.fn();
    const { getByTestId, queryByTestId, getAllByTestId } = render(
      <PendingDock
        items={[
          { id: 'p1', text: '附带截图看看', mode: 'queue', attachmentsMissing: true },
          { id: 'p2', text: '后续条目', mode: 'queue' },
        ]}
        onWithdraw={onWithdraw}
        onRemove={onRemove}
        onSendTextOnly={onSendTextOnly}
      />,
    );
    const alert = getByTestId('pending-attachments-missing');
    expect(alert.getAttribute('role')).toBe('alert');
    expect(queryByTestId('pending-send-error')).toBeNull();
    expect(queryByTestId('pending-retry')).toBeNull();
    expect(getAllByTestId('pending-item')[0]!.getAttribute('data-state')).toBe(
      'attachments-missing',
    );

    fireEvent.click(getByTestId('pending-send-text-only'));
    expect(onSendTextOnly).toHaveBeenCalledWith('p1');
    fireEvent.click(getByTestId('pending-reattach'));
    expect(onWithdraw).toHaveBeenCalledWith(expect.objectContaining({ id: 'p1' }));
    fireEvent.click(getByTestId('pending-missing-remove'));
    expect(onRemove).toHaveBeenCalledWith('p1');
  });

  it('纯图片条目附件缺失：不提供「仅发文字」，列表显示纯图片占位', () => {
    const { getByTestId, queryByTestId, getAllByTestId } = render(
      <PendingDock
        items={[
          { id: 'p1', text: '', mode: 'queue', attachmentsMissing: true, imageOnly: true },
        ]}
        onWithdraw={vi.fn()}
        onRemove={vi.fn()}
        onSendTextOnly={vi.fn()}
      />,
    );
    expect(getByTestId('pending-attachments-missing')).toBeTruthy();
    expect(queryByTestId('pending-send-text-only')).toBeNull();
    expect(getAllByTestId('pending-item')[0]!.getAttribute('data-state')).toBe(
      'attachments-missing',
    );
    expect(getAllByTestId('pending-item')[0]!.textContent).toContain(
      String(t('ui.session-workspace.pending-image-only-placeholder')),
    );
  });
});
