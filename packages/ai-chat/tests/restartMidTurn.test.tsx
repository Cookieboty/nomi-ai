// @vitest-environment happy-dom
import type { ClientAIClient } from '@nomi-ai/ai-sdk-client';
import { act, cleanup, render } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AiChatContextProvider, useAiChat } from '../src/contexts/AiChatContext';
import { INTERRUPTED_REPLY_PREFIX } from '../src/contexts/chatTurn';
import {
  prepareConversationStore,
  resetPreparedConversationStore,
} from '../src/services/conversationBoot';
import { createMemoryConversationKernel } from '../src/services/conversationKernel';
import { ConversationStore } from '../src/services/conversationStore';
import { type SdkIPCClient } from '../src/services/IPCClient';
import type { ChatMessage } from '../src/types/chat';

import type { ApiMockState } from './helpers/knowledgeApi';

const apiMock = vi.hoisted(() => ({ transport: false }) as ApiMockState);
vi.mock('../src/services/api', async () =>
  (await import('./helpers/knowledgeApi')).createApiMock(apiMock),
);

type Api = ReturnType<typeof useAiChat>;

/** hang = true：回复一直不结束（模拟这一轮还在跑时应用被重启） */
function fakeClient(opts: { hang: boolean }) {
  const chat = {
    agentStream() {
      return (async function* () {
        yield { type: 'delta', content: 'ok' };
        if (opts.hang) await new Promise(() => undefined);
      })();
    },
    stream() {
      throw new Error('stream() should not be used when agentStream exists');
    },
    sendMessage: vi.fn(),
    abort: vi.fn(),
  };
  return {
    chat,
    memory: { userProfile: { get: () => undefined, set: vi.fn() } },
    dispose: vi.fn(),
  } as unknown as ClientAIClient;
}

function mount(client: ClientAIClient) {
  const ref: { api?: Api } = {};
  const Probe = () => {
    ref.api = useAiChat();
    return null;
  };
  const r = render(
    <AiChatContextProvider client={client}>
      <Probe />
    </AiChatContextProvider>,
  );
  return { ref: ref as { api: Api }, unmount: r.unmount };
}

/** 复制一份内核数据（= 进程被杀那一刻磁盘上的内容） */
function snapshotKernel(from: ReturnType<typeof createMemoryConversationKernel>) {
  const to = createMemoryConversationKernel();
  const copy = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
  to.data.order.push(...from.data.order);
  for (const [k, v] of from.data.metas) to.data.metas.set(k, copy(v));
  for (const [k, v] of from.data.messages) to.data.messages.set(k, copy(v));
  Object.assign(to.data.previews, copy(from.data.previews));
  to.data.current = from.data.current;
  to.data.lastNomi = from.data.lastNomi;
  to.data.migrated = from.data.migrated;
  return to;
}

const flush = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));
const roles = (list: ChatMessage[]) => list.map((m) => [m.role, m.content]);

describe('应用在回复中途重启（如更新）：最后一条用户消息不丢', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    resetPreparedConversationStore();
    vi.restoreAllMocks();
    cleanup();
  });

  it('发出就落盘；重启后它还在对话里，并带一张可重试的卡，重试会重新发送', async () => {
    const kernel = createMemoryConversationKernel();
    await prepareConversationStore({ kernel });
    const first = mount(fakeClient({ hang: true }));
    await flush();
    const ipc = first.ref.api.state.ipcClient as SdkIPCClient;
    const A = ipc.conversationStore().create().id;
    ipc.conversationStore().switchTo(A);
    await act(async () => {
      await first.ref.api.actions.loadChatHistory();
    });
    await act(async () => {
      void first.ref.api.actions.sendStreamMessage('升级前的最后一句');
      await new Promise((r) => setTimeout(r, 20));
    });
    await ipc.conversationStore().flush();
    // 这一轮还没结束：用户消息已经写进内核
    expect(roles(kernel.data.messages.get(A)!)).toEqual([['user', '升级前的最后一句']]);

    // 重启：进程在这一刻没了——磁盘上就是现在这份，旧界面之后不会再写任何东西；新进程从磁盘读
    const disk = snapshotKernel(kernel);
    first.unmount();
    resetPreparedConversationStore();
    await prepareConversationStore({ kernel: disk });
    const second = mount(fakeClient({ hang: false }));
    await flush();
    const ipc2 = second.ref.api.state.ipcClient as SdkIPCClient;
    await ipc2.switchConversation(A);
    await act(async () => {
      await second.ref.api.actions.loadChatHistory();
    });
    const shown = second.ref.api.state.messages;
    expect(shown.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(shown[0]!.content).toBe('升级前的最后一句');
    expect(shown[1]!.id.startsWith(INTERRUPTED_REPLY_PREFIX)).toBe(true);
    expect(shown[1]!.error).toBeTruthy();
    // 提示卡只在界面上：不写进对话记录
    await ipc2.conversationStore().flush();
    expect(roles(disk.data.messages.get(A)!)).toEqual([['user', '升级前的最后一句']]);

    // 点重试：从这条用户消息重新发送
    await act(async () => {
      await second.ref.api.actions.resendFrom(shown[0]!.id);
    });
    await ipc2.conversationStore().flush();
    expect(roles(disk.data.messages.get(A)!)).toEqual([
      ['user', '升级前的最后一句'],
      ['assistant', 'ok'],
    ]);
    expect(roles(second.ref.api.state.messages)).toEqual([
      ['user', '升级前的最后一句'],
      ['assistant', 'ok'],
    ]);
  });

  it('正常结束的一轮：先存的用户消息不会多出一份，回复照常在后面', async () => {
    const kernel = createMemoryConversationKernel();
    await prepareConversationStore({ kernel });
    const { ref } = mount(fakeClient({ hang: false }));
    await flush();
    const ipc = ref.api.state.ipcClient as SdkIPCClient;
    const A = ipc.conversationStore().create().id;
    ipc.conversationStore().switchTo(A);
    await act(async () => {
      await ref.api.actions.loadChatHistory();
    });
    await act(async () => {
      await ref.api.actions.sendStreamMessage('一');
    });
    await act(async () => {
      await ref.api.actions.sendStreamMessage('二');
    });
    await ipc.conversationStore().flush();
    const want = [
      ['user', '一'],
      ['assistant', 'ok'],
      ['user', '二'],
      ['assistant', 'ok'],
    ];
    expect(roles(kernel.data.messages.get(A)!)).toEqual(want);
    // 回到这个会话：结尾是回复，不补提示卡
    await act(async () => {
      await ref.api.actions.loadChatHistory();
    });
    expect(roles(ref.api.state.messages)).toEqual(want);
    // 没有记忆 / 压缩时只追加，不整份重写
    expect(kernel.calls).not.toContain('replace');
  });
});

describe('ConversationStore.upsert', () => {
  const m = (id: string, content: string, role: 'user' | 'assistant' = 'user'): ChatMessage => ({
    id,
    role,
    content,
    timestamp: 1,
  });

  it('同 id 再存：覆盖并放到末尾（插在中间的摘要留在它前面）；新 id 照常追加', async () => {
    const kernel = createMemoryConversationKernel();
    const store = new ConversationStore({ kernel });
    const a = store.create().id;
    await store.upsert(m('u1', 'q'), a);
    await store.upsert(m('s', 'summary', 'assistant'), a);
    await store.upsert({ ...m('u1', 'q'), memory: { text: 'mem', ids: ['f1'] } }, a);
    await store.upsert(m('r', 'answer', 'assistant'), a);
    await store.flush();
    const saved = kernel.data.messages.get(a)!;
    expect(saved.map((x) => x.id)).toEqual(['s', 'u1', 'r']);
    expect(saved[1]!.memory?.text).toBe('mem');
  });

  it('会话没加载（已从缓存淘汰）：先读再判断，不会追加出两份', async () => {
    const kernel = createMemoryConversationKernel();
    const store = new ConversationStore({ kernel });
    const a = store.create().id;
    store.append(m('u1', 'q'), a);
    await store.flush();
    const again = new ConversationStore({ kernel, snapshot: await kernel.state() });
    await again.upsert({ ...m('u1', 'q'), delegateTo: 'codex' } as ChatMessage, a);
    await again.flush();
    expect(kernel.data.messages.get(a)!.map((x) => x.id)).toEqual(['u1']);
    store.dispose();
    again.dispose();
  });
});
