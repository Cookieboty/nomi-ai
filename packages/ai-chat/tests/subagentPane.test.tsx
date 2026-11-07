// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React, { useEffect, useRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  SubagentPane,
  useSubagentPane,
  WorkspacePanesProvider,
} from '../src/components/SubagentPane';
import { HarnessTabsProvider } from '../src/contexts/HarnessTabsContext';
import type { DelegateResult } from '../src/services/delegateClient';
import { delegateResultMessage } from '../src/services/delegateMessage';
import type { HarnessTabMeta, HarnessTabsState } from '../src/services/harnessClient';

import { installFakeApi, resetFakeApi } from './helpers/fakeApi';

vi.mock('../src/services/api', async () => (await import('./helpers/fakeApi')).fakeApiModule());

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

function setup(meta: HarnessTabMeta, steerOk = true) {
  const state: HarnessTabsState = { tabs: [meta], activeTabId: 'main', running: 0, queued: 0 };
  const invoke = vi.fn(async (ch: string) => {
    if (ch === 'harness.tabs') return state;
    if (ch === 'harness.tabMessages')
      return [{ id: 'm1', role: 'assistant', content: '修好了', timestamp: 1 }];
    if (ch === 'harness.tabSteer') return steerOk;
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

/** 挂上面板并打开 d1 */
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
        <SubagentPane />
      </WorkspacePanesProvider>
    </HarnessTabsProvider>,
  );

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  resetFakeApi();
});

describe('SubagentPane', () => {
  it('opens beside the chat with the sub-task conversation; idle send continues the sub-task', async () => {
    const { invoke } = setup(tab());
    mount();
    await screen.findByTestId('subagent-pane');
    await waitFor(() =>
      expect(screen.getByTestId('subagent-pane').textContent).toContain('修好了'),
    );
    // 子任务的模型 / 思考深度：输入栏里与编程助手标签同一个按钮
    expect(
      screen.getByTestId('subagent-pane').querySelector('[data-testid="model-chip"]'),
    ).toBeTruthy();
    fireEvent.change(screen.getByTestId('subagent-input'), { target: { value: '再加个测试' } });
    fireEvent.keyDown(screen.getByTestId('subagent-input'), { key: 'Enter' });
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('harness.tabSend', {
        id: 'd1',
        prompt: '再加个测试',
        images: undefined,
      }),
    );
    expect(screen.queryByTestId('subagent-stop')).toBeNull();
  });

  it('while running: sending interjects; stop interrupts; Esc closes', async () => {
    const { invoke } = setup(tab({ status: 'running' }));
    mount();
    await screen.findByTestId('subagent-pane');
    fireEvent.change(screen.getByTestId('subagent-input'), { target: { value: '先别动配置' } });
    fireEvent.click(screen.getByTestId('subagent-send'));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('harness.tabSteer', { id: 'd1', text: '先别动配置' }),
    );
    expect(invoke.mock.calls.some(([ch]) => ch === 'harness.tabSend')).toBe(false);
    fireEvent.click(screen.getByTestId('subagent-stop'));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('harness.tabCancel', { id: 'd1' }));
    act(() => {
      fireEvent.keyDown(window, { key: 'Escape' });
    });
    await waitFor(() => expect(screen.queryByTestId('subagent-pane')).toBeNull());
  });

  it('when the agent cannot interject, the message is queued for after this turn', async () => {
    setup(tab({ status: 'running' }), false);
    mount();
    await screen.findByTestId('subagent-pane');
    fireEvent.change(screen.getByTestId('subagent-input'), { target: { value: '顺便更新文档' } });
    fireEvent.click(screen.getByTestId('subagent-send'));
    await screen.findByTestId('conv-queued');
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
});
