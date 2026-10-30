// @vitest-environment happy-dom
import type { ClientAIClient } from '@nomi-ai/ai-sdk-client';
import { act, cleanup, render } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AiChatContextProvider, useAiChat } from '../src/contexts/AiChatContext';
import { extClient } from '../src/services/extClient';
import { type SdkIPCClient } from '../src/services/IPCClient';

import type { ApiMockState } from './helpers/knowledgeApi';

// 契约客户端（services/api）的替身：没有传输，记忆 / 压缩 / 编程助手状态都走缺省
const apiMock = vi.hoisted(() => ({ transport: false }) as ApiMockState);
vi.mock('../src/services/api', async () =>
  (await import('./helpers/knowledgeApi')).createApiMock(apiMock),
);

type Api = ReturnType<typeof useAiChat>;
type Sent = {
  extra?: { conversationId?: string; cwd?: string };
  messages?: Array<{ role: string; content: string }>;
};

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

/** 记下每次 agentStream 的请求；回一段文字就结束 */
function fakeClient() {
  const sent: Sent[] = [];
  const chat = {
    agentStream(opts: Sent) {
      sent.push(opts);
      return (async function* () {
        yield { type: 'delta', content: 'ok' };
      })();
    },
    stream() {
      throw new Error('stream() should not be used when agentStream exists');
    },
    sendMessage: vi.fn(),
    abort: vi.fn(),
  };
  const client = {
    chat,
    memory: { userProfile: { get: () => undefined, set: vi.fn() } },
    dispose: vi.fn(),
  };
  return { client: client as unknown as ClientAIClient, sent };
}

function mount(client: ClientAIClient) {
  const ref: { api?: Api } = {};
  const Probe = () => {
    ref.api = useAiChat();
    return null;
  };
  render(
    <AiChatContextProvider client={client}>
      <Probe />
    </AiChatContextProvider>,
  );
  return ref as { api: Api };
}

const flush = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));

async function setupAB() {
  const f = fakeClient();
  const ref = mount(f.client);
  await flush();
  const ipc = ref.api.state.ipcClient as SdkIPCClient;
  const store = ipc.conversationStore();
  const A = store.create({ cwd: '/work/a' }).id;
  const B = store.create({ cwd: '/work/b' }).id;
  store.switchTo(A);
  await act(async () => {
    await ref.api.actions.loadChatHistory();
  });
  return { f, ref, ipc, store, A, B };
}

/** 卡住发送前的准备（扩展上下文这一步），由测试决定何时放行 */
function holdPreparation() {
  const gate = deferred<string>();
  const spy = vi.spyOn(extClient, 'context').mockReturnValue(gate.promise);
  return { release: () => gate.resolve(''), spy };
}

describe('Nomi 发送准备期间切换会话（#184）', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    vi.restoreAllMocks();
    cleanup();
  });

  it('准备中切到 B 再放行：请求仍带 A 的会话 id 与工作区，B 收不到 A 的消息', async () => {
    const { f, ref, ipc, store, A, B } = await setupAB();
    const hold = holdPreparation();

    let done!: Promise<void>;
    await act(async () => {
      done = ref.api.actions.sendStreamMessage('给 A 的消息');
      await new Promise((r) => setTimeout(r, 5));
    });
    expect(hold.spy).toHaveBeenCalledTimes(1);
    expect(f.sent).toHaveLength(0);

    // 用户切到 B（Sidebar 的做法：switchConversation + loadChatHistory）
    await act(async () => {
      await ipc.switchConversation(B);
      await ref.api.actions.loadChatHistory();
    });
    expect(ipc.currentConversationId()).toBe(B);

    hold.release();
    await act(async () => {
      await done;
    });

    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]!.extra).toEqual({ conversationId: A, cwd: '/work/a' });
    expect(f.sent[0]!.messages?.at(-1)?.content).toBe('给 A 的消息');
    expect(store.getMessages(A).map((m) => [m.role, m.content])).toEqual([
      ['user', '给 A 的消息'],
      ['assistant', 'ok'],
    ]);
    expect(store.getMessages(B)).toEqual([]);
    // 当前展示的是 B：界面不能出现 A 的消息
    expect(ref.api.state.messages).toEqual([]);
    expect(ref.api.state.isLoading).toBe(false);
  });

  it('快速 A→B→A：仍只发一次，带 A 的会话与工作区', async () => {
    const { f, ref, ipc, A, B } = await setupAB();
    const hold = holdPreparation();
    let done!: Promise<void>;
    await act(async () => {
      done = ref.api.actions.sendStreamMessage('q');
      await new Promise((r) => setTimeout(r, 5));
    });
    await act(async () => {
      await ipc.switchConversation(B);
      await ipc.switchConversation(A);
      await ref.api.actions.loadChatHistory();
    });
    hold.release();
    await act(async () => {
      await done;
    });
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]!.extra).toEqual({ conversationId: A, cwd: '/work/a' });
    expect(ref.api.state.messages.map((m) => m.content)).toEqual(['q', 'ok']);
  });

  it('准备期间 A 被删除：不发送，也不落到 B', async () => {
    const { f, ref, ipc, store, A, B } = await setupAB();
    const hold = holdPreparation();
    let done!: Promise<void>;
    await act(async () => {
      done = ref.api.actions.sendStreamMessage('q');
      await new Promise((r) => setTimeout(r, 5));
    });
    await act(async () => {
      await ipc.switchConversation(B);
      await ipc.deleteConversation(A);
      await ref.api.actions.loadChatHistory();
    });
    hold.release();
    await act(async () => {
      await done;
    });
    expect(f.sent).toHaveLength(0);
    expect(store.get(A)).toBeUndefined();
    expect(store.getMessages(B)).toEqual([]);
    expect(ref.api.state.messages).toEqual([]);
    expect(ref.api.state.isLoading).toBe(false);
  });

  it('没有工作区的会话：请求只带会话 id，不借用别的会话的工作区', async () => {
    const { f, ref, ipc, store, B } = await setupAB();
    const C = store.create().id;
    expect(store.get(C)?.cwd).toBeUndefined();
    const hold = holdPreparation();
    let done!: Promise<void>;
    await act(async () => {
      done = ref.api.actions.sendStreamMessage('q');
      await new Promise((r) => setTimeout(r, 5));
    });
    await act(async () => {
      await ipc.switchConversation(B);
    });
    hold.release();
    await act(async () => {
      await done;
    });
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]!.extra).toEqual({ conversationId: C });
  });

  it('不切会话的正常路径：只发送一次，带当前会话与工作区', async () => {
    const { f, ref, store, A } = await setupAB();
    await act(async () => {
      await ref.api.actions.sendStreamMessage('hi');
    });
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]!.extra).toEqual({ conversationId: A, cwd: '/work/a' });
    expect(store.getMessages(A).map((m) => m.content)).toEqual(['hi', 'ok']);
    expect(ref.api.state.messages.map((m) => m.content)).toEqual(['hi', 'ok']);
  });

  it('IPCClient：显式给了会话就不读当前会话；会话已删则拒绝发送', async () => {
    const { f, ipc, store, A, B } = await setupAB();
    store.switchTo(B);
    await ipc.sendStreamMessage('x', undefined, [], undefined, undefined, {
      conversation: { id: A, cwd: '/work/a' },
    });
    expect(f.sent.at(-1)!.extra).toEqual({ conversationId: A, cwd: '/work/a' });
    store.delete(A);
    await expect(
      ipc.sendStreamMessage('y', undefined, [], undefined, undefined, {
        conversation: { id: A, cwd: '/work/a' },
      }),
    ).rejects.toThrow();
    expect(f.sent).toHaveLength(1);
  });
});
