// @vitest-environment happy-dom
import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Sidebar } from '../src/components/Sidebar';
import { setChatMode } from '../src/services/chatPrefs';

const list = [
  { id: 'chat', name: '聊聊天气', backend: 'nomi', createdAt: 1, updatedAt: Date.now() },
  { id: 'idle', name: '旧对话', backend: 'nomi', createdAt: 1, updatedAt: Date.now() - 1000 },
];

/** Nomi 对话没有 CLI 标签，侧栏只能从 busyConvos 知道它在回复 */
const busy = vi.hoisted(() => ({ ids: ['chat'] }));

vi.mock('../src/contexts/AiChatContext', () => {
  const api = {
    state: {
      messages: [],
      busyConvos: busy.ids,
      ipcClient: {
        listConversations: async () => list,
        currentConversationId: () => 'chat',
        conversationStore: () => undefined,
      },
    },
    actions: {},
  };
  return { useAiChat: () => api };
});

beforeEach(() => setChatMode('normal'));
afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe('Sidebar running dot', () => {
  it('Nomi rows show the running dot while that conversation is replying', async () => {
    const view = render(
      <Sidebar collapsed={false} onToggle={() => undefined} onNewChat={() => undefined} />,
    );
    const row = (id: string) =>
      view.container.querySelector(`[data-conversation-id="${id}"]`) as HTMLElement;
    // 会话列表是异步载入的
    await waitFor(() => expect(row('chat')).toBeTruthy());

    expect(row('chat').querySelector('[data-live="running"]')).toBeTruthy();
    // 读屏也能读到「进行中」
    expect(row('chat').querySelector('[data-testid="thread-live"]')!.textContent).toBe('进行中');
    // 没在回复的会话不画点
    expect(row('idle').querySelector('[data-live="running"]')).toBeNull();
  });
});
