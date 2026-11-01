// @vitest-environment happy-dom
/** 任务页：按「需要你 / 运行中 / 等触发 / 已结束」分组、旧提醒与定时并入、详情里处理收件箱、新建要过授权卡片 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TasksNav, TasksPage } from '../src/components/Tasks';

import { installFakeApi, resetFakeApi, type FakeApi } from './helpers/fakeApi';

vi.mock('../src/services/api', async () => (await import('./helpers/fakeApi')).fakeApiModule());
vi.mock('../src/components/ConfirmDialog', () => import('./helpers/confirmViaWindow'));

const T0 = 1_800_000_000_000;
const base = {
  goal: '每天看 CI',
  origin: { createdBy: 'user', createdAt: T0 },
  trigger: { kind: 'manual' },
  executor: { kind: 'nomi', tools: ['read'] },
  grant: { version: 1, level: 1, paths: [], connections: [], grantedAt: T0 },
  budget: {
    maxTokensPerAttempt: 200000,
    maxDurationMsPerAttempt: 1800000,
    maxCostUsdPerDay: 1,
    maxRetries: 3,
  },
  acceptance: 'auto',
  enabled: true,
  gen: 1,
  consecutiveFailures: 0,
  updatedAt: T0,
};
const tasks = [
  {
    ...base,
    id: 'task_a',
    title: '要批准的',
    status: 'waiting_user',
    wait: { kind: 'approval', requestId: 'r1', detail: '要跑 npm test', resumeTo: 'running' },
  },
  { ...base, id: 'task_b', title: '在跑的', status: 'running' },
  {
    ...base,
    id: 'task_c',
    title: '定时的',
    status: 'idle',
    trigger: { kind: 'schedule', at: T0, repeat: { kind: 'daily' } },
    nextRunAt: T0 + 86_400_000,
  },
  { ...base, id: 'task_d', title: '做完的', status: 'done' },
  { ...base, id: 'task_e', title: '待验收', status: 'awaiting_accept' },
];
const legacy = [
  { source: 'reminder', id: 'r1', title: '喝水', enabled: true, nextRunAt: T0 },
  {
    source: 'schedule',
    id: 's1',
    title: '每日简报',
    enabled: true,
    nextRunAt: T0,
    repeat: { kind: 'daily' },
  },
];

let fake: FakeApi;
beforeEach(() => {
  fake = installFakeApi({
    'tasks.list': () => ({ tasks, legacy }),
    'tasks.get': ({ id }: { id: string }) => ({
      task: tasks.find((x) => x.id === id),
      attempts: [
        {
          id: 'att_1',
          gen: 1,
          cause: { kind: 'manual' },
          status: 'awaiting_accept',
          startedAt: T0,
          usage: { inputTokens: 100, outputTokens: 50, costKnown: false },
          result: { summary: '改好了，测试通过', artifacts: [] },
        },
      ],
    }),
    'tasks.journal': () => [{ t: 'state', at: T0, event: 'trigger', from: 'idle', to: 'queued' }],
    'tasks.decide': () => ({ ok: true }),
    'tasks.accept': () => ({ ok: true }),
    'tasks.reject': () => ({ ok: true }),
    'tasks.revoke': () => ({ ok: true }),
    'tasks.create': (input: { title: string }) => ({
      ...base,
      id: 'task_new',
      title: input.title,
      status: 'idle',
    }),
  });
});
afterEach(() => {
  cleanup();
  resetFakeApi();
  vi.restoreAllMocks();
});

async function open(onOpenSchedule = vi.fn()) {
  render(<TasksPage active onBack={vi.fn()} onOpenSchedule={onOpenSchedule} />);
  await act(() => fake.settle());
  return onOpenSchedule;
}

describe('任务页', () => {
  it('按需要你 / 运行中 / 等触发 / 已结束分组；旧提醒与定时并入并打开日程', async () => {
    const onOpenSchedule = await open();
    expect(screen.getByTestId('tasks-group-needs_you').textContent).toContain('要批准的');
    expect(screen.getByTestId('tasks-group-needs_you').textContent).toContain('待验收');
    expect(screen.getByTestId('tasks-group-running').textContent).toContain('在跑的');
    expect(screen.getByTestId('tasks-group-waiting_trigger').textContent).toContain('定时的');
    expect(screen.getByTestId('tasks-group-ended').textContent).toContain('做完的');
    expect(screen.getByTestId('task-task_a').textContent).toContain('等你批准');
    fireEvent.click(screen.getByTestId('legacy-s1'));
    expect(onOpenSchedule).toHaveBeenCalled();
    expect(screen.getByTestId('tasks-group-reminders').textContent).toContain('喝水');
  });

  it('侧栏入口：有需要你处理的时显示角标', () => {
    render(<TasksNav collapsed={false} active={false} needsYou={2} onOpen={vi.fn()} />);
    expect(screen.getByTestId('tasks-open').getAttribute('aria-label')).toContain('2');
  });

  it('批准：带上代次与请求 id', async () => {
    await open();
    fireEvent.click(screen.getByTestId('task-task_a'));
    await act(() => fake.settle());
    expect(screen.getByTestId('task-needs-you').textContent).toContain('要跑 npm test');
    fireEvent.click(screen.getByTestId('task-approve'));
    await act(() => fake.settle());
    expect(fake.calls).toContainEqual([
      'tasks.decide',
      { id: 'task_a', gen: 1, requestId: 'r1', approve: true },
    ]);
  });

  it('验收：显示结果；退回必须写意见', async () => {
    await open();
    fireEvent.click(screen.getByTestId('task-task_e'));
    await act(() => fake.settle());
    expect(screen.getByTestId('task-accept-card').textContent).toContain('改好了，测试通过');
    expect((screen.getByTestId('task-reject') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId('task-accept'));
    await act(() => fake.settle());
    expect(fake.calls).toContainEqual(['tasks.accept', { id: 'task_e' }]);
  });

  it('撤销授权先确认；取消确认就不调用', async () => {
    await open();
    fireEvent.click(screen.getByTestId('task-task_b'));
    await act(() => fake.settle());
    const confirm = vi.fn(() => false);
    window.confirm = confirm;
    fireEvent.click(screen.getByTestId('task-revoke'));
    await act(() => fake.settle());
    expect(confirm).toHaveBeenCalled();
    expect(fake.calls.some(([n]) => n === 'tasks.revoke')).toBe(false);
    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByTestId('task-revoke'));
    await act(() => fake.settle());
    expect(fake.calls).toContainEqual(['tasks.revoke', { id: 'task_b' }]);
  });

  it('新建：过授权卡片后创建，能力等级由所选能力推出', async () => {
    await open();
    fireEvent.click(screen.getByTestId('tasks-new'));
    fireEvent.change(screen.getByTestId('task-form-title'), { target: { value: '看 CI' } });
    fireEvent.change(screen.getByTestId('task-form-goal'), { target: { value: '红了告诉我' } });
    fireEvent.click(screen.getByTestId('task-form-tool-shell'));
    const confirm = vi.fn(() => true);
    window.confirm = confirm;
    fireEvent.click(screen.getByTestId('task-form-submit'));
    await waitFor(() => expect(fake.calls.some(([n]) => n === 'tasks.create')).toBe(true));
    expect(confirm).toHaveBeenCalled();
    const [, input] = fake.calls.find(([n]) => n === 'tasks.create')!;
    expect(input).toMatchObject({
      title: '看 CI',
      goal: '红了告诉我',
      executor: { kind: 'nomi', tools: ['read', 'web', 'shell'] },
      grant: { level: 3, paths: [], connections: [] },
      trigger: { kind: 'schedule', repeat: { kind: 'daily' } },
    });
  });
});
