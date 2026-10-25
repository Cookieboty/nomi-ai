// @vitest-environment happy-dom
import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Sidebar } from '../src/components/Sidebar';
import type * as HarnessTabs from '../src/contexts/HarnessTabsContext';
import { setChatMode } from '../src/services/chatPrefs';

const now = Date.now();
const list = [
  { id: 'new', name: 'Codex 2', backend: 'codex', createdAt: 2, updatedAt: now, tabId: 't2' },
  {
    id: 'old',
    name: '你是什么模型？',
    backend: 'codex',
    createdAt: 1,
    updatedAt: now - 1000,
    tabId: 't1',
  },
  { id: 'chat', name: '聊聊天气', backend: 'nomi', createdAt: 1, updatedAt: now - 2000 },
];

// 新建 CLI 标签不会切换 Nomi 侧的当前会话：currentConversationId 仍是之前打开的 old
vi.mock('../src/contexts/AiChatContext', () => {
  const api = {
    state: {
      messages: [],
      ipcClient: {
        listConversations: async () => list,
        currentConversationId: () => 'old',
        conversationStore: () => undefined,
      },
    },
    actions: {},
  };
  return { useAiChat: () => api };
});

const tabsState = vi.hoisted(() => ({ activeTabId: 't2' }));
vi.mock('../src/contexts/HarnessTabsContext', async (importOriginal) => {
  const mod = await importOriginal<typeof HarnessTabs>();
  const tab = (id: string, title: string) => ({ id, title, backend: 'codex', status: 'idle' });
  return {
    ...mod,
    useHarnessTabs: () => ({
      ...mod.useHarnessTabs(),
      available: true,
      state: {
        activeTabId: tabsState.activeTabId,
        tabs: [tab('main', 'Nomi'), tab('t1', '你是什么模型？'), tab('t2', 'Codex 2')],
      },
    }),
  };
});

beforeEach(() => setChatMode('dev'));
afterEach(() => {
  cleanup();
  localStorage.clear();
});

const activeRows = (r: ReturnType<typeof render>) =>
  r
    .getAllByTestId('conversation-row')
    .filter((x) => x.hasAttribute('data-active'))
    .map((x) => x.textContent);

describe('Sidebar 高亮项', () => {
  it('当前在 CLI 标签时高亮该标签对应的项，而不是之前打开的会话', async () => {
    tabsState.activeTabId = 't2';
    const r = render(
      <Sidebar collapsed={false} onToggle={() => undefined} onNewChat={() => undefined} />,
    );
    await waitFor(() => expect(r.getAllByTestId('conversation-row')).toHaveLength(3));
    const active = activeRows(r);
    expect(active).toHaveLength(1);
    expect(active[0]).toContain('Codex 2');
  });

  it('在主标签时仍按当前会话高亮', async () => {
    tabsState.activeTabId = 'main';
    const r = render(
      <Sidebar collapsed={false} onToggle={() => undefined} onNewChat={() => undefined} />,
    );
    await waitFor(() => expect(r.getAllByTestId('conversation-row')).toHaveLength(3));
    const active = activeRows(r);
    expect(active).toHaveLength(1);
    expect(active[0]).toContain('你是什么模型');
  });
});
