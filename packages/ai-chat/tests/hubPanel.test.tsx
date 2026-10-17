// @vitest-environment happy-dom
import { cleanup, fireEvent, render } from '@testing-library/react';
import React, { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { HubPanel, type HubTab } from '../src/components/HubPanel';

// 内嵌面板各自的数据逻辑有自己的测试，这里只验证抽屉的标签切换与「在设置中打开」
vi.mock('../src/components/lazyPanels', () => ({
  KnowledgePanel: () => <div data-testid="kb-panel" />,
  MemoryPanel: () => <div data-testid="mem-panel" />,
  NotesPanel: () => <div data-testid="notes-panel" />,
  SchedulePanel: () => <div data-testid="sched-panel" />,
}));

afterEach(() => {
  cleanup();
  delete (window as { aiIPC?: unknown }).aiIPC;
});

const Harness = ({
  start = 'memory',
  onOpenSettings,
}: {
  start?: HubTab;
  onOpenSettings: (s: string, t: string) => void;
}) => {
  const [tab, setTab] = useState<HubTab>(start);
  return (
    <HubPanel
      isVisible
      onClose={() => undefined}
      tab={tab}
      onTab={setTab}
      onOpenSettings={onOpenSettings}
    />
  );
};

describe('HubPanel（顶栏「知识 · 记忆 · 日程」抽屉）', () => {
  it('四个标签切换内嵌面板，方向键移动焦点，「在设置中打开」跳到对应分区标签', () => {
    (window as { aiIPC?: unknown }).aiIPC = { invoke: async () => true, on: () => () => undefined };
    const open = vi.fn();
    const r = render(<Harness onOpenSettings={open} />);
    expect(r.getByTestId('hub-panel').className).toContain('cd-modal--drawer');
    expect(r.getByTestId('hub-body').getAttribute('data-tab')).toBe('memory');
    expect(r.getByTestId('mem-panel')).toBeTruthy();
    expect(r.getAllByRole('tab').map((x) => x.textContent)).toEqual([
      '知识库',
      '长期记忆',
      '笔记',
      '日程',
    ]);

    const cases: Array<[HubTab, string, [string, string]]> = [
      ['kb', 'kb-panel', ['knowledge', 'kb']],
      ['notes', 'notes-panel', ['knowledge', 'notes']],
      ['schedule', 'sched-panel', ['schedule', 'reminders']],
      ['memory', 'mem-panel', ['knowledge', 'memory']],
    ];
    for (const [tab, panel, target] of cases) {
      fireEvent.click(r.getByTestId(`hub-tab-${tab}`));
      expect(r.getByTestId(`hub-tab-${tab}`).getAttribute('aria-selected')).toBe('true');
      expect(r.getByTestId(panel)).toBeTruthy();
      fireEvent.click(r.getByTestId('open-in-settings'));
      expect(open).toHaveBeenLastCalledWith(...target);
    }

    fireEvent.keyDown(r.getByTestId('hub-tabs'), { key: 'ArrowRight' });
    expect(r.getByTestId('hub-tab-notes').getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(r.getByTestId('hub-tab-notes'));
  });

  it('只列出可用的标签（没有桌面服务时没有「笔记」）', () => {
    const r = render(<Harness onOpenSettings={() => undefined} />);
    expect(r.queryAllByRole('tab')).toHaveLength(0);
  });
});
