// @vitest-environment happy-dom
import { act, cleanup, render } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useCliTabSync } from '../src/hooks/useCliTabSync';

const store = vi.hoisted(() => ({
  upsertFromTab: vi.fn(),
  list: vi.fn(() => []),
  removeByTabId: vi.fn(),
}));
const tabsState = vi.hoisted(() => ({
  current: {
    activeTabId: 'a',
    tabs: [
      { id: 'main', title: 'Nomi', backend: 'nomi', createdAt: 0, updatedAt: 0 },
      { id: 'a', title: 'Codex 1', backend: 'codex', createdAt: 1, updatedAt: 1 },
    ],
  },
}));

vi.mock('../src/contexts/aiChatStore', () => {
  const ipcClient = { conversationStore: () => store };
  return {
    selectIpcClient: (s: { ipcClient: unknown }) => s.ipcClient,
    useAiChatSelector: (sel: (s: { ipcClient: unknown }) => unknown) => sel({ ipcClient }),
  };
});
vi.mock('../src/contexts/HarnessTabsContext', () => ({
  useHarnessTabs: () => ({ state: tabsState.current }),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const onChange = vi.fn();
const Probe: React.FC<{ v: number }> = () => {
  useCliTabSync(onChange);
  return null;
};

const withTab = (patch: object) => {
  const [main, a] = tabsState.current.tabs;
  tabsState.current = { ...tabsState.current, tabs: [main!, { ...a!, ...patch }] };
};

describe('useCliTabSync', () => {
  it('只有 updatedAt 变时推迟到空闲再同步；增删 / 改名立即同步', async () => {
    const r = render(<Probe v={0} />);
    expect(onChange).toHaveBeenCalledTimes(1);

    // 回合结束：只更新了时间 → 不在这次提交里写存储 / 刷新侧栏
    withTab({ updatedAt: 2 });
    r.rerender(<Probe v={1} />);
    expect(onChange).toHaveBeenCalledTimes(1);
    await act(() => new Promise((res) => setTimeout(res, 400)));
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(store.upsertFromTab).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: 'a', updatedAt: 2 }),
    );

    // 改名：立即同步
    withTab({ title: '修复登录' });
    r.rerender(<Probe v={2} />);
    expect(onChange).toHaveBeenCalledTimes(3);
    expect(store.upsertFromTab).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: 'a', title: '修复登录' }),
    );
  });
});
