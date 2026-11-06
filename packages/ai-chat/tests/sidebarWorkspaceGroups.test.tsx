// @vitest-environment happy-dom
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Sidebar } from '../src/components/Sidebar';
import { groupByWorkspace, workspaceKey } from '../src/components/Sidebar/workspaceGrouping';
import { SECTION_WORKSPACES } from '../src/components/Sidebar/WorkspaceGroups';
import { HarnessTabsProvider } from '../src/contexts/HarnessTabsContext';
import {
  getCollapsedWorkspaces,
  setChatMode,
  setGroupByWorkspace,
} from '../src/services/chatPrefs';
import type { HistorySession } from '../src/services/historyClient';

import { installFakeApi, resetFakeApi } from './helpers/fakeApi';

vi.mock('../src/services/api', async () => (await import('./helpers/fakeApi')).fakeApiModule());

const now = Date.now();
const conv = (id: string, name: string, backend: string, age: number, extra = {}) => ({
  id,
  name,
  backend,
  createdAt: 1,
  updatedAt: now - age * 60_000,
  ...extra,
});
let convs: ReturnType<typeof conv>[] = [];
const tabStatus = 'idle';
const updateMeta = vi.fn();
const deleteConversation = vi.fn(async () => undefined);
const onNewChat = vi.fn();

// 返回稳定引用（与生产一致）；每次新对象会让 Sidebar 的 refresh effect 每次渲染都重跑。
// 首次调用时才建对象：此时文件顶层的 vi.fn 已初始化。
vi.mock('../src/contexts/AiChatContext', () => {
  let api: unknown;
  return {
    useAiChat: () => {
      if (api) return api;
      const store = {
        upsertFromTab: () => undefined,
        removeByTabId: () => undefined,
        list: () => convs,
        currentId: () => 'n1',
        get: (id: string) => convs.find((x) => x.id === id),
        updateMeta,
        getMessages: () => [],
      };
      api = {
        state: {
          messages: [],
          ipcClient: {
            listConversations: async () => convs,
            currentConversationId: () => 'n1',
            switchConversation: async () => undefined,
            deleteConversation,
            conversationStore: () => store,
          },
        },
        actions: { loadChatHistory: async () => undefined },
      };
      return api;
    },
  };
});

const hist = {
  key: 'codex:s9',
  backend: 'codex',
  sessionId: 's9',
  title: 'disk codex session',
  cwd: '/work/app',
  cwdMissing: false,
  updatedAt: now - 60 * 60_000,
} as HistorySession;
type Input = {
  id?: string;
  backend?: string;
  sessionId?: string;
  options?: { offset?: number; limit?: number };
};
let calls: Array<[string, Input]> = [];

function mockIpc() {
  calls = [];
  const invoke = vi.fn(async (ch: string, input?: Input) => {
    calls.push([ch, input ?? {}]);
    if (ch === 'harness.tabs')
      return {
        tabs: [{ id: 't1', backend: 'claude', cwd: '/work/api', status: tabStatus, unread: 0 }],
        activeTabId: 'main',
        running: 0,
        queued: 0,
      };
    if (ch === 'harness.state')
      return { backend: 'nomi', cwd: '/w', bins: { claude: '/c', codex: '/x', dsh: null } };
    if (ch === 'harness.recentCwds') return [];
    if (ch === 'history.list') {
      const b = input?.backend;
      return { items: b === 'codex' ? [hist] : [], nextOffset: null, hasMore: false };
    }
    if (ch === 'history.open') return { ok: true };
    if (ch === 'history.delete') return { ok: true, removed: 1 };
    return {};
  });
  installFakeApi(invoke);
}

const mount = () =>
  render(
    <HarnessTabsProvider>
      <Sidebar collapsed={false} onToggle={() => undefined} onNewChat={onNewChat} />
    </HarnessTabsProvider>,
  );

const names = (el: HTMLElement) =>
  Array.from(el.querySelectorAll('[data-testid="history-item"]')).map((x) => x.textContent ?? '');

beforeEach(() => {
  setChatMode('dev');
  onNewChat.mockClear();
  updateMeta.mockClear();
  deleteConversation.mockClear();
  convs = [
    ...Array.from({ length: 7 }, (_, i) =>
      conv(`a${i}`, `app chat ${i}`, 'nomi', i + 1, { cwd: '/work/app' }),
    ),
    conv('c1', 'api via claude', 'claude', 3, { tabId: 't1' }),
    conv('n9', 'loose chat', 'nomi', 30),
  ];
  mockIpc();
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  resetFakeApi();
  vi.restoreAllMocks();
});

describe('groupByWorkspace', () => {
  const m = (id: string, updatedAt: number, cwd?: string) =>
    ({ id, name: id, backend: 'nomi', createdAt: 0, updatedAt, cwd }) as never;

  it('按最近活动排序分组，没有工作区的进 rest，同名目录带上父目录', () => {
    const { groups, rest } = groupByWorkspace(
      [m('1', 9, '/a/app/'), m('2', 8, '/b/app'), m('3', 7), m('4', 6, '/a/app')],
      (x) => (x as { cwd?: string }).cwd,
    );
    expect(groups.map((g) => [g.key, g.label, g.items.length])).toEqual([
      ['/a/app', 'a/app', 2],
      ['/b/app', 'b/app', 1],
    ]);
    expect(rest.map((x) => (x as { id: string }).id)).toEqual(['3']);
  });

  it('Windows 路径不分大小写与分隔符', () => {
    expect(workspaceKey('C:\\Users\\Me\\App\\')).toBe('c:/users/me/app');
    expect(workspaceKey('/Users/Me/App')).toBe('/Users/Me/App');
  });
});

describe('sidebar workspace groups', () => {
  it('Nomi 工作区与 CLI 标签目录分别成组，每组默认 5 条，展开后显示全部', async () => {
    const r = mount();
    const groups = await r.findAllByTestId('workspace-group');
    expect(groups.map((g) => g.getAttribute('data-workspace'))).toEqual(['/work/app', '/work/api']);
    const app = groups[0]!;
    expect(names(app)).toHaveLength(5);
    expect(names(groups[1]!)).toEqual([expect.stringContaining('api via claude')]);
    // 分页：每点一次多 5 条，全部显示后变成「收起」
    fireEvent.click(within(app).getByTestId('workspace-show-more'));
    expect(names(app)).toHaveLength(7);
    expect(within(app).getByTestId('workspace-show-more').textContent).toBe('收起');
    fireEvent.click(within(app).getByTestId('workspace-show-more'));
    expect(names(app)).toHaveLength(5);
    // 没有工作区的会话在「最近」里
    expect(names(r.getByTestId('workspace-recent'))).toEqual([
      expect.stringContaining('loose chat'),
    ]);
  });

  it('折叠工作区会记住；关掉分组回到平铺列表', async () => {
    const r = mount();
    const app = (await r.findAllByTestId('workspace-group'))[0]!;
    fireEvent.click(within(app).getByTestId('workspace-toggle'));
    expect(getCollapsedWorkspaces()).toEqual(['/work/app']);
    await waitFor(() => expect(names(r.getAllByTestId('workspace-group')[0]!)).toHaveLength(0));

    fireEvent.click(r.getByTestId('organize-sidebar'));
    fireEvent.click(r.getByTestId('merged-list'));
    await waitFor(() => expect(r.queryByTestId('workspace-group')).toBeNull());
    expect(r.getAllByTestId('history-item')).toHaveLength(9);
    setGroupByWorkspace(true);
  });

  it('标题前不画端点图标；工坊「全部」里编程助手的会话在行尾有灰色端点图标，Nomi 没有', async () => {
    setChatMode('normal');
    const r = mount();
    const app = (await r.findAllByTestId('workspace-group'))[0]!;
    const row = app.querySelector('[data-testid="history-item"]')!;
    expect(row.getAttribute('data-layout')).toBe('plain');
    expect(row.querySelector('[data-testid^="endpoint-icon-"]')).toBeNull();
    cleanup();
    setChatMode('dev');
    const d = mount();
    const groups = await d.findAllByTestId('workspace-group');
    const nomiRow = groups[0]!.querySelector('[data-testid="history-item"]')!;
    expect(nomiRow.querySelector('[data-testid="thread-endpoint"]')).toBeNull();
    const claudeRow = groups[1]!.querySelector('[data-testid="history-item"]')!;
    expect(claudeRow.querySelector('[data-testid="thread-endpoint"]')).toBeTruthy();
  });

  it('「工作区」「最近」分区标题可以收起整个分区，并记住', async () => {
    const r = mount();
    const ws = await r.findByTestId('workspace-section-toggle');
    expect(ws.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(ws);
    await waitFor(() => expect(r.queryByTestId('workspace-group')).toBeNull());
    expect(getCollapsedWorkspaces()).toContain(SECTION_WORKSPACES);
    fireEvent.click(r.getByTestId('recent-section-toggle'));
    await waitFor(() =>
      expect(within(r.getByTestId('workspace-recent')).queryByTestId('history-item')).toBeNull(),
    );
    cleanup();
    // 重新打开侧栏：仍是收起的
    const again = mount();
    expect(
      (await again.findByTestId('workspace-section-toggle')).getAttribute('aria-expanded'),
    ).toBe('false');
    fireEvent.click(again.getByTestId('workspace-section-toggle'));
    await waitFor(() => expect(again.getAllByTestId('workspace-group').length).toBeGreaterThan(0));
  });

  it('文件夹上的「新建」在该工作区里新建', async () => {
    setChatMode('normal');
    const r = mount();
    const app = (await r.findAllByTestId('workspace-group'))[0]!;
    fireEvent.click(within(app).getByTestId('workspace-new-chat'));
    await waitFor(() => expect(onNewChat).toHaveBeenCalledWith({ cwd: '/work/app' }));
  });
});
