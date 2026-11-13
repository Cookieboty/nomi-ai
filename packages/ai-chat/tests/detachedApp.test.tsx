// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DetachedApp } from '../src/detached/DetachedApp';
import type { HarnessTabsState } from '../src/services/harnessClient';
import {
  createSideChat,
  exportSideChat,
  forgetSideChat,
  setSideChatModel,
  sideChatState,
} from '../src/services/sideChat';
import type { DetachSpec } from '../src/utils/detachedTabs';

import { installFakeApi, resetFakeApi } from './helpers/fakeApi';

vi.mock('../src/services/api', async () => (await import('./helpers/fakeApi')).fakeApiModule());

afterEach(() => {
  cleanup();
  resetFakeApi();
});

function setup(extra?: (name: string, input: unknown) => unknown) {
  const tabs: HarnessTabsState = { tabs: [], activeTabId: 'main', running: 0, queued: 0 };
  return installFakeApi((name, input) => {
    const hit = extra?.(name, input);
    if (hit !== undefined) return hit;
    if (name === 'harness.tabs') return tabs;
    if (name === 'tasks.get')
      return {
        task: {
          id: (input as { id: string }).id,
          title: '整理周报',
          goal: '整理',
          status: 'running',
        },
        attempts: [],
      };
    if (name === 'tasks.trace') return { attemptId: null, lines: [], attempts: [] };
    if (name === 'chatWindow.dockTab') return true;
    if (name.endsWith('.list') || name.endsWith('.pending') || name === 'chatWindow.detachedTabs')
      return [];
    return null;
  });
}

describe('detached tab window', () => {
  it('renders only the popped-out agent with its own composer, and can dock it back', async () => {
    const fake = setup();
    const spec: DetachSpec = {
      v: 1,
      kind: 'agent',
      scope: 'nomi:c1',
      target: { kind: 'nomi-task', taskId: 'k1' },
      title: '整理周报',
    };
    render(<DetachedApp spec={spec} />);
    const pane = await screen.findByTestId('subagent-pane');
    expect(pane.dataset.sideTab).toBe('nomi-task:k1');
    expect(pane.hidden).toBe(false);
    expect(pane.querySelector('[data-testid="chat-input"]')).toBeTruthy();
    // 独立窗口里没有关闭按钮（关窗口即可），也没有侧栏 / 主列
    expect(screen.queryByTestId('subagent-close')).toBeNull();
    expect(screen.queryByTestId('chat-column')).toBeNull();
    await waitFor(() => expect(document.title).toBe('整理周报 — Nomi'));
    fireEvent.click(screen.getByTestId('detached-dock'));
    await waitFor(() =>
      expect(fake.inputs('chatWindow.dockTab')).toEqual([{ id: '["nomi:c1","nomi-task:k1"]' }]),
    );
  });

  it('a popped-out side chat takes its content from the host, hands it back, and docks', async () => {
    const id = createSideChat('nomi:c1');
    setSideChatModel(id, 'p/m');
    const raw = exportSideChat(id)!;
    forgetSideChat(id);
    const key = JSON.stringify(['nomi:c1', `side-chat:${id}`]);
    const store = new Map([[key, raw]]);
    const fake = setup((name, input) => {
      if (name === 'chatWindow.handoffTake') {
        const k = (input as { id: string }).id;
        const v = store.get(k) ?? null;
        store.delete(k);
        return v;
      }
      if (name === 'chatWindow.handoffPut') {
        const i = input as { id: string; data: string };
        store.set(i.id, i.data);
        return true;
      }
      return undefined;
    });
    const spec: DetachSpec = {
      v: 1,
      kind: 'agent',
      scope: 'nomi:c1',
      target: { kind: 'side-chat', chatId: id },
      title: '侧边聊天 1',
    };
    render(<DetachedApp spec={spec} />);
    const pane = await screen.findByTestId('side-chat');
    expect(pane.hidden).toBe(false);
    expect(sideChatState(id)?.model).toBe('p/m');
    // 取到之后马上交回一份（窗口刷新 / 关掉后主窗口还能取回）
    await waitFor(() => expect(store.has(key)).toBe(true));
    fireEvent.click(screen.getByTestId('detached-dock'));
    await waitFor(() => expect(fake.inputs('chatWindow.dockTab')).toEqual([{ id: key }]));
    expect(JSON.parse(store.get(key)!).chat.id).toBe(id);
  });

  it('shows the closed state when there is nothing to take', async () => {
    setup((name) => (name === 'chatWindow.handoffTake' ? null : undefined));
    render(
      <DetachedApp
        spec={{
          v: 1,
          kind: 'agent',
          scope: 's',
          target: { kind: 'side-chat', chatId: 'gone' },
          title: '侧边聊天 1',
        }}
      />,
    );
    await waitFor(() => expect(screen.queryByTestId('side-chat')).toBeNull());
    await screen.findByTestId('detached-gone');
  });
});
