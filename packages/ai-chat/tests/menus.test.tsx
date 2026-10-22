// @vitest-environment happy-dom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ChatTabs } from '../src/components/ChatTabs';
import { Sidebar } from '../src/components/Sidebar';
import { HarnessTabsProvider } from '../src/contexts/HarnessTabsContext';
import { setChatMode } from '../src/services/chatPrefs';
import type { HarnessTabMeta, HarnessTabsState } from '../src/services/harnessClient';

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
  maxConcurrent: 3,
  running: 0,
  queued: 0,
};

function mockIpc() {
  const invoke = vi.fn(async (ch: string) => {
    if (ch === 'ai:harness:tabs') return tabsState;
    if (ch === 'ai:harness:state')
      return { backend: 'nomi', cwd: '/w', bins: { claude: '/c', codex: '/x', dsh: null } };
    if (ch === 'ai:harness:recent-cwds') return [];
    if (ch === 'ai:harness:tab-rename') return tab({ title: '新名字' });
    if (ch === 'ai:harness:tab-close') return tabsState;
    if (ch === 'ai:history:list') return { items: [], nextOffset: null, hasMore: false };
    return {};
  });
  (window as unknown as { aiIPC: unknown }).aiIPC = { invoke, on: () => () => undefined };
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
  localStorage.clear();
  delete (window as { aiIPC?: unknown }).aiIPC;
});

const mountSidebar = () =>
  render(
    <HarnessTabsProvider>
      <Sidebar collapsed={false} onToggle={() => undefined} onNewChat={() => undefined} />
    </HarnessTabsProvider>,
  );

describe('one conversation context menu', () => {
  it('CLI conversation: rename / fork / fork-cross / close, no delete', async () => {
    mockIpc();
    const r = mountSidebar();
    await waitFor(() => expect(r.getAllByTestId('history-item')).toHaveLength(2));
    fireEvent.contextMenu(r.getAllByTestId('history-item')[0]!);
    const m = r.getByTestId('conversation-context-menu');
    expect(m.querySelectorAll('[role=menuitem]').length).toBe(4);
    for (const id of ['conversation-rename', 'fork-same', 'fork-cross', 'conversation-close'])
      expect(r.getByTestId(id)).toBeTruthy();
    expect(r.queryByTestId('conversation-delete')).toBeNull();
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
      expect(invoke).toHaveBeenCalledWith('ai:harness:tab-rename', 't1', '新名字'),
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

  it('the tab strip opens the same menu and forwards fork requests', async () => {
    mockIpc();
    const onForkTab = vi.fn();
    const r = render(
      <HarnessTabsProvider>
        <ChatTabs onForkTab={onForkTab} />
      </HarnessTabsProvider>,
    );
    await waitFor(() => r.getByTestId('chat-tab-1'));
    // 主标签（Nomi）没有右键菜单
    fireEvent.contextMenu(r.getByTestId('chat-tab-0'));
    expect(r.queryByTestId('conversation-context-menu')).toBeNull();
    fireEvent.contextMenu(r.getByTestId('chat-tab-1'));
    expect(r.getByTestId('conversation-close')).toBeTruthy();
    fireEvent.click(r.getByTestId('fork-cross'));
    expect(onForkTab).toHaveBeenCalledWith('t1', 'cross');
  });

  it('the tab menu can close tabs to the left or right', async () => {
    const invoke = mockIpc();
    tabsState.tabs = [
      tab({ id: 'main', backend: 'nomi', title: 'Nomi' }),
      tab({ id: 'left', title: '左侧' }),
      tab({ id: 't1', title: '当前' }),
      tab({ id: 'right', title: '右侧' }),
    ];
    const r = render(
      <HarnessTabsProvider>
        <ChatTabs />
      </HarnessTabsProvider>,
    );
    await waitFor(() => r.getByTestId('chat-tab-2'));
    fireEvent.contextMenu(r.getByTestId('chat-tab-2'));
    expect(r.getByTestId('conversation-close-left')).toBeTruthy();
    expect(r.getByTestId('conversation-close-right')).toBeTruthy();
    fireEvent.click(r.getByTestId('conversation-close-left'));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('ai:harness:tab-close', 'left'));
    expect(invoke).not.toHaveBeenCalledWith('ai:harness:tab-close', 'right');

    fireEvent.contextMenu(r.getByTestId('chat-tab-2'));
    fireEvent.click(r.getByTestId('conversation-close-right'));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('ai:harness:tab-close', 'right'));
  });
});

describe('one "new" menu', () => {
  it('sidebar and tab strip render the same component (names, icons, 未安装)', async () => {
    mockIpc();
    const r = render(
      <HarnessTabsProvider>
        <ChatTabs />
        <Sidebar collapsed={false} onToggle={() => undefined} onNewChat={() => undefined} />
      </HarnessTabsProvider>,
    );
    await waitFor(() => r.getByTestId('chat-tab-add'));
    fireEvent.click(r.getByTestId('chat-tab-add'));
    const tabMenu = await waitFor(() => r.getByTestId('chat-tab-menu'));
    expect(r.getByTestId('chat-tab-new-claude').textContent).toContain('Claude Code');
    fireEvent.click(r.getByTestId('chat-tab-add'));
    await waitFor(() => expect(r.queryByTestId('chat-tab-menu')).toBeNull());
    fireEvent.click(r.getByTestId('new-chat'));
    const sideMenu = await waitFor(() => r.getByTestId('new-chat-menu'));
    expect(tabMenu.getAttribute('role')).toBe('menu');
    expect(sideMenu.getAttribute('role')).toBe('menu');
    // 同样的名称；未安装的端点置灰（dsh 在侧栏里未探测到）
    expect(r.getByTestId('new-chat-claude').textContent).toBe('Claude Code');
    expect(r.getByTestId('new-chat-codex').textContent).toBe('Codex');
    expect((r.getByTestId('new-chat-dsh') as HTMLButtonElement).disabled).toBe(true);
    expect(r.getByTestId('new-chat-dsh').textContent).toContain('未安装');
    expect(r.getByTestId('new-chat-workspace')).toBeTruthy();
  });
});
