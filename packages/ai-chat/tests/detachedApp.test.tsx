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
  resetSideChats,
  setSideChatModel,
  sideChatDraftKey,
  sideChatDrafts,
  sideChatState,
} from '../src/services/sideChat';
import type { DetachSpec } from '../src/utils/detachedTabs';

import { installFakeApi, resetFakeApi } from './helpers/fakeApi';

vi.mock('../src/services/api', async () => (await import('./helpers/fakeApi')).fakeApiModule());

afterEach(() => {
  cleanup();
  resetFakeApi();
  resetSideChats();
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
    // 独立窗口没有标签栏：面板头（状态）照旧，说明不收进输入框上方
    expect(pane.querySelector('[data-testid="subagent-status"]')).toBeTruthy();
    expect(pane.querySelector('[data-testid="subagent-brief"]')).toBeNull();
    await waitFor(() => expect(document.title).toBe('整理周报 — Nomi'));
    fireEvent.click(screen.getByTestId('detached-dock'));
    await waitFor(() =>
      expect(fake.inputs('chatWindow.dockTab')).toEqual([
        { id: '["nomi:c1","nomi-task:k1"]', transferId: expect.any(String), requireAck: true },
      ]),
    );
    expect(fake.inputs('chatWindow.registerHost')).toHaveLength(0);
    expect(fake.inputs('chatWindow.detachedTabs')).toHaveLength(0);
  });

  it('a popped-out side chat takes its content from the host, hands it back, and docks', async () => {
    const id = createSideChat('nomi:c1');
    setSideChatModel(id, 'p/m');
    const raw = exportSideChat(id)!;
    forgetSideChat(id);
    const key = JSON.stringify(['nomi:c1', `side-chat:${id}`]);
    const handoffKey = (idVal: string, dir?: string) => `${dir ?? ''}:${idVal}`;
    const store = new Map<string, { data: string; transferId?: string; keepUntilAck?: boolean }>([
      [handoffKey(key, 'detach'), { data: raw }],
    ]);
    const fake = setup((name, input) => {
      if (name === 'chatWindow.handoffTake') {
        const i = input as { id: string; direction?: string; transferId?: string };
        const hk = handoffKey(i.id, i.direction);
        const entry = store.get(hk);
        if (!entry) return null;
        if (i.transferId && entry.transferId !== i.transferId) return null;
        if (!entry.keepUntilAck) store.delete(hk);
        return entry.data;
      }
      if (name === 'chatWindow.handoffPut') {
        const i = input as {
          id: string;
          data: string;
          direction?: string;
          transferId?: string;
          keepUntilAck?: boolean;
        };
        store.set(handoffKey(i.id, i.direction), {
          data: i.data,
          transferId: i.transferId,
          keepUntilAck: i.keepUntilAck,
        });
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
    // 取到之后马上按 dock 方向交回一份（窗口关闭兜底）
    await waitFor(() => expect(store.has(handoffKey(key, 'dock'))).toBe(true));

    // 输入草稿图片应同步到 dock 快照
    sideChatDrafts.write(sideChatDraftKey(id), {
      text: '草稿文字',
      images: [
        {
          id: 'img1',
          mime: 'image/png',
          data: 'DRAFT_IMG',
          width: 4,
          height: 4,
          thumb: 'data:t',
          source: 'paste',
        },
      ],
      files: [],
    });
    await waitFor(() =>
      expect(store.get(handoffKey(key, 'dock'))?.data).toContain('DRAFT_IMG'),
    );

    fireEvent.click(screen.getByTestId('detached-dock'));
    await waitFor(() =>
      expect(fake.inputs('chatWindow.dockTab')).toEqual([
        { id: key, transferId: expect.any(String), requireAck: true },
      ]),
    );
    const dockEntry = store.get(handoffKey(key, 'dock'))!;
    expect(dockEntry.keepUntilAck).toBe(true);
    expect(dockEntry.transferId).toEqual(expect.any(String));
    expect(JSON.parse(dockEntry.data).chat.id).toBe(id);
    expect(JSON.parse(dockEntry.data).draft.images[0].data).toBe('DRAFT_IMG');
  });

  it('keeps local side chat state intact when handoffPut or dockTab fails', async () => {
    const id = createSideChat('nomi:c1');
    const raw = exportSideChat(id)!;
    forgetSideChat(id);
    setup((name, input) => {
      if (name === 'chatWindow.handoffTake') return raw;
      if (name === 'chatWindow.handoffPut') {
        return !(input as { keepUntilAck?: boolean }).keepUntilAck;
      }
      if (name === 'chatWindow.dockTab') return false;
      return undefined;
    });
    render(
      <DetachedApp
        spec={{
          v: 1,
          kind: 'agent',
          scope: 'nomi:c1',
          target: { kind: 'side-chat', chatId: id },
          title: '侧边聊天 1',
        }}
      />,
    );
    await screen.findByTestId('side-chat');
    fireEvent.click(screen.getByTestId('detached-dock'));
    await waitFor(() =>
      expect((screen.getByTestId('detached-dock') as HTMLButtonElement).disabled).toBe(false),
    );
    expect(sideChatState(id)?.id).toBe(id);
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
