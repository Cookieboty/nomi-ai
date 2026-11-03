// @vitest-environment happy-dom
/**
 * 侧栏切换端点：打开该端正在运行（或排队）的会话；没有就打开列表里第一条；一条都没有就新建空对话；
 * 已经停在该端的会话上不动。
 */
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Sidebar } from '../src/components/Sidebar';
import { HarnessTabsProvider } from '../src/contexts/HarnessTabsContext';
import { setChatMode, setEndpointVisibility } from '../src/services/chatPrefs';

import { installFakeApi, resetFakeApi } from './helpers/fakeApi';

vi.mock('../src/services/api', async () => (await import('./helpers/fakeApi')).fakeApiModule());

const now = Date.now();
const CONVOS = [
  { id: 'n1', name: '聊天', backend: 'nomi', createdAt: 1, updatedAt: now },
  // claude：c2 更新（排第一），c1 在运行
  { id: 'c2', name: 'Claude 新', backend: 'claude', tabId: 't2', createdAt: 1, updatedAt: now - 1 },
  {
    id: 'c1',
    name: 'Claude 跑着',
    backend: 'claude',
    tabId: 't1',
    createdAt: 1,
    updatedAt: now - 2,
  },
  // codex：都没在运行，c4 排第一
  { id: 'c4', name: 'Codex 新', backend: 'codex', tabId: 't4', createdAt: 1, updatedAt: now - 3 },
  { id: 'c3', name: 'Codex 旧', backend: 'codex', tabId: 't3', createdAt: 1, updatedAt: now - 4 },
];

vi.mock('../src/contexts/AiChatContext', () => {
  const api = {
    state: {
      messages: [],
      ipcClient: {
        listConversations: async () => CONVOS,
        currentConversationId: () => 'n1',
        switchConversation: async () => undefined,
        conversationStore: () => undefined,
      },
    },
    actions: { loadChatHistory: async () => undefined },
  };
  return { useAiChat: () => api };
});

const tab = (id: string, backend: string, status: string) => ({
  id,
  backend,
  status,
  title: id,
  cwd: '/w',
  createdAt: 1,
  updatedAt: 1,
});

function mockIpc() {
  const activated: string[] = [];
  const created: string[] = [];
  installFakeApi(
    vi.fn(async (ch: string, input?: Record<string, unknown>) => {
      if (ch === 'harness.tabs')
        return {
          tabs: [
            tab('main', 'nomi', 'idle'),
            tab('t1', 'claude', 'running'),
            tab('t2', 'claude', 'idle'),
            tab('t3', 'codex', 'idle'),
            tab('t4', 'codex', 'idle'),
          ],
          activeTabId: 'main',
          running: 1,
          queued: 0,
        };
      if (ch === 'harness.tabCreate') {
        created.push(String(input?.backend));
        return tab('t9', String(input?.backend), 'idle');
      }
      if (ch === 'harness.tabActivate') {
        activated.push(String(input?.id));
        return {};
      }
      if (ch === 'harness.state')
        return {
          backend: 'nomi',
          cwd: '/w',
          bins: { claude: '/c', codex: '/x', grok: '/g', dsh: null },
        };
      if (ch === 'history.list') return { items: [], nextOffset: null, hasMore: false };
      return {};
    }),
  );
  return { activated, created };
}

beforeEach(() => {
  setChatMode('dev');
  // Grok 没有任何对话，默认不显示图标：这里设为显示
  setEndpointVisibility('grok', 'show');
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  resetFakeApi();
});

describe('sidebar endpoint switch picks a session', () => {
  it('opens the running session of that endpoint, else the first one in the list', async () => {
    const { activated, created } = mockIpc();
    const r = render(
      <HarnessTabsProvider>
        <Sidebar collapsed={false} onToggle={() => undefined} onNewChat={() => undefined} />
      </HarnessTabsProvider>,
    );
    await waitFor(() => r.getByTestId('endpoint-filter-claude'));
    // 等标签状态到达（运行中的点）再切换
    await waitFor(() => expect(r.getByTestId('endpoint-filter-codex')).toBeTruthy());
    await new Promise((res) => setTimeout(res, 50));

    fireEvent.click(r.getByTestId('endpoint-filter-claude'));
    await waitFor(() => expect(activated).toContain('t1'));
    expect(activated).not.toContain('t2');

    fireEvent.click(r.getByTestId('endpoint-filter-codex'));
    await waitFor(() => expect(activated).toContain('t4'));
    expect(activated).not.toContain('t3');
    expect(created).toEqual([]);

    // Grok 装了但一条对话都没有：新建一个空对话
    fireEvent.click(r.getByTestId('endpoint-filter-grok'));
    await waitFor(() => expect(created).toEqual(['grok']));
  });
});
