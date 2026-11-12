// @vitest-environment happy-dom
import type { ClientAIClient } from '@nomi-ai/ai-sdk-client';
import { act, cleanup, render } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AiChatContextProvider, useAiChat } from '../src/contexts/AiChatContext';
import { setSmartTitle } from '../src/services/chatPrefs';
import { type SdkIPCClient } from '../src/services/IPCClient';

const flush = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

/** 回复卡在流式生成中（gate 放行前不结束），标题请求应当已经发出 */
function fakeClient(titleGate: Promise<void>) {
  const titleCalls: unknown[] = [];
  const client = {
    chat: {
      agentStream: () =>
        (async function* () {
          await titleGate;
          yield { type: 'delta', content: '新回答' };
        })(),
      stream: () => {
        throw new Error('unused');
      },
      sendMessage: vi.fn(async (opts: { role?: string }) => {
        titleCalls.push(opts);
        return { content: '闲聊天气' };
      }),
      abort: vi.fn(),
    },
    memory: { userProfile: { get: () => undefined, set: vi.fn() } },
    dispose: vi.fn(),
  };
  return { client: client as unknown as ClientAIClient, chat: client.chat, titleCalls };
}

beforeEach(() => setSmartTitle(true));
afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe('Nomi 会话标题', () => {
  it('用户消息发出后就开始生成标题，不等这一轮回复结束', async () => {
    const gate = deferred<void>();
    const { client, chat } = fakeClient(gate.promise);
    const ref: { api?: ReturnType<typeof useAiChat> } = {};
    const Probe = () => {
      ref.api = useAiChat();
      return null;
    };
    render(
      <AiChatContextProvider client={client}>
        <Probe />
      </AiChatContextProvider>,
    );
    await flush();
    const ipc = ref.api!.state.ipcClient as SdkIPCClient;
    const store = ipc.conversationStore();
    const A = store.ensureCurrent();

    // 不 await：这一轮还在流式生成
    let done: Promise<void> | undefined;
    act(() => {
      done = ref.api!.actions.sendStreamMessage('明天天气怎么样');
    });
    // 等准备阶段的几个 await（压缩 / 记忆 / 扩展上下文）走完
    for (let i = 0; i < 8; i++) await flush();

    // 标题已经发起并写回会话名，而此时回复还没结束
    expect(chat.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ role: 'chat' }));
    expect(store.get(A)!.name).toBe('闲聊天气');
    expect(ref.api!.state.streaming).toBe(true);

    gate.resolve();
    await act(async () => {
      await done;
    });
    expect(ref.api!.state.streaming).toBe(false);
  });
});
