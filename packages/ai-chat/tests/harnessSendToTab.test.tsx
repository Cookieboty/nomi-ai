// @vitest-environment happy-dom
import { act, cleanup, render, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { HarnessTabsProvider, useHarnessTabs } from '../src/contexts/HarnessTabsContext';
import type { HarnessTabMeta, HarnessTabsState } from '../src/services/harnessClient';

afterEach(() => {
  cleanup();
  delete (window as { aiIPC?: unknown }).aiIPC;
});

const tab = (over: Partial<HarnessTabMeta>): HarnessTabMeta => ({
  id: 'x',
  title: 'X',
  backend: 'claude',
  cwd: '/w',
  cliSessionId: null,
  status: 'idle',
  unread: 0,
  createdAt: 0,
  updatedAt: 0,
  ...over,
});

const stateOf = (tabs: HarnessTabMeta[], activeTabId: string): HarnessTabsState => ({
  tabs: [tab({ id: 'main', title: 'Chat', backend: 'nomi' }), ...tabs],
  activeTabId,
  running: 0,
  queued: 0,
});

function mockIpc(initial: HarnessTabsState) {
  let state = initial;
  const listeners: Record<string, Array<(p: unknown) => void>> = {};
  const sent: Array<{ tabId: string; text: string }> = [];
  const invoke = vi.fn(async (ch: string, ...a: unknown[]) => {
    if (ch === 'ai:harness:tabs') return state;
    if (ch === 'ai:harness:tab-messages') return [];
    if (ch === 'ai:harness:tab-send') {
      sent.push({ tabId: String(a[0]), text: String(a[1]) });
      return { ok: true };
    }
    return state;
  });
  const on = (ch: string, fn: (p: unknown) => void) => {
    (listeners[ch] ??= []).push(fn);
    return () => undefined;
  };
  (window as unknown as { aiIPC: unknown }).aiIPC = { invoke, on };
  return {
    sent,
    push: (s: HarnessTabsState) => {
      state = s;
      act(() => listeners['ai:harness:tabs']?.forEach((f) => f(s)));
    },
  };
}

type Tabs = ReturnType<typeof useHarnessTabs>;
function mount() {
  const ref: { current: Tabs | null } = { current: null };
  const Probe: React.FC = () => {
    ref.current = useHarnessTabs();
    return null;
  };
  render(
    <HarnessTabsProvider>
      <Probe />
    </HarnessTabsProvider>,
  );
  return ref;
}

describe('HarnessTabsContext.sendToTab', () => {
  it('空闲的目标标签：直接派发，即使当前激活的是别的标签', async () => {
    const ipc = mockIpc(
      stateOf([tab({ id: 'a', backend: 'codex', cwd: '/a' }), tab({ id: 'b' })], 'b'),
    );
    const ref = mount();
    await waitFor(() => expect(ref.current!.state?.tabs).toHaveLength(3));
    let ok = false;
    await act(async () => {
      ok = await ref.current!.sendToTab('a', '给 A 的文本');
    });
    expect(ok).toBe(true);
    expect(ipc.sent).toEqual([{ tabId: 'a', text: '给 A 的文本' }]); // 不是激活标签 b
  });

  it('目标运行中：进该标签的队列（不派发、不进别的标签的队列）', async () => {
    const ipc = mockIpc(
      stateOf([tab({ id: 'a', status: 'running' }), tab({ id: 'b', status: 'idle' })], 'b'),
    );
    const ref = mount();
    await waitFor(() => expect(ref.current!.state?.tabs).toHaveLength(3));
    let ok = false;
    await act(async () => {
      ok = await ref.current!.sendToTab('a', '排队');
    });
    expect(ok).toBe(true);
    expect(ipc.sent).toHaveLength(0);
    expect(ref.current!.queues).toEqual({ a: ['排队'] });
  });

  it('用最新状态判断忙闲：渲染后目标刚进入运行态，也要入队而不是重复派发', async () => {
    const ipc = mockIpc(stateOf([tab({ id: 'a' }), tab({ id: 'b' })], 'a'));
    const ref = mount();
    await waitFor(() => expect(ref.current!.state?.tabs).toHaveLength(3));
    const stale = ref.current!.sendToTab; // 旧渲染里拿到的引用
    ipc.push(stateOf([tab({ id: 'a', status: 'running' }), tab({ id: 'b' })], 'b'));
    await waitFor(() => expect(ref.current!.activeTab?.id).toBe('b'));
    await act(async () => {
      await stale('a', '迟到文本');
    });
    expect(ipc.sent).toHaveLength(0);
    expect(ref.current!.queues.a).toEqual(['迟到文本']);
  });

  it('标签不存在 / 已关闭 / 是 main：返回 false，什么都不发', async () => {
    const ipc = mockIpc(stateOf([tab({ id: 'a' })], 'a'));
    const ref = mount();
    await waitFor(() => expect(ref.current!.state?.tabs).toHaveLength(2));
    const results: boolean[] = [];
    await act(async () => {
      results.push(await ref.current!.sendToTab('nope', 'x'));
      results.push(await ref.current!.sendToTab('main', 'x'));
    });
    // 关闭 a 之后
    ipc.push(stateOf([], 'main'));
    await waitFor(() => expect(ref.current!.hasTab('a')).toBe(false));
    await act(async () => {
      results.push(await ref.current!.sendToTab('a', 'x'));
    });
    expect(results).toEqual([false, false, false]);
    expect(ipc.sent).toHaveLength(0);
    expect(ref.current!.queues).toEqual({});
  });

  it('后端或目录被改过（已重置）：expect 不符时返回 false', async () => {
    const ipc = mockIpc(stateOf([tab({ id: 'a', backend: 'claude', cwd: '/new' })], 'a'));
    const ref = mount();
    await waitFor(() => expect(ref.current!.state?.tabs).toHaveLength(2));
    const r: boolean[] = [];
    await act(async () => {
      r.push(await ref.current!.sendToTab('a', 'x', { backend: 'codex', cwd: '/new' }));
      r.push(await ref.current!.sendToTab('a', 'x', { backend: 'claude', cwd: '/old' }));
      r.push(await ref.current!.sendToTab('a', 'ok', { backend: 'claude', cwd: '/new' }));
    });
    expect(r).toEqual([false, false, true]);
    expect(ipc.sent).toEqual([{ tabId: 'a', text: 'ok' }]);
  });

  it('send 委托 sendToTab：只发给当前激活的 CLI 标签；main 上是空操作', async () => {
    const ipc = mockIpc(stateOf([tab({ id: 'a' })], 'main'));
    const ref = mount();
    await waitFor(() => expect(ref.current!.state?.tabs).toHaveLength(2));
    await act(async () => {
      await ref.current!.send('在 main 上');
    });
    expect(ipc.sent).toHaveLength(0);
    ipc.push(stateOf([tab({ id: 'a' })], 'a'));
    await waitFor(() => expect(ref.current!.isCliTab).toBe(true));
    await act(async () => {
      await ref.current!.send('在 a 上');
    });
    expect(ipc.sent).toEqual([{ tabId: 'a', text: '在 a 上' }]);
  });
});
