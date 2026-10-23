// @vitest-environment happy-dom
import { act, cleanup, render, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  HarnessTabsProvider,
  useHarnessLive,
  useHarnessTabs,
} from '../src/contexts/HarnessTabsContext';
import type { HarnessTabsState } from '../src/services/harnessClient';

afterEach(() => {
  cleanup();
  delete (window as { aiIPC?: unknown }).aiIPC;
});

const state: HarnessTabsState = {
  tabs: [
    {
      id: 'main',
      title: 'Chat',
      backend: 'nomi',
      cwd: '/w',
      cliSessionId: null,
      status: 'idle',
      unread: 0,
      createdAt: 0,
      updatedAt: 0,
    },
    {
      id: 'a',
      title: 'A',
      backend: 'claude',
      cwd: '/a',
      cliSessionId: null,
      status: 'running',
      unread: 0,
      createdAt: 0,
      updatedAt: 0,
    },
  ],
  activeTabId: 'a',
  running: 1,
  queued: 0,
};

function mockIpc() {
  const listeners: Record<string, Array<(p: unknown) => void>> = {};
  const invoke = vi.fn(async (ch: string) => (ch === 'ai:harness:tab-messages' ? [] : state));
  const on = (ch: string, fn: (p: unknown) => void) => {
    (listeners[ch] ??= []).push(fn);
    return () => undefined;
  };
  (window as unknown as { aiIPC: unknown }).aiIPC = { invoke, on };
  return {
    invoke,
    emit: (events: unknown[]) => listeners['ai:harness:events']?.forEach((f) => f(events)),
  };
}

describe('HarnessTabsContext 实时进度', () => {
  it('流式事件只让订阅了该标签进度的组件重渲染，useHarnessTabs 的消费者不动', async () => {
    const ipc = mockIpc();
    let tabsRenders = 0;
    let otherRenders = 0;
    const seen: { text?: string } = {};
    const TabsProbe: React.FC = () => {
      useHarnessTabs();
      tabsRenders++;
      return null;
    };
    const LiveProbe: React.FC = () => {
      seen.text = useHarnessLive((l) => l.a)?.text;
      return null;
    };
    const OtherTabProbe: React.FC = () => {
      useHarnessLive((l) => l.b);
      otherRenders++;
      return null;
    };
    const tabs: { current: ReturnType<typeof useHarnessTabs> | null } = { current: null };
    const Active: React.FC = () => {
      tabs.current = useHarnessTabs();
      return null;
    };
    render(
      <HarnessTabsProvider>
        <TabsProbe />
        <LiveProbe />
        <OtherTabProbe />
        <Active />
      </HarnessTabsProvider>,
    );
    await waitFor(() => expect(tabs.current?.activeTab?.id).toBe('a'));
    // 切到 CLI 标签会拉一次消息：等它落地（messages 变化本就该重渲染）再记基准
    await waitFor(() =>
      expect(ipc.invoke).toHaveBeenCalledWith('ai:harness:tab-messages', expect.anything()),
    );
    await act(() => new Promise((r) => setTimeout(r, 0)));
    const tabsBefore = tabsRenders;
    const otherBefore = otherRenders;

    for (const chunk of ['你', '好']) {
      act(() => {
        ipc.emit([{ tabId: 'a', type: 'text-delta', text: chunk }]);
      });
      // rAF 在测试环境里不一定触发：等兜底定时器把这一批落下
      await act(() => new Promise((r) => setTimeout(r, 120)));
    }

    expect(seen.text).toBe('你好');
    expect(tabsRenders).toBe(tabsBefore);
    expect(otherRenders).toBe(otherBefore);
  });
});
