// @vitest-environment happy-dom
import type { ClientAIClient } from '@nomi-ai/ai-sdk-client';
import { act, cleanup, render, renderHook } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AiChatContextProvider, useAiChat } from '../src/contexts/AiChatContext';
import { useRestoreNomiOnMain } from '../src/hooks/useRestoreNomiOnMain';
import { ConversationStore, createMemoryStorage } from '../src/services/conversationStore';
import { type SdkIPCClient } from '../src/services/IPCClient';
import type { ChatMessage } from '../src/types/chat';

const msg = (id: string, role: ChatMessage['role'], content: string) =>
  ({ id, role, content, timestamp: Number(id) }) as ChatMessage;

const cliTab = (id: string) =>
  ({
    id,
    title: id,
    backend: 'claude',
    createdAt: 1,
    updatedAt: 1,
  }) as never;

describe('ConversationStore：Nomi 会话与 CLI 镜像分离（#19）', () => {
  const setup = () => {
    const store = new ConversationStore({ storage: createMemoryStorage() });
    const A = store.create('A').id;
    store.append(msg('1', 'user', '旧问题'), A);
    store.append(msg('2', 'assistant', '旧回答'), A);
    const C = store.upsertFromTab(cliTab('tab-c')).id;
    return { store, A, C };
  };

  it('镜像项不是 Nomi 会话；currentNomi / lastNomi 在切到镜像后仍指向 A', () => {
    const { store, A, C } = setup();
    expect(store.isNomi(A)).toBe(true);
    expect(store.isNomi(C)).toBe(false);
    store.switchTo(C);
    expect(store.currentId()).toBe(C);
    expect(store.lastNomiId()).toBe(A);
  });

  it('ensureCurrentNomi：当前在镜像上时恢复 A，不返回镜像 id、不新建', () => {
    const { store, A, C } = setup();
    store.switchTo(C);
    const before = store.list().length;
    expect(store.ensureCurrentNomi()).toBe(A);
    expect(store.currentId()).toBe(A);
    expect(store.list().length).toBe(before);
  });

  it('镜像被关闭（current 被清空）后，ensureCurrentNomi 仍回到 A，而不是新建会话', () => {
    const { store, A, C } = setup();
    store.switchTo(C);
    store.delete(C);
    const before = store.list().length;
    expect(store.ensureCurrentNomi()).toBe(A);
    expect(store.list().length).toBe(before);
  });

  it('nomiTarget：不改导航；镜像上取最近 Nomi，没有就静默新建；导航为空时同 ensureCurrentNomi', () => {
    const { store, A, C } = setup();
    store.switchTo(C);
    expect(store.nomiTarget()).toBe(A);
    expect(store.currentId()).toBe(C);

    const lone = new ConversationStore({ storage: createMemoryStorage() });
    const M = lone.upsertFromTab(cliTab('tab-m')).id;
    lone.switchTo(M);
    const fresh = lone.nomiTarget();
    expect(lone.isNomi(fresh)).toBe(true);
    expect(lone.currentId()).toBe(M);
    expect(lone.nomiTarget()).toBe(fresh); // 不会每次都新建

    const empty = new ConversationStore({ storage: createMemoryStorage() });
    const id = empty.nomiTarget();
    expect(empty.currentId()).toBe(id);
  });

  it('没有任何 Nomi 会话时才新建', () => {
    const store = new ConversationStore({ storage: createMemoryStorage() });
    const C = store.upsertFromTab(cliTab('tab-x')).id;
    store.switchTo(C);
    const id = store.ensureCurrentNomi();
    expect(id).not.toBe(C);
    expect(store.isNomi(id)).toBe(true);
  });
});

describe('Nomi 发送：A → 侧栏点 CLI C → 回主标签 → 发送（#19）', () => {
  beforeEach(() => localStorage.clear());
  afterEach(cleanup);

  function fakeClient() {
    const client = {
      chat: {
        agentStream: () =>
          (async function* () {
            yield { type: 'delta', content: '新回答' };
          })(),
        stream: () => {
          throw new Error('unused');
        },
        sendMessage: vi.fn(),
        abort: vi.fn(),
      },
      memory: { userProfile: { get: () => undefined, set: vi.fn() } },
      dispose: vi.fn(),
    };
    return client as unknown as ClientAIClient;
  }

  it('新一轮写进原 Nomi 会话 A；CLI 镜像 C 仍为空，关闭 C 后 A 的消息还在', async () => {
    const ref: { api?: ReturnType<typeof useAiChat> } = {};
    const Probe = () => {
      ref.api = useAiChat();
      return null;
    };
    render(
      <AiChatContextProvider client={fakeClient()}>
        <Probe />
      </AiChatContextProvider>,
    );
    await act(async () => void (await new Promise((r) => setTimeout(r, 0))));
    const ipc = ref.api!.state.ipcClient as SdkIPCClient;
    const store = ipc.conversationStore();
    const A = store.ensureCurrent();
    store.append(msg('1', 'user', '旧问题'), A);
    store.append(msg('2', 'assistant', '旧回答'), A);
    await act(async () => {
      await ref.api!.actions.loadChatHistory();
    });
    // 侧栏点 CLI 项：Sidebar 的做法是 switchConversation(镜像 id)，不加载也不更新 Nomi messages
    const C = store.upsertFromTab(cliTab('tab-c')).id;
    await act(async () => {
      await ipc.switchConversation(C);
    });
    expect(store.currentId()).toBe(C);
    // 顶栏回到 main：只切标签（这里不做任何事）；然后发送一条 Nomi 消息
    await act(async () => {
      await ref.api!.actions.sendStreamMessage('新问题');
    });
    expect(store.getMessages(A).map((m) => m.content)).toEqual([
      '旧问题',
      '旧回答',
      '新问题',
      '新回答',
    ]);
    expect(store.getMessages(C)).toEqual([]);
    store.delete(C); // 关闭 CLI 标签会删掉镜像
    expect(store.getMessages(A).map((m) => m.content)).toContain('新回答');
  });

  it('停在 CLI 镜像上时的后台 Nomi 轮次写进 A，但不把导航从镜像切走（侧栏不跳）', async () => {
    const ref: { api?: ReturnType<typeof useAiChat> } = {};
    const Probe = () => {
      ref.api = useAiChat();
      return null;
    };
    render(
      <AiChatContextProvider client={fakeClient()}>
        <Probe />
      </AiChatContextProvider>,
    );
    await act(async () => void (await new Promise((r) => setTimeout(r, 0))));
    const ipc = ref.api!.state.ipcClient as SdkIPCClient;
    const store = ipc.conversationStore();
    const A = store.ensureCurrent();
    store.append(msg('1', 'user', '旧问题'), A);
    const C = store.upsertFromTab(cliTab('tab-c')).id;
    await act(async () => {
      await ipc.switchConversation(C);
    });
    // 例如排队出队 / 异步斜杠命令在用户看着 CLI 标签时发出
    await act(async () => {
      await ref.api!.actions.sendStreamMessage('后台问题');
    });
    expect(store.getMessages(A).map((m) => m.content)).toEqual(['旧问题', '后台问题', '新回答']);
    expect(store.currentId()).toBe(C);
  });

  it('saveMessageTo 拒绝写入 CLI 镜像（兜底）', async () => {
    const ref: { api?: ReturnType<typeof useAiChat> } = {};
    const Probe = () => {
      ref.api = useAiChat();
      return null;
    };
    render(
      <AiChatContextProvider client={fakeClient()}>
        <Probe />
      </AiChatContextProvider>,
    );
    await act(async () => void (await new Promise((r) => setTimeout(r, 0))));
    const ipc = ref.api!.state.ipcClient as SdkIPCClient;
    const store = ipc.conversationStore();
    const C = store.upsertFromTab(cliTab('tab-c')).id;
    await ipc.saveMessageTo(msg('9', 'user', '不该写进来'), C);
    expect(store.getMessages(C)).toEqual([]);
  });
});

describe('useRestoreNomiOnMain：任何入口回到主标签都恢复 Nomi 会话（#19）', () => {
  const setup = () => {
    const store = new ConversationStore({ storage: createMemoryStorage() });
    const A = store.create('A').id;
    const C = store.upsertFromTab(cliTab('tab-c')).id;
    store.switchTo(C);
    const reload = vi.fn();
    return { store, A, C, reload };
  };

  it('CLI 标签 → main：store 当前会话恢复为 A 并重载消息；停在 CLI 标签时不动', () => {
    const { store, A, C, reload } = setup();
    const { rerender } = renderHook(({ tab }) => useRestoreNomiOnMain(tab, () => store, reload), {
      initialProps: { tab: 'tab-c' as string | undefined },
    });
    expect(store.currentId()).toBe(C);
    expect(reload).not.toHaveBeenCalled();
    rerender({ tab: 'main' }); // 顶栏点 main / 快捷键循环 / selectIndex 都是这个状态变化
    expect(store.currentId()).toBe(A);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('已经在 Nomi 会话上回到 main：不重载（不抖动）', () => {
    const { store, A, reload } = setup();
    store.switchTo(A);
    renderHook(() => useRestoreNomiOnMain('main', () => store, reload));
    expect(reload).not.toHaveBeenCalled();
  });

  it('重启后：主标签激活但持久化的 current 还指着 CLI 镜像 → 恢复 A', () => {
    const { store, A, reload } = setup();
    renderHook(() => useRestoreNomiOnMain('main', () => store, reload));
    expect(store.currentId()).toBe(A);
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
