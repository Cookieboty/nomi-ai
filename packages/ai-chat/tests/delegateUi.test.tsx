// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DelegateCard, delegateView } from '../src/components/Conversation/DelegateCard';
import { DelegateSettings } from '../src/components/ProvidersPage/DelegateSettings';
import { HarnessTabsProvider } from '../src/contexts/HarnessTabsContext';
import { setChatMode } from '../src/services/chatPrefs';
import { getNextDelegate, setNextDelegate } from '../src/services/delegateClient';
import type { HarnessTabMeta, HarnessTabsState } from '../src/services/harnessClient';
import { nomiAdapter } from '../src/slash/adapters/nomi';
import type { ToolCall } from '../src/utils/toolTrace';

// Nomi 把编程助手当子代理调用（docs/design/nomi-delegate-cli.md §4.6、§4.7、§7）

const tab = (over: Partial<HarnessTabMeta> = {}): HarnessTabMeta => ({
  id: 'd1',
  title: 'Nomi · 修复登录',
  backend: 'claude',
  cwd: '/w',
  cliSessionId: null,
  status: 'running',
  unread: 0,
  createdAt: 0,
  updatedAt: 0,
  delegation: {
    by: 'nomi',
    callId: 'call-1',
    goal: '修复登录 bug',
    approvals: { asked: 0, denied: 0, timedOut: 0 },
  },
  ...over,
});

const call = (over: Partial<ToolCall> = {}): ToolCall => ({
  id: 'call-1',
  name: 'delegate_to_cli',
  status: 'running',
  input: JSON.stringify({ goal: '修复登录 bug', done_when: 'npm test 通过' }),
  startedAt: Date.now(),
  ...over,
});

const done = (data: Record<string, unknown>) =>
  JSON.stringify({
    ok: true,
    data: {
      taskId: 'd1',
      cli: 'codex',
      status: 'done',
      summary: '',
      filesVerified: true,
      approvals: { asked: 1, denied: 1, timedOut: 0 },
      durationMs: 1000,
      ...data,
    },
  });

function mockIpc(tabs: HarnessTabMeta[], settings?: Record<string, unknown>) {
  const listeners: Record<string, Array<(p: unknown) => void>> = {};
  const state: HarnessTabsState = { tabs, activeTabId: 'main', running: 1, queued: 0 };
  const invoke = vi.fn(async (ch: string, ...a: unknown[]) => {
    if (ch === 'ai:harness:tabs') return state;
    if (ch === 'ai:delegate:settings')
      return (
        settings ?? { enabled: true, defaults: {}, installed: ['claude', 'codex'], pinned: null }
      );
    if (ch === 'ai:delegate:set-settings') return a[0];
    return true;
  });
  const on = (ch: string, fn: (p: unknown) => void) => {
    (listeners[ch] ??= []).push(fn);
    return () => undefined;
  };
  (window as unknown as { aiIPC: unknown }).aiIPC = { invoke, on };
  return {
    invoke,
    emit: (events: unknown[]) =>
      act(() => {
        listeners['ai:harness:events']?.forEach((f) => f(events));
      }),
  };
}

beforeEach(() => setChatMode('dev'));
afterEach(() => {
  cleanup();
  setNextDelegate(null);
  localStorage.clear();
  delete (window as { aiIPC?: unknown }).aiIPC;
});

describe('delegateView', () => {
  it('还没开标签 = 等待确认委派；有待审批 = 等你确认；结束后按工具输出', () => {
    expect(delegateView(call(), null, undefined).phase).toBe('confirming');
    expect(delegateView(call(), tab(), undefined).phase).toBe('running');
    expect(
      delegateView(call(), tab(), { text: '', permissions: [{ id: 'p', summary: 'npm i' }] }).phase,
    ).toBe('waiting');
    const v = delegateView(
      call({ status: 'done', output: done({ status: 'cancelled', cancelledBy: 'user' }) }),
      null,
      undefined,
    );
    expect(v.phase).toBe('cancelled');
    expect(v.backend).toBe('codex');
    expect(v.goal).toBe('修复登录 bug');
    expect(
      delegateView(
        call({
          status: 'error',
          output: JSON.stringify({ ok: false, error: { code: 'mode_blocked', message: '计划' } }),
        }),
        null,
        undefined,
      ).phase,
    ).toBe('error');
  });
});

describe('子任务卡片', () => {
  const mount = (c: ToolCall) =>
    render(
      <HarnessTabsProvider>
        <DelegateCard call={c} />
      </HarnessTabsProvider>,
    );

  it('运行中：当前步骤、子代理（Claude 可单独停止）、卡片内审批、停止只停这个子任务', async () => {
    const ipc = mockIpc([tab()]);
    const r = mount(call());
    await waitFor(() => expect(r.getByTestId('delegate-card').dataset.phase).toBe('running'));
    ipc.emit([
      { tabId: 'd1', type: 'agent', op: 'start', id: 'a1', label: 'explorer', at: 1 },
      { tabId: 'd1', type: 'agent', op: 'progress', id: 'a1', progress: 'Bash · npm test' },
      { tabId: 'd1', type: 'permission', id: 'p1', summary: 'npm install', agent: 'reviewer' },
    ]);
    await waitFor(() => expect(r.getByTestId('delegate-card').dataset.phase).toBe('waiting'));
    expect(r.getByTestId('delegate-step').textContent).toContain('explorer · Bash · npm test');
    const card = r.getByTestId('delegate-card');
    fireEvent.click(within(card).getByTestId('conv-permission-allow'));
    expect(ipc.invoke).toHaveBeenCalledWith('ai:harness:reply-permission', 'd1', 'p1', true);
    fireEvent.click(within(card).getByTestId('delegate-agent-stop'));
    expect(ipc.invoke).toHaveBeenCalledWith('ai:harness:stop-agent', 'd1', 'a1');
    fireEvent.click(r.getByTestId('delegate-stop'));
    expect(ipc.invoke).toHaveBeenCalledWith('ai:harness:tab-cancel', 'd1');
  });

  it('历史消息（标签已不在）：按工具输出显示汇报与审批统计', () => {
    mockIpc([]);
    const r = mount(
      call({
        status: 'done',
        endedAt: Date.now(),
        output: done({
          report: {
            done: '修好了登录',
            changedFiles: ['src/login.ts'],
            needsUser: '要不要删旧接口',
          },
        }),
      }),
    );
    const rep = r.getByTestId('delegate-report');
    expect(rep.textContent).toContain('修好了登录');
    expect(r.getByTestId('delegate-files').textContent).toContain('src/login.ts');
    expect(rep.textContent).toContain('要不要删旧接口');
    expect(rep.textContent).toContain('审批 1 次，拒绝 1 次');
    expect(r.queryByTestId('delegate-stop')).toBeNull();
  });
});

describe('/cli 命令', () => {
  const cli = () => nomiAdapter({} as never).find((c) => c.name === 'cli')!;

  it('/cli codex 需求：指定交给 Codex 并立即发出；/cli codex：只挂 chip；/cli off 取消', async () => {
    mockIpc([]);
    expect(await cli().run('codex 修复登录 bug', {} as never)).toEqual({
      type: 'send',
      text: '修复登录 bug',
    });
    expect(getNextDelegate()).toBe('codex');
    setNextDelegate(null);
    expect(await cli().run('CC', {} as never)).toEqual({ type: 'noop' });
    expect(getNextDelegate()).toBe('claude');
    await cli().run('off', {} as never);
    expect(getNextDelegate()).toBeNull();
  });

  it('未安装 / 不认识 / 总开关关闭：只出提示卡片，不指定', async () => {
    mockIpc([]);
    const o1 = await cli().run('gemini', {} as never);
    expect(o1.type).toBe('card');
    const o2 = await cli().run('cursor', {} as never);
    expect(o2.type).toBe('card');
    expect(getNextDelegate()).toBeNull();
    mockIpc([], { enabled: false, defaults: {}, installed: ['codex'], pinned: null });
    expect((await cli().run('codex x', {} as never)).type).toBe('card');
    expect(getNextDelegate()).toBeNull();
  });
});

describe('设置 →「编程助手」→「委派」', () => {
  it('总开关与按任务类型的默认编程助手', async () => {
    const ipc = mockIpc([], {
      enabled: true,
      defaults: { coding: 'codex' },
      installed: ['claude', 'codex'],
      pinned: null,
    });
    const r = render(<DelegateSettings />);
    await r.findByTestId('providers-section-delegate');
    fireEvent.click(r.getByTestId('delegate-enabled'));
    await waitFor(() =>
      expect(ipc.invoke).toHaveBeenCalledWith('ai:delegate:set-settings', {
        enabled: false,
        defaults: { coding: 'codex' },
      }),
    );
  });
});
