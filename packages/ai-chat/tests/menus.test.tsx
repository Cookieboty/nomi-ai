// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetConfirmDialogForTest } from '../src/components/ConfirmDialog';
import { Sidebar } from '../src/components/Sidebar';
import { HarnessTabsProvider } from '../src/contexts/HarnessTabsContext';
import { setChatMode } from '../src/services/chatPrefs';
import type { HarnessTabMeta, HarnessTabsState } from '../src/services/harnessClient';

import { installFakeApi, resetFakeApi } from './helpers/fakeApi';

vi.mock('../src/services/api', async () => (await import('./helpers/fakeApi')).fakeApiModule());

const updateMeta = vi.fn();
const loadChatHistory = vi.fn(async () => undefined);
const clearChatHistory = vi.fn(async () => undefined);
let currentId: string | undefined = 'b';
const list: Array<Record<string, unknown>> = [
  { id: 'a', name: '修复登录', backend: 'codex', createdAt: 1, updatedAt: Date.now(), tabId: 't1' },
  { id: 'b', name: '聊聊天气', backend: 'nomi', createdAt: 1, updatedAt: Date.now() - 1000 },
];
// 与 ConversationStore.delete 一致：删当前项时切到同后端最近更新的会话，没有则留空
const deleteConversation = vi.fn(async (id: string) => {
  const i = list.findIndex((x) => x.id === id);
  if (i < 0) return;
  const removed = list.splice(i, 1)[0]!;
  if (currentId === id) {
    currentId = list
      .filter((x) => x.backend === removed.backend)
      .sort((x, y) => (y.updatedAt as number) - (x.updatedAt as number))[0]?.id as
      string | undefined;
  }
});

// 返回稳定引用（与生产一致）；每次新对象会让 Sidebar 的 refresh effect 每次渲染都重跑。
// 首次调用时才建对象：此时文件顶层的 vi.fn 已初始化。
vi.mock('../src/contexts/AiChatContext', () => {
  let api: unknown;
  return {
    useAiChat: () => {
      if (api) return api;
      const store = {
        updateMeta,
        upsertFromTab: () => undefined,
        list: () => [],
        removeByTabId: () => undefined,
        ensureCurrent: () => currentId,
        get: (id: string) => list.find((x) => x.id === id),
      };
      api = {
        state: {
          messages: [],
          ipcClient: {
            listConversations: async () => list,
            currentConversationId: () => currentId,
            conversationStore: () => store,
            deleteConversation,
          },
        },
        actions: { loadChatHistory, clearChatHistory },
      };
      return api;
    },
  };
});

const tab = (o: Partial<HarnessTabMeta>): HarnessTabMeta => ({
  id: 't1',
  title: '修复登录',
  backend: 'codex',
  cwd: '/w',
  cliSessionId: null,
  status: 'idle',
  unread: 0,
  createdAt: 0,
  updatedAt: 0,
  ...o,
});
const tabsState: HarnessTabsState = {
  tabs: [tab({ id: 'main', backend: 'nomi', title: 'Nomi' }), tab({})],
  activeTabId: 't1',
  running: 0,
  queued: 0,
};

function mockIpc() {
  const invoke = vi.fn(async (ch: string, _input?: unknown) => {
    if (ch === 'harness.tabs') return tabsState;
    if (ch === 'harness.state')
      return { backend: 'nomi', cwd: '/w', bins: { claude: '/c', codex: '/x', dsh: null } };
    if (ch === 'harness.recentCwds') return [];
    if (ch === 'harness.tabRename') return tab({ title: '新名字' });
    if (ch === 'harness.tabClose') return tabsState;
    if (ch === 'history.list') return { items: [], nextOffset: null, hasMore: false };
    return {};
  });
  installFakeApi(invoke);
  return invoke;
}

beforeEach(() => {
  setChatMode('dev');
  updateMeta.mockClear();
  loadChatHistory.mockClear();
  clearChatHistory.mockClear();
  deleteConversation.mockClear();
  currentId = 'b';
  tabsState.tabs = [tab({ id: 'main', backend: 'nomi', title: 'Nomi' }), tab({})];
  tabsState.activeTabId = 't1';
  list.splice(
    0,
    list.length,
    {
      id: 'a',
      name: '修复登录',
      backend: 'codex',
      createdAt: 1,
      updatedAt: Date.now(),
      tabId: 't1',
    },
    { id: 'b', name: '聊聊天气', backend: 'nomi', createdAt: 1, updatedAt: Date.now() - 1000 },
  );
});
afterEach(() => {
  cleanup();
  resetConfirmDialogForTest();
  localStorage.clear();
  resetFakeApi();
});

const mountSidebar = () =>
  render(
    <HarnessTabsProvider>
      <Sidebar collapsed={false} onToggle={() => undefined} onNewChat={() => undefined} />
    </HarnessTabsProvider>,
  );

describe('one conversation context menu', () => {
  it('CLI conversation: rename / fork / fork-cross / close / delete', async () => {
    mockIpc();
    const r = mountSidebar();
    await waitFor(() => expect(r.getAllByTestId('history-item')).toHaveLength(2));
    fireEvent.contextMenu(r.getAllByTestId('history-item')[0]!);
    const m = r.getByTestId('conversation-context-menu');
    expect(m.querySelectorAll('[role=menuitem]').length).toBe(5);
    for (const id of [
      'conversation-rename',
      'fork-same',
      'fork-cross',
      'conversation-close',
      'conversation-delete',
    ])
      expect(r.getByTestId(id)).toBeTruthy();
  });

  it('deleting a CLI conversation confirms in-app, closes the tab, then trashes the CLI session record', async () => {
    const invoke = mockIpc();
    list[0]!.cliSessionId = 'sess-1';
    const r = mountSidebar();
    await waitFor(() => expect(r.getAllByTestId('history-item')).toHaveLength(2));
    const chans = () => invoke.mock.calls.map((c) => c[0]);
    fireEvent.contextMenu(r.getAllByTestId('history-item')[0]!);
    fireEvent.click(r.getByTestId('conversation-delete'));
    // 应用内确认框（不是 window.confirm）；取消：什么都不动
    const dialog = await screen.findByTestId('confirm-dialog');
    expect(dialog.textContent).toContain('修复登录');
    fireEvent.click(screen.getByTestId('confirm-dialog-cancel'));
    await waitFor(() => expect(screen.queryByTestId('confirm-dialog')).toBeNull());
    expect(chans()).not.toContain('harness.tabClose');
    expect(chans()).not.toContain('history.delete');

    fireEvent.contextMenu(r.getAllByTestId('history-item')[0]!);
    fireEvent.click(r.getByTestId('conversation-delete'));
    fireEvent.click(await screen.findByTestId('confirm-dialog-ok'));
    await waitFor(() => expect(chans()).toContain('history.delete'));
    const closeAt = chans().indexOf('harness.tabClose');
    const delAt = chans().indexOf('history.delete');
    expect(closeAt).toBeGreaterThanOrEqual(0);
    expect(closeAt).toBeLessThan(delAt);
    expect(invoke.mock.calls[delAt]!.slice(1)).toEqual([{ backend: 'codex', sessionId: 'sess-1' }]);
    expect(deleteConversation).not.toHaveBeenCalled();
  });

  it('Nomi conversation: rename / fork / fork-cross / delete, no close', async () => {
    mockIpc();
    const r = mountSidebar();
    await waitFor(() => expect(r.getAllByTestId('history-item')).toHaveLength(2));
    fireEvent.contextMenu(r.getAllByTestId('history-item')[1]!);
    expect(r.getByTestId('conversation-delete')).toBeTruthy();
    expect(r.queryByTestId('conversation-close')).toBeNull();
  });

  it('deleting the current conversation loads another same-backend one instead of creating a new one', async () => {
    mockIpc();
    // 多一个更新的 Nomi 会话 c；删除当前 b 后应切到 c
    list.push({
      id: 'c',
      name: '最新对话',
      backend: 'nomi',
      createdAt: 1,
      updatedAt: Date.now() + 1000,
    });
    const onNewChat = vi.fn();
    const r = render(
      <HarnessTabsProvider>
        <Sidebar collapsed={false} onToggle={() => undefined} onNewChat={onNewChat} />
      </HarnessTabsProvider>,
    );
    await waitFor(() => expect(r.getAllByTestId('history-item')).toHaveLength(3));
    fireEvent.contextMenu(
      r.getByTestId('conversation-list').querySelector('[data-conversation-id="b"]')!,
    );
    fireEvent.click(r.getByTestId('conversation-delete'));
    await waitFor(() => expect(deleteConversation).toHaveBeenCalledWith('b'));
    await waitFor(() => expect(loadChatHistory).toHaveBeenCalled());
    expect(clearChatHistory).not.toHaveBeenCalled();
    expect(onNewChat).not.toHaveBeenCalled();
  });

  it('新建 Nomi 会话等待创建完成，不会把当前 CLI 条目改写成 Nomi', async () => {
    mockIpc();
    currentId = 'a';
    let release!: () => void;
    const creating = new Promise<void>((resolve) => {
      release = resolve;
    });
    const onNewChat = vi.fn(async () => {
      await creating;
      list.push({
        id: 'n2',
        name: '新对话',
        backend: 'nomi',
        createdAt: 1,
        updatedAt: Date.now(),
      });
      currentId = 'n2';
    });
    const r = render(
      <HarnessTabsProvider>
        <Sidebar collapsed={false} onToggle={() => undefined} onNewChat={onNewChat} />
      </HarnessTabsProvider>,
    );
    await waitFor(() => expect(r.getAllByTestId('history-item')).toHaveLength(2));

    fireEvent.click(r.getByTestId('new-chat'));
    fireEvent.click(r.getByTestId('new-chat-nomi'));
    await waitFor(() => expect(onNewChat).toHaveBeenCalledTimes(1));
    expect(updateMeta).not.toHaveBeenCalled();

    release();
    await waitFor(() => expect(r.getAllByTestId('history-item')).toHaveLength(3));
    expect(updateMeta).not.toHaveBeenCalled();
    expect(
      r.getByTestId('conversation-list').querySelector('[data-conversation-id="a"]'),
    ).toBeTruthy();
    expect(
      r.getByTestId('conversation-list').querySelector('[data-conversation-id="n2"]'),
    ).toBeTruthy();
  });

  it('新建 Nomi 对话带上新建菜单里选的工作区；没选时交给默认（主标签目录）', async () => {
    const invoke = mockIpc();
    invoke.mockImplementation(async (ch: string) => {
      if (ch === 'harness.tabs') return tabsState;
      if (ch === 'harness.state')
        return { backend: 'nomi', cwd: '/w', bins: { claude: '/c', codex: '/x', dsh: null } };
      if (ch === 'harness.recentCwds') return ['/proj/one'];
      if (ch === 'history.list') return { items: [], nextOffset: null, hasMore: false };
      return {};
    });
    const onNewChat = vi.fn(async () => undefined);
    const r = render(
      <HarnessTabsProvider>
        <Sidebar collapsed={false} onToggle={() => undefined} onNewChat={onNewChat} />
      </HarnessTabsProvider>,
    );
    await waitFor(() => expect(r.getAllByTestId('history-item')).toHaveLength(2));
    fireEvent.click(r.getByTestId('new-chat'));
    fireEvent.click(r.getByTestId('new-chat-nomi'));
    await waitFor(() => expect(onNewChat).toHaveBeenCalledWith(undefined));
    fireEvent.click(r.getByTestId('new-chat'));
    fireEvent.click(r.getByTestId('new-chat-workspace-button'));
    fireEvent.click(await r.findByTestId('workspace-recent-item'));
    fireEvent.click(r.getByTestId('new-chat-nomi'));
    await waitFor(() => expect(onNewChat).toHaveBeenLastCalledWith({ cwd: '/proj/one' }));
  });

  it('deleting the last Nomi conversation clears the pane without creating a new one', async () => {
    mockIpc();
    const onNewChat = vi.fn();
    const r = render(
      <HarnessTabsProvider>
        <Sidebar collapsed={false} onToggle={() => undefined} onNewChat={onNewChat} />
      </HarnessTabsProvider>,
    );
    await waitFor(() => expect(r.getAllByTestId('history-item')).toHaveLength(2));
    fireEvent.contextMenu(
      r.getByTestId('conversation-list').querySelector('[data-conversation-id="b"]')!,
    );
    fireEvent.click(r.getByTestId('conversation-delete'));
    await waitFor(() => expect(deleteConversation).toHaveBeenCalledWith('b'));
    await waitFor(() => expect(clearChatHistory).toHaveBeenCalled());
    expect(loadChatHistory).not.toHaveBeenCalled();
    expect(onNewChat).not.toHaveBeenCalled();
  });

  it('rename in the sidebar updates the Nomi conversation title and CLI tab title', async () => {
    const invoke = mockIpc();
    const r = mountSidebar();
    await waitFor(() => expect(r.getAllByTestId('history-item')).toHaveLength(2));
    fireEvent.contextMenu(r.getAllByTestId('history-item')[1]!);
    fireEvent.click(r.getByTestId('conversation-rename'));
    const input = await waitFor(() => r.getByTestId('conversation-rename-input'));
    fireEvent.change(input, { target: { value: '天气闲聊' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(updateMeta).toHaveBeenCalledWith('b', { name: '天气闲聊' });

    fireEvent.contextMenu(r.getAllByTestId('history-item')[0]!);
    fireEvent.click(r.getByTestId('conversation-rename'));
    const input2 = await waitFor(() => r.getByTestId('conversation-rename-input'));
    fireEvent.change(input2, { target: { value: '新名字' } });
    fireEvent.keyDown(input2, { key: 'Enter' });
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('harness.tabRename', { id: 't1', title: '新名字' }),
    );
  });

  it('Escape closes the menu; arrow keys move focus between items', async () => {
    mockIpc();
    const r = mountSidebar();
    await waitFor(() => expect(r.getAllByTestId('history-item')).toHaveLength(2));
    fireEvent.contextMenu(r.getAllByTestId('history-item')[0]!);
    const first = r.getByTestId('conversation-rename');
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(r.getByTestId('conversation-context-menu'), { key: 'ArrowDown' });
    expect(document.activeElement).toBe(r.getByTestId('fork-same'));
    fireEvent.keyDown(r.getByTestId('conversation-context-menu'), { key: 'Escape' });
    expect(r.queryByTestId('conversation-context-menu')).toBeNull();
  });
});

describe('one "new" menu', () => {
  it('the sidebar new menu lists every endpoint (names, 未安装)', async () => {
    mockIpc();
    const r = render(
      <HarnessTabsProvider>
        <Sidebar collapsed={false} onToggle={() => undefined} onNewChat={() => undefined} />
      </HarnessTabsProvider>,
    );
    fireEvent.click(await waitFor(() => r.getByTestId('new-chat')));
    const sideMenu = await waitFor(() => r.getByTestId('new-chat-menu'));
    expect(sideMenu.getAttribute('role')).toBe('menu');
    // 同样的名称；未安装的端点置灰（dsh 在侧栏里未探测到）
    expect(r.getByTestId('new-chat-claude').textContent).toBe('Claude Code');
    expect(r.getByTestId('new-chat-codex').textContent).toBe('Codex');
    expect((r.getByTestId('new-chat-dsh') as HTMLButtonElement).disabled).toBe(true);
    expect(r.getByTestId('new-chat-dsh').textContent).toContain('未安装');
    expect(r.getByTestId('new-chat-workspace')).toBeTruthy();
  });
});
