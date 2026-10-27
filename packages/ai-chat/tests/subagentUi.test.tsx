// @vitest-environment happy-dom
import { cleanup, fireEvent, render, within } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConversationView } from '../src/components/Conversation';
import { liveOf } from '../src/components/Sidebar/SidebarRows';
import type { HarnessTabMeta, HarnessTraceEvent } from '../src/services/harnessClient';
import type { ConvLive } from '../src/types/conversation';

// 子代理界面（docs/design/cli-subagents.md §5）
afterEach(cleanup);

const tool = (e: Partial<Extract<HarnessTraceEvent, { type: 'tool' }>>): HarnessTraceEvent =>
  ({ type: 'tool', name: 'Agent', status: 'start', at: 1, textAt: 0, ...e }) as HarnessTraceEvent;

const view = (live: ConvLive, extra: Partial<React.ComponentProps<typeof ConversationView>> = {}) =>
  render(<ConversationView scopeId="s" messages={[]} live={live} phase="running" {...extra} />);

describe('子代理卡片', () => {
  it('后台子代理：派生调用已返回，但卡片按子代理状态显示运行中、后台标记与进度', () => {
    const { getByTestId } = view({
      text: '',
      startedAt: 0,
      trace: [
        tool({
          detail: 'toolu_1',
          input: JSON.stringify({ description: 'Audit auth', prompt: 'Audit the auth module' }),
        }),
        tool({ detail: 'toolu_1', status: 'done', output: 'Async agent launched' }),
      ],
      agents: {
        task1: {
          id: 'task1',
          callId: 'toolu_1',
          label: 'Audit auth',
          background: true,
          status: 'running',
          progress: 'Reading src/auth.ts',
          usage: { toolUses: 3 },
          startedAt: 1,
        },
      },
    });
    const card = getByTestId('tool-subagent');
    expect(
      card.getAttribute('data-status') ??
        card.querySelector('[data-status]')?.getAttribute('data-status'),
    ).toBe('running');
    expect(within(card).getByTestId('subagent-background').textContent).toBe('后台');
    expect(within(card).getByTestId('subagent-progress').textContent).toBe('Reading src/auth.ts');
    expect(card.textContent).toContain('3 次工具调用');
  });

  it('Codex / dsh 子代理没有内部步骤：注明，并用子代理的最终消息作结果', () => {
    const { getByTestId } = view({
      text: '',
      startedAt: 0,
      trace: [
        tool({
          name: 'spawn_agent',
          id: 'item_3',
          input: JSON.stringify({ prompt: 'Read a.txt' }),
        }),
        tool({ name: 'spawn_agent', id: 'item_3', status: 'done' }),
      ],
      agents: {
        th1: {
          id: 'th1',
          callId: 'item_3',
          status: 'completed',
          summary: 'hello',
          startedAt: 1,
          endedAt: 2,
        },
      },
    });
    const card = getByTestId('tool-subagent');
    fireEvent.click(card.querySelector('button')!);
    expect(within(card).getByTestId('subagent-no-steps')).toBeTruthy();
    expect(within(card).getByTestId('tool-output').textContent).toContain('hello');
  });
});

describe('后台任务条', () => {
  const agents = [
    { id: 'a1', label: 'Audit auth', startedAt: Date.now() - 75_000, stoppable: true },
    { id: 'a2', label: 'Codex helper', startedAt: Date.now(), stoppable: false },
  ];

  it('显示数量，展开后逐个列出；可停止的发 id，不支持的置灰', () => {
    const onStopAgent = vi.fn();
    const { getByTestId, getAllByTestId, getByRole } = render(
      <ConversationView
        scopeId="s"
        messages={[]}
        phase="idle"
        backgroundAgents={agents}
        backgroundCount={3}
        onStopAgent={onStopAgent}
      />,
    );
    const bar = getByTestId('conv-background-bar');
    expect(bar.textContent).toContain('后台任务 3 个');
    fireEvent.click(getByRole('button', { name: /后台任务/ }));
    const rows = getAllByTestId('conv-background-agent');
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining('Audit auth'),
      expect.stringContaining('Codex helper'),
    ]);
    expect(rows[0]!.textContent).toMatch(/1 分 1[45] 秒/);
    const stops = getAllByTestId('conv-background-stop') as HTMLButtonElement[];
    expect(stops[1]!.disabled).toBe(true);
    fireEvent.click(stops[0]!);
    expect(onStopAgent).toHaveBeenCalledWith('a1');
    expect(stops[0]!.textContent).toBe('正在停止…');
  });

  it('没有后台任务时不显示', () => {
    const { queryByTestId } = render(<ConversationView scopeId="s" messages={[]} phase="idle" />);
    expect(queryByTestId('conv-background-bar')).toBeNull();
  });
});

describe('标签圆点：空闲但有后台任务', () => {
  const tab = (over: Partial<HarnessTabMeta>): HarnessTabMeta => ({
    id: 't',
    title: 'Claude',
    backend: 'claude',
    cwd: '/w',
    cliSessionId: null,
    status: 'idle',
    unread: 0,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  });
  it('顶栏与侧栏都显示「后台运行中」；运行中 / 未读优先', () => {
    expect(liveOf(tab({ background: 2 }))).toBe('background');
  });
});
