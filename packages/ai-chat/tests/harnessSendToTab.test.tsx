// @vitest-environment happy-dom
import { act, cleanup, render, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { HarnessTabsProvider, useHarnessTabs } from '../src/contexts/HarnessTabsContext';
import type { HarnessTabMeta, HarnessTabsState } from '../src/services/harnessClient';

import { installFakeApi, resetFakeApi } from './helpers/fakeApi';

vi.mock('../src/services/api', async () => (await import('./helpers/fakeApi')).fakeApiModule());

afterEach(() => {
  cleanup();
  resetFakeApi();
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
  const sent: Array<{ tabId: string; text: string; images?: unknown[] }> = [];
  const cancels: string[] = [];
  const invoke = vi.fn(
    async (ch: string, i?: { id?: string; prompt?: string; images?: unknown[] }) => {
      if (ch === 'harness.tabs') return state;
      if (ch === 'harness.tabMessages') return [];
      if (ch === 'harness.tabSend') {
        sent.push({
          tabId: String(i?.id),
          text: String(i?.prompt),
          ...(i?.images ? { images: i.images } : {}),
        });
        return { ok: true };
      }
      if (ch === 'harness.tabCancel') {
        cancels.push(String(i?.id));
        return true;
      }
      if (ch === 'chatAssets.import') return { file: 'x.png', url: 'chat-asset://images/x.png' };
      return state;
    },
  );
  const fake = installFakeApi(invoke);
  return {
    sent,
    cancels,
    push: async (s: HarnessTabsState) => {
      state = s;
      await act(() => fake.emit('harness.tabsChanged', s));
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
    expect(Object.keys(ref.current!.queues)).toEqual(['a']);
    expect(ref.current!.queues.a!.map((i) => i.text)).toEqual(['排队']);
  });

  it('用最新状态判断忙闲：渲染后目标刚进入运行态，也要入队而不是重复派发', async () => {
    const ipc = mockIpc(stateOf([tab({ id: 'a' }), tab({ id: 'b' })], 'a'));
    const ref = mount();
    await waitFor(() => expect(ref.current!.state?.tabs).toHaveLength(3));
    const stale = ref.current!.sendToTab; // 旧渲染里拿到的引用
    await ipc.push(stateOf([tab({ id: 'a', status: 'running' }), tab({ id: 'b' })], 'b'));
    await waitFor(() => expect(ref.current!.activeTab?.id).toBe('b'));
    await act(async () => {
      await stale('a', '迟到文本');
    });
    expect(ipc.sent).toHaveLength(0);
    expect(ref.current!.queues.a!.map((i) => i.text)).toEqual(['迟到文本']);
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
    await ipc.push(stateOf([], 'main'));
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
    await ipc.push(stateOf([tab({ id: 'a' })], 'a'));
    await waitFor(() => expect(ref.current!.isCliTab).toBe(true));
    await act(async () => {
      await ref.current!.send('在 a 上');
    });
    expect(ipc.sent).toEqual([{ tabId: 'a', text: '在 a 上' }]);
  });

  it('目标运行中发送带图消息：以 queue 入队并在空闲后带着图片发送', async () => {
    const ipc = mockIpc(stateOf([tab({ id: 'a', status: 'running' })], 'a'));
    const ref = mount();
    await waitFor(() => expect(ref.current!.state?.tabs).toHaveLength(2));
    const img = {
      mime: 'image/png',
      data: 'QUJD',
      width: 10,
      height: 10,
      thumb: 'data:image/png;base64,T',
      source: 'paste',
    };
    let ok = false;
    await act(async () => {
      ok = await ref.current!.sendToTab('a', '运行中附图', undefined, [img], 'steer');
    });
    expect(ok).toBe(true);
    expect(ipc.sent).toHaveLength(0);
    expect(ref.current!.queues.a).toHaveLength(1);
    expect(ref.current!.queues.a![0]!.mode).toBe('queue');
    expect(ref.current!.queues.a![0]!.images).toEqual([img]);

    await ipc.push(stateOf([tab({ id: 'a', status: 'idle' })], 'a'));
    await waitFor(() => expect(ipc.sent).toHaveLength(1));
    expect(ipc.sent[0]).toMatchObject({
      tabId: 'a',
      text: '运行中附图',
      images: [expect.objectContaining({ data: 'QUJD', url: 'chat-asset://images/x.png' })],
    });
  });

  it('flushPendingFor 打断当前轮并合并保留图片，空闲后全部发出', async () => {
    const ipc = mockIpc(stateOf([tab({ id: 'a', status: 'running' })], 'a'));
    const ref = mount();
    await waitFor(() => expect(ref.current!.state?.tabs).toHaveLength(2));
    const img1 = { mime: 'image/png', data: 'QQ==' };
    const img2 = { mime: 'image/png', data: 'Qg==' };
    await act(async () => {
      await ref.current!.sendToTab('a', '第一条', undefined, [img1]);
      await ref.current!.sendToTab('a', '第二条', undefined, [img2]);
    });
    let flushed = false;
    await act(async () => {
      flushed = await ref.current!.flushPendingFor('a');
    });
    expect(flushed).toBe(true);
    expect(ipc.cancels).toEqual(['a']);
    expect(ref.current!.queues.a).toHaveLength(1);
    expect(ref.current!.queues.a![0]!.text).toBe('第一条\n\n第二条');
    expect(ref.current!.queues.a![0]!.images).toEqual([img1, img2]);

    await ipc.push(stateOf([tab({ id: 'a', status: 'idle' })], 'a'));
    await waitFor(() => expect(ipc.sent).toHaveLength(1));
    expect(ipc.sent[0]!.images).toHaveLength(2);
  });
});
