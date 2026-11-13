// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React, { useEffect, useRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  nestedEnvelope,
  SubagentPane,
  useSubagentPane,
  WorkspacePanesProvider,
} from '../src/components/SubagentPane';
import {
  agentIdsOfCall,
  applyTaskLiveEvent,
  liveFromView,
  nestedMessages,
  nomiTaskMessages,
} from '../src/components/SubagentPane/project';
import { HarnessTabsProvider } from '../src/contexts/HarnessTabsContext';
import type { HarnessTabMeta, HarnessTabsState } from '../src/services/harnessClient';
import type { TaskTraceView } from '../src/services/tasksClient';
import type { ConvMessage } from '../src/types/conversation';

import { installFakeApi, resetFakeApi } from './helpers/fakeApi';

vi.mock('../src/services/api', async () => (await import('./helpers/fakeApi')).fakeApiModule());

vi.mock('../src/contexts/aiChatStore', async (original) => {
  const actual = await original();
  const state = {
    messages: [],
    isLoading: false,
    busyConvos: [],
    streamingConvos: [],
    viewConvoId: undefined,
  };
  return {
    ...(actual as object),
    useAiChatSelector: (selector: (s: typeof state) => unknown) => selector(state),
    useAiChatActions: () => ({
      actions: {
        resendFrom: vi.fn(),
        sendMessage: vi.fn(),
        sendStreamMessage: vi.fn(),
        stopGeneration: vi.fn(),
        askKnowledge: vi.fn(),
      },
      store: { get: () => state },
      dispatch: vi.fn(),
    }),
  };
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  resetFakeApi();
});

const task = (status: string) => ({
  task: { id: 't9', title: '整理周报', goal: '把周报整理成表格', status },
  attempts: [],
});

const trace = (over: Partial<TaskTraceView> = {}): TaskTraceView => ({
  attemptId: 'a1',
  lines: [],
  attempts: [
    {
      attemptId: 'a1',
      cause: 'manual',
      status: 'succeeded',
      startedAt: 1,
      endedAt: 5,
      lines: [
        { at: 2, tool: 'fs_read_text', id: 'c1', output: 'ok', textAt: 0 },
        { at: 3, done: '整理好了' },
      ],
    },
  ],
  live: null,
  ...over,
});

const OpenTask: React.FC = () => {
  const pane = useSubagentPane();
  const once = useRef(false);
  useEffect(() => {
    if (once.current || !pane) return;
    once.current = true;
    pane.openNomiTask('t9');
  }, [pane]);
  return null;
};

const mountTask = (actions?: Parameters<typeof SubagentPane>[0]['actions']) =>
  render(
    <HarnessTabsProvider>
      <WorkspacePanesProvider>
        <OpenTask />
        <SubagentPane columnMessages={[]} actions={actions} />
      </WorkspacePanesProvider>
    </HarnessTabsProvider>,
  );

function setupTask(status: string, view: TaskTraceView, extra: Record<string, unknown> = {}) {
  const tabs: HarnessTabsState = { tabs: [], activeTabId: 'main', running: 0, queued: 0 };
  return installFakeApi((name) => {
    if (name === 'harness.tabs') return tabs;
    if (name === 'tasks.get') return task(status);
    if (name === 'tasks.trace') return view;
    if (name in extra) return extra[name];
    if (name === 'shortcuts.list' || name === 'ai.userQuestion.pending') return [];
    return true;
  });
}

describe('background Nomi in the side panel', () => {
  it('sends a follow-up when idle, through the same composer', async () => {
    const fake = setupTask('done', trace(), { 'tasks.followUp': { ok: true } });
    mountTask();
    const pane = await screen.findByTestId('subagent-pane');
    await waitFor(() => expect(pane.textContent).toContain('整理好了'));
    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: '再加一列合计' } });
    fireEvent.click(screen.getByTestId('send-button'));
    await waitFor(() =>
      expect(fake.inputs('tasks.followUp')).toContainEqual({ id: 't9', text: '再加一列合计' }),
    );
  });

  it('streams the running attempt from tasks.live and steers with Enter', async () => {
    const fake = setupTask(
      'running',
      trace({
        live: { attemptId: 'a2', text: '正在', tools: [] },
        attempts: [
          ...trace().attempts!,
          {
            attemptId: 'a2',
            cause: 'followup',
            note: '再加一列',
            status: 'running',
            startedAt: 6,
            lines: [],
          },
        ],
      }),
      { 'tasks.steer': true },
    );
    mountTask();
    const pane = await screen.findByTestId('subagent-pane');
    await waitFor(() => expect(pane.textContent).toContain('正在'));
    expect(pane.textContent).toContain('再加一列');
    await fake.emit('tasks.live', {
      id: 't9',
      attemptId: 'a2',
      event: { type: 'delta', text: '写表格' },
    });
    await waitFor(() => expect(pane.textContent).toContain('正在写表格'));
    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: '用中文表头' } });
    fireEvent.keyDown(screen.getByTestId('chat-input'), { key: 'Enter' });
    await waitFor(() =>
      expect(fake.inputs('tasks.steer')).toContainEqual({ id: 't9', text: '用中文表头' }),
    );
  });

  it('opens the main window panels from the side panel buttons', async () => {
    setupTask('done', trace());
    const openSettings = vi.fn();
    const openDesktop = vi.fn();
    mountTask({ openSettings, openDesktop });
    await screen.findByTestId('subagent-pane');
    // 输入栏自带的界面命令（/settings、/desktop）打开的是主窗口的面板
    const input = screen.getByTestId('chat-input');
    fireEvent.change(input, { target: { value: '/settings' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(openSettings).toHaveBeenCalled());
    fireEvent.change(input, { target: { value: '/desktop' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(openDesktop).toHaveBeenCalled());
  });
});

describe('live projections', () => {
  it('folds tasks.live events into the running attempt', () => {
    let live = liveFromView(trace({ live: { attemptId: 'a2', text: 'a', tools: [] } }));
    live = applyTaskLiveEvent(live, 'a2', { type: 'delta', text: 'b' });
    live = applyTaskLiveEvent(live, 'a2', {
      type: 'tool',
      status: 'start',
      id: 'x',
      name: 'fs_edit',
      textAt: 2,
    });
    live = applyTaskLiveEvent(live, 'a2', { type: 'interject', text: '顺便', textAt: 2 });
    expect(live?.text).toBe('ab');
    expect(live?.trace.map((e) => e.type)).toEqual(['tool', 'interject']);
    expect(applyTaskLiveEvent(live, 'a2', { type: 'done' })).toBeNull();
  });

  it('shows follow-ups as user turns and skips the running attempt', () => {
    const conv = nomiTaskMessages(
      '目标',
      trace({
        attempts: [
          ...trace().attempts!,
          {
            attemptId: 'a2',
            cause: 'followup',
            note: '再改改',
            status: 'running',
            startedAt: 6,
            lines: [],
          },
        ],
      }),
      'a2',
    );
    expect(conv.map((m) => `${m.role}:${m.text}`)).toEqual([
      'user:目标',
      'assistant:整理好了',
      'user:再改改',
    ]);
  });

  it('uses the subagent own text and places its steps inside it', () => {
    const messages: ConvMessage[] = [
      {
        id: 'p',
        role: 'assistant',
        text: '主回复',
        at: 1,
        trace: [
          { type: 'tool', name: 'Task', status: 'start', id: 'c1', input: '{"prompt":"查一下"}' },
          { type: 'agent-text', text: '先读 README', parentId: 'c1' },
          { type: 'tool', name: 'Read', status: 'start', id: 'r1', parentId: 'c1', textAt: 99 },
          { type: 'agent-text', text: '看完了', parentId: 'c1' },
          { type: 'agent-text', text: '别的子代理', parentId: 'c2' },
        ],
      },
    ];
    const conv = nestedMessages(messages, 'c1');
    expect(conv[1]?.text).toBe('先读 README\n\n看完了');
    expect(conv[1]?.trace?.[0]).toMatchObject({ name: 'Read', textAt: '先读 README'.length });
  });
});

describe('direct conversation with a subagent', () => {
  const base: ConvMessage[] = [
    {
      id: 'm1',
      role: 'assistant',
      text: '',
      at: 1,
      trace: [
        {
          type: 'tool',
          name: 'spawn_agent',
          status: 'done',
          id: 'c1',
          input: '{"prompt":"查","agents":["th9"]}',
        },
        { type: 'agent-text', text: '先看了 README', parentId: 'th9' },
        { type: 'thinking', text: '主代理的思考' },
        { type: 'thinking', text: '子代理的思考', parentId: 'c1' },
        { type: 'agent-input', text: '再看看 docs', parentId: 'c1', at: 5 },
        { type: 'tool', name: 'Read', status: 'start', id: 'r2', parentId: 'c1', at: 6 },
        { type: 'agent-text', text: 'docs 也看完了', parentId: 'c1', at: 7 },
      ],
    },
  ];

  it('turns each direct message into its own round, keyed by call or agent id', () => {
    const conv = nestedMessages(base, 'c1', undefined, { agentIds: ['th9'] });
    expect(conv.map((m) => [m.role, m.text])).toEqual([
      ['user', '查'],
      ['assistant', '先看了 README'],
      ['user', '再看看 docs'],
      ['assistant', 'docs 也看完了'],
    ]);
    expect(conv[1]?.trace?.map((e) => e.type)).toEqual(['thinking']);
    expect(conv[3]?.trace?.[0]).toMatchObject({ name: 'Read' });
  });

  it('appends text still streaming in to the last round', () => {
    const conv = nestedMessages(base, 'c1', undefined, {
      agentIds: ['th9'],
      deltas: { i1: { parentId: 'c1', text: '还在写' }, i2: { parentId: 'other', text: 'x' } },
    });
    expect(conv[conv.length - 1]?.text).toBe('docs 也看完了\n\n还在写');
  });

  it('finds the subagent ids of a call', () => {
    expect(agentIdsOfCall(base, 'c1')).toEqual(['th9']);
    const claude: ConvMessage[] = [
      {
        id: 'm',
        role: 'assistant',
        text: '',
        at: 1,
        trace: [
          {
            type: 'tool',
            name: 'Task',
            status: 'done',
            id: 'c2',
            output: 'ok\nagentId: a77 (internal)',
          },
        ],
      },
    ];
    expect(agentIdsOfCall(claude, 'c2')).toEqual(['a77']);
  });
});

const parentTab = (over: Partial<HarnessTabMeta> = {}): HarnessTabMeta => ({
  id: 'p1',
  title: 'Claude',
  backend: 'claude',
  cwd: '/w',
  cliSessionId: 's1',
  status: 'idle',
  unread: 0,
  createdAt: 0,
  updatedAt: 0,
  ...over,
});

const OpenNested: React.FC = () => {
  const pane = useSubagentPane();
  const once = useRef(false);
  useEffect(() => {
    if (once.current || !pane) return;
    once.current = true;
    pane.openNested('c1', 'p1');
  }, [pane]);
  return null;
};

const parentMessages = () => [
  {
    id: 'm1',
    role: 'assistant',
    content: '派了一个子代理',
    timestamp: 1,
    trace: [
      {
        type: 'tool',
        name: 'Task',
        status: 'done',
        id: 'c1',
        input: '{"prompt":"查调用方"}',
        output: '查完了\nagentId: a1b2c3 (internal ID)',
      },
      { type: 'agent-text', text: '我在查 auth.ts', parentId: 'c1' },
    ],
  },
];

function renderNested(messageAgent: (input: unknown) => unknown, tabs = [parentTab()]) {
  const state: HarnessTabsState = { tabs, activeTabId: 'main', running: 0, queued: 0 };
  const fake = installFakeApi((name, input) => {
    if (name === 'harness.tabs') return state;
    if (name === 'harness.tabMessages')
      return (input as { id: string }).id === 'p1' ? parentMessages() : [];
    if (name === 'harness.tabSend') return { text: 'ok', sessionId: null };
    if (name === 'harness.messageAgent') return messageAgent(input);
    if (name === 'harness.modelCatalog')
      return { backend: 'claude', defaultModel: null, models: [] };
    if (name === 'shortcuts.list' || name === 'ai.userQuestion.pending') return [];
    return true;
  });
  render(
    <HarnessTabsProvider>
      <WorkspacePanesProvider>
        <OpenNested />
        <SubagentPane columnMessages={[]} />
      </WorkspacePanesProvider>
    </HarnessTabsProvider>,
  );
  return fake;
}

const typeAndSend = (text: string) => {
  fireEvent.change(screen.getByTestId('chat-input'), { target: { value: text } });
  fireEvent.click(screen.getByTestId('send-button'));
};

describe('in-process subagent in the side panel', () => {
  it('sends straight to the subagent itself, with its own id', async () => {
    const fake = renderNested(() => ({ ok: true, via: 'start' }));
    const pane = await screen.findByTestId('subagent-pane');
    await waitFor(() => expect(pane.textContent).toContain('我在查 auth.ts'));
    typeAndSend('也看看 session.ts');
    await waitFor(() => expect(fake.inputs('harness.messageAgent').length).toBe(1));
    expect(fake.inputs('harness.messageAgent')[0]).toMatchObject({
      id: 'p1',
      callId: 'c1',
      agentId: 'a1b2c3',
      text: '也看看 session.ts',
      mode: 'steer',
    });
    expect(fake.inputs('harness.tabSend')).toHaveLength(0);
  });

  it('falls back to the main agent when the CLI has no direct channel', async () => {
    const fake = renderNested(() => ({ ok: false, reason: 'unsupported' }));
    const pane = await screen.findByTestId('subagent-pane');
    await waitFor(() => expect(pane.textContent).toContain('我在查 auth.ts'));
    typeAndSend('也看看 session.ts');
    await waitFor(() => expect(fake.inputs('harness.tabSend').length).toBe(1));
    const sent = fake.inputs('harness.tabSend')[0] as { id: string; prompt: string };
    expect(sent.id).toBe('p1');
    expect(sent.prompt).toContain('也看看 session.ts');
    expect(sent.prompt).toContain('a1b2c3');
    expect(screen.getByTestId('subagent-notice')).toBeTruthy();
  });

  it('keeps the message queued while the subagent is still running', async () => {
    renderNested(() => ({ ok: false, reason: 'running' }));
    const pane = await screen.findByTestId('subagent-pane');
    await waitFor(() => expect(pane.textContent).toContain('我在查 auth.ts'));
    typeAndSend('跑完再看 session.ts');
    await waitFor(() => expect(screen.getByTestId('subagent-notice')).toBeTruthy());
    expect(pane.textContent).toContain('跑完再看 session.ts');
  });

  it('shows the linked session that continues the subagent', async () => {
    const fork = parentTab({
      id: 'f1',
      subagentOf: { tabId: 'p1', callId: 'c1', agentId: 'a1b2c3' },
    });
    const fake = renderNested(() => ({ ok: true }), [parentTab(), fork]);
    const pane = await screen.findByTestId('subagent-pane');
    await waitFor(() => expect(pane.textContent).toContain('我在查 auth.ts'));
    typeAndSend('接着改');
    await waitFor(() => expect(fake.inputs('harness.tabSend').length).toBe(1));
    expect((fake.inputs('harness.tabSend')[0] as { id: string }).id).toBe('f1');
    expect(fake.inputs('harness.messageAgent')).toHaveLength(0);
  });

  it('addresses the message to that subagent', () => {
    const text = nestedEnvelope('worker', 'th1', 'hi');
    expect(text).toContain('th1');
    expect(text).toContain('hi');
  });
});

const TaskPaneControls: React.FC = () => {
  const pane = useSubagentPane();
  return (
    <>
      <button data-testid="reopen-task" onClick={() => pane?.openNomiTask('t9')}>
        reopen
      </button>
      <button data-testid="switch-task" onClick={() => pane?.openNomiTask('t10')}>
        switch
      </button>
    </>
  );
};

function mutableTask(followUp: () => unknown = () => ({ ok: true })) {
  let status = 'running';
  const fake = installFakeApi((name) => {
    if (name === 'harness.tabs') return { tabs: [], activeTabId: 'main', running: 0, queued: 0 };
    if (name === 'tasks.get') return task(status);
    if (name === 'tasks.trace') return trace();
    if (name === 'tasks.followUp') return followUp();
    if (name === 'shortcuts.list' || name === 'ai.userQuestion.pending') return [];
    return true;
  });
  const rendered = render(
    <HarnessTabsProvider>
      <WorkspacePanesProvider>
        <OpenTask />
        <TaskPaneControls />
        <SubagentPane columnMessages={[]} />
      </WorkspacePanesProvider>
    </HarnessTabsProvider>,
  );
  return {
    ...fake,
    ...rendered,
    setStatus: (next: string) => {
      status = next;
    },
  };
}

const queueTaskMessage = async (text: string) => {
  await screen.findByTestId('subagent-stop');
  fireEvent.change(screen.getByTestId('chat-input'), { target: { value: text } });
  fireEvent.keyDown(screen.getByTestId('chat-input'), { key: 'Enter', ctrlKey: true });
  await waitFor(() => expect(screen.getByTestId('pending-dock').textContent).toContain(text));
};

describe('durable subagent delivery', () => {
  it('keeps pending messages when closing and reopening the pane', async () => {
    mutableTask();
    await queueTaskMessage('keep this queued');
    fireEvent.click(screen.getByTestId('subagent-close'));
    await waitFor(() => expect(screen.queryByTestId('subagent-pane')).toBeNull());
    fireEvent.click(screen.getByTestId('reopen-task'));
    await screen.findByTestId('subagent-pane');
    expect(screen.getByTestId('pending-dock').textContent).toContain('keep this queued');
  });

  it('delivers after completion even when the pane stays closed', async () => {
    const fake = mutableTask();
    await queueTaskMessage('deliver without the pane');
    fireEvent.click(screen.getByTestId('subagent-close'));
    fake.setStatus('done');
    await fake.emit('tasks.changed', {});
    await waitFor(() =>
      expect(fake.inputs('tasks.followUp')).toEqual([
        { id: 't9', text: 'deliver without the pane' },
      ]),
    );
    expect(screen.queryByTestId('subagent-pane')).toBeNull();
  });

  it('does not move queued messages to another task when switching panes', async () => {
    const fake = mutableTask();
    await queueTaskMessage('belongs to t9');
    fireEvent.click(screen.getByTestId('switch-task'));
    await waitFor(() => expect(screen.queryByTestId('pending-dock')).toBeNull());
    fake.setStatus('done');
    await fake.emit('tasks.changed', {});
    await waitFor(() =>
      expect(fake.inputs('tasks.followUp')).toEqual([{ id: 't9', text: 'belongs to t9' }]),
    );
  });

  it.each(['rejected', 'transport'])(
    'keeps a failed %s follow-up and retries only on request',
    async (failure) => {
      let allowed = false;
      const fake = mutableTask(() => {
        if (allowed) return { ok: true };
        if (failure === 'transport') throw new Error('connection lost');
        return { ok: false, reason: 'expired' };
      });
      fake.setStatus('done');
      await waitFor(() => expect(screen.getByTestId('subagent-status').dataset.state).toBe('idle'));
      fireEvent.change(screen.getByTestId('chat-input'), {
        target: { value: 'retry this message' },
      });
      fireEvent.click(screen.getByTestId('send-button'));
      await screen.findByTestId('subagent-send-error');
      expect(screen.getByTestId('pending-dock').textContent).toContain('retry this message');
      expect(fake.inputs('tasks.followUp')).toHaveLength(1);
      allowed = true;
      fireEvent.click(screen.getByTestId('subagent-send-retry'));
      await waitFor(() => expect(screen.queryByTestId('pending-dock')).toBeNull());
      expect(fake.inputs('tasks.followUp')).toEqual([
        { id: 't9', text: 'retry this message' },
        { id: 't9', text: 'retry this message' },
      ]);
    },
  );

  it('keeps automatic dequeue failures available instead of clearing the queue', async () => {
    const fake = mutableTask(() => ({ ok: false, reason: 'expired' }));
    await queueTaskMessage('do not drop a rejected queue');
    fake.setStatus('done');
    await fake.emit('tasks.changed', {});
    await screen.findByTestId('subagent-send-error');
    expect(screen.getByTestId('pending-dock').textContent).toContain(
      'do not drop a rejected queue',
    );
    expect(fake.inputs('tasks.followUp')).toHaveLength(1);
  });

  it('shows and answers approval requests from the resumed Claude child tab', async () => {
    const fork = parentTab({
      id: 'f1',
      status: 'running',
      subagentOf: { tabId: 'p1', callId: 'c1', agentId: 'a1b2c3' },
    });
    const fake = renderNested(() => ({ ok: true }), [parentTab(), fork]);
    await screen.findByTestId('subagent-pane');
    await fake.emit('harness.events', [
      { tabId: 'f1', type: 'permission', id: 'approve-child', summary: 'npm install' },
    ]);
    fireEvent.click(await screen.findByTestId('conv-permission-allow'));
    await waitFor(() =>
      expect(fake.inputs('harness.replyPermission')).toContainEqual({
        tabId: 'f1',
        requestId: 'approve-child',
        allow: true,
      }),
    );
  });

  it('shows sandbox requests from a resumed Claude child tab', async () => {
    const fork = parentTab({
      id: 'f1',
      status: 'idle',
      subagentOf: { tabId: 'p1', callId: 'c1', agentId: 'a1b2c3' },
      sandboxPending: [
        { id: 'sandbox-child', kind: 'category', value: 'ssh', path: '/home/.ssh', at: 1 },
      ],
    });
    renderNested(() => ({ ok: true }), [parentTab(), fork]);
    expect(await screen.findByTestId('conv-sandbox-card')).toBeTruthy();
    expect(screen.getByTestId('subagent-status').dataset.state).toBe('waiting');
  });
});
