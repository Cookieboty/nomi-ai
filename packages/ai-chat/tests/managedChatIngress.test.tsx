// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

import type { AiChatState } from '../src/contexts/aiChatState';
import { useChatSends } from '../src/contexts/useChatSends';
import type { IPCClient } from '../src/types/ipc';

import { installFakeApi, resetFakeApi } from './helpers/fakeApi';

vi.mock('../src/services/api', async () => (await import('./helpers/fakeApi')).fakeApiModule());
const forbidden = () =>
  vi.fn(() => {
    throw new Error('legacy route must not execute');
  });
function setup() {
  const save = forbidden(),
    legacy = forbidden(),
    ingest = forbidden();
  const managed = vi.fn(async (_id: string, _text: string, update: (messages: unknown[]) => void) =>
    update([{ id: 'canonical', role: 'assistant', content: 'persisted answer', timestamp: 1 }]),
  );
  const client = {
    ensureConversationId: () => 'c',
    currentConversationId: () => 'c',
    isManagedConversation: () => true,
    conversationStore: () => ({ get: () => ({ id: 'c', backend: 'nomi' }) }),
    sendManagedConversation: managed,
    saveMessage: save,
    saveMessageTo: save,
    sendMessage: legacy,
    sendStreamMessage: legacy,
  } as unknown as IPCClient;
  const dispatch = vi.fn();
  const stateRef = { current: { ipcClient: client, messages: [], config: {} } as AiChatState };
  const activeStream = { current: new Map() };
  const hook = renderHook(() =>
    useChatSends({
      stateRef,
      dispatch,
      activeStream,
      inflight: { current: new Map() },
      steering: { current: new Map() },
      maybeIngest: ingest,
      notifyToolStart: forbidden(),
    }),
  );
  return { hook, save, legacy, ingest, managed, dispatch, activeStream };
}
afterEach(() => {
  resetFakeApi();
  cleanup();
});
it.each(['sendMessage', 'sendStreamMessage'] as const)(
  'actual %s hook uses managed ingress before view saves, legacy API and memory',
  async (method) => {
    const f = setup();
    await act(async () => {
      await f.hook.result.current[method]('once');
    });
    expect(f.managed).toHaveBeenCalledTimes(1);
    expect(f.save).not.toHaveBeenCalled();
    expect(f.legacy).not.toHaveBeenCalled();
    expect(f.ingest).not.toHaveBeenCalled();
    expect(f.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'SET_MESSAGES', convoId: 'c' }),
    );
    expect(f.dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'ADD_MESSAGE' }));
    expect(f.activeStream.current.size).toBe(0);
  },
);
it('unsupported attachment and knowledge bridge reject before any view or execution writes', async () => {
  const f = setup();
  await act(async () => {
    await f.hook.result.current.sendStreamMessage('once', [
      { mime: 'image/png', data: 'fake' },
    ] as never);
    await f.hook.result.current.askKnowledge('question');
  });
  expect(f.managed).not.toHaveBeenCalled();
  expect(f.save).not.toHaveBeenCalled();
  expect(f.legacy).not.toHaveBeenCalled();
  expect(f.dispatch.mock.calls.filter(([a]) => a.type === 'SET_ERROR' && a.payload)).toHaveLength(
    2,
  );
});

it('forwards encoded image attachments when active managed backend advertises attachment bridge', async () => {
  const fake = installFakeApi({
    'conversations.runtimeState': () => ({
      backend: 'api',
      capabilities: { attachments: true },
    }),
  });
  const f = setup();
  await act(async () => {
    await f.hook.result.current.sendStreamMessage('describe', [
      { mime: 'image/png', data: 'iVBOR' },
    ] as never);
  });
  expect(fake.inputs('conversations.runtimeState')).toEqual([{ id: 'c' }]);
  expect(f.managed).toHaveBeenCalledWith(
    'c',
    'describe',
    expect.any(Function),
    expect.any(AbortSignal),
    {
      images: ['data:image/png;base64,iVBOR'],
      messageId: expect.any(String),
    },
  );
  expect(f.dispatch.mock.calls.filter(([a]) => a.type === 'SET_ERROR' && a.payload)).toHaveLength(
    0,
  );
});

it('immediately renders optimistic user message before managed runtime responds and reconciles cleanly', async () => {
  const save = forbidden();
  const legacy = forbidden();
  const ingest = forbidden();
  let emitUpdate!: (messages: unknown[]) => void;
  let resolveSend!: () => void;
  const managed = vi.fn(
    (
      _id: string,
      _text: string,
      update: (messages: unknown[]) => void,
      _signal?: AbortSignal,
      _options?: { images?: string[]; messageId?: string },
    ) => {
      emitUpdate = update;
      return new Promise<void>((resolve) => {
        resolveSend = resolve;
      });
    },
  );
  const client = {
    ensureConversationId: () => 'c',
    currentConversationId: () => 'c',
    isManagedConversation: () => true,
    conversationStore: () => ({ get: () => ({ id: 'c', backend: 'antigravity' }) }),
    sendManagedConversation: managed,
    getChatHistory: async () => [],
    saveMessage: save,
    saveMessageTo: save,
    sendMessage: legacy,
    sendStreamMessage: legacy,
  } as unknown as IPCClient;
  const dispatch = vi.fn();
  const stateRef = { current: { ipcClient: client, messages: [], config: {} } as AiChatState };
  const activeStream = { current: new Map() };
  const inflight = { current: new Map() };
  const hook = renderHook(() =>
    useChatSends({
      stateRef,
      dispatch,
      activeStream,
      inflight,
      steering: { current: new Map() },
      maybeIngest: ingest,
      notifyToolStart: forbidden(),
    }),
  );

  let pending!: Promise<void>;
  act(() => {
    pending = hook.result.current.sendStreamMessage('explain captain');
  });

  await vi.waitFor(() => expect(managed).toHaveBeenCalledTimes(1));
  const sentOptions = managed.mock.calls[0]?.[4];
  expect(sentOptions?.messageId).toBeTruthy();

  const optimisticCall = dispatch.mock.calls.map(([a]) => a).find((a) => a.type === 'SET_MESSAGES');
  expect(optimisticCall).toMatchObject({
    type: 'SET_MESSAGES',
    convoId: 'c',
    payload: [
      {
        id: sentOptions!.messageId,
        role: 'user',
        content: 'explain captain',
      },
    ],
  });
  expect(inflight.current.get('c')?.messages).toEqual([
    expect.objectContaining({
      id: sentOptions!.messageId,
      role: 'user',
      content: 'explain captain',
    }),
  ]);
  expect(dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'ADD_MESSAGE' }));
  expect(save).not.toHaveBeenCalled();

  const canonical = [
    { id: sentOptions!.messageId, role: 'user', content: 'explain captain', timestamp: 10 },
    { id: 'draft_a1', role: 'assistant', content: 'thinking...', timestamp: 11 },
  ];
  act(() => {
    emitUpdate(canonical);
  });
  expect(dispatch).toHaveBeenLastCalledWith({
    type: 'SET_MESSAGES',
    payload: canonical,
    convoId: 'c',
  });

  await act(async () => {
    resolveSend();
    await pending;
  });
  expect(inflight.current.has('c')).toBe(false);
  expect(activeStream.current.size).toBe(0);
});

it('rolls back optimistic user message from authoritative history when send fails pre-submit', async () => {
  const getChatHistory = vi.fn(async () => []);
  const managed = vi.fn(async () => {
    throw new Error('RUNTIME_BUSY');
  });
  const client = {
    ensureConversationId: () => 'c',
    currentConversationId: () => 'c',
    isManagedConversation: () => true,
    conversationStore: () => ({ get: () => ({ id: 'c', backend: 'antigravity' }) }),
    sendManagedConversation: managed,
    getChatHistory,
    saveMessage: forbidden(),
    saveMessageTo: forbidden(),
    sendMessage: forbidden(),
    sendStreamMessage: forbidden(),
  } as unknown as IPCClient;
  const dispatch = vi.fn();
  const stateRef = { current: { ipcClient: client, messages: [], config: {} } as AiChatState };
  const activeStream = { current: new Map() };
  const inflight = { current: new Map() };
  const hook = renderHook(() =>
    useChatSends({
      stateRef,
      dispatch,
      activeStream,
      inflight,
      steering: { current: new Map() },
      maybeIngest: forbidden(),
      notifyToolStart: forbidden(),
    }),
  );

  await act(async () => {
    await hook.result.current.sendStreamMessage('will fail');
  });

  expect(getChatHistory).toHaveBeenCalledTimes(1);
  const messageSets = dispatch.mock.calls.map(([a]) => a).filter((a) => a.type === 'SET_MESSAGES');
  expect(messageSets).toHaveLength(2);
  expect(messageSets[0]!.payload).toHaveLength(1);
  expect(messageSets[1]!.payload).toEqual([]);
  expect(inflight.current.has('c')).toBe(false);
  expect(dispatch).toHaveBeenCalledWith({ type: 'SET_ERROR', payload: 'RUNTIME_BUSY' });
});

it.each(['sendMessage', 'sendStreamMessage'] as const)(
  '%s preserves IPCClient receiver so prototype sendManagedConversation can access this.store',
  async (method) => {
    const flush = vi.fn(async () => undefined);
    const refreshManaged = vi.fn(async () => undefined);
    const canonical = { id: 'canonical', role: 'assistant', content: 'ok', timestamp: 2 };

    class ProtoManagedIPCClient {
      private readonly store = {
        flush,
        refreshManaged,
        get: () => ({ id: 'c', backend: 'antigravity' }),
        isManaged: (id: string) => id === 'c',
        currentId: () => 'c',
        getMessages: () => [],
      };

      ensureConversationId() {
        return this.store.currentId();
      }

      currentConversationId() {
        return this.store.currentId();
      }

      isManagedConversation(id: string) {
        return this.store.isManaged(id);
      }

      conversationStore() {
        return this.store;
      }

      async sendManagedConversation(
        id: string,
        _text: string,
        onUpdate: (messages: unknown[]) => void,
        _signal?: AbortSignal,
        _options?: { images?: string[]; messageId?: string },
      ) {
        await this.store.flush();
        try {
          onUpdate([canonical]);
        } finally {
          await this.store.refreshManaged(id);
        }
      }

      getChatHistory = vi.fn(async () => []);
      saveMessage = forbidden();
      saveMessageTo = forbidden();
      sendMessage = forbidden();
      sendStreamMessage = forbidden();
    }

    const client = new ProtoManagedIPCClient();
    const dispatch = vi.fn();
    const stateRef = {
      current: {
        ipcClient: client as unknown as IPCClient,
        messages: [],
        config: {},
      } as AiChatState,
    };
    const activeStream = { current: new Map() };
    const inflight = { current: new Map() };
    const hook = renderHook(() =>
      useChatSends({
        stateRef,
        dispatch,
        activeStream,
        inflight,
        steering: { current: new Map() },
        maybeIngest: forbidden(),
        notifyToolStart: forbidden(),
      }),
    );

    await act(async () => {
      await hook.result.current[method]('hello prototype');
    });

    expect(flush).toHaveBeenCalledTimes(1);
    expect(refreshManaged).toHaveBeenCalledWith('c');
    expect(dispatch.mock.calls.filter(([a]) => a.type === 'SET_ERROR' && a.payload)).toHaveLength(
      0,
    );
    const messageSets = dispatch.mock.calls
      .map(([a]) => a)
      .filter((a) => a.type === 'SET_MESSAGES');
    expect(messageSets).toHaveLength(2);
    expect(messageSets[0]).toMatchObject({
      type: 'SET_MESSAGES',
      convoId: 'c',
      payload: [expect.objectContaining({ role: 'user', content: 'hello prototype' })],
    });
    expect(messageSets[1]).toEqual({
      type: 'SET_MESSAGES',
      convoId: 'c',
      payload: [canonical],
    });
  },
);
