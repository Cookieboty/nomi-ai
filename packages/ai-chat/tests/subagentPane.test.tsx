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
import { HarnessTabsProvider } from '../src/contexts/HarnessTabsContext';
import type { DelegateResult } from '../src/services/delegateClient';
import { CHANGED_FILES_SHOWN, delegateResultMessage } from '../src/services/delegateMessage';
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
    // 子任务的模型 / 思考深度：输入栏里与编程助手标签同一个按钮（模型列表异步取到后才渲染，CI 上可能晚于正文）
    await waitFor(() =>
      expect(
        screen.getByTestId('subagent-pane').querySelector('[data-testid="model-chip"]'),
      ).toBeTruthy(),
    );
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

  it('lists the changed files so the chat and the next Nomi turn see them', () => {
    // 持续任务的结果没有汇报，只有内核核对出的 changedFiles
    const m = delegateResultMessage({ ...base, changedFiles: ['src/a.ts', 'src/b.ts'] });
    expect(m.content).toContain('`src/a.ts`');
    expect(m.content).toContain('`src/b.ts`');
    // 有汇报时用汇报里的
    const r = delegateResultMessage({
      ...base,
      changedFiles: ['x.ts'],
      report: { done: '改好了', changedFiles: ['y.ts'] },
    });
    expect(r.content).toContain('`y.ts`');
    expect(r.content).not.toContain('`x.ts`');
    // 失败但已经改了的也列出来
    expect(
      delegateResultMessage({ ...base, status: 'error', error: 'boom', changedFiles: ['z.ts'] })
        .content,
    ).toContain('`z.ts`');
    // 太多时只列前面的，其余报数量
    const many = Array.from({ length: CHANGED_FILES_SHOWN + 3 }, (_, i) => `f${i}.ts`);
    const big = delegateResultMessage({ ...base, changedFiles: many }).content;
    expect(big).toContain('`f0.ts`');
    expect(big).not.toContain(`\`f${CHANGED_FILES_SHOWN}.ts\``);
    expect(big).toMatch(/3/);
    // 没改文件：不加这一段
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
