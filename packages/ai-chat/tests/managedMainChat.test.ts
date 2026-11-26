// @vitest-environment happy-dom
import { appContract } from '@nomi-ai/contract/app';
import { createTestClient } from '@nomi-ai/contract/testing';
import { afterEach, expect, it, vi } from 'vitest';

import {
  rewindManagedConversation,
  sendManagedConversation,
} from '../src/services/managedMainChat';

const base = {
  id: 'c',
  backend: 'fake',
  generation: 4,
  phase: 'idle' as const,
  queued: 0,
  partial: '',
  detail: '',
  approvals: [],
  recovery: 'none' as const,
  capabilities: {
    resume: true,
    cancel: true,
    approval: false,
    attachments: false,
    permissionModes: ['deny'],
    degraded: [],
  },
};
const token = { conversationId: 'c', attemptId: 'attempt', generation: 5 };
const messages = [
  { id: 'user', role: 'user', content: 'once', timestamp: 1 },
  { id: 'assistant', role: 'assistant', content: 'answer', timestamp: 2 },
];
function fixture(mode: 'fast' | 'pending' | 'admitted' | 'never' = 'fast', hangReconcile = false) {
  let state: Record<string, unknown> = { ...base };
  let reads = 0;
  let release: ((value: typeof token) => void) | undefined;
  const calls = { send: vi.fn(), cancel: vi.fn(), append: vi.fn() };
  const client: ReturnType<typeof createTestClient<typeof appContract>> = createTestClient(
    appContract,
    {
      'conversations.runtimeState': () =>
        ++reads > 1 && hangReconcile ? new Promise(() => undefined) : state,
      'conversations.messages': () => ({ messages, bytes: 1 }),
      'conversations.append': calls.append,
      'conversations.runtimeSend': (input: unknown) => {
        calls.send(input);
        if (mode === 'fast') {
          state = { ...base, generation: 5, phase: 'completed', token, recovery: 'new' };
          client.router.events.publish('conversations.runtimeChanged', state as never);
          return token;
        }
        if (mode === 'admitted') {
          state = { ...base, generation: 5, phase: 'running', token };
          return token;
        }
        return new Promise<typeof token>((resolve) => {
          release = resolve;
        });
      },
      'conversations.runtimeCancel': (input: unknown) => {
        calls.cancel(input);
        state = { ...base, generation: 6, phase: 'canceled', token };
        return state;
      },
    } as never,
    { caller: { surface: 'chat', trusted: true } },
  );
  return {
    client,
    calls,
    complete: () => {
      state = { ...base, generation: 5, phase: 'completed', token };
      client.router.events.publish('conversations.runtimeChanged', state as never);
      release?.(token);
    },
    publish: (extra: Record<string, unknown>) =>
      client.router.events.publish('conversations.runtimeChanged', {
        ...base,
        token,
        ...extra,
      } as never),
  };
}
afterEach(() => vi.useRealTimers());
it('typed wire: completion before admission response renders authoritative projection once, never upserts', async () => {
  const f = fixture();
  const update = vi.fn();
  try {
    await sendManagedConversation(f.client.api, 'c', 'once', update);
    expect(f.calls.send).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ id: 'c', text: 'once', expectedGeneration: 4 }),
    );
    expect(update).toHaveBeenLastCalledWith(messages);
    expect(f.calls.append).not.toHaveBeenCalled();
  } finally {
    f.client.close();
  }
});
it('cancel before send response uses the original generation and turn identity, without retry', async () => {
  const f = fixture('pending');
  const controller = new AbortController();
  try {
    const task = sendManagedConversation(f.client.api, 'c', 'once', vi.fn(), controller.signal);
    await vi.waitFor(() => expect(f.calls.send).toHaveBeenCalledTimes(1));
    controller.abort();
    await vi.waitFor(() => expect(f.calls.cancel).toHaveBeenCalledTimes(1));
    expect(f.calls.cancel).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'c', turnId: expect.any(String), beforeGeneration: 4 }),
    );
    f.complete();
    await task;
    expect(f.calls.send).toHaveBeenCalledTimes(1);
  } finally {
    f.client.close();
  }
});
it('terminal observation cannot be replaced by late running or foreign attempt events', async () => {
  const f = fixture('pending');
  const update = vi.fn();
  try {
    const task = sendManagedConversation(f.client.api, 'c', 'once', update);
    await vi.waitFor(() => expect(f.calls.send).toHaveBeenCalled());
    f.publish({ id: 'other', phase: 'running', partial: 'foreign' });
    f.publish({ phase: 'running', partial: 'stale', token: { ...token, generation: 1 } });
    f.complete();
    f.publish({ phase: 'running', partial: 'late partial' });
    await task;
    expect(update).toHaveBeenLastCalledWith(messages);
    expect(JSON.stringify(update.mock.calls)).not.toContain('late partial');
  } finally {
    f.client.close();
  }
});
it('bounded observation also times out admission itself and never repeats a side effect', async () => {
  vi.useFakeTimers();
  const f = fixture('never');
  try {
    const task = sendManagedConversation(f.client.api, 'c', 'once', vi.fn());
    const rejected = expect(task).rejects.toBeInstanceOf(Error);
    await vi.advanceTimersByTimeAsync(120001);
    await rejected;
    expect(f.calls.send).toHaveBeenCalledTimes(1);
    f.publish({ phase: 'completed' });
  } finally {
    f.client.close();
  }
});

it('observed completion is not blocked by a hung reconciliation query', async () => {
  const f = fixture('fast', true);
  try {
    await sendManagedConversation(f.client.api, 'c', 'once', vi.fn());
    expect(f.calls.send).toHaveBeenCalledTimes(1);
  } finally {
    f.client.close();
  }
});

it('forwards current-turn images, preserves retry ids, and renders tool trace drafts', async () => {
  const f = fixture('admitted');
  const update = vi.fn();
  const task = sendManagedConversation(f.client.api, 'c', 'retry me', update, undefined, {
    images: ['data:image/png;base64,AAA'],
    retry: { messageId: 'm-orig', turnId: 't-orig' },
  });
  try {
    await vi.waitFor(() => expect(f.calls.send).toHaveBeenCalledTimes(1));
    expect(f.calls.send).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'c',
        messageId: 'm-orig',
        turnId: 't-orig',
        retry: true,
        images: ['data:image/png;base64,AAA'],
      }),
    );
    f.publish({
      phase: 'running',
      partial: 'working',
      trace: [{ id: 'tr1', kind: 'tool', tool: 'fs_read_text', status: 'running', at: 1 }],
    });
    await vi.waitFor(() => expect(JSON.stringify(update.mock.calls)).toContain('fs_read_text'));
    f.complete();
    await task;
    expect(update).toHaveBeenLastCalledWith(messages);
  } finally {
    await task.catch(() => undefined);
    f.client.close();
  }
});

it('caches base messages across running stream deltas and emits structured trace without cli-default model', async () => {
  const calls = { send: vi.fn(), messages: vi.fn(() => ({ messages, bytes: 1 })) };
  let state: Record<string, unknown> = { ...base };
  const client: ReturnType<typeof createTestClient<typeof appContract>> = createTestClient(
    appContract,
    {
      'conversations.runtimeState': () => state,
      'conversations.messages': calls.messages,
      'conversations.runtimeSend': (input: unknown) => {
        calls.send(input);
        state = { ...base, generation: 5, phase: 'running', token };
        return token;
      },
      'conversations.runtimeCancel': () => state,
    } as never,
    { caller: { surface: 'chat', trusted: true } },
  );
  const update = vi.fn();
  const publish = (extra: Record<string, unknown>) =>
    client.router.events.publish('conversations.runtimeChanged', {
      ...base,
      backend: 'antigravity',
      model: 'cli-default',
      token,
      ...extra,
    } as never);
  try {
    const task = sendManagedConversation(client.api, 'c', 'hello', update);
    await vi.waitFor(() => expect(calls.send).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(calls.messages).toHaveBeenCalledTimes(1));
    publish({ phase: 'running', thinking: 'hmm', thinkingActive: true, partial: '' });
    publish({
      phase: 'running',
      thinking: 'hmm',
      thinkingActive: false,
      partial: 'hello ',
      trace: [
        { id: 't1', kind: 'tool', tool: 'read_file', status: 'completed', output: 'ok', at: 2 },
      ],
    });
    publish({
      phase: 'running',
      model: 'gemini-4-neon-medium',
      thinking: 'hmm',
      thinkingActive: false,
      partial: 'hello world',
    });
    await vi.waitFor(() => expect(JSON.stringify(update.mock.calls)).toContain('hello world'));
    // Multiple running stream frames only read messages once before completion.
    expect(calls.messages).toHaveBeenCalledTimes(1);
    const streamDraft = update.mock.calls.at(-1)?.[0].at(-1);
    expect(streamDraft).toMatchObject({
      role: 'assistant',
      content: 'hello world',
      runtimeBackend: 'antigravity',
      modelId: 'gemini-4-neon-medium',
      trace: [{ type: 'thinking', text: 'hmm' }],
    });
    state = { ...base, generation: 5, phase: 'completed', token };
    client.router.events.publish('conversations.runtimeChanged', state as never);
    await task;
    expect(calls.messages).toHaveBeenCalledTimes(2);
    expect(update).toHaveBeenLastCalledWith(messages);
  } finally {
    client.close();
  }
});

it('uses caller-supplied messageId without marking the turn as a retry', async () => {
  const f = fixture('fast');
  const update = vi.fn();
  try {
    await sendManagedConversation(f.client.api, 'c', 'once', update, undefined, {
      messageId: 'm_client_1',
    });
    const sent = f.calls.send.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(sent).toMatchObject({
      id: 'c',
      messageId: 'm_client_1',
      turnId: 'turn_m_client_1',
      text: 'once',
    });
    expect(sent.retry).toBeUndefined();
  } finally {
    f.client.close();
  }
});

it('auto-abandons non-unknown uncertain state on failure while rejecting with concrete detail', async () => {
  const calls = { resolve: vi.fn(), send: vi.fn() };
  let state: Record<string, unknown> = { ...base };
  const client: ReturnType<typeof createTestClient<typeof appContract>> = createTestClient(
    appContract,
    {
      'conversations.runtimeState': () => state,
      'conversations.messages': () => ({ messages, bytes: 1 }),
      'conversations.runtimeSend': (input: unknown) => {
        calls.send(input);
        state = {
          ...base,
          generation: 5,
          phase: 'uncertain',
          recovery: 'new',
          detail: 'upstream quota exceeded',
          token,
        };
        client.router.events.publish('conversations.runtimeChanged', state as never);
        return token;
      },
      'conversations.runtimeResolve': (input: unknown) => {
        calls.resolve(input);
        state = { ...base, generation: 6, phase: 'idle', recovery: 'none', detail: '' };
        client.router.events.publish('conversations.runtimeChanged', state as never);
        return state;
      },
      'conversations.runtimeCancel': () => state,
    } as never,
    { caller: { surface: 'chat', trusted: true } },
  );
  try {
    await expect(sendManagedConversation(client.api, 'c', 'once', vi.fn())).rejects.toThrow(
      'upstream quota exceeded',
    );
    expect(calls.resolve).toHaveBeenCalledExactlyOnceWith({
      id: 'c',
      decision: 'abandon',
      confirm: true,
      expectedGeneration: 5,
    });
  } finally {
    client.close();
  }
});

it('auto-abandons stale non-unknown uncertain state before sending and never auto-abandons unknown recovery', async () => {
  const calls = { resolve: vi.fn(), send: vi.fn() };
  let state: Record<string, unknown> = {
    ...base,
    generation: 4,
    phase: 'uncertain',
    recovery: 'error',
    detail: 'previous failure',
  };
  const nextToken = { conversationId: 'c', attemptId: 'attempt-6', generation: 6 };
  const client: ReturnType<typeof createTestClient<typeof appContract>> = createTestClient(
    appContract,
    {
      'conversations.runtimeState': () => state,
      'conversations.messages': () => ({ messages, bytes: 1 }),
      'conversations.runtimeResolve': (input: unknown) => {
        calls.resolve(input);
        state = { ...base, generation: 5, phase: 'idle', recovery: 'none', detail: '' };
        return state;
      },
      'conversations.runtimeSend': (input: unknown) => {
        calls.send(input);
        state = {
          ...base,
          generation: 6,
          phase: 'completed',
          recovery: 'new',
          token: nextToken,
        };
        client.router.events.publish('conversations.runtimeChanged', state as never);
        return nextToken;
      },
      'conversations.runtimeCancel': () => state,
    } as never,
    { caller: { surface: 'chat', trusted: true } },
  );
  try {
    await sendManagedConversation(client.api, 'c', 'next turn', vi.fn());
    expect(calls.resolve).toHaveBeenCalledExactlyOnceWith({
      id: 'c',
      decision: 'abandon',
      confirm: true,
      expectedGeneration: 4,
    });
    expect(calls.send).toHaveBeenCalledWith(expect.objectContaining({ expectedGeneration: 5 }));

    calls.resolve.mockClear();
    calls.send.mockClear();
    state = {
      ...base,
      generation: 7,
      phase: 'uncertain',
      recovery: 'unknown',
      detail: 'cold resume unproven',
    };
    const nextToken8 = { conversationId: 'c', attemptId: 'attempt-8', generation: 8 };
    // Even if runtimeState is uncertain/unknown before send, sendManagedConversation must NOT abandon it.
    let sentGen: unknown;
    const client2: ReturnType<typeof createTestClient<typeof appContract>> = createTestClient(
      appContract,
      {
        'conversations.runtimeState': () => state,
        'conversations.messages': () => ({ messages, bytes: 1 }),
        'conversations.runtimeResolve': (input: unknown) => {
          calls.resolve(input);
          return state;
        },
        'conversations.runtimeSend': (input: { expectedGeneration: number }) => {
          sentGen = input.expectedGeneration;
          state = {
            ...base,
            generation: 8,
            phase: 'completed',
            recovery: 'new',
            token: nextToken8,
          };
          client2.router.events.publish('conversations.runtimeChanged', state as never);
          return nextToken8;
        },
        'conversations.runtimeCancel': () => state,
      } as never,
      { caller: { surface: 'chat', trusted: true } },
    );
    try {
      await sendManagedConversation(client2.api, 'c', 'blocked', vi.fn());
      expect(calls.resolve).not.toHaveBeenCalled();
      expect(sentGen).toBe(7);
    } finally {
      client2.close();
    }
  } finally {
    client.close();
  }
});

it('rewindManagedConversation auto-abandons non-unknown uncertain state before rewinding and returns projected messages', async () => {
  const calls = { resolve: vi.fn(), rewind: vi.fn(), messages: vi.fn() };
  let state: Record<string, unknown> = {
    ...base,
    generation: 4,
    phase: 'uncertain',
    recovery: 'error',
    detail: 'command_lifecycle error',
  };
  let projected = [
    { id: 'm1', role: 'user', content: 'first', timestamp: 1 },
    { id: 'a1', role: 'assistant', content: 'first reply', timestamp: 2 },
    { id: 'm2', role: 'user', content: '翻译成韩文', timestamp: 3 },
  ];
  const client: ReturnType<typeof createTestClient<typeof appContract>> = createTestClient(
    appContract,
    {
      'conversations.runtimeState': () => state,
      'conversations.runtimeResolve': (input: unknown) => {
        calls.resolve(input);
        state = { ...base, generation: 5, phase: 'idle', recovery: 'none', detail: '' };
        return state;
      },
      'conversations.runtimeRewind': (input: {
        messageId: string;
        expectedGeneration?: number;
      }) => {
        calls.rewind(input);
        const cut = projected.findIndex((m) => m.id === input.messageId);
        if (cut >= 0) projected = projected.slice(0, cut);
        state = { ...base, generation: 6, phase: 'idle', recovery: 'none', detail: '' };
        return state;
      },
      'conversations.messages': () => {
        calls.messages();
        return { messages: projected, bytes: 1 };
      },
    } as never,
    { caller: { surface: 'chat', trusted: true } },
  );
  try {
    const kept = await rewindManagedConversation(client.api, 'c', 'm2');
    expect(calls.resolve).toHaveBeenCalledExactlyOnceWith({
      id: 'c',
      decision: 'abandon',
      confirm: true,
      expectedGeneration: 4,
    });
    expect(calls.rewind).toHaveBeenCalledExactlyOnceWith({
      id: 'c',
      messageId: 'm2',
      expectedGeneration: 5,
    });
    expect(calls.messages).toHaveBeenCalledTimes(1);
    expect(kept.map((m) => m.id)).toEqual(['m1', 'a1']);
  } finally {
    client.close();
  }
});

it('renews observation deadline while running events continue past 120s', async () => {
  vi.useFakeTimers();
  const f = fixture('admitted');
  const update = vi.fn();
  try {
    const task = sendManagedConversation(f.client.api, 'c', 'long task', update);
    await vi.waitFor(() => expect(f.calls.send).toHaveBeenCalledTimes(1));
    // 每 90 秒收到一次进展，累计超过 300 秒不应超时
    for (let i = 1; i <= 3; i++) {
      await vi.advanceTimersByTimeAsync(90_000);
      f.publish({ phase: 'running', partial: `step-${i}` });
      await Promise.resolve();
    }
    await vi.advanceTimersByTimeAsync(90_000);
    f.complete();
    await task;
    expect(update).toHaveBeenLastCalledWith(messages);
  } finally {
    f.client.close();
  }
});

it('probes runtimeState after 120s silence: keeps waiting on matching running, converges on completed, rejects on mismatch or probe timeout', async () => {
  vi.useFakeTimers();
  let state: Record<string, unknown> = { ...base };
  let probeHandler: () => Promise<Record<string, unknown>> | Record<string, unknown> = () => state;
  const client: ReturnType<typeof createTestClient<typeof appContract>> = createTestClient(
    appContract,
    {
      'conversations.runtimeState': () => probeHandler(),
      'conversations.messages': () => ({ messages, bytes: 1 }),
      'conversations.runtimeSend': () => {
        state = { ...base, generation: 5, phase: 'running', token };
        return token;
      },
      'conversations.runtimeCancel': () => state,
    } as never,
    { caller: { surface: 'chat', trusted: true } },
  );
  try {
    // 1) 120s 无事件时探活返回 running，继续等待直到后续再次 120s 探活拿到 completed 自动收敛
    let reads = 0;
    probeHandler = () => {
      reads += 1;
      if (reads === 1) return state; // initial
      if (reads === 2) return state; // post-send reconcile
      if (reads === 3) return { ...base, generation: 5, phase: 'running', token }; // first 120s probe
      return { ...base, generation: 5, phase: 'completed', token }; // second 120s probe
    };
    const task = sendManagedConversation(client.api, 'c', 'silent long', vi.fn());
    await vi.advanceTimersByTimeAsync(120_000);
    await vi.advanceTimersByTimeAsync(120_000);
    await task;
    expect(reads).toBe(4);

    // 2) 120s 探活返回失配状态（如已回到 idle）时按观察超时报错
    state = { ...base };
    let readsMismatch = 0;
    probeHandler = () => {
      readsMismatch += 1;
      if (readsMismatch === 1) return { ...base };
      if (readsMismatch === 2) return { ...base, generation: 5, phase: 'running', token };
      return { ...base, generation: 5, phase: 'idle' };
    };
    const mismatchTask = sendManagedConversation(client.api, 'c', 'lost terminal', vi.fn());
    const mismatchRejected =
      expect(mismatchTask).rejects.toThrow('运行时观察超时，请查看恢复状态，不要自动重试。');
    await vi.advanceTimersByTimeAsync(120_001);
    await mismatchRejected;

    // 3) 120s 探活自身超时（>15s）时报错
    state = { ...base };
    let readsHang = 0;
    probeHandler = () => {
      readsHang += 1;
      if (readsHang === 1) return { ...base };
      if (readsHang === 2) return { ...base, generation: 5, phase: 'running', token };
      return new Promise(() => undefined);
    };
    const hangTask = sendManagedConversation(client.api, 'c', 'hung probe', vi.fn());
    const hangRejected =
      expect(hangTask).rejects.toThrow('运行时观察超时，请查看恢复状态，不要自动重试。');
    await vi.advanceTimersByTimeAsync(120_000 + 15_001);
    await hangRejected;
  } finally {
    client.close();
  }
});
