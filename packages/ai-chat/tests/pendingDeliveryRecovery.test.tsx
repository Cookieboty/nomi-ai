// @vitest-environment happy-dom
/**
 * Regression: 队列自动发送以前先删掉队首、写「已交付」再派发；派发在图片导入 / 发送预检 / 来源帧被换掉时
 * 返回错误，错误被忽略——排队消息连同图片一起消失，后面的消息还会照常发出（乱序）。
 * 现在：派发成功（内核收下）才从列表移除；失败时整条（正文 + 图片）挂回队首、显示可见错误、不自动重试；
 * 重试 / 手动发送 / Esc 合成都能再发；重启后挂回的队列同样适用。
 */
import { act, cleanup, render, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { HarnessTabsProvider, useHarnessTabs } from '../src/contexts/HarnessTabsContext';
import type { HarnessTabMeta, HarnessTabsState } from '../src/services/harnessClient';
import { pendingKey } from '../src/services/pendingSendsStore';

import { installFakeApi, resetFakeApi } from './helpers/fakeApi';

vi.mock('../src/services/api', async () => (await import('./helpers/fakeApi')).fakeApiModule());

afterEach(() => {
  cleanup();
  resetFakeApi();
  localStorage.clear();
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

type SendBehavior = 'ok' | 'reject' | 'image-import';

function mockIpc(
  initial: HarnessTabsState,
  behavior: () => SendBehavior = () => 'ok',
  /** 测试可以让 tabSend 先挂着（回执晚到） */
  hold?: { p: Promise<void> | null },
) {
  let state = initial;
  const sent: Array<{ tabId: string; text: string; images?: unknown[] }> = [];
  const cancels: string[] = [];
  const invoke = vi.fn(
    async (ch: string, i?: { id?: string; prompt?: string; images?: unknown[] }) => {
      if (ch === 'harness.tabs') return state;
      if (ch === 'harness.tabMessages') return [];
      if (ch === 'harness.tabSend') {
        if (hold?.p) await hold.p;
        const how = behavior();
        if (how === 'reject')
          throw new Error('这个会话还没有选择模型，请先在输入栏选择一个第三方模型');
        if (how === 'image-import') throw new Error('图片导入失败：素材库暂时不可用');
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
      // 换内核状态也走 act：派发途中（等回执）换状态，视图要在同一个批次里提交
      await act(async () => {
        state = s;
        await fake.emit('harness.tabsChanged', s);
      });
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

const img = (data: string) => ({ mime: 'image/png', data, width: 4, height: 4, source: 'paste' });

/** 运行中入队两条（第二条带图），然后这一轮结束 */
async function queueTwo(ref: { current: Tabs | null }) {
  await act(async () => {
    await ref.current!.sendToTab('a', '第一条');
    await ref.current!.sendToTab('a', '第二条', undefined, [img('QUJD')]);
  });
}

describe('queued delivery failure recovery', () => {
  it('派发 / 预检失败：整条（含图片）留在队首、可见错误、不自动重试；重试成功后只移除一次，后面的不乱序', async () => {
    let failNext = 2; // 前两次自动派发都失败
    const ipc = mockIpc(stateOf([tab({ id: 'a', status: 'running' })], 'a'), () =>
      failNext-- > 0 ? 'reject' : 'ok',
    );
    const ref = mount();
    await waitFor(() => expect(ref.current!.state?.tabs).toHaveLength(2));
    await queueTwo(ref);
    expect(ref.current!.queues.a!.map((i) => i.text)).toEqual(['第一条', '第二条']);

    // 这一轮结束 → 自动发送第一条，被预检拒绝
    await ipc.push(stateOf([tab({ id: 'a', status: 'idle' })], 'a'));
    await waitFor(() => expect(ref.current!.sendFails.a).toBeTruthy());
    expect(ipc.sent).toHaveLength(0);
    // 正文与图片都还在，且仍在最前面；第二条没被跳过（不乱序、不丢）
    expect(ref.current!.queues.a!.map((i) => i.text)).toEqual(['第一条', '第二条']);
    expect(ref.current!.sendFails.a!.item.text).toBe('第一条');
    expect(ref.current!.sendFails.a!.message).toContain('还没有选择模型');
    expect(ref.current!.inFlight.a).toBeUndefined();

    // 不自动重试：状态再变（同一标签空转）也不会自己再发
    await ipc.push(stateOf([tab({ id: 'a', status: 'idle' }, 1)], 'a'));
    await act(() => new Promise((r) => setTimeout(r, 30)));
    expect(ipc.sent).toHaveLength(0);
    expect(ref.current!.queues.a!.map((i) => i.text)).toEqual(['第一条', '第二条']);

    // 明确重试：再失败一次 → 仍留在队首，仍然只失败这一条
    await act(async () => {
      ref.current!.retryFailedSend('a');
    });
    await waitFor(() => expect(ref.current!.sendFails.a).toBeTruthy());
    expect(ref.current!.queues.a!.map((i) => i.text)).toEqual(['第一条', '第二条']);

    // 再重试：成功 → 第一条移除（只移除一次），第二条随后自动发出
    await act(async () => {
      ref.current!.retryFailedSend('a');
    });
    await waitFor(() => expect(ipc.sent.length).toBeGreaterThanOrEqual(1));
    await waitFor(() => expect(ref.current!.queues.a ?? []).toHaveLength(0));
    expect(ipc.sent.map((s) => s.text)).toEqual(['第一条', '第二条']);
    expect(ref.current!.sendFails.a).toBeUndefined();
  });

  it('图片导入 / 派发阶段抛错：正文和图片都保留在队首，并显示失败原因', async () => {
    let mode: SendBehavior = 'image-import';
    const ipc = mockIpc(stateOf([tab({ id: 'a', status: 'running' })], 'a'), () => mode);
    const ref = mount();
    await waitFor(() => expect(ref.current!.state?.tabs).toHaveLength(2));
    await queueTwo(ref);
    await ipc.push(stateOf([tab({ id: 'a', status: 'idle' })], 'a'));
    await waitFor(() => expect(ref.current!.sendFails.a).toBeTruthy());
    expect(ref.current!.sendFails.a!.message).toContain('图片导入失败');
    const head = ref.current!.queues.a![0]!;
    expect(head.text).toBe('第一条');
    // 第二条带图的那条也还在，图片没被吞掉
    expect(ref.current!.queues.a![1]!.images).toEqual([img('QUJD')]);

    // 恢复后重试：两条都发出，带图的那条带着原图
    mode = 'ok';
    await act(async () => {
      ref.current!.retryFailedSend('a');
      ref.current!.retryFailedSend('a');
    });
    await waitFor(() => expect(ipc.sent).toHaveLength(2));
    expect(ipc.sent[1]!.text).toBe('第二条');
    expect(ipc.sent[1]!.images).toEqual([
      expect.objectContaining({ data: 'QUJD', url: 'chat-asset://images/x.png' }),
    ]);
    expect(ref.current!.queues.a ?? []).toHaveLength(0);
  });

  it('输入框手动发同一句：替代队首失败的那条（只发一次），解除提示，后面的接着发', async () => {
    let fail = 1;
    const ipc = mockIpc(stateOf([tab({ id: 'a', status: 'running' })], 'a'), () =>
      fail-- > 0 ? 'reject' : 'ok',
    );
    const ref = mount();
    await waitFor(() => expect(ref.current!.state?.tabs).toHaveLength(2));
    await queueTwo(ref);
    await ipc.push(stateOf([tab({ id: 'a', status: 'idle' })], 'a'));
    await waitFor(() => expect(ref.current!.sendFails.a).toBeTruthy());

    const errors: string[] = [];
    await act(async () => {
      await ref.current!.sendToTab('a', '第一条', undefined, undefined, 'queue', (m) =>
        errors.push(m),
      );
    });
    // 只交付一次：被替代的那条只发这一次；后面那条等这一轮结束（标签跑起来又空下来）再自动发
    expect(errors).toEqual([]);
    expect(ipc.sent.map((s) => s.text)).toEqual(['第一条']);
    expect(ref.current!.sendFails.a).toBeUndefined();
    await ipc.push(stateOf([tab({ id: 'a', status: 'running' })], 'a'));
    await ipc.push(stateOf([tab({ id: 'a', status: 'idle' })], 'a'));
    await act(() => new Promise((r) => setTimeout(r, 30)));
    await waitFor(() => expect(ipc.sent.map((s) => s.text)).toEqual(['第一条', '第二条']));
    expect(ipc.sent.filter((s) => s.text === '第一条')).toHaveLength(1);
    await waitFor(() => expect(ref.current!.queues.a ?? []).toHaveLength(0));
  });

  it('重启后挂回的队列：自动发送失败时保留在列表里并提示，而不是消失', async () => {
    const stored = [
      { id: 's1', text: '重启前排的', mode: 'queue' as const },
      { id: 's2', text: '后面那条', mode: 'queue' as const },
    ];
    localStorage.setItem(pendingKey('tab', 'a'), JSON.stringify(stored));
    let fail = 1;
    const ipc = mockIpc(stateOf([tab({ id: 'a' })], 'a'), () => (fail-- > 0 ? 'reject' : 'ok'));
    const ref = mount();
    await waitFor(() => expect(ref.current!.state?.tabs).toHaveLength(2));
    // 当前标签挂回存下的队列（与 useComposerPending 一样，标签是当前标签时调 restorePending）：队首自动发送被拒
    let restored = false;
    await act(async () => {
      restored = ref.current!.restorePending(pendingKey('tab', 'a'));
    });
    expect(restored).toBe(true);
    await waitFor(() => expect(ref.current!.sendFails.a).toBeTruthy());
    expect(ipc.sent).toHaveLength(0);
    expect(ref.current!.queues.a!.map((i) => i.text)).toEqual(['重启前排的', '后面那条']);
    expect(ref.current!.sendFails.a!.item.text).toBe('重启前排的');

    // 明确重试：恢复后按原顺序发出，每一条只发一次（后一条要等这一轮真的跑起来再接着发）
    await act(async () => {
      ref.current!.retryFailedSend('a');
    });
    await waitFor(() => expect(ipc.sent.map((s) => s.text)).toEqual(['重启前排的', '后面那条']));
    await ipc.push(stateOf([tab({ id: 'a', status: 'running' })], 'a'));
    await waitFor(() => expect(ipc.sent.map((s) => s.text)).toEqual(['重启前排的', '后面那条']));
    await waitFor(() => expect(ref.current!.queues.a ?? []).toHaveLength(0));
    expect(ref.current!.sendFails.a).toBeUndefined();
  });

  it('回执晚到、标签先回到空闲：同一条不会被派发两次', async () => {
    const hold = { p: null as Promise<void> | null };
    let release!: () => void;
    const ipc = mockIpc(stateOf([tab({ id: 'a', status: 'running' })], 'a'), () => 'ok', hold);
    const ref = mount();
    await waitFor(() => expect(ref.current!.state?.tabs).toHaveLength(2));
    await queueTwo(ref);
    hold.p = new Promise<void>((r) => {
      release = r;
    });
    // 这一轮结束 → 派发第一条，回执挂住
    await ipc.push(stateOf([tab({ id: 'a', status: 'idle' })], 'a'));
    await waitFor(() => expect(ref.current!.inFlight.a).toBeTruthy());
    // 回执回来之前标签又变成运行中、再回到空闲：不能把同一条再派发一次
    await ipc.push(stateOf([tab({ id: 'a', status: 'running' })], 'a'));
    await ipc.push(stateOf([tab({ id: 'a', status: 'idle' })], 'a'));
    expect(ipc.sent).toHaveLength(0);
    release();
    await waitFor(() => expect(ipc.sent.map((s) => s.text)).toEqual(['第一条', '第二条']));
    await waitFor(() => expect(ref.current!.queues.a ?? []).toHaveLength(0));
    expect(ipc.sent.filter((s) => s.text === '第一条')).toHaveLength(1);
  });

  it('别的消息手动发送不解除失败提示；手动发同一句解除提示、只交付一次', async () => {
    let fail = 1;
    const ipc = mockIpc(stateOf([tab({ id: 'a', status: 'running' })], 'a'), () =>
      fail-- > 0 ? 'reject' : 'ok',
    );
    const ref = mount();
    await waitFor(() => expect(ref.current!.state?.tabs).toHaveLength(2));
    await queueTwo(ref);
    // 这一轮结束：自动发送队首「第一条」被拒 → 失败提示，第二条留在它后面
    await ipc.push(stateOf([tab({ id: 'a', status: 'idle' })], 'a'));
    await waitFor(() => expect(ref.current!.sendFails.a).toBeTruthy());
    const failedId = ref.current!.sendFails.a!.item.id;
    expect(ipc.sent).toHaveLength(0);
    expect(ref.current!.queues.a!.map((i) => i.text)).toEqual(['第一条', '第二条']);

    // 同一个空闲标签上手动发一条别的：内核收下了（标签真的跑起来），再跑完回到空闲
    await act(async () => {
      await ref.current!.sendToTab('a', '别的一句', undefined, undefined, 'steer');
    });
    expect(ipc.sent.map((s) => s.text)).toEqual(['别的一句']);
    await ipc.push(stateOf([tab({ id: 'a', status: 'running' })], 'a'));
    // 跑起来的是「别的一句」，不是失败的队首：失败提示和原因都得在，失败队首仍排在最前、第二条没被越过
    expect(ref.current!.sendFails.a!.item.text).toBe('第一条');
    expect(ref.current!.sendFails.a!.item.id).toBe(failedId);
    expect(ref.current!.sendFails.a!.message).toContain('还没有选择模型');
    expect(ref.current!.queues.a!.map((i) => i.text)).toEqual(['第一条', '第二条']);
    await ipc.push(stateOf([tab({ id: 'a', status: 'idle' })], 'a'));
    // 回到空闲也不能自动重试失败队首 / 越过它发第二条
    await act(() => new Promise((r) => setTimeout(r, 30)));
    expect(ipc.sent.map((s) => s.text)).toEqual(['别的一句']);
    expect(ref.current!.sendFails.a!.item.id).toBe(failedId);
    expect(ref.current!.sendFails.a!.message).toContain('还没有选择模型');
    expect(ref.current!.queues.a!.map((i) => i.text)).toEqual(['第一条', '第二条']);

    // 手动发同一句（这次内核收下）
    const errors: string[] = [];
    await act(async () => {
      await ref.current!.sendToTab('a', '第一条', undefined, undefined, 'queue', (m) =>
        errors.push(m),
      );
    });
    // 成功确认之后才移除原失败项、解除提示
    expect(errors).toEqual([]);
    expect(ipc.sent.map((s) => s.text)).toEqual(['别的一句', '第一条']);
    expect(ref.current!.sendFails.a).toBeUndefined();
    expect(ref.current!.queues.a!.map((i) => i.text)).toEqual(['第二条']);

    // 「第一条」这一轮跑起来再跑完：第二条这时才接着自动发出，且「第一条」只交付一次
    await ipc.push(stateOf([tab({ id: 'a', status: 'running' })], 'a'));
    await ipc.push(stateOf([tab({ id: 'a', status: 'idle' })], 'a'));
    await waitFor(() =>
      expect(ipc.sent.map((s) => s.text)).toEqual(['别的一句', '第一条', '第二条']),
    );
    expect(ipc.sent.filter((s) => s.text === '第一条')).toHaveLength(1);
    expect(ref.current!.queues.a ?? []).toHaveLength(0);
  });

  it('Esc 合成发送：失败的队首与后面的合并成一条仍按顺序发出', async () => {
    let fail = 1;
    const ipc = mockIpc(stateOf([tab({ id: 'a', status: 'running' })], 'a'), () =>
      fail-- > 0 ? 'reject' : 'ok',
    );
    const ref = mount();
    await waitFor(() => expect(ref.current!.state?.tabs).toHaveLength(2));
    await queueTwo(ref);
    await ipc.push(stateOf([tab({ id: 'a', status: 'running' })], 'a'));
    await waitFor(() => expect(ref.current!.sendFails.a).toBeUndefined());
    // 先让自动发送失败一次（这一轮结束）
    await ipc.push(stateOf([tab({ id: 'a', status: 'idle' })], 'a'));
    await waitFor(() => expect(ref.current!.sendFails.a).toBeTruthy());
    await ipc.push(stateOf([tab({ id: 'a', status: 'running' })], 'a'));
    await act(async () => {
      await ref.current!.flushPendingFor('a');
    });
    expect(ipc.cancels).toEqual(['a']);
    expect(ref.current!.queues.a![0]!.text).toBe('第一条\n\n第二条');
    await ipc.push(stateOf([tab({ id: 'a', status: 'idle' })], 'a'));
    await waitFor(() => expect(ipc.sent.map((s) => s.text)).toEqual(['第一条\n\n第二条']));
  });
});

/**
 * 手动发送替代失败队首的时机：以前只要正文相同、id 还在队列里，就在派发之前先移除原失败项并清掉提示——
 * 附件不同也当成同一条；这次再失败时原条目已经没了，再次失败会静默丢掉。
 * 现在：正文与附件都一样才算同一条，成功确认后才移除，再次失败原条目仍在队首且失败可见。
 */
describe('手动发送失败队首的替代', () => {
  /** 队列里先排一条纯文字，失败一次（队首失败、失败可见） */
  async function failHead(ref: { current: Tabs | null }, ipc: ReturnType<typeof mockIpc>) {
    await act(async () => {
      await ref.current!.sendToTab('a', '第一条');
    });
    await ipc.push(stateOf([tab({ id: 'a', status: 'idle' })], 'a'));
    await waitFor(() => expect(ref.current!.sendFails.a).toBeTruthy());
    expect(ipc.sent).toHaveLength(0);
    expect(ref.current!.queues.a!.map((i) => i.text)).toEqual(['第一条']);
  }

  it('手动发同一句又失败：原条目仍在队首，失败原因重新可见（不被提前移除）', async () => {
    const ipc = mockIpc(stateOf([tab({ id: 'a', status: 'running' })], 'a'), () => 'reject');
    const ref = mount();
    await waitFor(() => expect(ref.current!.state?.tabs).toHaveLength(2));
    await failHead(ref, ipc);
    const failedId = ref.current!.sendFails.a!.item.id;

    const errors: string[] = [];
    await act(async () => {
      await ref.current!.sendToTab('a', '第一条', undefined, undefined, 'queue', (m) =>
        errors.push(m),
      );
    });
    // 这次也失败：错误回调照旧（输入框能给提示），队列里原条目没被提前删掉，失败提示仍可见
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('还没有选择模型');
    expect(ref.current!.queues.a!.map((i) => i.id)).toEqual([failedId]);
    expect(ref.current!.sendFails.a!.item.id).toBe(failedId);
    expect(ref.current!.sendFails.a!.message).toContain('还没有选择模型');
    // 之后明确重试成功：原条目只移除一次
    await act(async () => {
      ref.current!.retryFailedSend('a');
    });
    await waitFor(() => expect(ref.current!.sendFails.a).toBeTruthy());
    expect(ref.current!.queues.a!.map((i) => i.id)).toEqual([failedId]);
  });

  it('成功后（才）移除原失败项并撤掉提示', async () => {
    let fail = 1;
    const ipc = mockIpc(stateOf([tab({ id: 'a', status: 'running' })], 'a'), () =>
      fail-- > 0 ? 'reject' : 'ok',
    );
    const ref = mount();
    await waitFor(() => expect(ref.current!.state?.tabs).toHaveLength(2));
    await failHead(ref, ipc);
    const failedId = ref.current!.sendFails.a!.item.id;

    await act(async () => {
      await ref.current!.sendToTab('a', '第一条', undefined, undefined, 'queue');
    });
    expect(ipc.sent.map((s) => s.text)).toEqual(['第一条']);
    expect(ref.current!.queues.a ?? []).toHaveLength(0);
    expect(ref.current!.sendFails.a).toBeUndefined();
    expect(failedId).toBeTruthy();
  });

  it('正文相同但附件不同：不当作同一条（不提前移除、不吞掉失败项）', async () => {
    // 先失败一次（标签在跑 → 结束后自动发，被拒）：失败项留在队首、提示可见
    let fail = 1;
    const ipc = mockIpc(stateOf([tab({ id: 'a', status: 'running' })], 'a'), () =>
      fail-- > 0 ? 'reject' : 'ok',
    );
    const ref = mount();
    await waitFor(() => expect(ref.current!.state?.tabs).toHaveLength(2));
    await act(async () => {
      await ref.current!.sendToTab('a', '第一条', undefined, [img('QUJD')]);
    });
    await ipc.push(stateOf([tab({ id: 'a', status: 'idle' })], 'a'));
    await waitFor(() => expect(ref.current!.sendFails.a).toBeTruthy());
    const failed = ref.current!.sendFails.a!.item;
    expect(failed.images).toEqual([img('QUJD')]);
    expect(ref.current!.queues.a!.map((i) => i.id)).toEqual([failed.id]);

    // 同样的正文、另一张图：是另一条（这次派发成功），不能替换 / 提前移除失败的那条，提示也还在
    await act(async () => {
      await ref.current!.sendToTab('a', '第一条', undefined, [img('REVG')], 'queue');
    });
    expect(ipc.sent).toHaveLength(1);
    expect(ipc.sent[0]!.text).toBe('第一条');
    expect(ipc.sent[0]!.images).toEqual([expect.objectContaining({ data: 'REVG' })]);
    expect(ref.current!.sendFails.a?.item.id).toBe(failed.id);
  });
});
