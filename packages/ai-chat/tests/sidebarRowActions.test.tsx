// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetConfirmDialogForTest } from '../src/components/ConfirmDialog';
import { Sidebar } from '../src/components/Sidebar';
import { HarnessTabsProvider } from '../src/contexts/HarnessTabsContext';
import { setChatMode } from '../src/services/chatPrefs';
import { CONVERSATIONS_CHANGED_EVENT } from '../src/services/conversationStore';
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
let tabStatus = 'idle';
const updateMeta = vi.fn();
const setArchived = vi.fn();
const setPinned = vi.fn();
const deleteConversation = vi.fn(async () => undefined);
const onForkRequest = vi.fn();

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
        setArchived,
        setPinned,
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
        tabs: [{ id: 't1', backend: 'claude', cwd: '/w', status: tabStatus, unread: 0 }],
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

/** 「本机历史」默认折叠：这里的用例都要看历史行，挂载后自动点开一次 */
function expandLocalHistory(r: ReturnType<typeof render>) {
  void r
    .findByTestId('cli-history-toggle')
    .then((t) => {
      if (t.getAttribute('aria-expanded') === 'false') fireEvent.click(t);
    })
    .catch(() => undefined);
  return r;
}

const mount = (collapsed = false, onToggle: () => void = () => undefined) =>
  expandLocalHistory(
    render(
      <HarnessTabsProvider>
        <Sidebar
          collapsed={collapsed}
          onToggle={onToggle}
          onNewChat={() => undefined}
          onForkRequest={onForkRequest}
        />
      </HarnessTabsProvider>,
    ),
  );

/** 自管 collapsed，便于测「折叠态重命名先展开」（#163） */
function MountCollapsed() {
  const [collapsed, setCollapsed] = React.useState(true);
  return (
    <HarnessTabsProvider>
      <Sidebar
        collapsed={collapsed}
        onToggle={() => setCollapsed((c) => !c)}
        onNewChat={() => undefined}
        onForkRequest={onForkRequest}
      />
    </HarnessTabsProvider>
  );
}
const row = (r: ReturnType<typeof mount>, id: string) =>
  r.container
    .querySelector(`[data-conversation-id="${id}"]`)!
    .closest('[data-testid="conversation-row"]') as HTMLElement;

beforeEach(() => {
  setChatMode('dev');
  tabStatus = 'idle';
  updateMeta.mockClear();
  setArchived.mockClear();
  setPinned.mockClear();
  deleteConversation.mockClear();
  onForkRequest.mockClear();
  convs = [
    conv('n1', '周报', 'nomi', 1),
    conv('n2', '今天的待办', 'nomi', 2),
    conv('c1', 'Refactor login flow', 'claude', 4, { tabId: 't1' }),
  ];
  mockIpc();
});
afterEach(() => {
  cleanup();
  resetConfirmDialogForTest();
  localStorage.clear();
  resetFakeApi();
  vi.restoreAllMocks();
});

describe('sidebar row actions', () => {
  it('列表在外部改动（如分叉）后收到 conversations-changed 立即刷新（D1 回归）', async () => {
    setChatMode('normal');
    const r = mount();
    await waitFor(() => r.getAllByTestId('history-item'));
    expect(r.container.querySelector('[data-conversation-id="n3"]')).toBeNull();
    convs = [conv('n3', '周报 (副本)', 'nomi', 0), ...convs];
    act(() => {
      window.dispatchEvent(new Event(CONVERSATIONS_CHANGED_EVENT));
    });
    await waitFor(() =>
      expect(r.container.querySelector('[data-conversation-id="n3"]')).not.toBeNull(),
    );
  });

  it('every conversation row carries pin / archive / more icon buttons with tooltips + aria-labels', async () => {
    const r = mount();
    await waitFor(() => r.getAllByTestId('history-item'));
    const w = within(row(r, 'n2'));
    for (const [id, label] of [
      ['row-pin', '置顶聊天'],
      ['row-archive', '归档'],
      ['row-more', '更多操作'],
    ] as const) {
      const b = w.getByTestId(id);
      expect(b.getAttribute('aria-label')).toBe(label);
      expect(b.getAttribute('title')).toBe(label);
    }
    // 标签行：垃圾桶就是「关闭标签」
    expect(within(row(r, 'c1')).getByTestId('row-delete').getAttribute('aria-label')).toBe(
      '关闭标签',
    );
    // 不为每行常驻挂载菜单
    expect(r.queryByTestId('conversation-context-menu')).toBeNull();
    // 按钮是兄弟节点，不是嵌套在行按钮里
    expect(row(r, 'n2').querySelectorAll('button button')).toHaveLength(0);
  });

  it('没有重命名按钮；悬停卡片里点标题改名：Enter 保存，Esc 取消', async () => {
    const r = mount();
    await waitFor(() => r.getAllByTestId('history-item'));
    expect(within(row(r, 'n2')).queryByTestId('row-rename')).toBeNull();
    fireEvent.mouseEnter(row(r, 'n2'));
    fireEvent.click(await screen.findByTestId('session-peek-title'));
    let input = screen.getByTestId('session-peek-rename-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '新名字' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(updateMeta).toHaveBeenCalledWith('n2', { name: '新名字' });

    updateMeta.mockClear();
    fireEvent.mouseEnter(row(r, 'n2'));
    fireEvent.click(await screen.findByTestId('session-peek-title'));
    input = screen.getByTestId('session-peek-rename-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '不要' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(updateMeta).not.toHaveBeenCalled();
    expect(screen.queryByTestId('session-peek-rename-input')).toBeNull();
  });

  it('置顶按钮：置顶 / 取消置顶；置顶的会话在最上面的「置顶」里', async () => {
    const r = mount();
    await waitFor(() => r.getAllByTestId('history-item'));
    fireEvent.click(within(row(r, 'n2')).getByTestId('row-pin'));
    expect(setPinned).toHaveBeenCalledWith('n2', true);
    cleanup();
    convs = convs.map((c) => (c.id === 'n2' ? { ...c, pinnedAt: now } : c));
    const again = mount();
    const pinned = await again.findByTestId('pinned-section');
    expect(pinned.querySelector('[data-conversation-id="n2"]')).toBeTruthy();
    const btn = within(row(again, 'n2')).getByTestId('row-pin');
    expect(btn.getAttribute('aria-label')).toBe('取消置顶');
    fireEvent.click(btn);
    expect(setPinned).toHaveBeenCalledWith('n2', false);
  });

  it('archive icon archives a nomi conversation at once; permanent delete is in the menu and asks first', async () => {
    const r = mount();
    await waitFor(() => r.getAllByTestId('history-item'));
    fireEvent.click(within(row(r, 'n2')).getByTestId('row-archive'));
    expect(setArchived).toHaveBeenCalledWith('n2', true);
    expect(deleteConversation).not.toHaveBeenCalled();

    fireEvent.click(within(row(r, 'n2')).getByTestId('row-more'));
    expect(r.getByTestId('conversation-archive')).toBeTruthy();
    fireEvent.click(r.getByTestId('conversation-delete'));
    expect((await screen.findByTestId('confirm-dialog')).textContent).toContain('永久删除');
    fireEvent.click(screen.getByTestId('confirm-dialog-cancel'));
    await waitFor(() => expect(screen.queryByTestId('confirm-dialog')).toBeNull());
    expect(deleteConversation).not.toHaveBeenCalled();

    fireEvent.click(within(row(r, 'n2')).getByTestId('row-more'));
    fireEvent.click(r.getByTestId('conversation-delete'));
    fireEvent.click(await screen.findByTestId('confirm-dialog-ok'));
    await waitFor(() => expect(deleteConversation).toHaveBeenCalledWith('n2'));
  });

  it('archived conversations are not listed in the sidebar', async () => {
    convs = [...convs, conv('n3', '已经归档的', 'nomi', 3, { archivedAt: now })];
    const r = mount();
    await waitFor(() => r.getAllByTestId('history-item'));
    expect(r.container.querySelector('[data-conversation-id="n3"]')).toBeNull();
    expect(r.container.querySelector('[data-conversation-id="n2"]')).toBeTruthy();
  });

  it('cli tab: trash closes the tab; a running tab keeps the close confirmation (in-app)', async () => {
    tabStatus = 'running';
    const r = mount();
    await waitFor(() => r.getAllByTestId('history-item'));
    await waitFor(() => expect(within(row(r, 'c1')).getByTestId('row-delete')).toBeTruthy());
    fireEvent.click(within(row(r, 'c1')).getByTestId('row-delete'));
    expect((await screen.findByTestId('confirm-dialog')).textContent).toContain(
      '该标签仍在运行，关闭会中止它。确定关闭？',
    );
    fireEvent.click(screen.getByTestId('confirm-dialog-cancel'));
    await waitFor(() => expect(screen.queryByTestId('confirm-dialog')).toBeNull());
    expect(calls.some(([ch]) => ch === 'harness.tabClose')).toBe(false);
    fireEvent.click(within(row(r, 'c1')).getByTestId('row-delete'));
    fireEvent.click(await screen.findByTestId('confirm-dialog-ok'));
    await waitFor(() =>
      expect(calls.some(([ch, a]) => ch === 'harness.tabClose' && a.id === 't1')).toBe(true),
    );
  });

  it('idle cli tab closes without asking', async () => {
    const r = mount();
    await waitFor(() => r.getAllByTestId('history-item'));
    fireEvent.click(within(row(r, 'c1')).getByTestId('row-delete'));
    await waitFor(() => expect(calls.some(([ch]) => ch === 'harness.tabClose')).toBe(true));
    expect(screen.queryByTestId('confirm-dialog')).toBeNull();
  });

  it('"more" opens the shared conversation menu on demand (same as right click)', async () => {
    const r = mount();
    await waitFor(() => r.getAllByTestId('history-item'));
    fireEvent.click(within(row(r, 'n2')).getByTestId('row-more'));
    const menu = r.getByTestId('conversation-context-menu');
    expect(within(menu).getByTestId('fork-same')).toBeTruthy();
    expect(within(menu).getByTestId('conversation-delete')).toBeTruthy();
    fireEvent.click(within(menu).getByTestId('fork-same'));
    expect(onForkRequest).toHaveBeenCalledWith('n2');
    expect(r.queryByTestId('conversation-context-menu')).toBeNull();
    // 右键得到同一份菜单
    fireEvent.contextMenu(r.container.querySelector('[data-conversation-id="c1"]')!);
    expect(
      within(r.getByTestId('conversation-context-menu')).getByTestId('conversation-close'),
    ).toBeTruthy();
  });

  it('disk history rows: no rename / fork; "more" opens in a tab or deletes', async () => {
    const r = mount();
    const item = await waitFor(() => r.getByTestId('history-session-item'));
    const hrow = item.closest('[data-testid="history-session-row"]') as HTMLElement;
    const w = within(hrow);
    expect(w.queryByTestId('row-rename')).toBeNull();
    expect(w.getByTestId('row-delete')).toBeTruthy();
    fireEvent.click(w.getByTestId('row-more'));
    const menu = r.getByTestId('conversation-context-menu');
    expect(within(menu).queryByTestId('conversation-rename')).toBeNull();
    expect(within(menu).getByTestId('conversation-delete')).toBeTruthy();
    expect(within(menu).queryByTestId('fork-same')).toBeNull();
    fireEvent.click(within(menu).getByTestId('conversation-open'));
    await waitFor(() =>
      expect(calls.some(([ch, a]) => ch === 'history.open' && a.sessionId === 's9')).toBe(true),
    );
  });

  it('deleting a disk history row asks in-app first, then trashes it and refreshes the list', async () => {
    const r = mount();
    const item = await waitFor(() => r.getByTestId('history-session-item'));
    const w = within(item.closest('[data-testid="history-session-row"]') as HTMLElement);
    fireEvent.click(w.getByTestId('row-delete'));
    expect((await screen.findByTestId('confirm-dialog')).textContent).toContain(
      'disk codex session',
    );
    fireEvent.click(screen.getByTestId('confirm-dialog-cancel'));
    await waitFor(() => expect(screen.queryByTestId('confirm-dialog')).toBeNull());
    expect(calls.some(([ch]) => ch === 'history.delete')).toBe(false);

    const listsBefore = calls.filter(([ch]) => ch === 'history.list').length;
    fireEvent.click(w.getByTestId('row-delete'));
    fireEvent.click(await screen.findByTestId('confirm-dialog-ok'));
    await waitFor(() =>
      expect(calls.some(([ch, a]) => ch === 'history.delete' && a.sessionId === 's9')).toBe(true),
    );
    await waitFor(() =>
      expect(calls.filter(([ch]) => ch === 'history.list').length).toBeGreaterThan(listsBefore),
    );
  });

  it('works in normal mode too (nomi rows only)', async () => {
    setChatMode('normal');
    const r = mount();
    await waitFor(() => r.getAllByTestId('history-item'));
    expect(r.queryByTestId('cli-history')).toBeNull();
    const w = within(row(r, 'n2'));
    expect(w.getByTestId('row-pin')).toBeTruthy();
    expect(w.getByTestId('row-more')).toBeTruthy();
  });

  it('the current row carries the active flag (highlight only; actions reveal on hover/focus via CSS)', async () => {
    const r = mount();
    await waitFor(() => r.getAllByTestId('history-item'));
    expect(row(r, 'n1').hasAttribute('data-active')).toBe(true);
    expect(row(r, 'n2').hasAttribute('data-active')).toBe(false);
  });

  it('one fork entry in every menu: it opens the fork dialog (new session or another endpoint is chosen there)', async () => {
    const r = mount();
    await waitFor(() => r.getAllByTestId('history-item'));
    fireEvent.click(within(row(r, 'n2')).getByTestId('row-more'));
    let menu = r.getByTestId('conversation-context-menu');
    expect(within(menu).getByTestId('fork-same').textContent).toBe('分叉对话');
    expect(within(menu).queryByTestId('fork-cross')).toBeNull();
    fireEvent.click(within(menu).getByTestId('fork-same'));
    expect(onForkRequest).toHaveBeenCalledWith('n2');
    fireEvent.contextMenu(r.container.querySelector('[data-conversation-id="n1"]')!);
    menu = r.getByTestId('conversation-context-menu');
    expect(within(menu).getByTestId('fork-same')).toBeTruthy();
    expect(within(menu).queryByTestId('fork-cross')).toBeNull();
  });
});
