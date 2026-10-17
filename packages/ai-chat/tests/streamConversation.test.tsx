// @vitest-environment happy-dom
import type { ClientAIClient } from '@nomi-ai/ai-sdk-client';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AiChatContextProvider, useAiChat } from '../src/contexts/AiChatContext';
import { type SdkIPCClient } from '../src/services/IPCClient';

type Api = ReturnType<typeof useAiChat>;

/** 可手动推送 chunk 的假流；abort(reqId) 会触发 AbortController，并让流以 abort 错误收尾 */
function fakeClient() {
  const queue: Array<{ type: string; content?: string }> = [];
  let wake: (() => void) | undefined;
  let finished = false;
  const upstream = new AbortController();
  const abortCalls: string[] = [];
  const seen: { reqId?: string } = {};
  const chat = {
    agentStream(opts: { reqId?: string }) {
      seen.reqId = opts.reqId;
      return (async function* () {
        for (;;) {
          if (upstream.signal.aborted) throw new Error('aborted upstream');
          const next = queue.shift();
          if (next) {
            yield next;
            continue;
          }
          if (finished) return;
          await new Promise<void>((r) => (wake = r));
        }
      })();
    },
    stream() {
      throw new Error('stream() should not be used when agentStream exists');
    },
    sendMessage: vi.fn(),
    abort(reqId: string) {
      abortCalls.push(reqId);
      upstream.abort();
      wake?.();
    },
  };
  const client = {
    chat,
    memory: { userProfile: { get: () => undefined, set: vi.fn() } },
    dispose: vi.fn(),
  };
  return {
    client: client as unknown as ClientAIClient,
    push(content: string) {
      queue.push({ type: 'delta', content });
      wake?.();
    },
    finish() {
      finished = true;
      wake?.();
    },
    upstream,
    abortCalls,
    seen,
  };
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

describe('Nomi 流式回复 · 会话固定与停止生成', () => {
  beforeEach(() => localStorage.clear());
  afterEach(cleanup);

  it('流式中途切换会话：整轮消息落在发起会话，新会话保持为空', async () => {
    const f = fakeClient();
    const ref = mount(f.client);
    await flush();
    const ipc = ref.api.state.ipcClient as SdkIPCClient;
    const store = ipc.conversationStore();
    const A = store.ensureCurrent();
    const B = store.create().id;
    store.switchTo(A);

    let done!: Promise<void>;
    await act(async () => {
      done = ref.api.actions.sendStreamMessage('你好');
      await new Promise((r) => setTimeout(r, 5));
    });
    f.push('部分');
    await flush();
    expect(ref.api.state.messages.map((m) => m.content)).toEqual(['你好', '部分']);

    // 用户切到 B（Sidebar 的做法：switchConversation + loadChatHistory）
    await act(async () => {
      await ipc.switchConversation(B);
      await ref.api.actions.loadChatHistory();
    });
    f.push('回复');
    f.finish();
    await act(async () => {
      await done;
    });

    expect(store.getMessages(A).map((m) => [m.role, m.content])).toEqual([
      ['user', '你好'],
      ['assistant', '部分回复'],
    ]);
    expect(store.getMessages(B)).toEqual([]);
    // 当前展示的是 B：界面不能被 A 的流污染
    expect(ref.api.state.messages).toEqual([]);
    expect(ref.api.state.isLoading).toBe(false);
  });

  it('流式中途新建会话：不写入新会话', async () => {
    const f = fakeClient();
    const ref = mount(f.client);
    await flush();
    const ipc = ref.api.state.ipcClient as SdkIPCClient;
    const store = ipc.conversationStore();
    const A = store.ensureCurrent();
    let done!: Promise<void>;
    await act(async () => {
      done = ref.api.actions.sendStreamMessage('q');
      await new Promise((r) => setTimeout(r, 5));
    });
    f.push('x');
    await flush();
    await act(async () => {
      await ref.api.actions.newConversation();
    });
    const fresh = store.currentId()!;
    expect(fresh).not.toBe(A);
    f.finish();
    await act(async () => {
      await done;
    });
    expect(store.getMessages(A).map((m) => m.content)).toEqual(['q', 'x']);
    expect(store.getMessages(fresh)).toEqual([]);
  });

  it('3 个 chunk 后停止：上游 AbortSignal 被触发，已生成内容落盘并标记 stopped', async () => {
    const f = fakeClient();
    const ref = mount(f.client);
    await flush();
    const ipc = ref.api.state.ipcClient as SdkIPCClient;
    const store = ipc.conversationStore();
    const A = store.ensureCurrent();

    let done!: Promise<void>;
    await act(async () => {
      done = ref.api.actions.sendStreamMessage('写点东西');
      await new Promise((r) => setTimeout(r, 5));
    });
    expect(ref.api.state.streaming).toBe(true);
    f.push('一');
    f.push('二');
    f.push('三');
    await flush();
    await act(async () => {
      ref.api.actions.stopGeneration();
      await done;
    });

    expect(f.upstream.signal.aborted).toBe(true);
    expect(f.abortCalls[0]).toBe(f.seen.reqId);
    expect(f.seen.reqId).toMatch(/^req_/);
    const saved = store.getMessages(A);
    expect(saved.map((m) => m.content)).toEqual(['写点东西', '一二三']);
    expect(saved[1]!.stopped).toBe(true);
    expect(ref.api.state.streaming).toBe(false);
    expect(ref.api.state.isLoading).toBe(false);
    expect(ref.api.state.error).toBeUndefined();
  });

  it('没有任何内容就停止：落一条空的 stopped 助手消息（界面显示灰色提示）', async () => {
    const f = fakeClient();
    const ref = mount(f.client);
    await flush();
    const store = (ref.api.state.ipcClient as SdkIPCClient).conversationStore();
    const A = store.ensureCurrent();
    let done!: Promise<void>;
    await act(async () => {
      done = ref.api.actions.sendStreamMessage('hi');
      await new Promise((r) => setTimeout(r, 5));
    });
    await act(async () => {
      ref.api.actions.stopGeneration();
      await done;
    });
    const saved = store.getMessages(A);
    expect(saved).toHaveLength(2);
    expect(saved[1]).toMatchObject({ role: 'assistant', content: '', stopped: true });
  });

  it('历史加载竞态：先发起、后返回的旧结果被丢弃', async () => {
    const f = fakeClient();
    const ref = mount(f.client);
    await flush();
    const ipc = ref.api.state.ipcClient as SdkIPCClient;
    const store = ipc.conversationStore();
    const A = store.ensureCurrent();
    store.append({ id: 'a1', role: 'user', content: 'in A', timestamp: 1 }, A);
    const B = store.create().id;
    store.append({ id: 'b1', role: 'user', content: 'in B', timestamp: 2 }, B);

    // 第一次加载（读到 A）故意拖慢，第二次（读到 B）先返回
    const real = ipc.getChatHistory.bind(ipc);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const spy = vi
      .spyOn(ipc, 'getChatHistory')
      .mockImplementationOnce(async () => {
        const v = store.getMessages(A);
        await gate;
        return v;
      })
      .mockImplementation(real);
    store.switchTo(B);
    let p1!: Promise<void>;
    let p2!: Promise<void>;
    await act(async () => {
      p1 = ref.api.actions.loadChatHistory();
      p2 = ref.api.actions.loadChatHistory();
      await p2;
    });
    release();
    await act(async () => {
      await p1;
    });
    await waitFor(() => expect(ref.api.state.messages.map((m) => m.content)).toEqual(['in B']));
    spy.mockRestore();
  });
});
