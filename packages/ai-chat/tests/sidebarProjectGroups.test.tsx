// @vitest-environment happy-dom
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Sidebar } from '../src/components/Sidebar';
import { groupByProject } from '../src/components/Sidebar/projectGrouping';
import { SECTION_WORKSPACES } from '../src/components/Sidebar/ProjectGroups';
import { HarnessTabsProvider } from '../src/contexts/HarnessTabsContext';
import {
  getCollapsedWorkspaces,
  setChatMode,
  setConversationListView,
  setEndpointFilter,
  setGroupByWorkspace,
  setWorkspaceCollapsed,
} from '../src/services/chatPrefs';
import type { HistorySession } from '../src/services/historyClient';
import { __setProjectsForTest, type Project } from '../src/services/projects';

import { installFakeApi, resetFakeApi } from './helpers/fakeApi';

vi.mock('../src/services/api', async () => (await import('./helpers/fakeApi')).fakeApiModule());

const now = Date.now();
const proj = (id: string, name: string, primary: string, folders: string[] = []): Project => ({
  id,
  name,
  primary,
  folders,
  createdAt: 1,
  updatedAt: 1,
});
const PROJECTS = [
  proj('p_app', 'app', '/work/app', ['/work/server']),
  proj('p_api', 'api', '/work/api'),
  proj('p_empty', 'empty', '/work/empty'),
];
const conv = (id: string, name: string, backend: string, age: number, extra = {}) => ({
  id,
  name,
  backend,
  createdAt: 1,
  updatedAt: now - age * 60_000,
  ...extra,
});
let convs: ReturnType<typeof conv>[] = [];
let tabStatus = 'idle';
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
/** 让 harness.tabCreate 失败（新建失败的提示） */
let failCreate = false;

function mockIpc() {
  calls = [];
  const invoke = vi.fn(async (ch: string, input?: Input) => {
    calls.push([ch, input ?? {}]);
    if (ch === 'harness.tabCreate' && failCreate) throw new Error('disk full');
    if (ch === 'harness.tabs')
      return {
        tabs: [
          {
            id: 't1',
            backend: 'claude',
            cwd: '/work/api',
            projectId: 'p_api',
            status: tabStatus,
            unread: 0,
          },
        ],
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
      conv(`a${i}`, `app chat ${i}`, 'nomi', i + 1, { projectId: 'p_app' }),
    ),
    conv('c1', 'api via claude', 'claude', 3, { tabId: 't1' }),
    conv('n9', 'loose chat', 'nomi', 30),
  ];
  mockIpc();
  __setProjectsForTest(PROJECTS);
});
afterEach(() => {
  failCreate = false;
  tabStatus = 'idle';
  cleanup();
  localStorage.clear();
  resetFakeApi();
  vi.restoreAllMocks();
});

describe('groupByProject', () => {
  const m = (id: string, updatedAt: number, projectId?: string) =>
    ({ id, name: id, backend: 'nomi', createdAt: 0, updatedAt, projectId }) as never;

  it('分组来自项目列表（空项目也在），按最近活动排序；没有项目或项目已移除的进 rest', () => {
    const { groups, rest } = groupByProject(
      [m('1', 9, 'p_api'), m('2', 8, 'p_app'), m('3', 7), m('4', 6, 'p_gone'), m('5', 5, 'p_api')],
      PROJECTS,
      (x) => (x as { projectId?: string }).projectId,
    );
    expect(groups.map((g) => [g.key, g.project.name, g.items.length])).toEqual([
      ['p_api', 'api', 2],
      ['p_app', 'app', 1],
      ['p_empty', 'empty', 0],
    ]);
    expect(groups[1]!.title).toContain('/work/server');
    expect(rest.map((x) => (x as { id: string }).id)).toEqual(['3', '4']);
  });
});

describe('sidebar project groups', () => {
  it('Nomi 对话按会话的项目、CLI 会话按标签的项目成组，每组默认 5 条，展开后显示全部', async () => {
    const r = mount();
    const groups = await r.findAllByTestId('workspace-group');
    expect(groups.map((g) => g.getAttribute('data-project'))).toEqual([
      'p_app',
      'p_api',
      'p_empty',
    ]);
    const app = groups[0]!;
    expect(names(app)).toHaveLength(5);
    expect(names(groups[1]!)).toEqual([expect.stringContaining('api via claude')]);
    // 分页：按钮写还剩几条；每点一次多 5 条，全部显示后变成「收起」
    expect(within(app).getByTestId('workspace-show-more').textContent).toBe('再显示 2 条');
    fireEvent.click(within(app).getByTestId('workspace-show-more'));
    expect(names(app)).toHaveLength(7);
    expect(within(app).getByTestId('workspace-show-more').textContent).toBe('收起');
    fireEvent.click(within(app).getByTestId('workspace-show-more'));
    expect(names(app)).toHaveLength(5);
    // 没有项目的会话在「其他对话」里
    expect(names(r.getByTestId('workspace-recent'))).toEqual([
      expect.stringContaining('loose chat'),
    ]);
  });

  it('折叠项目会记住；关掉分组回到平铺列表', async () => {
    const r = mount();
    const app = (await r.findAllByTestId('workspace-group'))[0]!;
    fireEvent.click(within(app).getByTestId('workspace-toggle'));
    expect(getCollapsedWorkspaces()).toEqual(['p_app']);
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

  it('「项目」「最近」分区标题可以收起整个分区，并记住', async () => {
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

  it('项目上的「新建」在该项目里新建；「其他对话」标题上没有新建（与别处的新建重复）', async () => {
    setChatMode('normal');
    const r = mount();
    const app = (await r.findAllByTestId('workspace-group'))[0]!;
    fireEvent.click(within(app).getByTestId('workspace-new-chat'));
    await waitFor(() => expect(onNewChat).toHaveBeenCalledWith({ projectId: 'p_app' }));
    const other = r.getByTestId('workspace-recent');
    expect(within(other).queryByTestId('new-chat')).toBeNull();
    expect(other.textContent).toContain('其他对话');
  });

  it('新建失败时提示原因，不再静默', async () => {
    setConversationListView('all');
    failCreate = true;
    mockIpc();
    const onNotice = vi.fn();
    const r = render(
      <HarnessTabsProvider>
        <Sidebar
          collapsed={false}
          onToggle={() => undefined}
          onNewChat={onNewChat}
          onNotice={onNotice}
        />
      </HarnessTabsProvider>,
    );
    // api 项目里最近的会话是 Claude Code 的：项目上的「新建」开 Claude Code 标签，这里让它失败
    const groups = await r.findAllByTestId('workspace-group');
    const api = groups.find((g) => g.dataset.project === 'p_api')!;
    fireEvent.click(within(api).getByTestId('workspace-new-chat'));
    await waitFor(() =>
      expect(onNotice).toHaveBeenCalledWith(expect.stringContaining('disk full')),
    );
  });

  it('只看一个端时不列这个端没有会话的项目；折叠的项目只写当前端的数，0 不写', async () => {
    setConversationListView('by-endpoint');
    setEndpointFilter('nomi');
    setWorkspaceCollapsed('p_app', true);
    const r = mount();
    await waitFor(() =>
      expect(r.getAllByTestId('workspace-group').map((g) => g.dataset.project)).toEqual(['p_app']),
    );
    const app = r.getAllByTestId('workspace-group')[0]!;
    expect(within(app).getByTestId('workspace-toggle').textContent).toBe('app7');

    cleanup();
    setConversationListView('all');
    setWorkspaceCollapsed('p_empty', true);
    const all = mount();
    const empty = (await all.findAllByTestId('workspace-group')).find(
      (g) => g.dataset.project === 'p_empty',
    )!;
    expect(within(empty).getByTestId('workspace-toggle').textContent).toBe('empty');
  });

  it('进行中的会话只看行首状态点：行尾不写「进行中」，状态文字只给读屏', async () => {
    tabStatus = 'running';
    mockIpc();
    const r = mount();
    const api = (await r.findAllByTestId('workspace-group')).find(
      (g) => g.dataset.project === 'p_api',
    )!;
    const live = await within(api).findByTestId('thread-live');
    expect(live.textContent).toBe('进行中');
    expect(live.className).toMatch(/srOnly/);
  });

  it('「项目」标题上的按钮打开「创建项目」，不开对话；项目上的「…」打开「编辑项目」', async () => {
    const r = mount();
    fireEvent.click(await r.findByTestId('new-project'));
    const dialog = await r.findByTestId('project-dialog');
    expect(dialog.textContent).toContain('创建项目');
    expect(onNewChat).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByText('取消'));
    await waitFor(() => expect(r.queryByTestId('project-dialog')).toBeNull());
    const app = (await r.findAllByTestId('workspace-group'))[0]!;
    fireEvent.click(within(app).getByTestId('project-edit'));
    const edit = await r.findByTestId('project-dialog');
    expect(edit.textContent).toContain('编辑项目');
    expect(
      within(edit)
        .getAllByTestId('project-folder')
        .map((x) => x.title || x.textContent),
    ).toHaveLength(2);
    expect(within(edit).getByTestId('project-remove')).toBeTruthy();
  });
});
