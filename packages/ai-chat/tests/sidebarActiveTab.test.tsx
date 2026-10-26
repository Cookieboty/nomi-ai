// @vitest-environment happy-dom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
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
  {
    id: 'cc',
    name: '修个 bug',
    backend: 'claude',
    createdAt: 1,
    updatedAt: now - 3000,
    tabId: 't3',
  },
];
const current = vi.hoisted(() => ({ id: 'old' }));

// 新建 CLI 标签不会切换 Nomi 侧的当前会话：currentConversationId 仍是之前打开的 old
vi.mock('../src/contexts/AiChatContext', () => {
  const api = {
    state: {
      messages: [],
      ipcClient: {
        listConversations: async () => list,
        currentConversationId: () => current.id,
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
  const tab = (id: string, title: string, backend = 'codex') => ({
    id,
    title,
    backend,
    status: 'idle',
  });
  return {
    ...mod,
    useHarnessTabs: () => ({
      ...mod.useHarnessTabs(),
      available: true,
      state: {
        activeTabId: tabsState.activeTabId,
        tabs: [
          tab('main', 'Nomi'),
          tab('t1', '你是什么模型？'),
          tab('t2', 'Codex 2'),
          tab('t3', '修个 bug', 'claude'),
        ],
      },
    }),
  };
});

beforeEach(() => {
  setChatMode('dev');
  current.id = 'old';
});
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
    await waitFor(() => expect(r.getAllByTestId('conversation-row')).toHaveLength(4));
    const active = activeRows(r);
    expect(active).toHaveLength(1);
    expect(active[0]).toContain('Codex 2');
  });

  it('在主标签时仍按当前会话高亮', async () => {
    tabsState.activeTabId = 'main';
    const r = render(
      <Sidebar collapsed={false} onToggle={() => undefined} onNewChat={() => undefined} />,
    );
    await waitFor(() => expect(r.getAllByTestId('conversation-row')).toHaveLength(4));
    const active = activeRows(r);
    expect(active).toHaveLength(1);
    expect(active[0]).toContain('你是什么模型');
  });
});

const cardEndpoint = (r: ReturnType<typeof render>) =>
  r.getByTestId('endpoint-info-card').getAttribute('data-endpoint');

describe('左下角端信息卡', () => {
  it('跟随当前会话所在的端：Claude Code 标签显示 Claude Code 的卡', async () => {
    tabsState.activeTabId = 't3';
    const r = render(
      <Sidebar collapsed={false} onToggle={() => undefined} onNewChat={() => undefined} />,
    );
    await waitFor(() => expect(cardEndpoint(r)).toBe('claude'));
  });

  it('在主标签看 Nomi 对话时显示 Nomi 的卡', async () => {
    tabsState.activeTabId = 'main';
    current.id = 'chat';
    const r = render(
      <Sidebar collapsed={false} onToggle={() => undefined} onNewChat={() => undefined} />,
    );
    await waitFor(() => expect(cardEndpoint(r)).toBe('nomi'));
  });

  it('点顶部端点图标先看那个端，切换会话后回到当前会话的端', async () => {
    tabsState.activeTabId = 't3';
    const r = render(
      <Sidebar collapsed={false} onToggle={() => undefined} onNewChat={() => undefined} />,
    );
    await waitFor(() => expect(cardEndpoint(r)).toBe('claude'));
    fireEvent.click(r.getByTestId('endpoint-filter-nomi'));
    expect(cardEndpoint(r)).toBe('nomi');
    tabsState.activeTabId = 't2';
    r.rerender(
      <Sidebar collapsed={false} onToggle={() => undefined} onNewChat={() => undefined} />,
    );
    tabsState.activeTabId = 't3';
    r.rerender(
      <Sidebar collapsed={false} onToggle={() => undefined} onNewChat={() => undefined} />,
    );
    expect(cardEndpoint(r)).toBe('claude');
  });
});
