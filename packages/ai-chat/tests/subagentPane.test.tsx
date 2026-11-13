// @vitest-environment happy-dom
import { t } from '@nomi-ai/ui';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React, { useEffect, useRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  SubagentPane,
  useSubagentPane,
  WorkspacePanesProvider,
} from '../src/components/SubagentPane';
import { nestedMessages, nomiTaskMessages } from '../src/components/SubagentPane/project';
import { HarnessTabsProvider } from '../src/contexts/HarnessTabsContext';
import type { DelegateResult } from '../src/services/delegateClient';
import { CHANGED_FILES_SHOWN, delegateResultMessage } from '../src/services/delegateMessage';
import type { HarnessTabMeta, HarnessTabsState } from '../src/services/harnessClient';
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

const tab = (over: Partial<HarnessTabMeta> = {}): HarnessTabMeta => ({
  id: 'd1',
  title: 'Nomi · 修复登录',
  backend: 'claude',
  cwd: '/w',
  cliSessionId: 's1',
  status: 'idle',
  unread: 0,
  createdAt: 0,
  updatedAt: 0,
  delegation: { by: 'nomi', goal: '修复登录 bug', taskId: 't1' },
  ...over,
});

function setup(meta: HarnessTabMeta) {
  const state: HarnessTabsState = { tabs: [meta], activeTabId: 'main', running: 0, queued: 0 };
  const invoke = vi.fn(async (ch: string) => {
    if (ch === 'harness.tabs') return state;
    if (ch === 'harness.tabMessages')
      return [{ id: 'm1', role: 'assistant', content: '修好了', timestamp: 1 }];
    if (ch === 'harness.tabSend') return { text: 'ok', sessionId: null };
    if (ch === 'harness.tabCancel') return true;
    if (ch === 'harness.modelCatalog')
      return {
        backend: 'claude',
        defaultModel: null,
        models: [{ id: 'sonnet', label: 'Sonnet 5.5', reasoning: false, efforts: [] }],
      };
    if (ch === 'shortcuts.list' || ch === 'ai.userQuestion.pending') return [];
    return true;
  });
  installFakeApi(invoke);
  return { invoke, state };
}

const Opener: React.FC = () => {
  const open = useSubagentPane()?.openSubagent;
  const once = useRef(false);
  useEffect(() => {
    if (once.current || !open) return;
    once.current = true;
    open('d1');
  }, [open]);
  return null;
};

const mount = () =>
  render(
    <HarnessTabsProvider>
      <WorkspacePanesProvider>
        <Opener />
        <SubagentPane columnMessages={[]} />
      </WorkspacePanesProvider>
    </HarnessTabsProvider>,
  );

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  resetFakeApi();
});

describe('SubagentPane', () => {
  it('keeps the delegated tab beside the parent chat and shows its transcript', async () => {
    const { invoke, state } = setup(tab());
    mount();
    const pane = await screen.findByTestId('subagent-pane');
    await waitFor(() => expect(pane.textContent).toContain('修好了'));
    expect(pane.textContent).toContain('修复登录 bug');
    // 主列的当前标签不动
    expect(state.activeTabId).toBe('main');
    expect(invoke.mock.calls.some(([ch]) => ch === 'harness.tabActivate')).toBe(false);
    expect(screen.getByTestId('chat-input')).toBeTruthy();
    expect(screen.queryByTestId('subagent-stop')).toBeNull();
  });

  it('uses the main composer and Esc outside it closes the pane', async () => {
    setup(tab());
    mount();
    await screen.findByTestId('subagent-pane');
    expect(screen.getByTestId('chat-input')).toBeTruthy();
    expect(screen.getByTestId('send-button')).toBeTruthy();
    expect(screen.getByTestId('composer-bar')).toBeTruthy();
    fireEvent.keyDown(screen.getByTestId('chat-input'), { key: 'Escape' });
    expect(screen.getByTestId('subagent-pane')).toBeTruthy();
    act(() => {
      fireEvent.keyDown(window, { key: 'Escape' });
    });
    await waitFor(() => expect(screen.queryByTestId('subagent-pane')).toBeNull());
  });

  it('stop interrupts that tab, not the parent', async () => {
    const { invoke } = setup(tab({ status: 'running' }));
    mount();
    await screen.findByTestId('subagent-pane');
    fireEvent.click(screen.getByTestId('subagent-stop'));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('harness.tabCancel', { id: 'd1' }));
  });
});

describe('nested and nomi-task projections', () => {
  it('lifts a subagent call and its child steps into a conversation', () => {
    const messages: ConvMessage[] = [
      {
        id: 'a',
        role: 'assistant',
        text: '',
        at: 1,
        trace: [
          {
            type: 'tool',
            name: 'Task',
            status: 'done',
            id: 'c1',
            input: JSON.stringify({ prompt: '查调用方' }),
            output: '找到了',
          },
          {
            type: 'tool',
            name: 'Read',
            status: 'done',
            id: 'c2',
            parentId: 'c1',
            output: 'auth.ts',
          },
        ],
      },
    ];
    const conv = nestedMessages(messages, 'c1');
    expect(conv[0]?.text).toBe('查调用方');
    expect(conv[1]?.text).toBe('找到了');
    expect(conv[1]?.trace?.some((e) => e.type === 'tool' && e.name === 'Read')).toBe(true);
  });

  it('turns a Nomi task trace into a goal plus tool steps', () => {
    const conv = nomiTaskMessages('画五张', [
      { at: 2, tool: 'image_generate', output: 'ok' },
      { at: 3, done: '画好了' },
    ]);
    expect(conv[0]?.text).toBe('画五张');
    expect(conv[1]?.text).toBe('画好了');
    expect(conv[1]?.trace?.[0]).toMatchObject({ name: 'image_generate', status: 'done' });
  });
});

describe('delegateResultMessage', () => {
  const base: DelegateResult = {
    taskId: 't1',
    cli: 'codex',
    status: 'done',
    summary: '全部修好',
    filesVerified: true,
    approvals: { asked: 0, denied: 0, timedOut: 0 },
    durationMs: 42,
  };
  it('keeps the first report id; follow-ups get their own id so each one lands in the chat', () => {
    expect(delegateResultMessage(base).id).toBe('delegate-t1-42');
    const a = delegateResultMessage({ ...base, followUp: true }, 1000);
    const b = delegateResultMessage({ ...base, followUp: true }, 2000);
    expect(a.id).not.toBe(b.id);
    expect(a.id.startsWith('delegate-t1-')).toBe(true);
    expect(a.origin).toBe('background');
  });

  it('lists the changed files so the chat and the next Nomi turn see them', () => {
    const m = delegateResultMessage({ ...base, changedFiles: ['src/a.ts', 'src/b.ts'] });
    expect(m.content).toContain('`src/a.ts`');
    expect(m.content).toContain('`src/b.ts`');
    const r = delegateResultMessage({
      ...base,
      changedFiles: ['x.ts'],
      report: { done: '改好了', changedFiles: ['y.ts'] },
    });
    expect(r.content).toContain('`y.ts`');
    expect(r.content).not.toContain('`x.ts`');
    expect(
      delegateResultMessage({ ...base, status: 'error', error: 'boom', changedFiles: ['z.ts'] })
        .content,
    ).toContain('`z.ts`');
    const many = Array.from({ length: CHANGED_FILES_SHOWN + 3 }, (_, i) => `f${i}.ts`);
    const big = delegateResultMessage({ ...base, changedFiles: many }).content;
    expect(big).toContain('`f0.ts`');
    expect(big).not.toContain(`\`f${CHANGED_FILES_SHOWN}.ts\``);
    expect(big).toMatch(/3/);
    expect(delegateResultMessage(base).content).not.toContain('- `');
  });

  it('shows images a Nomi task generated, even with no written report', () => {
    const m = delegateResultMessage({
      ...base,
      cli: 'nomi',
      summary: '',
      images: ['chat-asset://images/gen-1.png', 'https://evil.example/x.png'],
    });
    expect(m.content).toContain('](chat-asset://images/gen-1.png)');
    expect(m.content).not.toContain('evil.example');
    expect(m.content).not.toContain(t('ui.session-workspace.no-report'));
  });
});
