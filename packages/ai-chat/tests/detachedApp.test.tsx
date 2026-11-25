// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DetachedApp } from '../src/detached/DetachedApp';
import type { HarnessTabsState } from '../src/services/harnessClient';
import {
  createSideChat,
  exportSideChat,
  forgetSideChat,
  importSideChat,
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

/** 假宿主：交接快照 + 两阶段放回（主窗口按 surface 取走快照、回确认，和 Go 的 tabwindows 一样） */
function fakeHost(initial: [detachedId: string, data: string][]) {
  const store = new Map<string, string>();
  const putIds: string[] = [];
  const takeIds: string[] = [];
  const dockInputs: Array<{ id: string; transferId: string; requireAck: boolean }> = [];
  const acks: Array<{ id: string; transferId: string; ok: boolean }> = [];
  const key = (id: string, dir?: string) => `${dir ?? ''}:${id}`;
  let nextPut: boolean | Promise<boolean> = true;
  let nextDock: boolean | Promise<boolean> = true;
  for (const [id, data] of initial) store.set(key(id, 'detach'), data);
  /** 主窗口一侧直接调：不经过渲染，到的就是这个假宿主 */
  const hostCall = (name: string, input: unknown) => handler(name, input);
  const fake = setup((name, input) => handler(name, input));
  function handler(name: string, input: unknown): unknown {
    if (name === 'chatWindow.handoffPut') {
      const i = input as { id: string; data: string; direction?: string };
      const answer = nextPut;
      nextPut = true;
      if (answer) {
        putIds.push(i.id);
        store.set(key(i.id, i.direction), i.data);
      }
      return answer;
    }
    if (name === 'chatWindow.handoffTake') {
      const i = input as { id: string; direction?: string };
      const hk = key(i.id, i.direction);
      if (!store.has(hk)) return null;
      takeIds.push(hk);
      const data = store.get(hk)!;
      store.delete(hk);
      return data;
    }
    if (name === 'chatWindow.dockTab') {
      const i = input as { id: string; transferId?: string; requireAck?: boolean };
      dockInputs.push({ id: i.id, transferId: i.transferId!, requireAck: !!i.requireAck });
      const answer = nextDock;
      nextDock = true;
      return answer;
    }
    if (name === 'chatWindow.dockAck') {
      const i = input as { id: string; transferId: string; ok: boolean };
      acks.push({ ...i });
      return true;
    }
    return undefined;
  }
  return {
    fake,
    store,
    putIds,
    takeIds,
    dockInputs,
    acks,
    latest: () => {
      const last = putIds.at(-1);
      return last ? store.get(key(last, 'dock')) : undefined;
    },
    failNextPut: (answer: boolean | Promise<boolean> = false) => {
      nextPut = answer;
    },
    failNextDock: (answer: boolean | Promise<boolean> = false) => {
      nextDock = answer;
    },
    /** 主窗口：收到放回请求，取走快照、收下、回确认 */
    ackFromMain: async (dock: { id: string; transferId: string }, ok = true) => {
      const raw = await hostCall('chatWindow.handoffTake', {
        id: dock.id,
        direction: 'dock',
        transferId: dock.transferId,
      });
      expect(raw).toEqual(expect.any(String));
      importSideChat(raw, { withDraft: true });
      await hostCall('chatWindow.dockAck', { id: dock.id, transferId: dock.transferId, ok });
      return raw as string;
    },
  };
}

/** 输入栏里打字（受控 textarea：change 写进草稿） */
function typeDraft(text: string) {
  fireEvent.change(screen.getByTestId('chat-input'), { target: { value: text } });
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const sideSpec = (id: string): DetachSpec => ({
  v: 1,
  kind: 'agent',
  scope: 'nomi:c1',
  target: { kind: 'side-chat', chatId: id },
  title: '侧边聊天 1',
});

const sideKey = (id: string) => JSON.stringify(['nomi:c1', `side-chat:${id}`]);

const draftOf = (raw: string | null | undefined) =>
  (JSON.parse(raw!) as { draft: { text: string; images: Array<{ data: string }> } }).draft;

describe('side chat dock while waiting for the main window (#415)', () => {
  it('edits made while the ack is delayed are not dropped: the main window gets the latest draft', async () => {
    const id = createSideChat('nomi:c1');
    setSideChatModel(id, 'p/m');
    const raw = exportSideChat(id)!;
    forgetSideChat(id);
    const keyboard = deferred<boolean>();
    const host = fakeHost([[sideKey(id), raw]]);
    host.failNextDock(keyboard.promise);
    render(<DetachedApp spec={sideSpec(id)} />);
    await screen.findByTestId('side-chat');
    // 放回之前打的字（还没等到 150ms 的自动交接）
    typeDraft('放回前');
    fireEvent.click(screen.getByTestId('detached-dock'));
    await waitFor(() => expect(host.dockInputs).toHaveLength(1));
    const dock = host.dockInputs[0]!;
    // 开始等之前的那份只带旧草稿（之前的自动交接已被放回快照覆盖）
    expect(draftOf(host.store.get(`dock:${sideKey(id)}`)).text).toBe('放回前');
    // 等确认期间继续编辑：输入栏不锁死，但不能发送
    const input = screen.getByTestId('chat-input') as HTMLTextAreaElement;
    expect(input.disabled).toBe(false);
    expect(screen.getByTestId('side-chat-dock-note').dataset.state).toBe('pending');
    typeDraft('放回中又改了');
    await waitFor(() => expect(draftOf(host.store.get(`dock:${sideKey(id)}`)).text).toBe('放回中又改了'));
    // 主窗口确认收下：收到的是最新的草稿，两边是同一个传输 id
    const taken = await host.ackFromMain(dock);
    expect(draftOf(taken).text).toBe('放回中又改了');
    expect(sideChatDrafts.read(sideChatDraftKey(id)).text).toBe('放回中又改了');
    await act(async () => keyboard.resolve(true));
    expect(host.acks).toEqual([{ id: dock.id, transferId: dock.transferId, ok: true }]);
    // 收下之后这里迟到的自动交接（同一个传输 id）不能把更新的草稿盖回去
    const adopted = JSON.parse(taken) as { draft: { text: string } };
    adopted.draft.text = '旧草稿';
    importSideChat(JSON.stringify(adopted), { withDraft: true, draftOnly: true });
    expect(sideChatDrafts.read(sideChatDraftKey(id)).text).toBe('放回中又改了');
    expect(sideChatState(id)?.model).toBe('p/m');
  });

  it('a failed handoff put unlocks the composer, keeps the content, and the next dock retries', async () => {
    const id = createSideChat('nomi:c1');
    const raw = exportSideChat(id)!;
    forgetSideChat(id);
    const host = fakeHost([[sideKey(id), raw]]);
    render(<DetachedApp spec={sideSpec(id)} />);
    await screen.findByTestId('side-chat');
    typeDraft('失败前');
    host.failNextPut(false);
    fireEvent.click(screen.getByTestId('detached-dock'));
    await waitFor(() =>
      expect(screen.getByTestId('side-chat-dock-note').dataset.state).toBe('failed'),
    );
    // 窗口没关、按钮能再点；输入栏解锁，写回的是这里（最新的）那份草稿
    const button = screen.getByTestId('detached-dock') as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    expect(host.dockInputs).toHaveLength(0);
    expect((screen.getByTestId('chat-input') as HTMLTextAreaElement).disabled).toBe(false);
    expect(sideChatState(id)?.id).toBe(id);
    expect(sideChatDrafts.read(sideChatDraftKey(id)).text).toBe('失败前');
    typeDraft('失败后接着改');
    expect(sideChatDrafts.read(sideChatDraftKey(id)).text).toBe('失败后接着改');

    // 再点一次：新的放回带着最新的草稿（模拟放回超时：确认之外宿主以 false 结束）
    const timedOut = deferred<boolean>();
    host.failNextDock(timedOut.promise);
    fireEvent.click(button);
    await waitFor(() => expect(host.dockInputs).toHaveLength(1));
    expect(screen.getByTestId('side-chat-dock-note').dataset.state).toBe('pending');
    expect(draftOf(host.store.get(`dock:${sideKey(id)}`)).text).toBe('失败后接着改');
    // 等确认期间再点不会再发起一次
    fireEvent.click(screen.getByTestId('detached-dock'));
    expect(host.dockInputs).toHaveLength(1);

    // 放回超时（宿主 / 主窗口没确认）：同样不关窗、解锁、草稿都在
    const taken = await host.ackFromMain(host.dockInputs[0]!);
    expect(draftOf(taken).text).toBe('失败后接着改');
    await act(async () => timedOut.resolve(false));
    await waitFor(() =>
      expect(screen.getByTestId('side-chat-dock-note').dataset.state).toBe('failed'),
    );
    expect((screen.getByTestId('detached-dock') as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByTestId('chat-input') as HTMLTextAreaElement).disabled).toBe(false);
    expect(sideChatState(id)?.id).toBe(id);
    expect(sideChatDrafts.read(sideChatDraftKey(id)).text).toBe('失败后接着改');
  });
});
