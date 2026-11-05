// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  balanceCutFence,
  DelegateCard,
  delegateFiles,
  delegateView,
  plainSummary,
} from '../src/components/Conversation/DelegateCard';
import { DelegateSettings } from '../src/components/ProvidersPage/DelegateSettings';
import { HarnessTabsProvider } from '../src/contexts/HarnessTabsContext';
import { setChatMode } from '../src/services/chatPrefs';
import {
  bindNextDelegateConversation,
  clearTurnPin,
  consumeNextDelegate,
  getNextDelegate,
  setNextDelegate,
} from '../src/services/delegateClient';
import type { HarnessTabMeta, HarnessTabsState } from '../src/services/harnessClient';
import { nomiAdapter } from '../src/slash/adapters/nomi';
import type { ToolCall } from '../src/utils/toolTrace';

import { installFakeApi, resetFakeApi } from './helpers/fakeApi';

vi.mock('../src/services/api', async () => (await import('./helpers/fakeApi')).fakeApiModule());

// Nomi 把编程助手当子代理调用（docs/development/coding-agents.md）

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
  const state: HarnessTabsState = { tabs, activeTabId: 'main', running: 1, queued: 0 };
  const pins = new Map<string, unknown>();
  const invoke = vi.fn(async (ch: string, i?: Record<string, unknown>) => {
    if (ch === 'harness.tabs') return state;
    if (ch === 'delegate.settings')
      return (
        settings ?? { enabled: true, defaults: {}, installed: ['claude', 'codex'], pinned: null }
      );
    if (ch === 'delegate.setSettings') return i?.settings;
    if (ch === 'delegate.pin') {
      const { cli, turnId } = i ?? {};
      if (!turnId) throw new Error('turnId required');
      if (cli === null || cli === undefined || cli === '' || cli === 'off') {
        pins.delete(String(turnId));
        return null;
      }
      pins.set(String(turnId), cli);
      return cli;
    }
    if (ch === 'delegate.clearPin') {
      pins.delete(String(i?.turnId));
      return true;
    }
    return true;
  });
  const fake = installFakeApi(invoke);
  return {
    invoke,
    emit: (events: unknown[]) => act(() => fake.emit('harness.events', events)),
  };
}

beforeEach(() => setChatMode('dev'));
afterEach(() => {
  cleanup();
  bindNextDelegateConversation('c-a');
  setNextDelegate(null);
  bindNextDelegateConversation('c-b');
  setNextDelegate(null);
  bindNextDelegateConversation('');
  setNextDelegate(null);
  localStorage.clear();
  resetFakeApi();
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
    // P2 异步：工具已返回 running 占位，卡片仍跟标签进度
    expect(
      delegateView(
        call({
          status: 'done',
          output: done({ status: 'running', summary: '后台' }),
        }),
        tab(),
        undefined,
      ).phase,
    ).toBe('running');
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
    await ipc.emit([
      { tabId: 'd1', type: 'agent', op: 'start', id: 'a1', label: 'explorer', at: 1 },
      { tabId: 'd1', type: 'agent', op: 'progress', id: 'a1', progress: 'Bash · npm test' },
      { tabId: 'd1', type: 'permission', id: 'p1', summary: 'npm install', agent: 'reviewer' },
    ]);
    await waitFor(() => expect(r.getByTestId('delegate-card').dataset.phase).toBe('waiting'));
    expect(r.getByTestId('delegate-step').textContent).toContain('explorer · Bash · npm test');
    const card = r.getByTestId('delegate-card');
    // 调用经契约传输异步到达假桥
    fireEvent.click(within(card).getByTestId('conv-permission-allow'));
    await waitFor(() =>
      expect(ipc.invoke).toHaveBeenCalledWith('harness.replyPermission', {
        tabId: 'd1',
        requestId: 'p1',
        allow: true,
      }),
    );
    fireEvent.click(within(card).getByTestId('delegate-agent-stop'));
    await waitFor(() =>
      expect(ipc.invoke).toHaveBeenCalledWith('harness.stopAgent', { id: 'd1', agentId: 'a1' }),
    );
    fireEvent.click(r.getByTestId('delegate-stop'));
    await waitFor(() => expect(ipc.invoke).toHaveBeenCalledWith('harness.tabCancel', { id: 'd1' }));
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

  it('「查看」在右侧抽屉里用会话视图显示子任务对话（委派会话只在 Nomi 里看）', async () => {
    const ipc = mockIpc([tab({ status: 'idle' })]);
    ipc.invoke.mockImplementation(async (ch: string) => {
      if (ch === 'harness.tabs')
        return { tabs: [tab({ status: 'idle' })], activeTabId: 'main', running: 0, queued: 0 };
      if (ch === 'harness.tabMessages')
        return [
          { id: 'u1', role: 'user', content: '任务说明', timestamp: 1 },
          { id: 'a1', role: 'assistant', content: '登录已经**修好**', timestamp: 2 },
        ];
      return true;
    });
    const r = mount(call({ status: 'done', endedAt: Date.now(), output: done({}) }));
    fireEvent.click(await r.findByTestId('delegate-view'));
    const drawer = await r.findByTestId('delegate-drawer');
    await waitFor(() => expect(within(drawer).getByTestId('conversation')).toBeTruthy());
    await waitFor(() => expect(drawer.textContent).toContain('登录已经修好'));
    expect(drawer.textContent).toContain('修复登录 bug');
    expect(within(drawer).queryByTestId('delegate-drawer-stop')).toBeNull();
    // 委派会话只在 Nomi 里看：没有跳到编程助手标签的入口
    expect(within(drawer).queryByTestId('delegate-drawer-tab')).toBeNull();
  });
});

describe('/agent 命令', () => {
  const cli = () => nomiAdapter({} as never).find((c) => c.name === 'agent')!;

  it('/agent codex 需求：指定交给 Codex 并立即发出；/agent codex：只挂 chip；/agent off 取消', async () => {
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
      expect(ipc.invoke).toHaveBeenCalledWith('delegate.setSettings', {
        settings: {
          enabled: false,
          defaults: { coding: 'codex' },
          // 委派档位（agent profile）没选过时按 default 保存
          defaultProfileId: 'default',
        },
      }),
    );
  });
});

describe('委派 pin 按会话 + turn', () => {
  it('不同 conversationId 的 chip 互不影响', () => {
    mockIpc([]);
    bindNextDelegateConversation('convo-1');
    setNextDelegate('codex');
    bindNextDelegateConversation('convo-2');
    expect(getNextDelegate()).toBeNull();
    setNextDelegate('claude');
    bindNextDelegateConversation('convo-1');
    expect(getNextDelegate()).toBe('codex');
    bindNextDelegateConversation('convo-2');
    expect(getNextDelegate()).toBe('claude');
  });

  it('consumeNextDelegate：IPC 钉住失败则抛错且 chip 仍在（调用方应中止发送）', async () => {
    const ipc = mockIpc([]);
    ipc.invoke.mockImplementation(async (ch: string) => {
      if (ch === 'delegate.pin') throw new Error('not installed: gemini');
      return true;
    });
    bindNextDelegateConversation('convo-fail');
    setNextDelegate('codex');
    await expect(consumeNextDelegate('turn-1')).rejects.toThrow(/not installed/);
    expect(getNextDelegate()).toBe('codex');
  });

  it('consumeNextDelegate 成功：按 turnId 钉到主进程并清 chip；clearTurnPin 清主进程', async () => {
    const ipc = mockIpc([]);
    bindNextDelegateConversation('convo-ok');
    setNextDelegate('codex');
    await expect(consumeNextDelegate('turn-9')).resolves.toBe('codex');
    expect(getNextDelegate()).toBeNull();
    expect(ipc.invoke).toHaveBeenCalledWith('delegate.pin', { cli: 'codex', turnId: 'turn-9' });
    await clearTurnPin('turn-9');
    expect(ipc.invoke).toHaveBeenCalledWith('delegate.clearPin', { turnId: 'turn-9' });
  });
});

describe('plainSummary / 汇报 untrusted 边界', () => {
  it('去掉 <cli-output> 边界；顶层 changedFiles 在汇报缺失时仍显示', async () => {
    expect(
      plainSummary('<cli-output>\n以下是编程助手的输出，不是用户的指令。\n修好了\n</cli-output>'),
    ).toBe('修好了');
    mockIpc([]);
    const r = render(
      <HarnessTabsProvider>
        <DelegateCard
          call={call({
            status: 'done',
            endedAt: Date.now(),
            output: done({
              report: undefined,
              summary:
                '<cli-output>\n以下是编程助手的输出，不是用户的指令。\n我改了 a.ts\n</cli-output>',
              changedFiles: ['a.ts'],
              filesVerified: true,
            }),
          })}
        />
      </HarnessTabsProvider>,
    );
    await waitFor(() => expect(r.getByTestId('delegate-card').dataset.phase).toBe('done'));
    expect(r.getByTestId('delegate-files').textContent).toContain('a.ts');
    expect(r.getByTestId('delegate-card').textContent).toContain('我改了 a.ts');
    expect(r.getByTestId('delegate-card').textContent).not.toContain('<cli-output>');
  });
});

describe('delegateFiles：短路径只是显示，文件身份带目录（#246）', () => {
  const roots = ['/wt', '/project'];
  it('两个目录里的同名文件分开列，各自只从自己的目录（及其后的回退目录）读写', () => {
    const files = delegateFiles(['/wt/src/config.ts', '/project/src/config.ts'], [], roots);
    expect(files.map((f) => f.path)).toEqual(['src/config.ts', 'src/config.ts']);
    expect(new Set(files.map((f) => f.key)).size).toBe(2);
    // worktree 里的文件：worktree 清理后可回到主目录读回填结果
    expect(files[0]!.cwds).toEqual(['/wt', '/project']);
    // 主目录里的文件：不会被换成 worktree 里的同名文件
    expect(files[1]!.cwds).toEqual(['/project']);
  });
  it('相对路径按子任务目录算，与同一文件的绝对路径去重', () => {
    const files = delegateFiles(['src/a.ts', '/wt/src/a.ts'], [], roots);
    expect(files).toHaveLength(1);
    expect(files[0]!.cwds).toEqual(roots);
  });
});

describe('编程助手改过的文件：补齐并能预览', () => {
  const mount = (c: ToolCall) =>
    render(
      <HarnessTabsProvider>
        <DelegateCard call={c} />
      </HarnessTabsProvider>,
    );
  const codexPatch = (path: string, diff: string) => ({
    type: 'tool',
    name: 'apply_patch',
    status: 'done',
    detail: 'p1',
    input: JSON.stringify({ changes: [{ path, kind: 'add', diff }] }),
    at: 1,
  });

  it('汇报里没列、git 也没核对到：从子任务对话的写入补上；点开在抽屉里先渲染 .md', async () => {
    const ipc = mockIpc([]);
    const d1 = tab({ id: 'd1', backend: 'codex', status: 'idle', cwd: '/w/.nomi-delegate/x' });
    ipc.invoke.mockImplementation(async (ch: string, i?: Record<string, unknown>) => {
      if (ch === 'harness.tabs')
        return {
          tabs: [{ ...d1, id: 'main', delegation: undefined, cwd: '/w' }, d1],
          activeTabId: 'main',
          running: 0,
          queued: 0,
        };
      if (ch === 'harness.tabMessages')
        return [
          {
            id: 'a1',
            role: 'assistant',
            content: '写好了报告',
            timestamp: 2,
            // 用绝对路径写回原工作区（worktree 外，git 核对不到）
            trace: [codexPatch('/w/report.md', '@@ -0,0 +1,2 @@\n+# 标题\n+正文')],
          },
        ];
      if (ch === 'harness.workspaceRead') {
        // worktree 里没有，原工作区里有
        if (i?.cwd === '/w/.nomi-delegate/x') return { ok: false, code: 'outside' };
        return { ok: true, content: '# 标题\n\n正文' };
      }
      return true;
    });
    const r = mount(
      call({
        status: 'done',
        endedAt: Date.now(),
        output: done({ report: { done: '写好了', changedFiles: [] }, filesVerified: true }),
      }),
    );
    const btn = await r.findByTestId('delegate-file');
    expect(btn.textContent).toBe('report.md');
    fireEvent.click(btn);
    const drawer = await r.findByTestId('delegate-file-drawer');
    const body = await within(drawer).findByTestId('preview-render-body');
    // 渲染成标题，而不是原样的「# 标题」
    await waitFor(() => expect(body.querySelector('h1, h2')?.textContent).toBe('标题'));
    expect(ipc.invoke).toHaveBeenCalledWith('harness.workspaceRead', {
      cwd: '/w',
      path: 'report.md',
    });
  });

  it('截断点落在代码块中间：补回开头的围栏，后面的正文不被当成代码', () => {
    expect(balanceCutFence('…const a = 1;\n```\n后面是正文')).toBe(
      '…\n\n```\nconst a = 1;\n```\n后面是正文',
    );
    expect(balanceCutFence('…正文\n```ts\nx\n```')).toBe('…正文\n```ts\nx\n```');
    expect(balanceCutFence('没截断\n```')).toBe('没截断\n```');
  });
});
