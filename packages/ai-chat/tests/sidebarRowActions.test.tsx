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

import type { CodingApiMockState } from './helpers/codingApi';

// D3 客户端走契约（services/api）；测试仍用旧通道形状的 window.aiIPC 假桥，经 helpers/codingApi 转发
const codingApi = vi.hoisted(() => ({}) as CodingApiMockState);
vi.mock('../src/services/api', async () =>
  (await import('./helpers/codingApi')).createCodingApiMock(codingApi),
);

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
let calls: Array<[string, unknown[]]> = [];

function mockIpc() {
  calls = [];
  const invoke = vi.fn(async (ch: string, ...args: unknown[]) => {
    calls.push([ch, args]);
    if (ch === 'ai:harness:tabs')
      return {
        tabs: [{ id: 't1', backend: 'claude', cwd: '/w', status: tabStatus, unread: 0 }],
        activeTabId: 'main',
        running: 0,
        queued: 0,
      };
    if (ch === 'ai:harness:state')
      return { backend: 'nomi', cwd: '/w', bins: { claude: '/c', codex: '/x', dsh: null } };
    if (ch === 'ai:harness:recent-cwds') return [];
    if (ch === 'ai:history:list') {
      const [b] = args as [string];
      return { items: b === 'codex' ? [hist] : [], nextOffset: null, hasMore: false };
    }
    if (ch === 'ai:history:open') return { ok: true };
    if (ch === 'ai:history:delete') return { ok: true, removed: 1 };
    return {};
  });
  (window as unknown as { aiIPC: unknown }).aiIPC = { invoke, on: () => () => undefined };
}

const mount = (collapsed = false, onToggle: () => void = () => undefined) =>
  render(
    <HarnessTabsProvider>
      <Sidebar
        collapsed={collapsed}
        onToggle={onToggle}
        onNewChat={() => undefined}
        onForkRequest={onForkRequest}
      />
    </HarnessTabsProvider>,
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
  delete (window as { aiIPC?: unknown }).aiIPC;
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

  it('every conversation row carries rename / delete / more icon buttons with tooltips + aria-labels', async () => {
    const r = mount();
    await waitFor(() => r.getAllByTestId('history-item'));
    const w = within(row(r, 'n2'));
    for (const [id, label] of [
      ['row-rename', '重命名'],
      ['row-delete', '删除对话'],
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

  it('rename pen starts inline editing: Enter commits, Esc cancels', async () => {
    const r = mount();
    await waitFor(() => r.getAllByTestId('history-item'));
    fireEvent.click(within(row(r, 'n2')).getByTestId('row-rename'));
    let input = r.getByTestId('conversation-rename-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '新名字' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(updateMeta).toHaveBeenCalledWith('n2', { name: '新名字' });
    await waitFor(() => expect(r.queryByTestId('conversation-rename-input')).toBeNull());

    updateMeta.mockClear();
    fireEvent.click(within(row(r, 'n2')).getByTestId('row-rename'));
    input = r.getByTestId('conversation-rename-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '不要' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(updateMeta).not.toHaveBeenCalled();
    expect(r.queryByTestId('conversation-rename-input')).toBeNull();
  });

  it('delete a nomi conversation needs a second confirmation; Esc / cancel back out', async () => {
    const r = mount();
    await waitFor(() => r.getAllByTestId('history-item'));
    fireEvent.click(within(row(r, 'n2')).getByTestId('row-delete'));
    expect(deleteConversation).not.toHaveBeenCalled();
    const confirm = within(row(r, 'n2')).getByTestId('row-delete-confirm');
    expect(confirm.textContent).toBe('确认删除');
    // 取消
    fireEvent.click(within(row(r, 'n2')).getByTestId('row-delete-cancel'));
    expect(within(row(r, 'n2')).queryByTestId('row-delete-confirm')).toBeNull();
    expect(deleteConversation).not.toHaveBeenCalled();
    // Esc
    fireEvent.click(within(row(r, 'n2')).getByTestId('row-delete'));
    fireEvent.keyDown(within(row(r, 'n2')).getByTestId('row-delete-confirm'), { key: 'Escape' });
    expect(within(row(r, 'n2')).queryByTestId('row-delete-confirm')).toBeNull();
    // 确认
    fireEvent.click(within(row(r, 'n2')).getByTestId('row-delete'));
    fireEvent.click(within(row(r, 'n2')).getByTestId('row-delete-confirm'));
    await waitFor(() => expect(deleteConversation).toHaveBeenCalledWith('n2'));
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
    expect(calls.some(([ch]) => ch === 'ai:harness:tab-close')).toBe(false);
    fireEvent.click(within(row(r, 'c1')).getByTestId('row-delete'));
    fireEvent.click(await screen.findByTestId('confirm-dialog-ok'));
    await waitFor(() =>
      expect(calls.some(([ch, a]) => ch === 'ai:harness:tab-close' && a[0] === 't1')).toBe(true),
    );
  });

  it('idle cli tab closes without asking', async () => {
    const r = mount();
    await waitFor(() => r.getAllByTestId('history-item'));
    fireEvent.click(within(row(r, 'c1')).getByTestId('row-delete'));
    await waitFor(() => expect(calls.some(([ch]) => ch === 'ai:harness:tab-close')).toBe(true));
    expect(screen.queryByTestId('confirm-dialog')).toBeNull();
  });

  it('"more" opens the shared conversation menu on demand (same as right click)', async () => {
    const r = mount();
    await waitFor(() => r.getAllByTestId('history-item'));
    fireEvent.click(within(row(r, 'n2')).getByTestId('row-more'));
    const menu = r.getByTestId('conversation-context-menu');
    expect(within(menu).getByTestId('fork-same')).toBeTruthy();
    expect(within(menu).getByTestId('fork-cross')).toBeTruthy();
    expect(within(menu).getByTestId('conversation-delete')).toBeTruthy();
    fireEvent.click(within(menu).getByTestId('fork-same'));
    expect(onForkRequest).toHaveBeenCalledWith('n2', 'same');
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
      expect(calls.some(([ch, a]) => ch === 'ai:history:open' && a[1] === 's9')).toBe(true),
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
    expect(calls.some(([ch]) => ch === 'ai:history:delete')).toBe(false);

    const listsBefore = calls.filter(([ch]) => ch === 'ai:history:list').length;
    fireEvent.click(w.getByTestId('row-delete'));
    fireEvent.click(await screen.findByTestId('confirm-dialog-ok'));
    await waitFor(() =>
      expect(calls.some(([ch, a]) => ch === 'ai:history:delete' && a[1] === 's9')).toBe(true),
    );
    await waitFor(() =>
      expect(calls.filter(([ch]) => ch === 'ai:history:list').length).toBeGreaterThan(listsBefore),
    );
  });

  it('works in normal mode too (nomi rows only)', async () => {
    setChatMode('normal');
    const r = mount();
    await waitFor(() => r.getAllByTestId('history-item'));
    expect(r.queryByTestId('cli-history')).toBeNull();
    const w = within(row(r, 'n2'));
    expect(w.getByTestId('row-rename')).toBeTruthy();
    expect(w.getByTestId('row-more')).toBeTruthy();
  });

  it('the current row carries the active flag (highlight only; actions reveal on hover/focus via CSS)', async () => {
    const r = mount();
    await waitFor(() => r.getAllByTestId('history-item'));
    expect(row(r, 'n1').hasAttribute('data-active')).toBe(true);
    expect(row(r, 'n2').hasAttribute('data-active')).toBe(false);
  });

  it('cross-endpoint fork is a dev-mode feature: normal mode menus only offer fork as a new nomi chat', async () => {
    // 开发模式：右键 / 更多都有「分叉到其他端」
    const dev = mount();
    await waitFor(() => dev.getAllByTestId('history-item'));
    fireEvent.click(within(row(dev, 'n2')).getByTestId('row-more'));
    expect(
      within(dev.getByTestId('conversation-context-menu')).getByTestId('fork-cross'),
    ).toBeTruthy();
    fireEvent.keyDown(dev.getByTestId('conversation-context-menu'), { key: 'Escape' });
    cleanup();

    // 普通模式：同端分叉可用，跨端分叉入口不存在（更多 + 右键）
    setChatMode('normal');
    const r = mount();
    await waitFor(() => r.getAllByTestId('history-item'));
    fireEvent.click(within(row(r, 'n2')).getByTestId('row-more'));
    let menu = r.getByTestId('conversation-context-menu');
    expect(within(menu).getByTestId('fork-same')).toBeTruthy();
    expect(within(menu).queryByTestId('fork-cross')).toBeNull();
    fireEvent.click(within(menu).getByTestId('fork-same'));
    expect(onForkRequest).toHaveBeenCalledWith('n2', 'same');
    fireEvent.contextMenu(r.container.querySelector('[data-conversation-id="n1"]')!);
    menu = r.getByTestId('conversation-context-menu');
    expect(within(menu).getByTestId('fork-same')).toBeTruthy();
    expect(within(menu).queryByTestId('fork-cross')).toBeNull();
    expect(within(menu).queryByText('分叉到其他端')).toBeNull();
  });
});
