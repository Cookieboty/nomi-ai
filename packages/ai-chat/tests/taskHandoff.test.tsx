// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { nomiSlots } from '../src/components/Conversation/nomiSlots';
import { HandoffTriggerButton } from '../src/components/Conversation/StatusLine';
import { OPEN_TASK_EVENT, type Task } from '../src/services/tasksClient';
import { executeSlash } from '../src/slash/registry';
import type { ChatMessage } from '../src/types/chat';
import { fromChatMessage } from '../src/utils/convAdapters';

import { installFakeApi, resetFakeApi } from './helpers/fakeApi';
import { makeCtx } from './slashHelpers';

vi.mock('../src/services/api', async () => (await import('./helpers/fakeApi')).fakeApiModule());

afterEach(() => {
  cleanup();
  resetFakeApi();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const baseTask: Task = {
  id: 't_handoff_1',
  title: '后台分析',
  goal: '分析全仓并输出报告',
  origin: { createdBy: 'nomi', createdAt: 1, via: 'handoff', conversationId: 'conv-1' },
  trigger: { kind: 'manual' },
  executor: { kind: 'nomi', tools: ['read'] },
  grant: { version: 1, level: 1, paths: [], connections: [], grantedAt: 1 },
  budget: { maxRetries: 0 },
  acceptance: 'auto',
  status: 'running',
  enabled: true,
  gen: 1,
  consecutiveFailures: 0,
  updatedAt: 1,
};

describe('Phase 3 前台转后台与 /bg 命令', () => {
  it('HandoffTriggerButton：满足工具调用或 10 秒显现，阻塞态隐藏，点击触发回调', () => {
    vi.useFakeTimers();
    const now = 1_700_000_000_000;
    vi.setSystemTime(now);
    const onHandoff = vi.fn();

    const { rerender } = render(
      <HandoffTriggerButton
        startedAt={now}
        forceShow={false}
        blocked={false}
        onHandoff={onHandoff}
      />,
    );
    expect(screen.queryByTestId('conv-handoff-bg')).toBeNull();

    // 推进 10 秒后出现
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(screen.getByTestId('conv-handoff-bg')).toBeTruthy();

    // 阻塞时隐藏
    rerender(
      <HandoffTriggerButton
        startedAt={now}
        forceShow={true}
        blocked={true}
        onHandoff={onHandoff}
      />,
    );
    expect(screen.queryByTestId('conv-handoff-bg')).toBeNull();

    // forceShow（工具调用）立即显示并可点击
    rerender(
      <HandoffTriggerButton
        startedAt={now}
        forceShow={true}
        blocked={false}
        onHandoff={onHandoff}
      />,
    );
    fireEvent.click(screen.getByTestId('conv-handoff-bg'));
    expect(onHandoff).toHaveBeenCalledTimes(1);
  });

  it('nomiSlots.after：带 handoffTaskId 的消息渲染任务卡，状态随 tasks.changed 更新且点击可跳转', async () => {
    let current = { ...baseTask, status: 'running' as Task['status'] };
    const fake = installFakeApi({
      'tasks.get': () => ({ task: current, attempts: [] }),
    });

    const msg: ChatMessage = {
      id: 'm_handoff',
      role: 'assistant',
      content: '已转入后台处理',
      timestamp: 1000,
      handoffTaskId: 't_handoff_1',
    };
    const conv = fromChatMessage(msg)!;
    const onOpen = vi.fn();
    const listener = (e: Event) => onOpen((e as CustomEvent<string>).detail);
    window.addEventListener(OPEN_TASK_EVENT, listener);

    render(<>{nomiSlots.after!(conv)}</>);
    await act(() => fake.settle());

    const card = screen.getByTestId('handoff-task-card');
    expect(card.getAttribute('data-status')).toBe('running');

    // 任务完成后广播 tasks.changed，卡片同步状态
    current = { ...current, status: 'done' };
    act(() => fake.publish('tasks.changed', { id: 't_handoff_1' }));
    await act(() => fake.settle());
    expect(screen.getByTestId('handoff-task-card').getAttribute('data-status')).toBe('done');

    // 点击跳转看板
    fireEvent.click(screen.getByTestId('handoff-open-task'));
    expect(onOpen).toHaveBeenCalledWith('t_handoff_1');
    window.removeEventListener(OPEN_TASK_EVENT, listener);
  });

  it('/bg 命令：空参数返回用法卡片；带内容调用 sendBackgroundNomi', async () => {
    const { ctx, actions, commands } = makeCtx('nomi');

    const emptyRes = await executeSlash('/bg', commands, ctx);
    expect(emptyRes.handled).toBe(true);
    if (!emptyRes.handled) throw new Error('expected handled');
    expect(emptyRes.outcome.type).toBe('card');
    expect(actions.sendBackgroundNomi).not.toHaveBeenCalled();

    const runRes = await executeSlash('/bg 扫描仓库全部 TODO 并归类', commands, ctx);
    expect(runRes.handled).toBe(true);
    if (!runRes.handled) throw new Error('expected handled');
    expect(runRes.outcome).toEqual({ type: 'noop' });
    expect(actions.sendBackgroundNomi).toHaveBeenCalledWith('扫描仓库全部 TODO 并归类');
  });
});
