// @vitest-environment happy-dom
/** 任务页：按「需要你 / 运行中 / 等触发 / 已结束」分组、旧提醒与定时并入、详情里处理收件箱、新建要过授权卡片 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TasksNav } from '../src/components/Tasks';
import { TasksPage } from '../src/components/Tasks/TasksPage';

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
  { ...base, id: 'task_b', title: '在跑的', status: 'running', priority: 'urgent' },
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
  {
    ...base,
    id: 'task_f',
    title: '盯网页',
    status: 'idle',
    trigger: { kind: 'event', sourceId: 'web', filter: { url: 'https://x' }, mode: 'observe' },
  },
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
          ...(id === 'task_e' ? { carrier: { worktree: '/wt/x', sourceCwd: '/repo' } } : {}),
        },
      ],
    }),
    'harness.state': () => ({ bins: { claude: '/bin/claude' } }),
    'ext.mcpList': () => ({
      servers: [
        {
          id: 'mail',
          name: 'Mail',
          transport: 'stdio',
          enabled: true,
          trust: 'ask',
          status: 'connected',
          tools: [
            { name: 'mail__list', description: '', readOnly: true, dangerous: false },
            { name: 'mail__send', description: '', readOnly: false, dangerous: true },
          ],
        },
      ],
      env: [],
      presets: [],
      ready: true,
    }),
    'tasks.events': () => ({
      observed: [{ key: 'k1', summary: '网页有变化', occurredAt: T0, payload: {} }],
      lastPollAt: T0,
      sources: ['web'],
    }),
    'tasks.processObserved': () => ({ ok: true }),
    'tasks.clearObserved': () => true,
    'tasks.setMode': () => null,
    'harness.recentCwds': () => ['/repo'],
    'tasks.applyWorktree': () => ({
      applied: ['a.ts'],
      skipped: [],
      conflicted: [],
      denied: [],
    }),
    'tasks.journal': () => [{ t: 'state', at: T0, event: 'trigger', from: 'idle', to: 'queued' }],
    'tasks.decide': () => ({ ok: true }),
    'tasks.accept': () => ({ ok: true }),
    'tasks.update': (input: { id: string }) => ({
      ...base,
      ...tasks.find((x) => x.id === input.id),
      ...input,
    }),
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
  it('列表：卡片铺开，按进度筛选（等批准与待验收都在「待处理」）；旧提醒与定时并入并打开日程', async () => {
    const onOpenSchedule = await open();
    const card = (id: string) => screen.getByTestId(`task-${id}`).closest('li')!;
    expect(card('task_a').textContent).toContain('等你批准');
    const list = () => screen.getByTestId('tasks-list').textContent ?? '';
    expect(list()).toContain('喝水');
    fireEvent.click(screen.getByTestId('tasks-stage-needs_you'));
    expect(list()).toContain('要批准的');
    expect(list()).toContain('待验收');
    expect(list()).not.toContain('在跑的');
    expect(list()).not.toContain('喝水');
    fireEvent.click(screen.getByTestId('tasks-stage-all'));
    fireEvent.click(screen.getByTestId('legacy-s1'));
    expect(onOpenSchedule).toHaveBeenCalled();
    // 点卡片打开详情
    fireEvent.click(screen.getByTestId('task-task_a'));
    await act(() => fake.settle());
    expect(screen.getByTestId('task-detail')).toBeTruthy();
  });

  it('侧栏入口：有需要你处理的时显示角标', () => {
    render(<TasksNav collapsed={false} active={false} needsYou={2} running={1} onOpen={vi.fn()} />);
    expect(screen.getByTestId('tasks-open').getAttribute('aria-label')).toContain('2');
  });

  it('侧栏入口：没有要你处理的事时显示运行中的条数；都没有时不显示数字', () => {
    const r = render(
      <TasksNav collapsed={false} active={false} needsYou={0} running={3} onOpen={vi.fn()} />,
    );
    const nav = screen.getByTestId('tasks-open');
    expect(nav.textContent).toContain('3');
    expect(nav.getAttribute('aria-label')).toContain('3');
    r.unmount();
    render(<TasksNav collapsed={false} active={false} needsYou={0} running={0} onOpen={vi.fn()} />);
    expect(screen.getByTestId('tasks-open').textContent).not.toMatch(/\d/);
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

  it('新建：勾 MCP 工具；非只读工具是对外动作，等级 L4，授权按工具逐个列出', async () => {
    await open();
    fireEvent.click(screen.getByTestId('tasks-new'));
    await act(() => fake.settle());
    fireEvent.change(screen.getByTestId('task-form-title'), { target: { value: '回邮件' } });
    fireEvent.change(screen.getByTestId('task-form-goal'), { target: { value: '整理并回复' } });
    fireEvent.click(screen.getByTestId('task-form-mcp-mail__list'));
    fireEvent.click(screen.getByTestId('task-form-mcp-mail__send'));
    window.confirm = vi.fn(() => true);
    fireEvent.click(screen.getByTestId('task-form-submit'));
    await waitFor(() => expect(fake.calls.some(([n]) => n === 'tasks.create')).toBe(true));
    const [, input] = fake.calls.find(([n]) => n === 'tasks.create')!;
    expect(input).toMatchObject({
      grant: {
        level: 4,
        connections: [
          {
            connectionId: 'mcp:mail',
            capabilities: ['mcp.call', 'mcp.read'],
            resources: ['list', 'send'],
          },
        ],
      },
    });
  });

  it('看板：按进度分列；切到按重要程度；按类型筛选；详情里改重要程度', async () => {
    localStorage.clear();
    await open();
    fireEvent.click(screen.getByTestId('tasks-view-board'));
    const col = (k: string) => screen.getByTestId(`board-column-${k}`).textContent ?? '';
    expect(col('needs_you')).toContain('要批准的');
    expect(col('in_progress')).toContain('在跑的');
    expect(col('todo')).toContain('定时的');
    // 等你验收与等批准一样是等人处理：同在「待处理」
    expect(col('needs_you')).toContain('待验收');
    expect(screen.queryByTestId('board-column-review')).toBeNull();
    expect(col('done')).toContain('做完的');
    expect(screen.getByTestId('tasks-list').hidden).toBe(true);

    fireEvent.change(screen.getByTestId('tasks-board-group'), { target: { value: 'priority' } });
    expect(col('urgent')).toContain('在跑的');
    expect(col('none')).toContain('定时的');
    // 视图选择记在本机
    expect(JSON.parse(localStorage.getItem('nomi.tasks.view')!)).toEqual({
      view: 'board',
      group: 'priority',
    });

    // 类型：事件触发推断为「盯着某处」
    fireEvent.change(screen.getByTestId('tasks-category'), { target: { value: 'monitor' } });
    expect(screen.queryByTestId('board-card-task_b')).toBeNull();
    expect(screen.getByTestId('board-card-task_f')).toBeTruthy();

    fireEvent.click(screen.getByTestId('board-card-task_f'));
    await act(() => fake.settle());
    fireEvent.change(screen.getByTestId('task-priority'), { target: { value: 'high' } });
    await act(() => fake.settle());
    expect(fake.calls).toContainEqual(['tasks.update', { id: 'task_f', priority: 'high' }]);
    fireEvent.change(screen.getByTestId('task-priority'), { target: { value: 'none' } });
    await act(() => fake.settle());
    expect(fake.calls).toContainEqual(['tasks.update', { id: 'task_f', priority: null }]);
    localStorage.clear();
  });

  it('看板：按进度筛选、搜索；卡片上的快捷操作', async () => {
    localStorage.clear();
    await open();
    fireEvent.click(screen.getByTestId('tasks-view-board'));
    // 计数是真实条数
    expect(screen.getByTestId('tasks-stage-in_progress').textContent).toContain('1');
    fireEvent.click(screen.getByTestId('tasks-stage-in_progress'));
    expect(screen.queryByTestId('board-column-todo')).toBeNull();
    expect(screen.getByTestId('board-column-in_progress').textContent).toContain('在跑的');
    fireEvent.click(screen.getByTestId('tasks-stage-all'));

    fireEvent.change(screen.getByTestId('tasks-search'), { target: { value: '定时' } });
    expect(screen.getByTestId('board-card-task_c')).toBeTruthy();
    expect(screen.queryByTestId('board-card-task_b')).toBeNull();
    fireEvent.change(screen.getByTestId('tasks-search'), { target: { value: '' } });

    // 待开始的立即运行、在跑的暂停；要你处理的没有快捷操作（在详情里处理）
    fireEvent.click(screen.getByTestId('board-action-task_c'));
    fireEvent.click(screen.getByTestId('board-action-task_b'));
    await act(() => fake.settle());
    expect(fake.calls).toContainEqual(['tasks.runNow', { id: 'task_c' }]);
    expect(fake.calls).toContainEqual(['tasks.pause', { id: 'task_b' }]);
    expect(screen.queryByTestId('board-action-task_a')).toBeNull();
    localStorage.clear();
  });

  it('验收卡片：编程助手的 worktree 确认后回填，显示结果', async () => {
    await open();
    fireEvent.click(screen.getByTestId('task-task_e'));
    await act(() => fake.settle());
    window.confirm = vi.fn(() => true);
    fireEvent.click(screen.getByTestId('task-apply-worktree'));
    await waitFor(() =>
      expect(fake.calls).toContainEqual(['tasks.applyWorktree', { id: 'task_e' }]),
    );
    await act(() => fake.settle());
    expect(screen.getByRole('status')).toBeTruthy();
  });

  it('新建：交给已装好的编程助手，选代码目录，L2 起、授权路径是该目录', async () => {
    await open();
    fireEvent.click(screen.getByTestId('tasks-new'));
    await act(() => fake.settle());
    fireEvent.change(screen.getByTestId('task-form-title'), { target: { value: '修 bug' } });
    fireEvent.change(screen.getByTestId('task-form-goal'), { target: { value: '修 #12' } });
    fireEvent.change(screen.getByTestId('task-form-who'), { target: { value: 'cli' } });
    await act(() => fake.settle());
    expect((screen.getByTestId('task-form-submit') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId('task-form-cwd-button'));
    await act(() => fake.settle());
    fireEvent.click(screen.getByTestId('workspace-recent-item'));
    await act(() => fake.settle());
    // 沙箱预授权：勾上「云账号凭据」，跑的时候不用再问
    fireEvent.click(screen.getByTestId('task-form-sandbox-cloud'));
    window.confirm = vi.fn(() => true);
    fireEvent.click(screen.getByTestId('task-form-submit'));
    await waitFor(() => expect(fake.calls.some(([n]) => n === 'tasks.create')).toBe(true));
    const [, input] = fake.calls.find(([n]) => n === 'tasks.create')!;
    expect(input).toMatchObject({
      executor: { kind: 'cli', cli: 'claude', cwd: '/repo', isolation: 'worktree' },
      grant: { level: 2, paths: ['/repo'], sandbox: ['cloud'] },
    });
  });

  it('事件任务：显示发现的事；处理这些；改成自动处理要先确认', async () => {
    await open();
    fireEvent.click(screen.getByTestId('task-task_f'));
    await act(() => fake.settle());
    expect(screen.getByTestId('task-observed').textContent).toContain('网页有变化');
    fireEvent.click(screen.getByTestId('task-process-observed'));
    await act(() => fake.settle());
    expect(fake.calls).toContainEqual(['tasks.processObserved', { id: 'task_f' }]);
    const confirm = vi.fn(() => false);
    window.confirm = confirm;
    fireEvent.click(screen.getByTestId('task-mode-act'));
    await act(() => fake.settle());
    expect(confirm).toHaveBeenCalled();
    expect(fake.calls.some(([n]) => n === 'tasks.setMode')).toBe(false);
    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByTestId('task-mode-act'));
    await act(() => fake.settle());
    expect(fake.calls).toContainEqual(['tasks.setMode', { id: 'task_f', mode: 'act' }]);
  });

  it('新建事件任务：先只记录；网址必填', async () => {
    await open();
    fireEvent.click(screen.getByTestId('tasks-new'));
    await act(() => fake.settle());
    fireEvent.change(screen.getByTestId('task-form-title'), { target: { value: '盯博客' } });
    fireEvent.change(screen.getByTestId('task-form-goal'), {
      target: { value: '有新文章总结给我' },
    });
    fireEvent.change(screen.getByTestId('task-form-when'), { target: { value: 'event' } });
    expect((screen.getByTestId('task-form-submit') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByTestId('task-form-url'), {
      target: { value: 'https://example.com/feed' },
    });
    window.confirm = vi.fn(() => true);
    fireEvent.click(screen.getByTestId('task-form-submit'));
    await waitFor(() => expect(fake.calls.some(([n]) => n === 'tasks.create')).toBe(true));
    const [, input] = fake.calls.find(([n]) => n === 'tasks.create')!;
    expect(input).toMatchObject({
      trigger: {
        kind: 'event',
        sourceId: 'web',
        filter: { url: 'https://example.com/feed', kind: 'page' },
        mode: 'observe',
      },
    });
  });
});
