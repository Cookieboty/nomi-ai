// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TasksPage } from '../src/components/Tasks/TasksPage';
import type { Task, TaskQueueInfo } from '../src/services/tasksClient';

import { installFakeApi, resetFakeApi, type FakeApi } from './helpers/fakeApi';

vi.mock('../src/services/api', async () => (await import('./helpers/fakeApi')).fakeApiModule());
vi.mock('../src/components/ConfirmDialog', () => import('./helpers/confirmViaWindow'));

const T0 = Date.UTC(2026, 10, 1, 9, 0, 0);

const base: Task = {
  id: 'base',
  title: 'base',
  goal: 'goal',
  origin: { createdBy: 'user', createdAt: T0 },
  trigger: { kind: 'manual' },
  executor: { kind: 'nomi', tools: ['read'] },
  grant: { version: 1, level: 1, paths: [], connections: [], grantedAt: T0 },
  budget: { maxRetries: 1 },
  acceptance: 'user',
  status: 'idle',
  enabled: true,
  gen: 1,
  consecutiveFailures: 0,
  updatedAt: T0,
};

const sampleTasks: Task[] = [
  {
    ...base,
    id: 'run_queued',
    title: '排队后台任务',
    status: 'queued',
    pending: { cause: 'manual' },
  },
  {
    ...base,
    id: 'run_running',
    title: '正在跑的后台委派',
    status: 'running',
    origin: { createdBy: 'nomi', createdAt: T0, via: 'delegate', conversationId: 'conv-1' },
    acceptance: 'auto',
  },
  {
    ...base,
    id: 'run_done',
    title: '完成的一次性任务',
    status: 'done',
    endedAt: Date.now() - 3600_000,
    acceptance: 'auto',
  },
  {
    ...base,
    id: 'run_failed_independent',
    title: '独立无人失败任务',
    status: 'failed',
    endedAt: Date.now(),
    lastError: { code: 'exec', message: '命令退出码 1' },
  },
  {
    ...base,
    id: 'run_failed_handoff',
    title: '对话转后台失败任务',
    status: 'failed',
    endedAt: Date.now(),
    origin: { createdBy: 'nomi', createdAt: T0, via: 'handoff', conversationId: 'conv-2' },
    acceptance: 'auto',
    lastError: { code: 'exec', message: '已回传对话' },
  },
  {
    ...base,
    id: 'auto_cron',
    title: '每日巡检持续任务',
    goal: '每天检查构建状态',
    status: 'idle',
    trigger: { kind: 'schedule', at: T0 + 3600_000, repeat: 'daily' },
    lastRunStatus: 'succeeded',
    lastRunAt: T0 - 600_000,
  },
  {
    ...base,
    id: 'awaiting_user',
    title: '待验收任务',
    status: 'awaiting_accept',
    acceptance: 'user',
  },
  {
    ...base,
    id: 'archived_done',
    title: '已归档历史任务',
    status: 'done',
    endedAt: T0 - 48 * 3600_000,
    archivedAt: T0 - 24 * 3600_000,
    archiveReason: 'auto_24h',
  },
];

const queueMap: Record<string, TaskQueueInfo> = {
  run_queued: {
    reason: 'slot',
    position: 1,
    activeCount: 2,
    maxConcurrent: 2,
  },
};

const legacy = [
  { source: 'schedule', id: 's1', title: '旧版定时提醒', enabled: true, nextRunAt: T0 },
];

let fake: FakeApi;

beforeEach(() => {
  localStorage.clear();
  fake = installFakeApi({
    'tasks.list': () => ({ tasks: sampleTasks, legacy, queue: queueMap }),
    'tasks.get': ({ id }: { id: string }) => {
      const task = sampleTasks.find((x) => x.id === id) ?? sampleTasks[0]!;
      return {
        task,
        attempts: [
          {
            id: `att-${id}`,
            taskId: id,
            gen: 1,
            startedAt: T0,
            endedAt: T0 + 2000,
            cause: { kind: 'manual' },
            status: 'succeeded',
            usage: { inputTokens: 0, outputTokens: 0, costKnown: false },
            result: { summary: '执行完成' },
          },
        ],
      };
    },
    'tasks.trace': () => ({ lines: [], live: null }),
    'tasks.journal': () => [],
    'tasks.events': () => ({ observed: [] }),
    'tasks.steer': () => true,
    'tasks.appendQueued': () => ({ ok: true }),
    'tasks.reject': () => ({ ok: true }),
    'tasks.followUp': () => ({ ok: true }),
    'tasks.update': (input: { id: string }) => ({
      ...base,
      ...sampleTasks.find((x) => x.id === input.id),
      ...input,
    }),
    'tasks.ack': () => ({ ok: true }),
    'tasks.archive': () => ({ ok: true }),
    'tasks.unarchive': () => ({ ok: true }),
    'tasks.archiveAllEnded': () => ({ archived: 2 }),
    'tasks.create': (input: Record<string, unknown>) => ({
      ...base,
      ...input,
      id: 'task_created',
      status: 'idle',
    }),
    'tasks.revoke': () => ({ ok: true }),
    'cli.accounts.list': () => [],
    'cli.install.detect': () => [],
    'workspace.recents': () => [],
    'mcp.listTools': () => [],
    'github.status': () => ({ available: false, repos: [] }),
  });
});

afterEach(() => {
  cleanup();
  resetFakeApi();
  localStorage.clear();
  vi.restoreAllMocks();
});

async function openPage(onOpenSchedule = vi.fn()) {
  render(<TasksPage active onBack={vi.fn()} onOpenSchedule={onOpenSchedule} />);
  await act(() => fake.settle());
  return onOpenSchedule;
}

describe('任务看板透明性与 Phase 1-2 交互', () => {
  it('双轨分流、已归档独立 Tab 与一键归档已完成', async () => {
    await openPage();
    const listText = () => screen.getByTestId('tasks-list').textContent ?? '';

    // 默认全部：不显示已归档，同时显示一次性与持续任务
    expect(listText()).toContain('排队后台任务');
    expect(listText()).toContain('每日巡检持续任务');
    expect(listText()).not.toContain('已归档历史任务');

    // 后台执行轨：过滤掉持续自动化
    fireEvent.click(screen.getByTestId('tasks-track-run'));
    expect(listText()).toContain('排队后台任务');
    expect(listText()).not.toContain('每日巡检持续任务');

    // 持续自动化轨
    fireEvent.click(screen.getByTestId('tasks-track-automation'));
    expect(listText()).toContain('每日巡检持续任务');
    expect(listText()).not.toContain('排队后台任务');

    // 已归档轨 + 还原按钮
    fireEvent.click(screen.getByTestId('tasks-track-archived'));
    expect(screen.getByTestId('tasks-archive-note')).toBeTruthy();
    expect(listText()).toContain('已归档历史任务');
    fireEvent.click(screen.getByTestId('list-unarchive-archived_done'));
    await act(() => fake.settle());
    expect(fake.calls).toContainEqual(['tasks.unarchive', { id: 'archived_done' }]);

    // 切回全部轨道：存在可归档终态任务，一键归档可用
    fireEvent.click(screen.getByTestId('tasks-track-all'));
    fireEvent.click(screen.getByTestId('tasks-archive-all'));
    await act(() => fake.settle());
    expect(fake.calls).toContainEqual(['tasks.archiveAllEnded', undefined]);
  });

  it('排队透明、看板保留 legacy、独立失败需「知道了」而对话任务不要求确认', async () => {
    const onOpenSchedule = await openPage();

    // 列表视图：独立失败有「知道了」，对话失败没有
    expect(screen.getByTestId('list-ack-run_failed_independent')).toBeTruthy();
    expect(screen.queryByTestId('list-ack-run_failed_handoff')).toBeNull();
    expect(screen.getByTestId('list-queue-run_queued')).toBeTruthy();

    // 切换看板视图
    fireEvent.click(screen.getByTestId('tasks-view-board'));
    expect(screen.getByTestId('board-column-todo')).toBeTruthy();
    expect(screen.getByTestId('board-queued-group')).toBeTruthy();
    expect(screen.getByTestId('board-queue-run_queued')).toBeTruthy();
    expect(screen.getByTestId('board-ack-run_failed_independent')).toBeTruthy();
    expect(screen.queryByTestId('board-ack-run_failed_handoff')).toBeNull();

    // 看板中保留 legacy 并触发打开旧日程面板
    fireEvent.click(screen.getByTestId('board-legacy-s1'));
    expect(onOpenSchedule).toHaveBeenCalled();

    // 看板点「知道了」
    fireEvent.click(screen.getByTestId('board-ack-run_failed_independent'));
    await act(() => fake.settle());
    expect(fake.calls).toContainEqual(['tasks.ack', { id: 'run_failed_independent' }]);

    // 独立失败详情页 sticky 区有 ack 按钮
    fireEvent.click(screen.getByTestId('board-card-run_failed_independent'));
    await act(() => fake.settle());
    expect(screen.getByTestId('task-failed-card')).toBeTruthy();
    fireEvent.click(screen.getByTestId('task-ack'));
    await act(() => fake.settle());
    expect(fake.calls.filter(([n]) => n === 'tasks.ack').length).toBe(2);
  });

  it('新建表单：通知任务隐藏验收并提交 auto；非通知默认提交 user', async () => {
    await openPage();
    fireEvent.click(screen.getByTestId('tasks-new'));
    await act(() => fake.settle());
    expect((screen.getByTestId('task-form-acceptance') as HTMLSelectElement).value).toBe('user');

    fireEvent.change(screen.getByTestId('task-form-title'), { target: { value: '喝水提醒' } });
    fireEvent.change(screen.getByTestId('task-form-goal'), { target: { value: '提醒一次' } });
    fireEvent.change(screen.getByTestId('task-form-who'), { target: { value: 'notify' } });
    expect(screen.queryByTestId('task-form-acceptance')).toBeNull();

    window.confirm = vi.fn(() => true);
    fireEvent.click(screen.getByTestId('task-form-submit'));
    await waitFor(() => expect(fake.calls.some(([n]) => n === 'tasks.create')).toBe(true));
    const [, payload] = fake.calls.find(([n]) => n === 'tasks.create')!;
    expect(payload).toMatchObject({
      executor: { kind: 'notify', text: '提醒一次' },
      acceptance: 'auto',
    });
  });

  it('TaskDetail 双 Tab 与各状态交互（插话 / 排队追加 / 退回 / 持续追问同步目标 / 规则编辑）', async () => {
    await openPage();

    // 1) running → steer & Tab 2 规则编辑保存
    fireEvent.click(screen.getByTestId('task-run_running'));
    await act(() => fake.settle());
    expect(screen.getByTestId('task-conv-composer').getAttribute('data-mode')).toBe('steer');
    fireEvent.change(screen.getByTestId('task-conv-input'), { target: { value: '先跑单测' } });
    fireEvent.click(screen.getByTestId('task-conv-send'));
    await act(() => fake.settle());
    expect(fake.calls).toContainEqual(['tasks.steer', { id: 'run_running', text: '先跑单测' }]);

    fireEvent.click(screen.getByTestId('task-tab-settings'));
    fireEvent.change(screen.getByTestId('task-edit-title'), { target: { value: '新任务名' } });
    fireEvent.change(screen.getByTestId('task-edit-done-when'), { target: { value: '绿灯通过' } });
    fireEvent.change(screen.getByTestId('task-edit-acceptance'), { target: { value: 'user' } });
    fireEvent.click(screen.getByTestId('task-save-rules'));
    await act(() => fake.settle());
    expect(fake.calls).toContainEqual([
      'tasks.update',
      {
        id: 'run_running',
        title: '新任务名',
        goal: 'goal',
        doneWhen: '绿灯通过',
        acceptance: 'user',
      },
    ]);

    // 2) queued → appendQueued
    fireEvent.click(screen.getByTestId('task-run_queued'));
    await act(() => fake.settle());
    expect(screen.getByTestId('task-detail-queue')).toBeTruthy();
    expect(screen.getByTestId('task-conv-composer').getAttribute('data-mode')).toBe('append');
    fireEvent.change(screen.getByTestId('task-conv-input'), { target: { value: '附带检查文档' } });
    fireEvent.click(screen.getByTestId('task-conv-send'));
    await act(() => fake.settle());
    expect(fake.calls).toContainEqual([
      'tasks.appendQueued',
      { id: 'run_queued', text: '附带检查文档' },
    ]);

    // 3) awaiting_accept → reject
    fireEvent.click(screen.getByTestId('task-awaiting_user'));
    await act(() => fake.settle());
    expect(screen.getByTestId('task-conv-composer').getAttribute('data-mode')).toBe('reject');
    fireEvent.change(screen.getByTestId('task-conv-input'), { target: { value: '补测边界条件' } });
    fireEvent.click(screen.getByTestId('task-conv-send'));
    await act(() => fake.settle());
    expect(fake.calls).toContainEqual([
      'tasks.reject',
      { id: 'awaiting_user', feedback: '补测边界条件' },
    ]);

    // 4) recurring idle → followup 且可选同步更新长期目标
    fireEvent.click(screen.getByTestId('task-auto_cron'));
    await act(() => fake.settle());
    expect(screen.getByTestId('task-conv-composer').getAttribute('data-mode')).toBe('followup');
    expect(screen.getByTestId('task-conv-goal-mode')).toBeTruthy();
    fireEvent.click(screen.getByTestId('task-goal-mode-sync'));
    fireEvent.change(screen.getByTestId('task-conv-input'), {
      target: { value: '额外检查 lint 输出' },
    });
    fireEvent.click(screen.getByTestId('task-conv-send'));
    await act(() => fake.settle());
    expect(fake.calls).toContainEqual([
      'tasks.followUp',
      { id: 'auto_cron', text: '额外检查 lint 输出', updateGoal: true },
    ]);
  });
});
