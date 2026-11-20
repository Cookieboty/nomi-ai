// @vitest-environment happy-dom
import { act, cleanup, render } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useIslandOpenItem } from '../src/hooks/useIslandOpenItem';

type OpenItemPayload = { target: 'task' | 'tab' | 'nomi'; id: string };

const state = vi.hoisted(() => ({
  handler: null as ((e: OpenItemPayload) => void) | null,
  tabs: {
    available: true,
    isCliTab: false,
    activeTab: { id: 'main', backend: 'nomi' as string },
    activate: vi.fn(async () => {}),
  },
  harnessAvailable: true,
  setBackend: vi.fn(async () => ({})),
}));

vi.mock('../src/services/desktopClient', () => ({
  desktopClient: {
    onOpenItem: (fn: (e: OpenItemPayload) => void) => {
      state.handler = fn;
      return () => {
        if (state.handler === fn) state.handler = null;
      };
    },
  },
}));

vi.mock('../src/contexts/HarnessTabsContext', () => ({
  useHarnessTabsCore: () => state.tabs,
}));

vi.mock('../src/services/harnessClient', () => ({
  MAIN_TAB_ID: 'main',
  harnessClient: {
    available: () => state.harnessAvailable,
    setBackend: state.setBackend,
  },
}));

beforeEach(() => {
  state.handler = null;
  state.tabs.available = true;
  state.tabs.isCliTab = false;
  state.tabs.activeTab = { id: 'main', backend: 'nomi' };
  state.tabs.activate.mockClear();
  state.harnessAvailable = true;
  state.setBackend.mockClear();
});

afterEach(() => {
  cleanup();
});

describe('useIslandOpenItem', () => {
  it('routes task, tab, and nomi navigation events to the expected targets', () => {
    const order: string[] = [];
    const openTask = vi.fn((id: string) => order.push(`task:${id}`));
    const leavePage = vi.fn(() => order.push('leave'));
    const openConversation = vi.fn((id: string) => order.push(`convo:${id}`));
    const onOpenTab = vi.fn((id: string) => order.push(`onTab:${id}`));
    state.tabs.activate.mockImplementation(async (id: string) => {
      order.push(`activate:${id}`);
    });

    const Host = () => {
      useIslandOpenItem(openTask, leavePage, openConversation, onOpenTab);
      return null;
    };

    render(<Host />);
    expect(state.handler).toBeTypeOf('function');

    // 1. target = task：直接进任务详情，不额外离开主区页面或切标签
    act(() => {
      state.handler!({ target: 'task', id: 'tk_42' });
    });
    expect(openTask).toHaveBeenCalledWith('tk_42');
    expect(leavePage).not.toHaveBeenCalled();
    expect(state.tabs.activate).not.toHaveBeenCalled();

    // 2. target = tab：先退出全页/设置页，再激活目标 agent 标签并同步会话记录
    act(() => {
      state.handler!({ target: 'tab', id: 'tab_7' });
    });
    expect(leavePage).toHaveBeenCalledTimes(1);
    expect(state.tabs.activate).toHaveBeenCalledWith('tab_7');
    expect(onOpenTab).toHaveBeenCalledWith('tab_7');
    expect(openConversation).not.toHaveBeenCalled();

    // 3. target = nomi（带具体会话 id 且当前正在 CLI 标签）：先更新会话指针再切回 main
    order.length = 0;
    state.tabs.isCliTab = true;
    state.tabs.activeTab = { id: 'tab_7', backend: 'codex' };
    act(() => {
      state.handler!({ target: 'nomi', id: 'conv_99' });
    });
    expect(order).toEqual(['leave', 'convo:conv_99', 'activate:main']);

    // 4. target = nomi（不带会话 id 且主标签停在非 nomi 后端）：留在当前会话，切回 nomi 后端
    order.length = 0;
    state.tabs.isCliTab = false;
    state.tabs.activeTab = { id: 'main', backend: 'claude' };
    act(() => {
      state.handler!({ target: 'nomi', id: '' });
    });
    expect(openConversation).toHaveBeenCalledTimes(1);
    expect(state.setBackend).toHaveBeenCalledWith('nomi');
    expect(order).toEqual(['leave']);
  });
});
