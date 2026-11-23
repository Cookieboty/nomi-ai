// @vitest-environment happy-dom
import { appContract } from '@nomi-ai/contract/app';
import { createTestClient } from '@nomi-ai/contract/testing';
import { afterEach, expect, it, vi } from 'vitest';

import { sendManagedConversation } from '../src/services/managedMainChat';

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
