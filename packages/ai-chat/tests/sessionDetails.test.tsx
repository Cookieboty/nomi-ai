// @vitest-environment happy-dom
/** 标题栏「会话详情」浮层：项目、本会话变更、用到的智能体与状态；子任务点开进子任务面板 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SessionDetailsToggle } from '../src/components/SessionDetails';
import { collectSessionAgents, countRunning } from '../src/components/SessionDetails/agents';
import { useChangesUi } from '../src/components/SessionWorkspace';
import { useSubagentPane, WorkspacePanesProvider } from '../src/components/SubagentPane';
import { HarnessTabsProvider } from '../src/contexts/HarnessTabsContext';
import type { HarnessTabMeta, HarnessTabsState } from '../src/services/harnessClient';
import type { ConvMessage } from '../src/types/conversation';

import { installFakeApi, resetFakeApi } from './helpers/fakeApi';

vi.mock('../src/services/api', async () => (await import('./helpers/fakeApi')).fakeApiModule());

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
    return true;
  });
  installFakeApi(invoke);
  return invoke;
}

const Probe: React.FC = () => {
  const pane = useSubagentPane();
  const { workbench } = useChangesUi();
  return (
    <span data-testid="probe">
      {pane?.tabId ?? '-'}|{workbench ? 'wb' : '-'}
    </span>
  );
};

const mount = (cwd: string | null = '/w/app') =>
  render(
    <HarnessTabsProvider>
      <WorkspacePanesProvider>
        <SessionDetailsToggle messages={messages} cwd={cwd} />
        <Probe />
      </WorkspacePanesProvider>
    </HarnessTabsProvider>,
  );

afterEach(() => {
  cleanup();
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
  it('toggles a panel with the project, changes and agents', async () => {
    setup();
    mount();
    const btn = screen.getByTestId('session-details-toggle');
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(btn);
    const panel = await screen.findByTestId('session-details');
    expect(btn.getAttribute('aria-expanded')).toBe('true');
    expect(panel.textContent).toContain('app');
    await waitFor(() =>
      expect(screen.getByTestId('session-details-branch').textContent).toBe('release/2.3.3'),
    );
    expect(screen.getByTestId('session-details-changes').textContent).toMatch(/\+2.*-1/);
    await waitFor(() => expect(screen.getAllByTestId('session-details-agent')).toHaveLength(2));
    expect(screen.getByTestId('session-details-agent-count').textContent).toMatch(/2.*1/);
    // 再点一次收起
    fireEvent.click(btn);
    expect(screen.queryByTestId('session-details')).toBeNull();
  });

  it('opens the sub-task pane from an agent row and the diff from the changes row', async () => {
    setup();
    mount();
    fireEvent.click(screen.getByTestId('session-details-toggle'));
    await waitFor(() => expect(screen.getAllByTestId('session-details-agent')).toHaveLength(2));
    fireEvent.click(screen.getAllByTestId('session-details-agent')[0]!.querySelector('button')!);
    expect(screen.getByTestId('probe').textContent).toBe('d1|-');
    expect(screen.queryByTestId('session-details')).toBeNull();
    fireEvent.click(screen.getByTestId('session-details-toggle'));
    fireEvent.click(await screen.findByTestId('session-details-changes'));
    expect(screen.getByTestId('probe').textContent).toBe('d1|wb');
  });

  it('closes on Escape and outside clicks; no workspace hides the changes row', async () => {
    setup();
    mount(null);
    fireEvent.click(screen.getByTestId('session-details-toggle'));
    const panel = await screen.findByTestId('session-details');
    expect(screen.queryByTestId('session-details-changes')).toBeNull();
    fireEvent.keyDown(panel, { key: 'Escape' });
    expect(screen.queryByTestId('session-details')).toBeNull();
    fireEvent.click(screen.getByTestId('session-details-toggle'));
    await screen.findByTestId('session-details');
    fireEvent.mouseDown(document.body);
    expect(screen.queryByTestId('session-details')).toBeNull();
  });
});
