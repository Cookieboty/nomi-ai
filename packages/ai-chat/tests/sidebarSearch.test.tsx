// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Sidebar } from '../src/components/Sidebar';
import { HarnessTabsProvider } from '../src/contexts/HarnessTabsContext';
import { setChatMode } from '../src/services/chatPrefs';
import { HISTORY_MAX_ITEMS, type HistorySession } from '../src/services/historyClient';

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
let currentId = 'n1';
const switchConversation = vi.fn(async () => undefined);
const listConversations = vi.fn(async () => convs);
const FIRST: Record<string, string> = { n2: '帮我整理 login 日志，按天归档' };

// 与生产一致：state.ipcClient 与 conversationStore() 是稳定引用。每次调用都返回新对象会让
// Sidebar 的 refresh effect 每次渲染都重跑（每秒数千次），慢的 CI 机器上把其他等待拖到超时。
vi.mock('../src/contexts/AiChatContext', () => {
  let api: unknown;
  return {
    useAiChat: () => {
      if (api) return api;
      const store = {
        upsertFromTab: () => undefined,
        removeByTabId: () => undefined,
        list: () => convs,
        currentId: () => currentId,
        ensureCurrent: () => currentId ?? 'new',
        get: (id: string) => convs.find((x) => x.id === id),
        updateMeta: () => undefined,
        getMessages: (id: string) => (FIRST[id] ? [{ role: 'user', content: FIRST[id] }] : []),
        firstUserPreview: (id: string) => FIRST[id] ?? '',
      };
      api = {
        state: {
          messages: [],
          ipcClient: {
            listConversations,
            currentConversationId: () => currentId,
            switchConversation,
            conversationStore: () => store,
          },
        },
        actions: { loadChatHistory: async () => undefined },
      };
      return api;
    },
  };
});

const h = (backend: HistorySession['backend'], i: number, o: Partial<HistorySession> = {}) =>
  ({
    key: `${backend}:${i}`,
    backend,
    sessionId: `${backend}-${i}`,
    title: `${backend} task ${i}`,
    cwd: '/work/app',
    cwdMissing: false,
    updatedAt: now - (i + 10) * 60_000,
    ...o,
  }) as HistorySession;

let indexPages: Record<string, HistorySession[][]> = {};
let calls: Array<[string, unknown[]]> = [];

function mockIpc() {
  calls = [];
  const invoke = vi.fn(async (ch: string, ...args: unknown[]) => {
    calls.push([ch, args]);
    if (ch === 'ai:harness:tabs')
      return {
        tabs: [
          { id: 't1', backend: 'claude', cwd: '/work/pay-service', status: 'idle', unread: 0 },
        ],
        activeTabId: 'main',
        running: 0,
        queued: 0,
      };
    if (ch === 'ai:harness:state')
      return { backend: 'nomi', cwd: '/w', bins: { claude: '/c', codex: '/x', dsh: null } };
    if (ch === 'ai:harness:recent-cwds') return [];
    if (ch === 'ai:history:list') {
      const [b] = args as [string];
      return {
        items: b === 'claude' ? [h('claude', 1)] : b === 'codex' ? [h('codex', 2)] : [],
        nextOffset: null,
        hasMore: false,
      };
    }
    if (ch === 'ai:history:index') {
      const [b, o] = args as [string, { offset?: number; limit?: number }];
      const pages = indexPages[b] ?? [[]];
      // offset 是文件游标：每页 20 条（与后端 HISTORY_PAGE_SIZE 一致）
      const pi = (o.offset ?? 0) / 20;
      const items = pages[pi] ?? [];
      const more = pi + 1 < pages.length;
      return { items, nextOffset: more ? (o.offset ?? 0) + 20 : null, hasMore: more };
    }
    if (ch === 'ai:history:open') return { ok: true };
    return {};
  });
  (window as unknown as { aiIPC: unknown }).aiIPC = { invoke, on: () => () => undefined };
}

const mount = (onNewChat = vi.fn()) =>
  render(
    <HarnessTabsProvider>
      <Sidebar collapsed={false} onToggle={() => undefined} onNewChat={onNewChat} />
    </HarnessTabsProvider>,
  );

const type = async (r: ReturnType<typeof mount>, text: string) => {
  fireEvent.click(r.getByTestId('sidebar-search-toggle'));
  const input = r.getByTestId('sidebar-search-input') as HTMLInputElement;
  fireEvent.change(input, { target: { value: text } });
  return input;
};
const titles = (r: ReturnType<typeof mount>) =>
  r.queryAllByTestId('search-result').map((x) => x.textContent ?? '');

beforeEach(() => {
  setChatMode('dev');
  currentId = 'n1';
  switchConversation.mockClear();
  listConversations.mockClear();
  convs = [
    conv('n1', '周报', 'nomi', 1),
    conv('n2', '今天的待办', 'nomi', 2),
    conv('n3', '登录页样式', 'nomi', 3),
    conv('c1', 'Refactor login flow', 'claude', 4, { tabId: 't1' }),
  ];
  indexPages = {
    claude: [[h('claude', 1), h('claude', 5, { title: 'Fix payment webhook' })]],
    codex: [[h('codex', 2)]],
  };
  mockIpc();
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  delete (window as { aiIPC?: unknown }).aiIPC;
});

describe('sidebar search', () => {
  it('top row: logo + Nomi, search icon and a new-chat icon; no full-width new-chat button', async () => {
    const r = mount();
    await waitFor(() => r.getAllByTestId('history-item'));
    expect(r.getAllByText('Nomi').length).toBeGreaterThan(0);
    expect(r.getAllByTestId('endpoint-icon-nomi').length).toBeGreaterThan(0);
    expect(r.getByTestId('sidebar-search-toggle').getAttribute('aria-label')).toBe('搜索对话');
    const nb = r.getByTestId('new-chat');
    expect(nb.getAttribute('aria-label')).toBe('新对话');
    expect(nb.getAttribute('title')).toContain('新对话');
    expect(nb.textContent).toBe(''); // 只有图标，没有整行文字
  });

  it('settles after mount instead of refreshing the list in a loop', async () => {
    const r = mount();
    await waitFor(() => r.getAllByTestId('history-session-item'));
    const settled = listConversations.mock.calls.length;
    await act(() => new Promise((res) => setTimeout(res, 300)));
    expect(listConversations.mock.calls.length - settled).toBeLessThanOrEqual(2);
  });

  it('filters in real time (150ms debounce) over title, first message, workspace and endpoint name', async () => {
    const r = mount();
    await waitFor(() => r.getAllByTestId('history-item'));
    const input = await type(r, '登录');
    // 防抖：立刻还在原列表
    expect(r.queryAllByTestId('search-result')).toHaveLength(0);
    await waitFor(() => expect(titles(r).some((t) => t.includes('登录页样式'))).toBe(true));
    expect(r.getByRole('search')).toBeTruthy();
    expect(r.getByRole('listbox')).toBeTruthy();
    // 首条用户消息（Nomi 会话 n2）
    fireEvent.change(input, { target: { value: '按天归档' } });
    await waitFor(() => expect(titles(r)[0] ?? '').toContain('今天的待办'));
    expect(titles(r)).toHaveLength(1);
    // 工作区路径（CLI 标签）
    fireEvent.change(input, { target: { value: 'pay-service' } });
    await waitFor(() => expect(titles(r)[0] ?? '').toContain('Refactor login flow'));
    expect(titles(r)).toHaveLength(1);
    // 端点名
    fireEvent.change(input, { target: { value: 'claude code' } });
    await waitFor(() => expect(titles(r).length).toBeGreaterThanOrEqual(1));
    // 磁盘历史（来自主进程索引）
    fireEvent.change(input, { target: { value: 'webhook' } });
    await waitFor(() => expect(titles(r)[0] ?? '').toContain('Fix payment webhook'));
    expect(r.getByTestId('search-result').getAttribute('data-kind')).toBe('hist');
  });

  it('highlights the matched fragment', async () => {
    const r = mount();
    await waitFor(() => r.getAllByTestId('history-item'));
    await type(r, 'login');
    await waitFor(() => expect(r.container.querySelectorAll('mark').length).toBeGreaterThan(0));
    expect(r.container.querySelector('mark')!.textContent!.toLowerCase()).toBe('login');
  });

  it('keyboard: ↑/↓ moves, Enter opens, Esc clears then closes', async () => {
    const r = mount();
    await waitFor(() => r.getAllByTestId('history-item'));
    const input = await type(r, '登录');
    await waitFor(() => r.getAllByTestId('search-result'));
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(switchConversation).toHaveBeenCalledWith('n3'));
    fireEvent.keyDown(input, { key: 'Escape' });
    expect((r.getByTestId('sidebar-search-input') as HTMLInputElement).value).toBe('');
    fireEvent.keyDown(r.getByTestId('sidebar-search-input'), { key: 'Escape' });
    expect(r.queryByTestId('sidebar-search-input')).toBeNull();
    expect(r.getByTestId('sidebar-search-toggle')).toBeTruthy();
  });

  it('clicking a disk-history result opens it through the main process', async () => {
    const r = mount();
    await waitFor(() => r.getAllByTestId('history-item'));
    await type(r, 'webhook');
    await waitFor(() => r.getByTestId('search-result'));
    fireEvent.click(r.getByTestId('search-result'));
    await waitFor(() =>
      expect(calls.some(([c, a]) => c === 'ai:history:open' && a[1] === 'claude-5')).toBe(true),
    );
  });

  it('a session known to both the paged list and the index appears once', async () => {
    const r = mount();
    await waitFor(() => r.getAllByTestId('history-session-item'));
    await type(r, 'claude task 1');
    await waitFor(() => r.getAllByTestId('search-result'));
    const keys = r
      .getAllByTestId('search-result')
      .map((x) => x.getAttribute('data-session-id'))
      .filter(Boolean);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.filter((k) => k === 'claude-1')).toHaveLength(1);
  });

  it('hides local history when the same CLI session is already mirrored in conversations', async () => {
    convs = convs.map((c) => (c.id === 'c1' ? { ...c, cliSessionId: '1' } : c));
    const r = mount();
    await waitFor(() => r.getAllByTestId('history-session-item'));
    expect(
      r.getAllByTestId('history-session-item').some((x) => x.dataset.sessionId === 'claude-1'),
    ).toBe(false);

    await type(r, 'claude task 1');
    await waitFor(() => r.getByTestId('sidebar-search-empty'));
    expect(r.queryAllByTestId('search-result')).toHaveLength(0);
  });

  it('no match: empty state, and "搜索更早的历史" fetches the next page', async () => {
    indexPages.claude = [[h('claude', 1)], [h('claude', 7, { title: 'ancient zebra migration' })]];
    const r = mount();
    await waitFor(() => r.getAllByTestId('history-item'));
    // 第一页没有 zebra → 空态且可加载更早（等第一页加载完、按钮出现）
    await type(r, 'zebra');
    await waitFor(() => r.getByTestId('sidebar-search-more'));
    expect(r.getByTestId('sidebar-search-empty').textContent).toBe('没有匹配的会话');
    // 点「搜索更早的历史」取下一页 → 命中
    fireEvent.click(r.getByTestId('sidebar-search-more'));
    await waitFor(() => expect(titles(r).some((t) => t.includes('zebra'))).toBe(true));
    fireEvent.change(r.getByTestId('sidebar-search-input'), { target: { value: 'qqqqzzzz' } });
    await waitFor(() => r.getByTestId('sidebar-search-empty'));
    expect(r.getByTestId('sidebar-search-empty').textContent).toBe('没有匹配的会话');
  });

  it('by-endpoint view: search is scoped to the selected endpoint', async () => {
    localStorage.setItem('ai-chat:conversationListView', 'by-endpoint');
    localStorage.setItem('ai-chat:endpointFilter', 'claude');
    const r = mount();
    await waitFor(() => r.getAllByTestId('history-item'));
    await type(r, 'task');
    await waitFor(() => r.getAllByTestId('search-result'));
    expect(
      r.getAllByTestId('search-result').every((x) => x.getAttribute('data-backend') === 'claude'),
    ).toBe(true);
  });

  it('search state does not break the context menu', async () => {
    const r = mount();
    await waitFor(() => r.getAllByTestId('history-item'));
    await type(r, '周报');
    const row = await waitFor(() => r.getByTestId('search-result'));
    fireEvent.contextMenu(row);
    await waitFor(() =>
      expect(r.container.ownerDocument.querySelector('[role="menu"]')).toBeTruthy(),
    );
  });
});

describe('large history', () => {
  it('搜索时先取第一页（20），「搜索更早的历史」逐页加载，最多索引到每端硬上限条', async () => {
    const pages = HISTORY_MAX_ITEMS / 20;
    const page = (p: number) =>
      Array.from({ length: 20 }, (_, i) => h('claude', p * 20 + i, { title: `bulk ${p}-${i}` }));
    // 比硬上限多一页，但前端只索引到第 HISTORY_MAX_ITEMS 条
    indexPages = { claude: Array.from({ length: pages + 1 }, (_, p) => page(p)), codex: [[]] };
    const r = mount();
    await waitFor(() => r.getAllByTestId('history-item'));
    await type(r, 'qqqzzzxxx');
    await waitFor(() => r.getByTestId('sidebar-search-empty'));
    // 空态可能先于索引请求渲染（慢机器上更明显），等请求记录到再断言
    await waitFor(() =>
      expect(calls.filter(([c, a]) => c === 'ai:history:index' && a[0] === 'claude')).toHaveLength(
        1,
      ),
    );
    // 逐页点到最后一页为止：累计到硬上限后前端主动收尾，按钮消失。
    // loading 期间按钮是 disabled，需要等它恢复可用再点
    const clickMoreWhenEnabled = async () => {
      await waitFor(() =>
        expect((r.getByTestId('sidebar-search-more') as HTMLButtonElement).disabled).toBe(false),
      );
      fireEvent.click(r.getByTestId('sidebar-search-more'));
    };
    for (let p = 1; p < pages; p++) {
      const off = p * 20;
      await clickMoreWhenEnabled();
      await waitFor(() =>
        expect(
          calls.filter(
            ([c, a]) => c === 'ai:history:index' && (a[1] as { offset?: number }).offset === off,
          ),
        ).toHaveLength(1),
      );
    }
    // 到硬上限；多出来的那一页不会再被请求
    expect(calls.filter(([c, a]) => c === 'ai:history:index' && a[0] === 'claude')).toHaveLength(
      pages,
    );
    await waitFor(() => expect(r.queryByTestId('sidebar-search-more')).toBeNull());
  }, 30_000);

  it('renders at most 100 results and says so', async () => {
    // claude 与 codex 各 5 页 × 20 = 各 100 条同名命中 → 合并候选 200 条，超过渲染上限 100
    const makePages = (backend: 'claude' | 'codex') =>
      [0, 1, 2, 3, 4].map((p) =>
        Array.from({ length: 20 }, (_, i) =>
          h(backend, p * 20 + i, {
            key: `${backend}:${p * 20 + i}`,
            title: `same title ${p * 20 + i}`,
          }),
        ),
      );
    indexPages = { claude: makePages('claude'), codex: makePages('codex') };
    const r = mount();
    await waitFor(() => r.getAllByTestId('history-item'));
    await type(r, 'same title');
    // 首页自动取（各 20），再点 4 次「更早」把两端都取满到 100；每次点击前按钮须仍在
    for (let n = 0; n < 4; n++) {
      await waitFor(() => r.getByTestId('sidebar-search-more'));
      fireEvent.click(r.getByTestId('sidebar-search-more'));
    }
    await waitFor(() => r.getByTestId('sidebar-search-capped'), { timeout: 5000 });
    expect(r.getAllByTestId('search-result')).toHaveLength(100);
  });
});

describe('normal mode: Nomi only', () => {
  beforeEach(() => setChatMode('normal'));

  it('hides the all/by-endpoint switch, CLI sessions and the history group; new chat is direct', async () => {
    localStorage.setItem('ai-chat:conversationListView', 'by-endpoint');
    const onNewChat = vi.fn();
    const r = mount(onNewChat);
    await waitFor(() => expect(r.getAllByTestId('history-item')).toHaveLength(3));
    expect(r.queryByTestId('list-view-all')).toBeNull();
    expect(r.queryByTestId('cli-history')).toBeNull();
    expect(r.queryAllByTestId('history-item').every((x) => x.dataset.backend === 'nomi')).toBe(
      true,
    );
    fireEvent.click(r.getByTestId('new-chat'));
    await waitFor(() => expect(onNewChat).toHaveBeenCalled());
    expect(r.queryByTestId('new-chat-menu')).toBeNull();
    expect(calls.some(([c]) => c === 'ai:history:list' || c === 'ai:history:index')).toBe(false);
  });

  it('search only covers Nomi conversations', async () => {
    const r = mount();
    await waitFor(() => r.getAllByTestId('history-item'));
    await type(r, 'login');
    await waitFor(() => expect(r.queryAllByTestId('search-result').length).toBeGreaterThan(0));
    expect(
      r.getAllByTestId('search-result').every((x) => x.getAttribute('data-backend') === 'nomi'),
    ).toBe(true);
    expect(calls.some(([c]) => c === 'ai:history:index')).toBe(false);
  });

  it('switching back to dev mode restores the saved view (by-endpoint) and the switch', async () => {
    localStorage.setItem('ai-chat:conversationListView', 'by-endpoint');
    localStorage.setItem('ai-chat:endpointFilter', 'claude');
    const r = mount();
    await waitFor(() => r.getAllByTestId('history-item'));
    expect(r.queryByTestId('list-view-all')).toBeNull();
    act(() => setChatMode('dev'));
    await waitFor(() => r.getByTestId('list-view-all'));
    expect(r.getByTestId('list-view-all').getAttribute('aria-pressed')).toBe('false');
    expect(r.getByTestId('endpoint-filter-claude').getAttribute('aria-pressed')).toBe('true');
  });
});

describe('normal mode: current CLI conversation is swapped for a Nomi one', () => {
  it('switches to the most recent Nomi conversation when the selected one is a CLI session', async () => {
    currentId = 'c1';
    setChatMode('normal');
    mount();
    await waitFor(() => expect(switchConversation).toHaveBeenCalledWith('n1'));
  });

  it('does nothing when the selected conversation is already a Nomi one', async () => {
    currentId = 'n2';
    setChatMode('normal');
    const r = mount();
    await waitFor(() => r.getAllByTestId('history-item'));
    expect(switchConversation).not.toHaveBeenCalled();
  });
});
