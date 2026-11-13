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

describe('in-process subagent in the side panel', () => {
  it('sends through the source tab, addressed to that subagent', async () => {
    const state: HarnessTabsState = {
      tabs: [parentTab()],
      activeTabId: 'main',
      running: 0,
      queued: 0,
    };
    const fake = installFakeApi((name) => {
      if (name === 'harness.tabs') return state;
      if (name === 'harness.tabMessages')
        return [
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
                output: '查完了',
              },
              { type: 'agent-text', text: '我在查 auth.ts', parentId: 'c1' },
            ],
          },
        ];
      if (name === 'harness.tabSend') return { text: 'ok', sessionId: null };
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
    const pane = await screen.findByTestId('subagent-pane');
    await waitFor(() => expect(pane.textContent).toContain('我在查 auth.ts'));
    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: '也看看 session.ts' } });
    fireEvent.click(screen.getByTestId('send-button'));
    await waitFor(() => expect(fake.inputs('harness.tabSend').length).toBe(1));
    const sent = fake.inputs('harness.tabSend')[0] as { id: string; prompt: string };
    expect(sent.id).toBe('p1');
    expect(sent.prompt).toContain('也看看 session.ts');
    expect(sent.prompt).toContain('c1');
  });

  it('addresses the message to that subagent', () => {
    const text = nestedEnvelope('worker', 'th1', 'hi');
    expect(text).toContain('th1');
    expect(text).toContain('hi');
  });
});
