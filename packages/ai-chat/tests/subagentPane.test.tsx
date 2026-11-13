// @vitest-environment happy-dom
import { t } from '@nomi-ai/ui';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React, { useEffect, useRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ChatBody } from '../src/app/ChatBody';
import {
  SubagentReturnBar,
  useSubagentPane,
  WorkspacePanesProvider,
} from '../src/components/SubagentPane';
import type { AiChatState } from '../src/contexts/AiChatContext';
import { useHarnessTabs, HarnessTabsProvider } from '../src/contexts/HarnessTabsContext';
import type { DelegateResult } from '../src/services/delegateClient';
import { CHANGED_FILES_SHOWN, delegateResultMessage } from '../src/services/delegateMessage';
import type { HarnessTabMeta, HarnessTabsState } from '../src/services/harnessClient';
import type { SlashHook } from '../src/slash/useSlashCommands';
import { fromHarnessMessage } from '../src/utils/convAdapters';

import { installFakeApi, resetFakeApi } from './helpers/fakeApi';

vi.mock('../src/services/api', async () => (await import('./helpers/fakeApi')).fakeApiModule());

vi.mock('../src/contexts/aiChatStore', async (original) => {
  const actual = await original();
  const state = {
    messages: [],
    isLoading: false,
    busyConvos: [],
    viewConvoId: undefined,
  } as unknown as AiChatState;
  return {
    ...actual,
    useAiChatSelector: (selector: (s: AiChatState) => unknown) => selector(state),
    useAiChatActions: () => ({
      actions: { resendFrom: vi.fn(), sendMessage: vi.fn() },
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

const slash = { cards: [], dismissCard: () => undefined } as unknown as SlashHook;

function setup(meta: HarnessTabMeta | HarnessTabMeta[]) {
  const tabs = Array.isArray(meta) ? meta : [meta];
  const state: HarnessTabsState = { tabs, activeTabId: 'main', running: 0, queued: 0 };
  const invoke = vi.fn(async (ch: string, input?: { id?: string }) => {
    if (ch === 'harness.tabs') return state;
    if (ch === 'harness.tabMessages')
      return input?.id === 'd1'
        ? [{ id: 'm1', role: 'assistant', content: '修好了', timestamp: 1 }]
        : [];
    if (ch === 'harness.modelCatalog')
      return {
        backend: 'claude',
        defaultModel: null,
        models: [{ id: 'sonnet', label: 'Sonnet 5.5', reasoning: false, efforts: [] }],
      };
    return true;
  });
  const fake = installFakeApi(invoke);
  return { invoke, fake, state };
}

/** 主对话列：返回条 + 和编程助手标签同一套 ChatBody */
const Host: React.FC = () => {
  const tabs = useHarnessTabs();
  const backend = tabs.activeTab?.backend ?? 'claude';
  const cliMessages = tabs.isCliTab ? tabs.messages.map((m) => fromHarnessMessage(m, backend)) : [];
  return (
    <>
      <SubagentReturnBar />
      <ChatBody
        tabs={tabs}
        isDev
        sessionKey={tabs.isCliTab && tabs.activeTab ? `tab:${tabs.activeTab.id}` : 'nomi:parent'}
        cliMessages={cliMessages}
        nomiMessages={[]}
        slash={slash}
        onOpenModels={() => undefined}
      />
      <textarea data-testid="composer-stand-in" defaultValue="" />
    </>
  );
};

/** 挂上主列并打开 d1 */
const Opener: React.FC<{ id?: string }> = ({ id = 'd1' }) => {
  const open = useSubagentPane()?.openSubagent;
  const once = useRef(false);
  useEffect(() => {
    if (once.current || !open) return;
    once.current = true;
    open(id);
  }, [open, id]);
  return null;
};

const mount = () =>
  render(
    <HarnessTabsProvider>
      <WorkspacePanesProvider>
        <Opener />
        <Host />
      </WorkspacePanesProvider>
    </HarnessTabsProvider>,
  );

/** 测试里手动打开两个子任务，记下返回目标 */
const Switcher: React.FC = () => {
  const pane = useSubagentPane();
  return (
    <>
      <button type="button" data-testid="open-a" onClick={() => pane?.openSubagent('d1')} />
      <button type="button" data-testid="open-b" onClick={() => pane?.openSubagent('d2')} />
    </>
  );
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  resetFakeApi();
});

describe('SubagentReturnBar', () => {
  it('opens the sub-task as the main conversation and returns to the parent', async () => {
    const { invoke } = setup(tab());
    mount();
    const bar = await screen.findByTestId('subagent-return');
    await waitFor(() => expect(bar.textContent).toContain('修复登录 bug'));
    await waitFor(() => expect(screen.getByTestId('conv-scroll').textContent).toContain('修好了'));
    expect(screen.getByTestId('subagent-status').getAttribute('data-state')).toBe('idle');
    expect(screen.queryByTestId('subagent-stop')).toBeNull();
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('harness.tabActivate', { id: 'd1' }));
    fireEvent.click(screen.getByTestId('subagent-back'));
    await waitFor(() => expect(screen.queryByTestId('subagent-return')).toBeNull());
    expect(invoke).toHaveBeenCalledWith('harness.tabActivate', { id: 'main' });
  });

  it('while running: stop interrupts the active tab; Esc outside the composer returns', async () => {
    const { invoke } = setup(tab({ status: 'running' }));
    mount();
    await screen.findByTestId('subagent-return');
    expect(screen.getByTestId('subagent-status').getAttribute('data-state')).toBe('running');
    fireEvent.click(screen.getByTestId('subagent-stop'));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('harness.tabCancel', { id: 'd1' }));
    fireEvent.keyDown(screen.getByTestId('composer-stand-in'), { key: 'Escape' });
    expect(screen.getByTestId('subagent-return')).toBeTruthy();
    act(() => {
      fireEvent.keyDown(window, { key: 'Escape' });
    });
    await waitFor(() => expect(screen.queryByTestId('subagent-return')).toBeNull());
  });

  it('opening another sub-task keeps the original parent as the way back', async () => {
    const other = tab({
      id: 'd2',
      delegation: { by: 'nomi', goal: '补测试', taskId: 't2' },
    });
    const { invoke } = setup([tab(), other]);
    const Probe: React.FC = () => {
      const pane = useSubagentPane();
      return <span data-testid="return-to">{pane?.returnTo ?? '-'}</span>;
    };
    render(
      <HarnessTabsProvider>
        <WorkspacePanesProvider>
          <Probe />
          <Switcher />
          <SubagentReturnBar />
        </WorkspacePanesProvider>
      </HarnessTabsProvider>,
    );
    fireEvent.click(screen.getByTestId('open-a'));
    await screen.findByTestId('subagent-return');
    expect(screen.getByTestId('return-to').textContent).toBe('main');
    fireEvent.click(screen.getByTestId('open-b'));
    await waitFor(() =>
      expect(screen.getByTestId('subagent-return').textContent).toContain('补测试'),
    );
    expect(screen.getByTestId('return-to').textContent).toBe('main');
    fireEvent.click(screen.getByTestId('subagent-back'));
    await waitFor(() => {
      const ids = invoke.mock.calls
        .filter(([ch]) => ch === 'harness.tabActivate')
        .map(([, input]) => (input as { id: string }).id);
      expect(ids).toContain('d1');
      expect(ids).toContain('d2');
      expect(ids[ids.length - 1]).toBe('main');
    });
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
