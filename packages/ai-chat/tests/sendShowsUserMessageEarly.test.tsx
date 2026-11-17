// @vitest-environment happy-dom
import type { ClientAIClient } from '@nomi-ai/ai-sdk-client';
import { act, cleanup, render } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AiChatContextProvider, useAiChat } from '../src/contexts/AiChatContext';
import { gatewayClient } from '../src/services/gatewayClient';
import { harnessClient } from '../src/services/harnessClient';
import { type SdkIPCClient } from '../src/services/IPCClient';
import type { ChatMessage } from '../src/types/chat';

import type { ApiMockState } from './helpers/knowledgeApi';

const apiMock = vi.hoisted(() => ({ transport: false }) as ApiMockState);
vi.mock('../src/services/api', async () =>
  (await import('./helpers/knowledgeApi')).createApiMock(apiMock),
);

type Api = ReturnType<typeof useAiChat>;

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

function fakeClient() {
  // 摘要走 chat.sendMessage({ role: 'summary' })：这里把它挂住，模拟压缩要跑几十秒
  const summarizeGate = deferred<{ content: string }>();
  const sendMessage = vi.fn(() => summarizeGate.promise);
  const chat = {
    agentStream() {
      return (async function* () {
        yield { type: 'delta', content: 'ok' };
      })();
    },
    stream() {
      throw new Error('stream() should not be used when agentStream exists');
    },
    sendMessage,
    abort: vi.fn(),
  };
  const client = {
    chat,
    memory: { userProfile: { get: () => undefined, set: vi.fn() } },
    dispose: vi.fn(),
  };
  return { client: client as unknown as ClientAIClient, sendMessage, summarizeGate };
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
const settle = (ms = 5) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));

const msg = (id: string, role: ChatMessage['role'], content: string): ChatMessage =>
  ({ id, role, content, timestamp: Number(id.replace(/\D/g, '')) || 1 }) as ChatMessage;

// 发送前的压缩要跑一次模型（几十秒）：这期间用户刚发的那句话必须已经在会话里，
// 否则输入框看起来像把消息吞了，等摘要跑完才突然出现。
describe('压缩期间用户消息先上屏', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    vi.restoreAllMocks();
    cleanup();
  });

  it('摘要还在生成时消息已显示；摘要卡排在它上方', async () => {
    const f = fakeClient();
    const ref = mount(f.client);
    await flush();
    const ipc = ref.api.state.ipcClient as SdkIPCClient;
    const store = ipc.conversationStore();
    const A = store.create({ projectId: 'p_a' }).id;
    store.switchTo(A);
    // 已经聊过一段（至少 4 条才会自动压缩）：compactAt 给得很低，一发就压
    store.setMessages(A, [
      msg('1', 'user', '早先的问题'),
      msg('2', 'assistant', '早先的回答'),
      msg('3', 'user', '第二个问题'),
      msg('4', 'assistant', '第二个回答'),
      msg('5', 'user', '第三个问题'),
      msg('6', 'assistant', '第三个回答'),
    ]);
    await act(async () => {
      await ref.api.actions.loadChatHistory();
    });

    vi.spyOn(harnessClient, 'available').mockReturnValue(false);
    vi.spyOn(gatewayClient, 'nomiContext').mockResolvedValue({
      model: 'p/m',
      window: 10_000,
      outputReserve: 2_000,
      budget: 8_000,
      compactAt: 1,
      source: 'catalog',
    });
    const gate = f.summarizeGate;

    let done!: Promise<void>;
    await settle();
    await act(async () => {
      done = ref.api.actions.sendStreamMessage('压缩时发的话');
      await new Promise((r) => setTimeout(r, 10));
    });

    // 压缩真的在跑（摘要模型还没回），而那句话已经上屏
    expect(f.sendMessage).toHaveBeenCalledTimes(1);
    expect(ref.api.state.messages.map((m) => m.content).at(-1)).toBe('压缩时发的话');
    expect(ref.api.state.messages.map((m) => m.role)).toContain('user');
    expect(ref.api.state.isLoading).toBe(true);

    gate.resolve({ content: 'SUMMARY' });
    await act(async () => {
      await done;
    });

    // 摘要卡在用户消息上方：它概括的是更早的对话，不是刚发的这句
    expect(ref.api.state.messages.map((m) => m.content)).toEqual([
      '早先的问题',
      '早先的回答',
      '第二个问题',
      '第二个回答',
      '第三个问题',
      '第三个回答',
      'SUMMARY',
      '压缩时发的话',
      'ok',
    ]);
    // 落盘顺序同样成立
    expect(store.getMessages(A).map((m) => m.content)).toEqual([
      '早先的问题',
      '早先的回答',
      '第二个问题',
      '第二个回答',
      '第三个问题',
      '第三个回答',
      'SUMMARY',
      '压缩时发的话',
      'ok',
    ]);
  });
});
