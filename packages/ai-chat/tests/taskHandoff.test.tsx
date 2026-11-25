// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConversationView } from '../src/components/Conversation';
import { nomiSlots } from '../src/components/Conversation/nomiSlots';
import { HandoffTriggerButton } from '../src/components/Conversation/StatusLine';
import type { HarnessTraceEvent } from '../src/services/harnessClient';
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

  it('极简模式运行中：转后台按钮嵌入步骤横条同父行右侧，展开后仍在顶部且阻塞/旧阶段不显示', async () => {
    const now = Date.now();
    const onHandoff = vi.fn();
    const liveTrace: HarnessTraceEvent[] = [
      {
        type: 'tool',
        name: 'Read',
        id: 'r1',
        status: 'start',
        at: now - 3000,
        textAt: 0,
        input: JSON.stringify({ file_path: 'a.ts' }),
      },
    ];

    const r = render(
      <ConversationView
        scopeId="s-minimal-handoff"
        transcriptView="minimal"
        phase="running"
        messages={[{ id: 'u', role: 'user', text: '分析仓库', at: 0 }]}
        live={{
          text: '',
          startedAt: now - 3500,
          firstEventAt: now - 3400,
          trace: liveTrace,
        }}
        onHandoffToBackground={onHandoff}
      />,
    );

    const steps = r.getByTestId('minimal-steps');
    const toggle = r.getByTestId('minimal-steps-toggle');
    const handoffBtn = r.getByTestId('conv-handoff-bg');

    // 1. 位于 minimal-steps 内、与 toggle 共享同一头部容器且不嵌套在 toggle 内
    expect(steps.contains(handoffBtn)).toBe(true);
    expect(toggle.contains(handoffBtn)).toBe(false);
    expect(handoffBtn.parentElement).toBe(toggle.parentElement);

    // 2. 点击「转后台」触发回调且不触发展开
    await act(async () => {
      fireEvent.click(handoffBtn);
      await Promise.resolve();
    });
    expect(onHandoff).toHaveBeenCalledTimes(1);
    expect(steps.getAttribute('data-open')).toBe('false');

    // 3. 展开步骤后，「转后台」留在顶部头部容器内、位于折叠主体之前
    fireEvent.click(toggle);
    expect(steps.getAttribute('data-open')).toBe('true');
    const body = r.getByTestId('minimal-steps-body');
    const activeHandoff = r.getByTestId('conv-handoff-bg');
    expect(activeHandoff.parentElement).toBe(toggle.parentElement);
    expect(
      Boolean(activeHandoff.compareDocumentPosition(body) & Node.DOCUMENT_POSITION_FOLLOWING),
    ).toBe(true);

    // 4. 阻塞态（如权限请求）隐藏「转后台」，保留步骤切换按钮
    r.rerender(
      <ConversationView
        scopeId="s-minimal-handoff"
        transcriptView="minimal"
        phase="running"
        messages={[{ id: 'u', role: 'user', text: '分析仓库', at: 0 }]}
        live={{
          text: '',
          startedAt: now - 3500,
          firstEventAt: now - 3400,
          trace: liveTrace,
          permissions: [{ id: 'p1', summary: 'Bash: ls' }],
        }}
        onPermission={() => undefined}
        onHandoffToBackground={onHandoff}
      />,
    );
    expect(r.queryByTestId('conv-handoff-bg')).toBeNull();
    expect(r.getByTestId('minimal-steps-toggle')).toBeTruthy();

    // 5. 中途插话形成两段 minimal-steps 时，仅末尾运行中阶段渲染「转后台」
    const interjectTrace: HarnessTraceEvent[] = [
      { ...liveTrace[0]!, status: 'done', output: 'ok' },
      {
        type: 'interject',
        text: '补充看看 tests 目录',
        at: now - 1500,
        textAt: 0,
      },
      {
        type: 'tool',
        name: 'Bash',
        id: 'b1',
        status: 'start',
        at: now - 1000,
        textAt: 0,
        input: JSON.stringify({ command: 'ls tests' }),
      },
    ];
    r.rerender(
      <ConversationView
        scopeId="s-minimal-handoff"
        transcriptView="minimal"
        phase="running"
        messages={[{ id: 'u', role: 'user', text: '分析仓库', at: 0 }]}
        live={{
          text: '',
          startedAt: now - 3500,
          firstEventAt: now - 3400,
          trace: interjectTrace,
        }}
        onHandoffToBackground={onHandoff}
      />,
    );

    const allSteps = r.getAllByTestId('minimal-steps');
    expect(allSteps).toHaveLength(2);
    expect(allSteps[0]!.querySelector('[data-testid="conv-handoff-bg"]')).toBeNull();
    const tailHandoff = allSteps[1]!.querySelector('[data-testid="conv-handoff-bg"]');
    expect(tailHandoff).toBeTruthy();
    expect(r.getAllByTestId('conv-handoff-bg')).toHaveLength(1);
    expect(tailHandoff!.parentElement).toBe(
      allSteps[1]!.querySelector('[data-testid="minimal-steps-toggle"]')!.parentElement,
    );
  });
});
