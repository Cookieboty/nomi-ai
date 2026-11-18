// @vitest-environment happy-dom
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Sidebar } from '../src/components/Sidebar';
import { groupByProject, pinnedFirst } from '../src/components/Sidebar/projectGrouping';
import { SECTION_WORKSPACES } from '../src/components/Sidebar/ProjectGroups';
import { HarnessTabsProvider } from '../src/contexts/HarnessTabsContext';
import {
  getCollapsedWorkspaces,
  getPinnedProjects,
  setChatMode,
  setConversationListView,
  setEndpointFilter,
  setEndpointVisibility,
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
      return {
        backend: 'nomi',
        cwd: '/w',
        bins: { claude: '/c', codex: '/x', grok: '/g', dsh: null },
      };
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

describe('pinnedFirst', () => {
  const m = (id: string, pinnedAt?: number) => ({ id, pinnedAt });

  it('置顶的排最前（后置顶的在上），其余保持原顺序；没有置顶时原样返回', () => {
    const items = [m('1'), m('2', 10), m('3'), m('4', 20), m('5')];
    expect(pinnedFirst(items).map((x) => x.id)).toEqual(['4', '2', '1', '3', '5']);
    const plain = [m('1'), m('2')];
    expect(pinnedFirst(plain)).toBe(plain);
  });

  it('先排再分组：每个项目和「其他对话」里都是置顶的在最前，项目顺序仍按最近活动', () => {
    const c = (id: string, updatedAt: number, projectId?: string, pinnedAt?: number) =>
      ({ id, name: id, backend: 'nomi', createdAt: 0, updatedAt, projectId, pinnedAt }) as never;
    const { groups, rest } = groupByProject(
      pinnedFirst([
        c('1', 9, 'p_api'),
        c('2', 8, 'p_app'),
        c('3', 7),
        c('4', 6, 'p_api', 100),
        c('5', 5),
        c('6', 4, undefined, 50),
      ]),
      PROJECTS,
      (x) => (x as { projectId?: string }).projectId,
    );
    const ids = (xs: readonly unknown[]) => xs.map((x) => (x as { id: string }).id);
    expect(groups.map((g) => g.key)).toEqual(['p_api', 'p_app', 'p_empty']);
    expect(ids(groups[0]!.items)).toEqual(['4', '1']);
    expect(ids(rest)).toEqual(['6', '3', '5']);
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

  it('标题前不画端点图标；工坊「全部」里 agent 的会话在行尾有灰色端点图标，Nomi 没有', async () => {
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
    // 开发模式「全部」视图下点击项目上的「新建」弹出后端菜单，选 Claude Code 让它失败
    const groups = await r.findAllByTestId('workspace-group');
    const api = groups.find((g) => g.dataset.project === 'p_api')!;
    fireEvent.click(within(api).getByTestId('workspace-new-chat'));
    const menu = await r.findByTestId('workspace-new-chat-menu');
    fireEvent.click(within(menu).getByTestId('new-chat-claude'));
    await waitFor(() =>
      expect(onNotice).toHaveBeenCalledWith(expect.stringContaining('disk full')),
    );
  });

  it('按端筛选时仍展示全部共享项目；折叠的项目只写当前端的数，0 不写', async () => {
    setConversationListView('by-endpoint');
    setEndpointFilter('nomi');
    setWorkspaceCollapsed('p_app', true);
    const r = mount();
    await waitFor(() =>
      expect(r.getAllByTestId('workspace-group').map((g) => g.dataset.project)).toEqual([
        'p_app',
        'p_api',
        'p_empty',
      ]),
    );
    const app = r.getAllByTestId('workspace-group')[0]!;
    expect(within(app).getByTestId('workspace-toggle').textContent).toBe('app7');
    const api = r.getAllByTestId('workspace-group')[1]!;
    // Nomi 端下 p_api 只有 Claude 会话（Nomi 数为 0），仍展示项目头但不显示数字 0
    expect(within(api).getByTestId('workspace-toggle').textContent).toBe('api');

    cleanup();
    // 切到 Codex 端（全部项目在 Codex 端都还没有会话）：项目依然跨端可用，直接点击即可在该项目创建 Codex 会话
    setEndpointVisibility('codex', 'show');
    setEndpointFilter('codex');
    const c = mount();
    const codexGroups = await c.findAllByTestId('workspace-group');
    expect(codexGroups.map((g) => g.dataset.project)).toEqual(['p_app', 'p_api', 'p_empty']);
    fireEvent.click(within(codexGroups[0]!).getByTestId('workspace-new-chat'));
    await waitFor(() =>
      expect(calls).toContainEqual([
        'harness.tabCreate',
        expect.objectContaining({ backend: 'codex', projectId: 'p_app' }),
      ]),
    );

    cleanup();
    setConversationListView('all');
    setWorkspaceCollapsed('p_empty', true);
    const all = mount();
    const empty = (await all.findAllByTestId('workspace-group')).find(
      (g) => g.dataset.project === 'p_empty',
    )!;
    expect(within(empty).getByTestId('workspace-toggle').textContent).toBe('empty');
  });

  it('开发模式「全部」下同一项目可跨多 CLI 创建会话，并汇总同一分组', async () => {
    setConversationListView('all');
    convs = [
      conv('n1', 'app nomi', 'nomi', 1, { projectId: 'p_app' }),
      conv('c2', 'app claude', 'claude', 2, { projectId: 'p_app', tabId: 't2' }),
      conv('x3', 'app codex', 'codex', 3, { projectId: 'p_app', tabId: 't3' }),
    ];
    mockIpc();
    const r = mount();
    const groups = await r.findAllByTestId('workspace-group');
    const app = groups.find((g) => g.dataset.project === 'p_app')!;
    expect(names(app)).toEqual([
      expect.stringContaining('app nomi'),
      expect.stringContaining('app claude'),
      expect.stringContaining('app codex'),
    ]);

    fireEvent.click(within(app).getByTestId('workspace-new-chat'));
    const menu1 = await r.findByTestId('workspace-new-chat-menu');
    expect(within(menu1).queryByTestId('new-chat-project')).toBeNull();
    fireEvent.click(within(menu1).getByTestId('new-chat-codex'));
    await waitFor(() =>
      expect(calls).toContainEqual([
        'harness.tabCreate',
        expect.objectContaining({ backend: 'codex', projectId: 'p_app' }),
      ]),
    );

    fireEvent.click(within(app).getByTestId('workspace-new-chat'));
    const menu2 = await r.findByTestId('workspace-new-chat-menu');
    fireEvent.click(within(menu2).getByTestId('new-chat-claude'));
    await waitFor(() =>
      expect(calls).toContainEqual([
        'harness.tabCreate',
        expect.objectContaining({ backend: 'claude', projectId: 'p_app' }),
      ]),
    );
  });

  it('切换到尚无会话的新 CLI 端自动建标签时，会衔接当前高亮会话所属项目', async () => {
    setEndpointVisibility('grok', 'show');
    convs = [conv('n1', 'active nomi', 'nomi', 1, { projectId: 'p_app' })];
    mockIpc();
    const r = mount();
    const grokChip = await r.findByTestId('endpoint-filter-grok');
    fireEvent.click(grokChip);
    await waitFor(() =>
      expect(calls).toContainEqual([
        'harness.tabCreate',
        expect.objectContaining({ backend: 'grok', projectId: 'p_app' }),
      ]),
    );
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

  it('「项目」标题：「+」是新建项目，笔形是新对话且不放进任何项目', async () => {
    setChatMode('normal');
    const r = mount();
    const plus = await r.findByTestId('new-project');
    expect(plus.getAttribute('aria-label')).toBe('创建项目');
    fireEvent.click(r.getByTestId('new-chat'));
    await waitFor(() => expect(onNewChat).toHaveBeenCalledWith({ projectId: null }));
  });

  it('没有「其他对话」时整个分区不显示', async () => {
    convs = convs.filter((c) => (c as { projectId?: string }).projectId);
    mockIpc();
    const r = mount();
    await r.findAllByTestId('workspace-group');
    expect(r.queryByTestId('workspace-recent')).toBeNull();
    expect(r.queryByTestId('recent-section-toggle')).toBeNull();
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

describe('sidebar pinned sessions', () => {
  it('置顶不单独成组：置顶的会话留在自己的项目里排第一，带置顶标记', async () => {
    convs = convs.map((c) =>
      c.id === 'a5' ? { ...c, pinnedAt: now } : c.id === 'n9' ? { ...c, pinnedAt: now - 1 } : c,
    );
    const r = mount();
    const groups = await r.findAllByTestId('workspace-group');
    expect(r.queryByTestId('pinned-section')).toBeNull();
    const app = groups.find((g) => g.getAttribute('data-project') === 'p_app')!;
    // 原本排在第 6 条（默认收起看不到），置顶后排到项目第一
    expect(names(app)[0]).toContain('app chat 5');
    expect(names(app)).toHaveLength(5);
    const first = app.querySelector('[data-testid="conversation-row"]')!;
    expect(first.getAttribute('data-pinned')).toBe('true');
    expect(within(first as HTMLElement).getByTestId('thread-pinned')).toBeTruthy();
    // 没有项目的置顶会话在「其他对话」里排第一
    expect(names(r.getByTestId('workspace-recent'))[0]).toContain('loose chat');
  });

  it('平铺列表里置顶的也排在最前', async () => {
    convs = convs.map((c) => (c.id === 'n9' ? { ...c, pinnedAt: now } : c));
    setGroupByWorkspace(false);
    const r = mount();
    await waitFor(() => expect(r.getAllByTestId('history-item').length).toBeGreaterThan(0));
    expect(r.getAllByTestId('history-item')[0]!.textContent).toContain('loose chat');
    expect(r.queryByTestId('pinned-section')).toBeNull();
  });
});

describe('project hover peek card & pinning', () => {
  it('悬停项目头时在右侧弹出项目详情卡片：展示名称、跨端总聊天数、全部文件夹与缺失标记', async () => {
    __setProjectsForTest([
      {
        ...PROJECTS[0]!,
        missing: ['/work/server'],
      },
      PROJECTS[1]!,
      PROJECTS[2]!,
    ]);
    // 切到 claude 单端视图：p_app 下虽然当前视图是 0 条 claude 会话，悬停卡片仍显示全部 7 次聊天
    setConversationListView('by-endpoint');
    setEndpointFilter('claude');
    const r = mount();
    const groups = await r.findAllByTestId('workspace-group');
    const app = groups.find((g) => g.dataset.project === 'p_app')!;
    const head = within(app).getByTestId('workspace-toggle').parentElement!;

    fireEvent.mouseEnter(head);
    const peek = await r.findByTestId('project-peek');
    expect(peek.getAttribute('data-project')).toBe('p_app');
    expect(peek.textContent).toContain('app');
    expect(within(peek).getByTestId('project-peek-chats').textContent).toBe('7 次聊天');

    const folders = within(peek).getAllByTestId('project-peek-folder');
    expect(folders.map((f) => f.textContent)).toEqual(['/work/app', '/work/server']);
    expect(folders[0]!.getAttribute('data-primary')).toBe('true');
    expect(folders[1]!.getAttribute('data-missing')).toBe('true');

    // 图标按钮禁加原生 title，仅用 aria-label
    const pinBtn = within(peek).getByTestId('project-peek-pin');
    expect(pinBtn.getAttribute('title')).toBeNull();
    expect(pinBtn.getAttribute('aria-label')).toBe('置顶项目');

    // 鼠标移出项目头但进入弹窗卡片时，弹窗保持打开；离开卡片后收起
    fireEvent.mouseLeave(head);
    fireEvent.mouseEnter(peek);
    await new Promise((res) => setTimeout(res, 240));
    expect(r.queryByTestId('project-peek')).toBeTruthy();

    fireEvent.mouseLeave(peek);
    await waitFor(() => expect(r.queryByTestId('project-peek')).toBeNull());
  });

  it('悬停卡片内可点击置顶项目（排到最前）或点击编辑项目（打开弹窗并关闭悬停卡）', async () => {
    const r = mount();
    const groups = await r.findAllByTestId('workspace-group');
    const empty = groups.find((g) => g.dataset.project === 'p_empty')!;
    const head = within(empty).getByTestId('workspace-toggle').parentElement!;

    fireEvent.mouseEnter(head);
    const peek = await r.findByTestId('project-peek');
    fireEvent.click(within(peek).getByTestId('project-peek-pin'));

    await waitFor(() => {
      const ids = r.getAllByTestId('workspace-group').map((g) => g.dataset.project);
      expect(ids[0]).toBe('p_empty');
    });
    expect(getPinnedProjects().p_empty).toBeGreaterThan(0);
    const pinnedFirst = r.getAllByTestId('workspace-group')[0]!;
    expect(pinnedFirst.getAttribute('data-pinned')).toBe('true');
    expect(within(pinnedFirst).getByTestId('project-pinned')).toBeTruthy();

    // 再点一次取消置顶，恢复按最近活动排序
    fireEvent.click(within(r.getByTestId('project-peek')).getByTestId('project-peek-pin'));
    await waitFor(() => {
      const ids = r.getAllByTestId('workspace-group').map((g) => g.dataset.project);
      expect(ids).toEqual(['p_app', 'p_api', 'p_empty']);
    });
    expect(getPinnedProjects().p_empty).toBeUndefined();

    // 点击「编辑项目」关闭悬停卡片并打开 ProjectDialog
    fireEvent.click(within(r.getByTestId('project-peek')).getByTestId('project-peek-edit'));
    await waitFor(() => expect(r.queryByTestId('project-peek')).toBeNull());
    const dialog = await r.findByTestId('project-dialog');
    expect(dialog.textContent).toContain('编辑项目');
  });

  it('按 Escape 关闭项目悬停弹窗；相邻项目头之间切换无闪烁', async () => {
    const r = mount();
    const groups = await r.findAllByTestId('workspace-group');
    const headApp = within(groups[0]!).getByTestId('workspace-toggle').parentElement!;
    const headApi = within(groups[1]!).getByTestId('workspace-toggle').parentElement!;

    fireEvent.mouseEnter(headApp);
    const peek1 = await r.findByTestId('project-peek');
    expect(peek1.getAttribute('data-project')).toBe('p_app');

    // 从当前已显示的项目头滑到相邻项目头：立即更新内容
    fireEvent.mouseLeave(headApp);
    fireEvent.mouseEnter(headApi);
    await waitFor(() =>
      expect(r.getByTestId('project-peek').getAttribute('data-project')).toBe('p_api'),
    );

    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(r.queryByTestId('project-peek')).toBeNull());
  });
});
