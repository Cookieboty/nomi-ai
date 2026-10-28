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

import type { CodingApiMockState } from './helpers/codingApi';

// D3 客户端走契约（services/api）；测试仍用旧通道形状的 window.aiIPC 假桥，经 helpers/codingApi 转发
const codingApi = vi.hoisted(() => ({}) as CodingApiMockState);
vi.mock('../src/services/api', async () =>
  (await import('./helpers/codingApi')).createCodingApiMock(codingApi),
);

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
    emitMessage: (p: unknown) => listeners['ai:harness:tab-message']?.forEach((f) => f(p)),
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

describe('HarnessTabsContext 回合定稿', () => {
  /** 记录每次渲染时的「定稿消息数 / 是否还有实时进度」 */
  async function setup() {
    const ipc = mockIpc();
    const frames: Array<{ messages: number; live: boolean }> = [];
    const tabs: { current: ReturnType<typeof useHarnessTabs> | null } = { current: null };
    const Probe: React.FC = () => {
      tabs.current = useHarnessTabs();
      const live = useHarnessLive((l) => l.a);
      frames.push({ messages: tabs.current.messages.length, live: !!live });
      return null;
    };
    render(
      <HarnessTabsProvider>
        <Probe />
      </HarnessTabsProvider>,
    );
    await waitFor(() => expect(tabs.current?.activeTab?.id).toBe('a'));
    await waitFor(() =>
      expect(ipc.invoke).toHaveBeenCalledWith('ai:harness:tab-messages', expect.anything()),
    );
    await act(() => new Promise((r) => setTimeout(r, 0)));
    return { ipc, frames };
  }
  const message = (extra: object = {}) => ({
    tabId: 'a',
    message: { id: 'm1', role: 'assistant', content: '你好', timestamp: 1, ...extra },
  });

  it('定稿助手消息一到就清掉实时进度，不等标签状态回到空闲', async () => {
    const { ipc, frames } = await setup();
    act(() => ipc.emit([{ tabId: 'a', type: 'text-delta', text: '你好' }]));
    await act(() => new Promise((r) => setTimeout(r, 120)));
    expect(frames.at(-1)).toEqual({ messages: 0, live: true });

    // 最后一段流式事件还在缓冲里（未到下一帧）时定稿消息就到了
    act(() => {
      ipc.emit([{ tabId: 'a', type: 'text-delta', text: '！' }]);
      ipc.emitMessage(message());
    });
    // 不等「已空闲」的标签状态：消息一到实时进度就清掉
    expect(frames.at(-1)).toEqual({ messages: 1, live: false });
    // 缓冲里的残余事件已先落下，兜底定时器之后也不会把进度重建出来
    await act(() => new Promise((r) => setTimeout(r, 120)));
    expect(frames.at(-1)).toEqual({ messages: 1, live: false });
  });

  it('后台自动回合的消息不清实时进度（用户回合可能还在进行）', async () => {
    const { ipc, frames } = await setup();
    act(() => ipc.emit([{ tabId: 'a', type: 'text-delta', text: '处理中' }]));
    await act(() => new Promise((r) => setTimeout(r, 120)));
    act(() => ipc.emitMessage(message({ origin: 'background' })));
    await act(() => new Promise((r) => setTimeout(r, 0)));
    expect(frames.at(-1)).toEqual({ messages: 1, live: true });
  });
});
