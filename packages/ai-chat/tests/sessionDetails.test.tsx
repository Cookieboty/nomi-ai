// @vitest-environment happy-dom
/**
 * 「会话详情」：标题栏按钮开 / 收对话卡片右侧的一栏：项目、本会话变更、用到的智能体与任务；
 * 列表最多 5 个可展开；屏幕窄且展开了别的栏时自动收起
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SessionDetailsDock, SessionDetailsToggle } from '../src/components/SessionDetails';
import { collectSessionAgents, countRunning } from '../src/components/SessionDetails/agents';
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
let small = false;

beforeEach(() => {
  tasks = [];
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
    return true;
  });
  installFakeApi(invoke);
  return invoke;
}

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

  it('stays open while opening the sub-task pane and the diff; outside clicks do not close it', async () => {
    setup();
    mount();
    fireEvent.click(screen.getByTestId('session-details-toggle'));
    await waitFor(() => expect(screen.getAllByTestId('session-details-agent')).toHaveLength(2));
    fireEvent.click(screen.getAllByTestId('session-details-agent')[0]!.querySelector('button')!);
    expect(screen.getByTestId('probe').textContent).toBe('d1|-');
    fireEvent.click(screen.getByTestId('session-details-changes'));
    expect(screen.getByTestId('probe').textContent).toBe('d1|wb');
    fireEvent.mouseDown(document.body);
    expect(screen.getByTestId('session-details')).toBeTruthy();
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
      task('d1', {
        origin: { conversationId: 'n1', createdBy: 'nomi', createdAt: 0, via: 'delegate' },
      }),
    ];
    setup();
    mount();
    fireEvent.click(screen.getByTestId('session-details-toggle'));
    await waitFor(() => expect(screen.getAllByTestId('session-details-task')).toHaveLength(5));
    // 进行中的排最前
    expect(screen.getAllByTestId('session-details-task')[0]!.textContent).toContain('任务 t9');
    expect(screen.getByTestId('session-details-tasks-count').textContent).toMatch(/7.*1/);
    const more = screen.getByTestId('session-details-tasks-more');
    expect(more.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(more);
    expect(screen.getAllByTestId('session-details-task')).toHaveLength(7);
    expect(screen.queryByText('任务 x1')).toBeNull();
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

  it('caps agents at five too; no tasks shows the empty line', async () => {
    setup();
    mount('/w/app', subagentCalls(8));
    fireEvent.click(screen.getByTestId('session-details-toggle'));
    await screen.findByTestId('session-details');
    expect(screen.getAllByTestId('session-details-agent')).toHaveLength(5);
    fireEvent.click(screen.getByTestId('session-details-agents-more'));
    expect(screen.getAllByTestId('session-details-agent')).toHaveLength(8);
    expect(screen.getByTestId('session-details-tasks').textContent).toMatch(/\S/);
    expect(screen.queryByTestId('session-details-tasks-more')).toBeNull();
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
    expect(screen.queryByTestId('session-details')).toBeNull();
  });

  it('opening the sub-task pane hides it on a narrow window and closing brings it back', async () => {
    small = true;
    localStorage.setItem('nomi.sessionDetails.open', '1');
    setup();
    mount();
    expect(await screen.findByTestId('session-details')).toBeTruthy();
    fireEvent.click(screen.getByTestId('probe-open-pane'));
    expect(screen.queryByTestId('session-details')).toBeNull();
    fireEvent.click(screen.getByTestId('probe-close-pane'));
    expect(screen.getByTestId('session-details')).toBeTruthy();
  });

  it('wide windows keep it open next to the files panel', async () => {
    localStorage.setItem('nomi.sessionDetails.open', '1');
    setup();
    mount('/w/app', messages, true);
    expect(await screen.findByTestId('session-details')).toBeTruthy();
  });
});
