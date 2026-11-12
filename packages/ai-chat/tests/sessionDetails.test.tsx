// @vitest-environment happy-dom
/**
 * 「会话详情」：标题栏按钮开 / 收对话卡片右侧的一栏：项目、本会话变更、用到的 Agents 与任务；
 * 列表最多 5 个可展开；屏幕窄且展开了别的栏时自动收起
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SessionDetailsDock, SessionDetailsToggle } from '../src/components/SessionDetails';
import {
  collectSessionAgents,
  countRunning,
  pendingDelegateTaskIds,
} from '../src/components/SessionDetails/agents';
import { summarizeGit } from '../src/components/SessionDetails/useWorkspaceChanges';
import { useChangesUi } from '../src/components/SessionWorkspace';
import { useSubagentPane, WorkspacePanesProvider } from '../src/components/SubagentPane';
import { HarnessTabsProvider } from '../src/contexts/HarnessTabsContext';
import type { HarnessTabMeta, HarnessTabsState } from '../src/services/harnessClient';
import type { ConvMessage } from '../src/types/conversation';

import { installFakeApi, resetFakeApi } from './helpers/fakeApi';

vi.mock('../src/services/api', async () => (await import('./helpers/fakeApi')).fakeApiModule());

vi.mock('../src/contexts/AiChatContext', () => {
  const api = {
    state: {
      messages: [],
      ipcClient: {
        currentConversationId: () => 'n1',
        conversationStore: () => ({ list: () => [], get: () => undefined }),
      },
    },
    actions: {},
  };
  return { useAiChat: () => api };
});

const task = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  title: `任务 ${id}`,
  goal: `目标 ${id}`,
  status: 'idle',
  enabled: true,
  updatedAt: Number(id.replace(/\D/g, '')) || 0,
  origin: { conversationId: 'n1', createdBy: 'nomi', createdAt: 0 },
  trigger: { kind: 'manual' },
  ...over,
});
let tasks: unknown[] = [];
let gitSummary: unknown = true;
let small = false;

beforeEach(() => {
  tasks = [];
  gitSummary = true;
  small = false;
  window.matchMedia = ((q: string) => ({
    matches: small,
    media: q,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
});

const delegated: HarnessTabMeta = {
  id: 'd1',
  title: 'Nomi · 修复登录',
  backend: 'codex',
  cwd: '/w/app',
  cliSessionId: 's1',
  status: 'running',
  unread: 0,
  createdAt: 0,
  updatedAt: 0,
  delegation: {
    by: 'nomi',
    callId: 'c1',
    goal: '修复登录 bug',
    approvals: { asked: 0, denied: 0, timedOut: 0 },
  },
};

const messages = [
  {
    id: 'a1',
    role: 'assistant',
    content: '好的',
    timestamp: 1,
    trace: [
      {
        type: 'tool',
        name: 'delegate_to_cli',
        status: 'start',
        id: 'c1',
        input: JSON.stringify({ goal: '修复登录 bug' }),
      },
      {
        type: 'tool',
        name: 'Task',
        status: 'start',
        id: 'c2',
        input: JSON.stringify({ description: '查找调用方', subagent_type: 'explorer' }),
      },
      {
        type: 'tool',
        name: 'Task',
        status: 'done',
        id: 'c2',
      },
      {
        type: 'tool',
        name: 'Edit',
        status: 'start',
        id: 'c3',
        input: JSON.stringify({ file_path: '/w/app/a.ts', old_string: 'a', new_string: 'b\nc' }),
      },
      { type: 'tool', name: 'Edit', status: 'done', id: 'c3' },
    ],
  },
] as unknown as ConvMessage[];

function setup() {
  const state: HarnessTabsState = {
    tabs: [delegated],
    activeTabId: 'main',
    running: 1,
    queued: 0,
  };
  const invoke = vi.fn(async (ch: string) => {
    if (ch === 'harness.tabs') return state;
    if (ch === 'harness.gitBranch') return { branch: 'release/2.3.3' };
    if (ch === 'tasks.list') return { tasks, legacy: [] };
    if (ch === 'harness.gitSummary') return gitSummary;
    return true;
  });
  fake = installFakeApi(invoke);
  return invoke;
}
let fake: ReturnType<typeof installFakeApi>;

const Probe: React.FC = () => {
  const pane = useSubagentPane();
  const { workbench } = useChangesUi();
  return (
    <>
      <span data-testid="probe">
        {pane?.tabId ?? '-'}|{workbench ? 'wb' : '-'}
      </span>
      <button
        type="button"
        data-testid="probe-open-pane"
        onClick={() => pane?.openSubagent('d1')}
      />
      <button type="button" data-testid="probe-close-pane" onClick={() => pane?.closeSubagent()} />
    </>
  );
};

const mount = (cwd: string | null = '/w/app', msgs: ConvMessage[] = messages, railOpen = false) =>
  render(
    <HarnessTabsProvider>
      <WorkspacePanesProvider>
        <SessionDetailsToggle railOpen={railOpen} />
        <SessionDetailsDock messages={msgs} cwd={cwd} />
        <div data-testid="chat-col">
          <SessionDetailsDock overlay messages={msgs} cwd={cwd} />
        </div>
        <Probe />
      </WorkspacePanesProvider>
    </HarnessTabsProvider>,
  );

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
  resetFakeApi();
});

describe('collectSessionAgents', () => {
  it('a hand-off to background Nomi is a task, not an agent', () => {
    const msgs = [
      {
        id: 'b',
        role: 'assistant',
        content: '',
        timestamp: 1,
        trace: [
          {
            type: 'tool',
            name: 'delegate_to_nomi',
            status: 'done',
            id: 'n1',
            input: '{"goal":"画 5 张"}',
          },
        ],
      },
    ] as unknown as ConvMessage[];
    expect(collectSessionAgents(msgs, [], {})).toEqual([]);
  });

  it('lists delegated sub-tasks and sub-agents with their status', () => {
    const agents = collectSessionAgents(messages, [delegated], {});
    expect(agents.map((a) => [a.kind, a.status, a.tabId ?? a.label])).toEqual([
      ['delegate', 'running', 'd1'],
      ['subagent', 'done', 'explorer'],
    ]);
    expect(countRunning(agents)).toBe(1);
  });

  it('prefers live sub-agent status and adds live agents not tied to a call', () => {
    const agents = collectSessionAgents(
      messages,
      [],
      {},
      {
        x: { id: 'x', callId: 'c2', status: 'running', startedAt: 1, label: 'explorer' },
        y: { id: 'y', status: 'failed', startedAt: 2, agentType: 'worker', progress: '跑测试' },
      },
    );
    const sub = agents.filter((a) => a.kind === 'subagent');
    expect(sub.map((a) => [a.label, a.status])).toEqual([
      ['explorer', 'running'],
      ['worker', 'error'],
    ]);
    // 标签已经没了：子任务仍列出，但不能打开
    expect(agents[0]).toMatchObject({ kind: 'delegate', tabId: undefined });
  });
});

describe('SessionDetailsToggle', () => {
  it('toggles a docked column with the project, changes and agents', async () => {
    setup();
    mount();
    const btn = screen.getByTestId('session-details-toggle');
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    expect(screen.queryByTestId('session-details')).toBeNull();
    fireEvent.click(btn);
    const panel = await screen.findByTestId('session-details');
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    expect(panel.tagName).toBe('ASIDE');
    // 平时那一栏在对话列外面（对话卡片右侧）
    expect(screen.getByTestId('chat-col').contains(panel)).toBe(false);
    expect(panel.textContent).toContain('app');
    await waitFor(() =>
      expect(screen.getByTestId('session-details-branch').textContent).toBe('release/2.3.3'),
    );
    expect(screen.getByTestId('session-details-changes').textContent).toMatch(/\+2.*-1/);
    await waitFor(() => expect(screen.getAllByTestId('session-details-agent')).toHaveLength(2));
    expect(screen.getByTestId('session-details-agents-count').textContent).toMatch(/2.*1/);
    fireEvent.click(btn);
    expect(screen.queryByTestId('session-details')).toBeNull();
  });

  it('stays open for the sub-task pane on a wide window as a float over the chat; outside clicks do not close it', async () => {
    setup();
    mount();
    fireEvent.click(screen.getByTestId('session-details-toggle'));
    await waitFor(() => expect(screen.getAllByTestId('session-details-agent')).toHaveLength(2));
    fireEvent.click(screen.getAllByTestId('session-details-agent')[0]!.querySelector('button')!);
    expect(screen.getByTestId('probe').textContent).toBe('d1|-');
    expect(screen.getByTestId('session-details').getAttribute('data-floating')).toBe('true');
    fireEvent.pointerDown(document.body);
    expect(screen.getByTestId('session-details').getAttribute('data-floating')).toBe('true');
  });

  it('opening the diff hides it; reopening floats it over the chat and an outside click puts it away', async () => {
    setup();
    mount();
    const btn = screen.getByTestId('session-details-toggle');
    fireEvent.click(btn);
    await screen.findByTestId('session-details');
    fireEvent.click(screen.getByTestId('session-details-changes'));
    expect(screen.getByTestId('probe').textContent).toBe('-|wb');
    // 展开 Diff：自动收起（宽屏也一样）
    expect(screen.queryByTestId('session-details')).toBeNull();
    expect(btn.getAttribute('data-auto-hidden')).toBe('true');
    // 再点按钮：浮层放进对话列，盖在对话右上角（不落到中栏上）
    fireEvent.click(btn);
    expect(screen.getByTestId('session-details').getAttribute('data-floating')).toBe('true');
    expect(screen.getByTestId('chat-col').contains(screen.getByTestId('session-details'))).toBe(
      true,
    );
    // 点浮层里面不收回，点外面收回（还是自动收起，不改用户的开关）
    fireEvent.pointerDown(screen.getByTestId('session-details'));
    expect(screen.getByTestId('session-details')).toBeTruthy();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByTestId('session-details')).toBeNull();
    expect(btn.getAttribute('data-auto-hidden')).toBe('true');
    expect(localStorage.getItem('nomi.sessionDetails.open')).toBe('1');
  });

  it('Escape closes it; the choice is remembered; an empty session shows nothing', async () => {
    setup();
    const first = mount(null);
    fireEvent.click(screen.getByTestId('session-details-toggle'));
    const panel = await screen.findByTestId('session-details');
    expect(screen.queryByTestId('session-details-changes')).toBeNull();
    fireEvent.keyDown(panel, { key: 'Escape' });
    expect(screen.queryByTestId('session-details')).toBeNull();
    fireEvent.click(screen.getByTestId('session-details-toggle'));
    first.unmount();
    // 重新打开应用：保持开着
    mount();
    expect(await screen.findByTestId('session-details')).toBeTruthy();
    cleanup();
    mount('/w/app', []);
    expect(screen.queryByTestId('session-details')).toBeNull();
  });
});

const subagentCalls = (n: number) =>
  [
    {
      id: 'many',
      role: 'assistant',
      content: '',
      timestamp: 1,
      trace: Array.from({ length: n }, (_, i) => ({
        type: 'tool',
        name: 'Task',
        status: 'done',
        id: `s${i}`,
        input: JSON.stringify({ description: `第 ${i} 个`, subagent_type: `agent${i}` }),
      })),
    },
  ] as unknown as ConvMessage[];

describe('session details lists', () => {
  it("lists this session's tasks (not delegations or other chats), at most five until expanded", async () => {
    tasks = [
      ...Array.from({ length: 6 }, (_, i) => task(`t${i + 1}`)),
      task('t9', { status: 'running' }),
      task('x1', { origin: { conversationId: 'other', createdBy: 'nomi', createdAt: 0 } }),
      // 后台派给编程助手的：在「Agents」里，不在任务里
      task('d1', {
        origin: { conversationId: 'n1', createdBy: 'nomi', createdAt: 0, via: 'delegate' },
        executor: { kind: 'cli', cli: 'claude', cwd: '/w', isolation: 'shared' },
      }),
      // 派给后台 Nomi 的（delegate_to_nomi）：是任务
      task('n7', {
        title: '海边漫画',
        origin: { conversationId: 'n1', createdBy: 'nomi', createdAt: 0, via: 'delegate' },
        executor: { kind: 'nomi', tools: [] },
      }),
    ];
    setup();
    mount();
    fireEvent.click(screen.getByTestId('session-details-toggle'));
    await waitFor(() => expect(screen.getAllByTestId('session-details-task')).toHaveLength(5));
    // 进行中的排最前
    expect(screen.getAllByTestId('session-details-task')[0]!.textContent).toContain('任务 t9');
    expect(screen.getByTestId('session-details-tasks-count').textContent).toMatch(/8.*1/);
    const more = screen.getByTestId('session-details-tasks-more');
    expect(more.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(more);
    expect(screen.getAllByTestId('session-details-task')).toHaveLength(8);
    expect(screen.getByText('海边漫画')).toBeTruthy();
    expect(screen.queryByText('任务 x1')).toBeNull();
    expect(screen.queryByText('任务 d1')).toBeNull();
    fireEvent.click(more);
    expect(screen.getAllByTestId('session-details-task')).toHaveLength(5);
  });

  it('opens a task on the tasks page', async () => {
    tasks = [task('t1')];
    setup();
    mount();
    const seen: string[] = [];
    const on = (e: Event) => seen.push((e as CustomEvent<string>).detail);
    window.addEventListener('nomi:open-task', on);
    fireEvent.click(screen.getByTestId('session-details-toggle'));
    const row = await screen.findByTestId('session-details-task');
    fireEvent.click(row.querySelector('button')!);
    window.removeEventListener('nomi:open-task', on);
    expect(seen).toEqual(['t1']);
  });

  it('caps agents at five too; no tasks hides the tasks block', async () => {
    setup();
    mount('/w/app', subagentCalls(8));
    fireEvent.click(screen.getByTestId('session-details-toggle'));
    await screen.findByTestId('session-details');
    expect(screen.getAllByTestId('session-details-agent')).toHaveLength(5);
    fireEvent.click(screen.getByTestId('session-details-agents-more'));
    expect(screen.getAllByTestId('session-details-agent')).toHaveLength(8);
    // 没有任务：整个「任务」区块不显示
    expect(screen.queryByTestId('session-details-tasks')).toBeNull();
    expect(screen.queryByTestId('session-details-tasks-more')).toBeNull();
  });
});

describe('workspace changes', () => {
  it('the changes row counts the git workspace from gitSummary, never the full diff', async () => {
    gitSummary = { ok: true, status: ' M a.ts\n M b.ts\n?? c.ts\n', added: 7, removed: 2 };
    const invoke = setup();
    mount();
    fireEvent.click(screen.getByTestId('session-details-toggle'));
    await waitFor(
      () => expect(screen.getByTestId('session-details-changes').textContent).toMatch(/3.*\+7.*-2/),
      { timeout: 2000 },
    );
    expect(invoke.mock.calls.some(([ch]) => ch === 'harness.gitDiff')).toBe(false);
  });
});

describe('live state', () => {
  it('a delegated tab waiting for approval shows as waiting; its streaming text does not matter', async () => {
    setup();
    mount();
    fireEvent.click(screen.getByTestId('session-details-toggle'));
    await waitFor(() => expect(screen.getAllByTestId('session-details-agent')).toHaveLength(2));
    const state = () =>
      screen
        .getAllByTestId('session-details-agent')[0]!
        .querySelector('[data-state]')!
        .getAttribute('data-state');
    expect(state()).toBe('running');
    await act(() => fake.emit('harness.events', [{ tabId: 'd1', type: 'text', text: '写代码…' }]));
    expect(state()).toBe('running');
    await act(() =>
      fake.emit('harness.events', [
        { tabId: 'd1', type: 'permission', id: 'p1', summary: 'npm install' },
      ]),
    );
    await waitFor(() => expect(state()).toBe('waiting'));
  });
});

describe('empty blocks', () => {
  it('a session without agents or tasks shows neither block', async () => {
    setup();
    mount('/w/app', [
      { id: 'u', role: 'user', content: '你好', timestamp: 1 },
    ] as unknown as ConvMessage[]);
    await screen.findByTestId('session-details-toggle');
    fireEvent.click(screen.getByTestId('session-details-toggle'));
    await screen.findByTestId('session-details');
    expect(screen.queryByTestId('session-details-agents')).toBeNull();
    expect(screen.queryByTestId('session-details-tasks')).toBeNull();
    // 没有改动：只是一行说明，不能点开空的 Diff
    const row = screen.getByTestId('session-details-changes');
    expect(row.tagName).toBe('DIV');
    fireEvent.click(row);
    expect(screen.getByTestId('probe').textContent).toBe('-|-');
    expect(screen.getByTestId('session-details')).toBeTruthy();
  });
});

describe('auto-hide on small screens', () => {
  it('hides when the files panel is open on a narrow window; the button can still force it open', async () => {
    small = true;
    localStorage.setItem('nomi.sessionDetails.open', '1');
    setup();
    mount('/w/app', messages, true);
    const btn = screen.getByTestId('session-details-toggle');
    await waitFor(() => expect(screen.queryByTestId('session-details')).toBeNull());
    expect(btn.getAttribute('data-auto-hidden')).toBe('true');
    fireEvent.click(btn);
    expect(screen.getByTestId('session-details')).toBeTruthy();
    // 子任务面板展开：又自动收起
    fireEvent.click(screen.getByTestId('probe-open-pane'));
    // 收起时先放完淡出动画再卸载
    await waitFor(() => expect(screen.queryByTestId('session-details')).toBeNull());
  });

  it('opening the sub-task pane hides it on a narrow window and closing brings it back', async () => {
    small = true;
    localStorage.setItem('nomi.sessionDetails.open', '1');
    setup();
    mount();
    expect(await screen.findByTestId('session-details')).toBeTruthy();
    fireEvent.click(screen.getByTestId('probe-open-pane'));
    // 收起时先放完淡出动画再卸载
    await waitFor(() => expect(screen.queryByTestId('session-details')).toBeNull());
    fireEvent.click(screen.getByTestId('probe-close-pane'));
    expect(screen.getByTestId('session-details')).toBeTruthy();
  });

  it('wide windows keep it open with the files panel, floating over the chat instead of squeezing it', async () => {
    localStorage.setItem('nomi.sessionDetails.open', '1');
    setup();
    mount('/w/app', messages, true);
    const panel = await screen.findByTestId('session-details');
    expect(panel.getAttribute('data-floating')).toBe('true');
    expect(screen.getByTestId('chat-col').contains(panel)).toBe(true);
    // 这种浮层是常驻的：点外面不收回；再点按钮才关
    fireEvent.pointerDown(document.body);
    expect(screen.getByTestId('session-details')).toBeTruthy();
    fireEvent.click(screen.getByTestId('session-details-toggle'));
    expect(screen.queryByTestId('session-details')).toBeNull();
  });
});

describe('会话详情：异步委派的状态与工作区改动', () => {
  // 异步委派：工具已返回，输出是 running 占位
  const asyncMessages = (output: unknown) =>
    [
      {
        id: 'a1',
        role: 'assistant',
        content: '',
        timestamp: 1,
        trace: [
          {
            type: 'tool',
            name: 'delegate_to_cli',
            status: 'start',
            id: 'c1',
            input: JSON.stringify({ goal: '修复登录 bug' }),
          },
          {
            type: 'tool',
            name: 'delegate_to_cli',
            status: 'done',
            id: 'c1',
            output: JSON.stringify(output),
          },
        ],
      },
    ] as unknown as ConvMessage[];
  const running = { ok: true, data: { taskId: 't1', cli: 'codex', status: 'running' } };

  it('最终结果到了就按结果显示，不再一直「运行中」', () => {
    const msgs = asyncMessages(running);
    expect(pendingDelegateTaskIds(msgs)).toEqual(['t1']);
    const tabs = [{ ...delegated, status: 'idle' as const }];
    expect(collectSessionAgents(msgs, tabs, {})[0]?.status).toBe('running');
    const done = { taskId: 't1', cli: 'codex', status: 'done' } as never;
    expect(collectSessionAgents(msgs, tabs, {}, {}, { t1: done })[0]?.status).toBe('done');
    const failed = { taskId: 't1', cli: 'codex', status: 'error', error: '400' } as never;
    expect(collectSessionAgents(msgs, tabs, {}, {}, { t1: failed })[0]?.status).toBe('error');
    // 子任务里后续轮次的结果不算委派本身
    const follow = { taskId: 't1', cli: 'codex', status: 'done', followUp: true } as never;
    expect(collectSessionAgents(msgs, tabs, {}, {}, { t1: follow })[0]?.status).toBe('running');
  });

  it('标签已经出错停下、结果还没到：显示出错', () => {
    const tabs = [{ ...delegated, status: 'error' as const }];
    expect(collectSessionAgents(asyncMessages(running), tabs, {})[0]?.status).toBe('error');
  });

  it('工作区改动按 git 统计（未跟踪的只计文件数）', () => {
    expect(summarizeGit({ ok: true, status: ' M a.ts\n?? b.ts\n', added: 3, removed: 1 })).toEqual({
      files: 2,
      added: 3,
      removed: 1,
    });
    expect(summarizeGit({ ok: false, status: '', added: 0, removed: 0 })).toBeNull();
  });
});

describe('agent list cache', () => {
  it('reuses earlier messages and still sees calls appended to a trace in place', () => {
    const msg = {
      id: 'x',
      role: 'assistant',
      content: '',
      timestamp: 1,
      trace: [
        {
          type: 'tool',
          name: 'Task',
          status: 'start',
          id: 't1',
          input: JSON.stringify({ subagent_type: 'explorer', description: '找' }),
        },
      ],
    } as unknown as ConvMessage;
    expect(collectSessionAgents([msg], [], {})).toHaveLength(1);
    // 同一条消息的 trace 原地追加了一个子代理
    (msg.trace as unknown[]).push({
      type: 'tool',
      name: 'Task',
      status: 'start',
      id: 't2',
      input: JSON.stringify({ subagent_type: 'reviewer', description: '审' }),
    });
    expect(collectSessionAgents([msg], [], {}).map((a) => a.label)).toEqual([
      'explorer',
      'reviewer',
    ]);
  });
});
