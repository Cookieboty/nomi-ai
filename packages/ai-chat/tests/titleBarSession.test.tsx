// @vitest-environment happy-dom
/** 标题栏里的当前会话：有消息时显示会话名与工作区，「…」菜单能重命名 / 归档 / 永久删除 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetConfirmDialogForTest } from '../src/components/ConfirmDialog';
import {
  SessionMenuButton,
  SessionTitle,
  TitleBarTitle,
} from '../src/components/TitleBar/SessionTitle';
import { HarnessTabsProvider } from '../src/contexts/HarnessTabsContext';
import { setChatMode } from '../src/services/chatPrefs';

import { installFakeApi, resetFakeApi } from './helpers/fakeApi';

vi.mock('../src/services/api', async () => (await import('./helpers/fakeApi')).fakeApiModule());

const meta = {
  id: 'n1',
  name: '周报整理',
  backend: 'nomi',
  createdAt: 1,
  updatedAt: 2,
  cwd: '/w/app',
};
const setArchived = vi.fn();
const updateMeta = vi.fn();
const deleteConversation = vi.fn(async () => undefined);
const loadChatHistory = vi.fn(async () => undefined);
let messages: unknown[] = [];

vi.mock('../src/contexts/AiChatContext', () => {
  let api: { state: { messages: unknown[] } } | undefined;
  return {
    useAiChat: () => {
      if (!api) {
        const store = {
          list: () => [meta],
          get: (id: string) => (id === meta.id ? meta : undefined),
          setArchived,
          updateMeta,
        };
        api = {
          state: {
            messages,
            ipcClient: {
              currentConversationId: () => 'n1',
              conversationStore: () => store,
              deleteConversation,
            },
          },
          actions: { loadChatHistory, clearChatHistory: vi.fn() },
        } as never;
      }
      api!.state.messages = messages;
      return api;
    },
  };
});

beforeEach(() => {
  setChatMode('normal');
  installFakeApi(
    vi.fn(async (ch: string) => {
      if (ch === 'harness.tabs') return { tabs: [], activeTabId: 'main', running: 0, queued: 0 };
      if (ch === 'harness.state') return { backend: 'nomi', cwd: '/w', bins: {} };
      return {};
    }),
  );
});
afterEach(() => {
  cleanup();
  resetConfirmDialogForTest();
  resetFakeApi();
  vi.clearAllMocks();
  messages = [];
});

const mount = () =>
  render(
    <HarnessTabsProvider>
      <SessionTitle />
      <SessionMenuButton />
    </HarnessTabsProvider>,
  );

describe('标题栏的当前会话', () => {
  it('新会话（还没有消息）不显示名称与菜单', () => {
    const r = mount();
    expect(r.queryByTestId('titlebar-session')).toBeNull();
    expect(r.queryByTestId('titlebar-session-menu')).toBeNull();
  });

  it('有消息时显示会话名与工作区目录名；「…」里能归档与永久删除', async () => {
    messages = [{ id: 'm', role: 'user', content: 'hi', timestamp: 1 }];
    const r = mount();
    const title = r.getByTestId('titlebar-session');
    expect(title.textContent).toContain('周报整理');
    expect(title.textContent).toContain('app');
    expect(title.getAttribute('title')).toBe('/w/app');

    fireEvent.click(r.getByTestId('titlebar-session-menu'));
    fireEvent.click(r.getByTestId('conversation-archive'));
    expect(setArchived).toHaveBeenCalledWith('n1', true);
    await waitFor(() => expect(loadChatHistory).toHaveBeenCalled());

    fireEvent.click(r.getByTestId('titlebar-session-menu'));
    fireEvent.click(r.getByTestId('conversation-delete'));
    fireEvent.click(await screen.findByTestId('confirm-dialog-ok'));
    await waitFor(() => expect(deleteConversation).toHaveBeenCalledWith('n1'));
  });

  it('任务 / 素材库整页打开时显示页名，不显示会话名', () => {
    messages = [{ id: 'm', role: 'user', content: 'hi', timestamp: 1 }];
    const r = render(
      <HarnessTabsProvider>
        <TitleBarTitle page="tasks" />
      </HarnessTabsProvider>,
    );
    expect(r.getByTestId('titlebar-page').textContent).toBe('任务');
    expect(r.queryByTestId('titlebar-session')).toBeNull();
  });
});
