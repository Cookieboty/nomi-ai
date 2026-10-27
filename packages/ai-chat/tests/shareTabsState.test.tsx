// @vitest-environment happy-dom
import { act, cleanup, render, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  HarnessTabsProvider,
  useHarnessTabs,
  useHarnessTabsCore,
} from '../src/contexts/HarnessTabsContext';
import type { HarnessTabMeta, HarnessTabsState } from '../src/services/harnessClient';
import { jsonEqual, shareTabsState } from '../src/utils/shareTabsState';

function tab(id: string, over: Partial<HarnessTabMeta> = {}): HarnessTabMeta {
  return {
    id,
    title: id.toUpperCase(),
    backend: id === 'main' ? 'nomi' : 'claude',
    cwd: `/${id}`,
    cliSessionId: null,
    status: 'idle',
    unread: 0,
    createdAt: 0,
    updatedAt: 0,
    backgroundAgents: [{ id: `${id}-bg`, label: 'x', startedAt: 1, stoppable: true }],
    delegation: {
      by: 'nomi',
      goal: 'g',
      approvals: { asked: 0, denied: 0, timedOut: 0 },
    },
    ...over,
  };
}

/** 每次都新建对象，模拟主进程推送的完整 listTabs() */
function payload(overB: Partial<HarnessTabMeta> = {}, active = 'a'): HarnessTabsState {
  return {
    tabs: [tab('main'), tab('a'), tab('b', overB)],
    activeTabId: active,
    running: 0,
    queued: 0,
  };
}

describe('shareTabsState', () => {
  it('同样的内容返回旧状态本身', () => {
    const prev = payload();
    expect(shareTabsState(prev, payload())).toBe(prev);
  });

  it('只换掉变了的标签，其它标签与没变的嵌套字段沿用旧引用', () => {
    const prev = payload();
    const next = shareTabsState(prev, payload({ status: 'running', unread: 2 }));
    expect(next).not.toBe(prev);
    expect(next.tabs).not.toBe(prev.tabs);
    expect(next.tabs[0]).toBe(prev.tabs[0]);
    expect(next.tabs[1]).toBe(prev.tabs[1]);
    expect(next.tabs[2]).not.toBe(prev.tabs[2]);
    expect(next.tabs[2]!.status).toBe('running');
    expect(next.tabs[2]!.unread).toBe(2);
    expect(next.tabs[2]!.backgroundAgents).toBe(prev.tabs[2]!.backgroundAgents);
    expect(next.tabs[2]!.delegation).toBe(prev.tabs[2]!.delegation);
  });

  it('嵌套数组变了就换新引用', () => {
    const prev = payload();
    const agents = [{ id: 'b-bg', label: 'y', startedAt: 1, stoppable: true }];
    const next = shareTabsState(prev, payload({ backgroundAgents: agents }));
    expect(next.tabs[2]!.backgroundAgents).toBe(agents);
    expect(next.tabs[2]!.delegation).toBe(prev.tabs[2]!.delegation);
  });

  it('只是顶层字段变了：沿用旧标签数组', () => {
    const prev = payload();
    const next = shareTabsState(prev, payload({}, 'b'));
    expect(next).not.toBe(prev);
    expect(next.activeTabId).toBe('b');
    expect(next.tabs).toBe(prev.tabs);
  });

  it('标签增删 / 重排时换标签数组，已有标签对象复用', () => {
    const prev = payload();
    const raw = payload();
    const next = shareTabsState(prev, { ...raw, tabs: [raw.tabs[0]!, raw.tabs[2]!] });
    expect(next.tabs).not.toBe(prev.tabs);
    expect(next.tabs[0]).toBe(prev.tabs[0]);
    expect(next.tabs[1]).toBe(prev.tabs[2]);
  });

  it('jsonEqual 区分缺省字段与键数不同', () => {
    expect(jsonEqual({ a: 1 }, { a: 1, b: undefined })).toBe(false);
    expect(jsonEqual([1, { x: [2] }], [1, { x: [2] }])).toBe(true);
    expect(jsonEqual([], {})).toBe(false);
  });
});

describe('HarnessTabsProvider 标签广播', () => {
  afterEach(() => {
    cleanup();
    delete (window as { aiIPC?: unknown }).aiIPC;
  });

  function mockIpc() {
    const listeners: Record<string, Array<(p: unknown) => void>> = {};
    const invoke = vi.fn(async (ch: string) => (ch === 'ai:harness:tab-messages' ? [] : payload()));
    const on = (ch: string, fn: (p: unknown) => void) => {
      (listeners[ch] ??= []).push(fn);
      return () => undefined;
    };
    (window as unknown as { aiIPC: unknown }).aiIPC = { invoke, on };
    return {
      invoke,
      emitTabs: (s: HarnessTabsState) => listeners['ai:harness:tabs']?.forEach((f) => f(s)),
    };
  }

  it('相同推送不重渲染；后台标签变化只让订阅完整列表的组件重渲染，activeTab 保持引用', async () => {
    const ipc = mockIpc();
    let fullRenders = 0;
    let coreRenders = 0;
    const full: { current: ReturnType<typeof useHarnessTabs> | null } = { current: null };
    const core: { current: ReturnType<typeof useHarnessTabsCore> | null } = { current: null };
    const Full: React.FC = () => {
      full.current = useHarnessTabs();
      fullRenders++;
      return null;
    };
    const Core: React.FC = () => {
      core.current = useHarnessTabsCore();
      coreRenders++;
      return null;
    };
    render(
      <HarnessTabsProvider>
        <Full />
        <Core />
      </HarnessTabsProvider>,
    );
    await waitFor(() => expect(core.current?.activeTab?.id).toBe('a'));
    await waitFor(() =>
      expect(ipc.invoke).toHaveBeenCalledWith('ai:harness:tab-messages', expect.anything()),
    );
    await act(() => new Promise((r) => setTimeout(r, 0)));
    const stateBefore = full.current!.state;
    const activeBefore = core.current!.activeTab;
    const fullBefore = fullRenders;
    const coreBefore = coreRenders;

    // 内容相同的推送：什么都不变
    act(() => ipc.emitTabs(payload()));
    expect(full.current!.state).toBe(stateBefore);
    expect(fullRenders).toBe(fullBefore);
    expect(coreRenders).toBe(coreBefore);

    // 后台标签 b 开始运行：完整列表换引用，当前标签与 core 不动
    act(() => ipc.emitTabs(payload({ status: 'running' })));
    expect(full.current!.state).not.toBe(stateBefore);
    expect(full.current!.state!.tabs[1]).toBe(stateBefore!.tabs[1]);
    expect(fullRenders).toBe(fullBefore + 1);
    expect(coreRenders).toBe(coreBefore);
    expect(core.current!.activeTab).toBe(activeBefore);
  });
});
