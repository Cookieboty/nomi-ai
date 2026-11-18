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
  sessionAgentTarget,
  sideChatAgents,
  sortSessionAgents,
  type SessionAgent,
} from '../src/components/SessionDetails/agents';
import { resetDelegateResultsCache } from '../src/components/SessionDetails/useDelegateResults';
import { summarizeGit } from '../src/components/SessionDetails/useWorkspaceChanges';
import { useChangesUi } from '../src/components/SessionWorkspace';
import { useSubagentPane, WorkspacePanesProvider } from '../src/components/SubagentPane';
import { HarnessTabsProvider } from '../src/contexts/HarnessTabsContext';
import type { HarnessTabMeta, HarnessTabsState } from '../src/services/harnessClient';
import { createSideChat, resetSideChats } from '../src/services/sideChat';
import type { ConvMessage } from '../src/types/conversation';
import {
  agentTargetBackend,
  nestedHostTabId,
  nestedOwnerBackend,
  sessionAgentIdentity,
} from '../src/utils/agentIdentity';
import { resolveDelegateTarget } from '../src/utils/delegateTarget';
import { agentKey } from '../src/utils/sideTabs';

import { installFakeApi, resetFakeApi } from './helpers/fakeApi';

vi.mock('../src/services/api', async () => (await import('./helpers/fakeApi')).fakeApiModule());

// Nomi 对话的状态（含流式中的尾消息）：用例可改 messages / isLoading 模拟进行中的一轮
const aiChatState = vi.hoisted(() => ({
  messages: [] as unknown[],
  isLoading: false,
  ipcClient: {
    currentConversationId: () => 'n1',
    conversationStore: () => ({ list: () => [], get: () => undefined }),
  },
}));
vi.mock('../src/contexts/AiChatContext', () => {
  const api = { state: aiChatState, actions: {} };
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
      <span data-testid="probe-target">{pane?.target ? agentKey(pane.target) : '-'}</span>
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
  aiChatState.messages = [];
  aiChatState.isLoading = false;
  localStorage.clear();
  resetDelegateResultsCache();
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

describe('side chats in the agents list', () => {
  it('maps side chats to agent rows (status from the last turn)', () => {
    expect(
      sideChatAgents([
        {
          id: 'a',
          name: '侧边聊天 1',
          running: true,
          messages: [{ role: 'user', text: ' 问\n题 ' }],
        },
        { id: 'b', name: '侧边聊天 2', running: false, messages: [] },
        {
          id: 'c',
          name: '侧边聊天 3',
          running: false,
          messages: [
            { role: 'user', text: 'q' },
            { role: 'assistant', text: '', error: 'x' },
          ],
        },
      ]).map((a) => [a.id, a.kind, a.status, a.detail ?? '']),
    ).toEqual([
      ['side-chat:a', 'side-chat', 'running', ' 问 题 '],
      ['side-chat:b', 'side-chat', 'idle', ''],
      ['side-chat:c', 'side-chat', 'error', 'q'],
    ]);
  });

  it("lists this conversation's side chats with the agents and opens one as a tab", async () => {
    resetSideChats();
    const id = createSideChat('');
    createSideChat('other');
    try {
      setup();
      mount();
      fireEvent.click(screen.getByTestId('session-details-toggle'));
      await waitFor(() => expect(screen.getAllByTestId('session-details-agent')).toHaveLength(3));
      const row = screen
        .getAllByTestId('session-details-agent')
        .find((r) => r.textContent?.includes('侧边聊天 1'))!;
      expect(row).toBeTruthy();
      fireEvent.click(row.querySelector('button')!);
      await waitFor(() =>
        expect(screen.getByTestId('probe-target').textContent).toBe(`side-chat:${id}`),
      );
    } finally {
      resetSideChats();
    }
  });
});

describe('SessionDetailsToggle', () => {
  it('floats the session details over the chat even when the files rail is closed', async () => {
    setup();
    mount();
    const btn = screen.getByTestId('session-details-toggle');
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    expect(screen.queryByTestId('session-details')).toBeNull();
    fireEvent.click(btn);
    const panel = await screen.findByTestId('session-details');
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    expect(panel.tagName).toBe('ASIDE');
    expect(panel.getAttribute('data-floating')).toBe('true');
    expect(screen.getByTestId('chat-col').contains(panel)).toBe(true);
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
      // 后台派给 agent 的：在「Agents」里，不在任务里
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
    // 子任务侧栏展开：又自动收起
    fireEvent.click(screen.getByTestId('probe-open-pane'));
    await waitFor(() => expect(screen.queryByTestId('session-details')).toBeNull());
  });

  it('opening the sub-task pane hides it on a narrow window and closing brings it back', async () => {
    small = true;
    localStorage.setItem('nomi.sessionDetails.open', '1');
    setup();
    mount();
    expect(await screen.findByTestId('session-details')).toBeTruthy();
    fireEvent.click(screen.getByTestId('probe-open-pane'));
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

  it('出错后在子任务里「继续」：标签又跑起来就显示进行中，那一轮结束后按它的结果', () => {
    const msgs = asyncMessages(running);
    const failed = { taskId: 't1', cli: 'codex', status: 'error', error: '400' } as never;
    const runningTab = [{ ...delegated, status: 'running' as const }];
    const agents = collectSessionAgents(msgs, runningTab, {}, {}, { t1: failed });
    expect(agents[0]?.status).toBe('running');
    expect(countRunning(agents)).toBe(1);
    // 排队中也算进行中；等你批准时显示等待
    const queued = [{ ...delegated, status: 'queued' as const }];
    expect(collectSessionAgents(msgs, queued, {}, {}, { t1: failed })[0]?.status).toBe('running');
    const live = { d1: { permissions: [{}] } } as never;
    expect(collectSessionAgents(msgs, runningTab, live, {}, { t1: failed })[0]?.status).toBe(
      'waiting',
    );
    // 「继续」那一轮结束：按它的结果，而不是委派最初的出错
    const idle = [{ ...delegated, status: 'idle' as const }];
    const followDone = { taskId: 't1', cli: 'codex', status: 'done', followUp: true } as never;
    expect(
      collectSessionAgents(msgs, idle, {}, {}, { t1: failed }, { t1: followDone })[0]?.status,
    ).toBe('done');
    expect(collectSessionAgents(msgs, idle, {}, {}, { t1: failed })[0]?.status).toBe('error');
  });

  it('Nomi 这一轮出错后「继续」：旧消息里被关掉的委派调用，标签还在跑就显示进行中', () => {
    const msgs = [
      {
        id: 'a1',
        role: 'assistant',
        content: '',
        timestamp: 1,
        error: 'network',
        trace: [
          {
            type: 'tool',
            name: 'delegate_to_cli',
            status: 'start',
            id: 'c1',
            input: JSON.stringify({ goal: '修复登录 bug' }),
          },
          { type: 'tool', name: 'delegate_to_cli', status: 'error', id: 'c1', output: '已停止' },
        ],
      },
    ] as unknown as ConvMessage[];
    expect(collectSessionAgents(msgs, [{ ...delegated, status: 'idle' }], {})[0]?.status).toBe(
      'error',
    );
    expect(collectSessionAgents(msgs, [delegated], {})[0]?.status).toBe('running');
  });

  it('第一次派出子任务：还在进行中的这一轮里就列出来并算进行中', async () => {
    setup();
    const user = { id: 'u1', role: 'user', content: '修一下登录', timestamp: 1 };
    // 主列只给定稿的消息（只有用户这一条）；委派调用还只在流式中的尾消息里
    aiChatState.messages = [
      user,
      {
        id: 'a1',
        role: 'assistant',
        content: '',
        timestamp: 2,
        trace: [
          {
            type: 'tool',
            name: 'delegate_to_cli',
            status: 'start',
            id: 'c1',
            input: JSON.stringify({ goal: '修复登录 bug' }),
          },
        ],
      },
    ];
    aiChatState.isLoading = true;
    const settled = [{ id: 'u1', role: 'user', text: '修一下登录', at: 1 }] as ConvMessage[];
    mount('/w/app', settled);
    fireEvent.click(screen.getByTestId('session-details-toggle'));
    await waitFor(() => expect(screen.getAllByTestId('session-details-agent')).toHaveLength(1));
    await waitFor(() =>
      expect(screen.getByTestId('session-details-agents-count').textContent).toMatch(/1.*1/),
    );
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

describe('Agents order: status group first, newest first inside a group', () => {
  const at = (id: string, status: SessionAgent['status'], t?: number): SessionAgent => ({
    id,
    kind: 'subagent',
    status,
    ...(t != null ? { at: t } : {}),
  });

  it('running (incl. waiting) → error → done, newest first; untimed last; ties keep order', () => {
    const sorted = sortSessionAgents([
      at('done-old', 'done', 1),
      at('done-new', 'done', 5),
      at('err-old', 'error', 2),
      at('err-new', 'error', 6),
      at('run', 'running', 3),
      at('wait', 'waiting', 4),
      at('stopped', 'stopped', 9),
      at('done-untimed', 'done'),
      at('done-tie-a', 'done', 5),
    ]);
    expect(sorted.map((a) => a.id)).toEqual([
      'wait',
      'run',
      'err-new',
      'err-old',
      'done-new',
      'done-tie-a',
      'done-old',
      'done-untimed',
      'stopped',
    ]);
  });

  it('re-sorts only when a status changes (same input, same order)', () => {
    const list = [at('a', 'done', 1), at('b', 'running', 2), at('c', 'done', 3)];
    const first = sortSessionAgents(list).map((a) => a.id);
    expect(sortSessionAgents(list).map((a) => a.id)).toEqual(first);
    expect(first).toEqual(['b', 'c', 'a']);
    const finished = list.map((a) => (a.id === 'b' ? { ...a, status: 'error' as const } : a));
    expect(sortSessionAgents(finished).map((a) => a.id)).toEqual(['b', 'c', 'a']);
    const failedA = list.map((a) => (a.id === 'a' ? { ...a, status: 'error' as const } : a));
    expect(sortSessionAgents(failedA).map((a) => a.id)).toEqual(['b', 'a', 'c']);
  });

  it('rows take their start time from the call (side chats: the latest question)', () => {
    const msgs = [
      {
        id: 'm',
        role: 'assistant',
        content: '',
        timestamp: 1,
        trace: [
          { type: 'tool', name: 'Task', status: 'start', id: 's1', at: 100, input: '{}' },
          { type: 'tool', name: 'Task', status: 'done', id: 's1', at: 900 },
        ],
      },
    ] as unknown as ConvMessage[];
    expect(collectSessionAgents(msgs, [], {})[0]).toMatchObject({ id: 's1', at: 100 });
    expect(
      sideChatAgents([
        {
          id: 'x',
          name: 'n',
          running: false,
          messages: [
            { role: 'user', text: 'a', at: 10 },
            { role: 'assistant', text: 'b', at: 11 },
            { role: 'user', text: 'c', at: 20 },
            { role: 'assistant', text: 'd', at: 21 },
          ],
        },
      ])[0],
    ).toMatchObject({ at: 20 });
  });

  it('the popover lists running → error → done (also behind ⋯)', async () => {
    const call = (id: string, t: number, end: 'done' | 'error') => [
      {
        type: 'tool',
        name: 'Task',
        status: 'start',
        id,
        at: t,
        input: JSON.stringify({ subagent_type: id }),
      },
      { type: 'tool', name: 'Task', status: end, id, at: t + 0.5 },
    ];
    const msgs = [
      {
        id: 'm',
        role: 'assistant',
        content: '',
        timestamp: 1,
        trace: [
          ...call('done1', 1, 'done'),
          ...call('done2', 2, 'done'),
          ...call('err1', 3, 'error'),
          ...call('err2', 4, 'error'),
          ...call('done3', 6, 'done'),
        ],
      },
      // 委派 c1 的标签 d1 还在跑（第一条消息里派出，最早，但进行中排最前）
      ...messages,
    ] as unknown as ConvMessage[];
    setup();
    mount('/w/app', msgs);
    fireEvent.click(screen.getByTestId('session-details-toggle'));
    await screen.findByTestId('session-details');
    await waitFor(() =>
      expect(screen.getByTestId('session-details-agents-count').textContent).toMatch(/7.*1/),
    );
    fireEvent.click(screen.getByTestId('session-details-agents-more'));
    const names = screen
      .getAllByTestId('session-details-agent')
      .map((r) => r.textContent?.match(/(done|err)\d|explorer|修复登录/)?.[0]);
    expect(names).toEqual(['修复登录', 'err2', 'err1', 'done3', 'done2', 'done1', 'explorer']);
  });
});

describe('Nomi delegations stay continuable and collapse into one row when reused', () => {
  // 同一种委派接着用了 d1：标签上的 callId 已换成新那次（c1），旧的 c0 只剩结果里的 taskId 或 prevCallIds
  const reused = [
    {
      id: 'old',
      role: 'assistant',
      content: '',
      timestamp: 1,
      trace: [
        {
          type: 'tool',
          name: 'delegate_to_cli',
          status: 'start',
          id: 'c0',
          at: 1,
          input: JSON.stringify({ goal: '先查一下' }),
        },
        {
          type: 'tool',
          name: 'delegate_to_cli',
          status: 'done',
          id: 'c0',
          at: 2,
          output: JSON.stringify({
            ok: true,
            data: { taskId: 'd1', cli: 'codex', status: 'done', summary: '查完了' },
          }),
        },
      ],
    },
    ...messages,
  ] as unknown as ConvMessage[];

  it('merges previous and current delegations on the same reused tab into a single agent row', () => {
    const agents = collectSessionAgents(reused, [delegated], {});
    const delegates = agents.filter((a) => a.kind === 'delegate');
    expect(delegates).toHaveLength(1);
    expect(delegates[0]).toMatchObject({
      id: 'c1',
      kind: 'delegate',
      tabId: 'd1',
      status: 'running',
      backend: 'codex',
      detail: '修复登录 bug',
    });
    expect(countRunning(agents)).toBe(1);
    // 同一个载体只出现 1 条（新任务状态，旧任务不会再残留占成 2 个 agent）
    expect(agents.find((a) => a.id === 'c0')).toBeUndefined();
  });

  it('the single old delegation opens its (reused) tab, not a read-only sub-agent', () => {
    const agents = collectSessionAgents([reused[0]!], [delegated], {});
    const old = agents.find((a) => a.id === 'c0')!;
    // 状态仍按这一次自己的结果（标签现在在跑的是另一轮未带入本集合时的结果）
    expect(old).toMatchObject({ kind: 'delegate', tabId: 'd1', status: 'done', backend: 'codex' });
    expect(sessionAgentTarget(old, null)).toEqual({ kind: 'harness', tabId: 'd1' });
    // 标签整个没了：不再掉成「进程内子代理」
    const gone = collectSessionAgents([reused[0]!], [], {}).find((a) => a.id === 'c0')!;
    expect(sessionAgentTarget(gone, null)).toBeNull();
  });

  it('a nested target that is really a delegation resolves to its harness tab', () => {
    expect(
      resolveDelegateTarget(
        { kind: 'nested', callId: 'c0', parentTabId: null },
        [delegated],
        reused,
      ),
    ).toEqual({ kind: 'harness', tabId: 'd1' });
    // 真正的进程内子代理不动
    expect(
      resolveDelegateTarget(
        { kind: 'nested', callId: 'c2', parentTabId: null },
        [delegated],
        reused,
      ),
    ).toEqual({ kind: 'nested', callId: 'c2', parentTabId: null });
  });

  it('merges background tasks reusing the same agent tab via prevCallIds or result tabId, while keeping distinct tabs separate', () => {
    const bgMsgs = [
      {
        id: 'm1',
        role: 'assistant',
        content: '',
        timestamp: 1,
        trace: [
          {
            type: 'tool',
            name: 'delegate_to_cli',
            status: 'done',
            id: 'call-1',
            at: 10,
            input: JSON.stringify({ goal: '全仓库重命名' }),
            output: JSON.stringify({
              ok: true,
              data: { taskId: 'task-1', cli: 'claude', status: 'running', background: true },
            }),
          },
        ],
      },
      {
        id: 'm2',
        role: 'assistant',
        content: '',
        timestamp: 2,
        trace: [
          {
            type: 'tool',
            name: 'delegate_to_cli',
            status: 'done',
            id: 'call-2',
            at: 20,
            input: JSON.stringify({ goal: '拆分三方与本地模型标签' }),
            output: JSON.stringify({
              ok: true,
              data: { taskId: 'task-2', cli: 'claude', status: 'running', background: true },
            }),
          },
        ],
      },
    ] as unknown as ConvMessage[];

    // 1) 通过标签 delegation.prevCallIds 同步识别复用（无需等异步 results 返回）
    const reboundTab: HarnessTabMeta = {
      ...delegated,
      id: 'tab-claude-1',
      backend: 'claude',
      delegation: {
        by: 'nomi',
        callId: 'call-2',
        taskId: 'task-2',
        prevCallIds: ['call-1'],
        prevTaskIds: ['task-1'],
        goal: '拆分三方与本地模型标签',
        approvals: { asked: 0, denied: 0, timedOut: 0 },
      },
    };
    const synced = collectSessionAgents(bgMsgs, [reboundTab], {});
    expect(synced).toHaveLength(1);
    expect(synced[0]).toMatchObject({
      id: 'call-2',
      kind: 'delegate',
      tabId: 'tab-claude-1',
      status: 'running',
      detail: '拆分三方与本地模型标签',
    });

    // 2) 通过 results 中的 tabId 识别复用（即便标签不在了或未带 prevCallIds）
    const byResult = collectSessionAgents(
      bgMsgs,
      [],
      {},
      {},
      {
        'task-1': {
          taskId: 'task-1',
          cli: 'claude',
          status: 'done',
          tabId: 'tab-claude-1',
        } as never,
        'task-2': {
          taskId: 'task-2',
          cli: 'claude',
          status: 'done',
          tabId: 'tab-claude-1',
        } as never,
      },
    );
    expect(byResult).toHaveLength(1);
    expect(byResult[0]).toMatchObject({
      id: 'call-2',
      status: 'done',
      detail: '拆分三方与本地模型标签',
    });

    // 3) 真正两个不同标签的任务不合并
    const twoTabs = collectSessionAgents(
      bgMsgs,
      [],
      {},
      {},
      {
        'task-1': { taskId: 'task-1', cli: 'claude', status: 'done', tabId: 'tab-1' } as never,
        'task-2': { taskId: 'task-2', cli: 'claude', status: 'running', tabId: 'tab-2' } as never,
      },
    );
    expect(twoTabs).toHaveLength(2);
  });

  it('clicking the reused agent in the popover shows only 1 delegate row and opens its tab', async () => {
    setup();
    mount('/w/app', reused);
    fireEvent.click(screen.getByTestId('session-details-toggle'));
    await screen.findByTestId('session-details');
    // reused 里 c0 与 c1 复用同一标签 d1，合并为 1 个 delegate（修复登录 bug），加上 explorer 子代理共 2 个
    await waitFor(() => expect(screen.getAllByTestId('session-details-agent')).toHaveLength(2));
    expect(screen.getByTestId('session-details-agents-count').textContent).toMatch(/2.*1/);
    const row = screen
      .getAllByTestId('session-details-agent')
      .find((x) => x.textContent?.includes('修复登录 bug'))!;
    expect(row).toBeTruthy();
    expect(
      screen
        .getAllByTestId('session-details-agent')
        .some((x) => x.textContent?.includes('先查一下')),
    ).toBe(false);
    fireEvent.click(row.querySelector('button')!);
    expect(screen.getByTestId('probe-target').textContent).toBe(
      agentKey({ kind: 'harness', tabId: 'd1' }),
    );
  });
});

describe('agent identity (icon + name) comes from what the agent really is', () => {
  const tab = (id: string, backend: HarnessTabMeta['backend']) =>
    ({ id, backend }) as HarnessTabMeta;

  it('a sub-agent of the Nomi chat is Nomi; of a coding-agent tab, that agent', () => {
    expect(nestedOwnerBackend(null, [tab('main', 'nomi')])).toBe('nomi');
    expect(nestedOwnerBackend(null, [])).toBe('nomi');
    // 主标签切到了 agent：那一轮是它跑的
    expect(nestedOwnerBackend(null, [tab('main', 'claude')])).toBe('claude');
    expect(nestedOwnerBackend('t1', [tab('t1', 'codex')])).toBe('codex');
    expect(
      agentTargetBackend({ kind: 'nested', callId: 'x', parentTabId: null }, [tab('main', 'nomi')]),
    ).toBe('nomi');
    expect(agentTargetBackend({ kind: 'nomi-task', taskId: 't' }, [])).toBe('nomi');
    expect(agentTargetBackend({ kind: 'harness', tabId: 'd1' }, [tab('d1', 'grok')])).toBe('grok');
  });

  it('only a sub-agent whose source can take a message gets a host tab', () => {
    expect(nestedHostTabId(null, [tab('main', 'nomi')])).toBeNull();
    expect(nestedHostTabId(null, [tab('main', 'claude')])).toBe('main');
    expect(nestedHostTabId('t1', [])).toBe('t1');

    // 主标签后来换了后端：历史消息里的子代理仍保留原后端身份，不会误路由到新后端
    const hist: ConvMessage[] = [
      {
        id: 'm1',
        role: 'assistant',
        text: '',
        model: 'claude-code',
        trace: [{ type: 'tool', id: 'c_claude', name: 'Agent', status: 'done' }],
      },
      {
        id: 'm2',
        role: 'assistant',
        text: '',
        model: 'deepseek-v4.1-flash',
        trace: [{ type: 'tool', id: 'c_nomi', name: 'Agent', status: 'done' }],
      },
    ];
    expect(nestedOwnerBackend(null, [tab('main', 'nomi')], 'c_claude', hist)).toBe('claude');
    expect(nestedOwnerBackend(null, [tab('main', 'codex')], 'c_nomi', hist)).toBe('nomi');
    expect(nestedHostTabId(null, [tab('main', 'codex')], 'c_claude', hist)).toBeNull();
    expect(nestedHostTabId(null, [tab('main', 'codex')], 'c_nomi', hist)).toBeNull();
    expect(nestedHostTabId(null, [tab('main', 'claude')], 'c_claude', hist)).toBe('main');
  });

  it('session-detail rows: sub-agents use the owner icon, delegations their CLI', () => {
    expect(sessionAgentIdentity({ kind: 'subagent', label: 'explorer' }, 'nomi')).toEqual({
      backend: 'nomi',
      name: 'explorer',
    });
    expect(sessionAgentIdentity({ kind: 'delegate', backend: 'codex' }, 'nomi').backend).toBe(
      'codex',
    );
    expect(sessionAgentIdentity({ kind: 'side-chat', label: 's' }, 'claude').backend).toBe('nomi');
  });

  it('a Nomi-chat sub-agent row shows the Nomi icon, not a Claude one', async () => {
    setup();
    mount('/w/app', subagentCalls(1));
    fireEvent.click(screen.getByTestId('session-details-toggle'));
    const row = await screen.findByTestId('session-details-agent');
    expect(row.querySelector('[data-testid="endpoint-icon-nomi"]')).toBeTruthy();
    expect(row.querySelector('[data-testid="endpoint-icon-claude"]')).toBeNull();
  });
});

describe('session details agent hover card placement', () => {
  it('places the hover card to the left of the panel, closes immediately when moving to the next row, and opens on click in dismissible mode', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1200 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });

    const origRect = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this.dataset?.testid === 'session-details') {
        return {
          left: 880,
          right: 1180,
          top: 52,
          bottom: 500,
          width: 300,
          height: 448,
          x: 880,
          y: 52,
          toJSON: () => ({}),
        } as DOMRect;
      }
      const li = this.closest?.('[data-testid="session-details-agent"]');
      if (li) {
        const list = Array.from(document.querySelectorAll('[data-testid="session-details-agent"]'));
        const idx = Math.max(0, list.indexOf(li));
        const top = 180 + idx * 52;
        return {
          left: 892,
          right: 1168,
          top,
          bottom: top + 44,
          width: 276,
          height: 44,
          x: 892,
          y: top,
          toJSON: () => ({}),
        } as DOMRect;
      }
      return origRect.call(this);
    });

    setup();
    const msgsWithChanges = [
      {
        ...subagentCalls(2)[0]!,
        trace: [
          ...subagentCalls(2)[0]!.trace!,
          {
            type: 'tool',
            name: 'Edit',
            status: 'done',
            id: 'e1',
            input: JSON.stringify({ file_path: '/w/app/a.ts', old_string: 'a', new_string: 'b' }),
          },
        ],
      },
    ] as unknown as ConvMessage[];
    mount('/w/app', msgsWithChanges);
    fireEvent.click(screen.getByTestId('session-details-toggle'));
    await screen.findByTestId('session-details');
    // 点开变更以触发自动收起，再用按钮以 dismissible 浮层打开
    fireEvent.click(screen.getByTestId('session-details-changes'));
    expect(screen.queryByTestId('session-details')).toBeNull();
    fireEvent.click(screen.getByTestId('session-details-toggle'));
    await screen.findByTestId('session-details');

    const rows = screen.getAllByTestId('session-details-agent');
    expect(rows).toHaveLength(2);
    const trigger0 = rows[0]!.firstElementChild as HTMLElement;
    const trigger1 = rows[1]!.firstElementChild as HTMLElement;

    fireEvent.pointerEnter(trigger0, { pointerType: 'mouse', buttons: 0 });
    const card0 = await screen.findByTestId('agent-hover-card', undefined, { timeout: 2000 });
    expect(card0.textContent).toContain('第 0 个');
    const left0 = parseFloat(card0.style.left);
    const width0 = parseFloat(card0.style.width);
    expect(left0 + width0).toBeLessThanOrEqual(880);
    expect(parseFloat(card0.style.top)).toBe(180);

    // 鼠标离开第 1 行并移入第 2 行：旧卡片立即收起，随后出现第 2 行的卡片
    fireEvent.pointerLeave(trigger0);
    fireEvent.pointerEnter(trigger1, { pointerType: 'mouse', buttons: 0 });
    expect(screen.queryByTestId('agent-hover-card')).toBeNull();
    const card1 = await screen.findByTestId('agent-hover-card', undefined, { timeout: 2000 });
    expect(card1.textContent).toContain('第 1 个');
    expect(parseFloat(card1.style.top)).toBe(232);

    // 在 dismissible 浮层模式下点击卡片：不被外部 pointerdown 误关闭，正常打开子任务面板
    fireEvent.pointerDown(card1);
    fireEvent.click(card1);
    await waitFor(() => expect(screen.getByTestId('probe-target').textContent).toBe('nested:s1'));
  });
});
