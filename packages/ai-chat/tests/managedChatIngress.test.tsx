// @vitest-environment happy-dom
import type { ClientAIClient } from '@nomi-ai/ai-sdk-client';
import { act, cleanup, render, renderHook } from '@testing-library/react';
import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';

import { AiChatContextProvider, useAiChat, type AiChatState } from '../src/contexts/AiChatContext';
import { useChatSends } from '../src/contexts/useChatSends';
import type { ChatMessage } from '../src/types/chat';
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
  const rewind = vi.fn(async () => []);
  const client = {
    ensureConversationId: () => 'c',
    currentConversationId: () => 'c',
    isManagedConversation: () => true,
    conversationStore: () => ({ get: () => ({ id: 'c', backend: 'nomi' }) }),
    rewindManagedConversation: rewind,
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
  return { hook, save, legacy, ingest, managed, rewind, dispatch, activeStream };
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

      async rewindManagedConversation(id: string, _messageId: string): Promise<ChatMessage[]> {
        await this.store.flush();
        await this.store.refreshManaged(id);
        return [];
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

it('resendManagedMessage rewinds via managed ingress without writing legacy store, preserves receiver, and uses rewound baseline for optimistic UI', async () => {
  const flush = vi.fn(async () => undefined);
  const refreshManaged = vi.fn(async () => undefined);
  const setMessagesForbidden = forbidden();
  const keptFirst: ChatMessage = { id: 'm1', role: 'user', content: 'first prompt', timestamp: 1 };
  const keptReply: ChatMessage = {
    id: 'a1',
    role: 'assistant',
    content: 'first reply',
    timestamp: 2,
  };
  const oldSecond: ChatMessage = { id: 'm2', role: 'user', content: '翻译成韩文', timestamp: 3 };
  let releaseSend!: () => void;
  let emitUpdate!: (msgs: ChatMessage[]) => void;

  class ProtoResendIPCClient {
    private readonly store = {
      flush,
      refreshManaged,
      setMessages: setMessagesForbidden,
      get: () => ({ id: 'c', backend: 'grok' }),
      isManaged: (id: string) => id === 'c',
      currentId: () => 'c',
      getMessages: () => [keptFirst, keptReply, oldSecond],
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

    rewindManagedConversation = vi.fn(async (id: string, messageId: string) => {
      expect(id).toBe('c');
      expect(messageId).toBe('m2');
      await this.store.flush();
      await this.store.refreshManaged(id);
      return [keptFirst, keptReply];
    });

    sendManagedConversation = vi.fn(
      async (
        id: string,
        text: string,
        onUpdate: (messages: ChatMessage[]) => void,
        _signal?: AbortSignal,
        _options?: { messageId?: string },
      ) => {
        expect(id).toBe('c');
        expect(text).toBe('翻译成日文');
        emitUpdate = onUpdate;
        await this.store.flush();
        await new Promise<void>((resolve) => {
          releaseSend = resolve;
        });
      },
    );

    getChatHistory = vi.fn(async () => [keptFirst, keptReply]);
    saveMessage = forbidden();
    saveMessageTo = forbidden();
    sendMessage = forbidden();
    sendStreamMessage = forbidden();
  }

  const client = new ProtoResendIPCClient();
  const dispatch = vi.fn();
  const stateRef = {
    current: {
      ipcClient: client as unknown as IPCClient,
      messages: [keptFirst, keptReply, oldSecond],
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

  let pending!: Promise<void>;
  act(() => {
    pending = hook.result.current.resendManagedMessage('m2', '翻译成日文');
  });

  await vi.waitFor(() => expect(client.sendManagedConversation).toHaveBeenCalledTimes(1));
  const sentOpts = client.sendManagedConversation.mock.calls[0]?.[4];
  expect(sentOpts?.messageId).toBeTruthy();

  const messageSets = dispatch.mock.calls.map(([a]) => a).filter((a) => a.type === 'SET_MESSAGES');
  // First SET_MESSAGES clears rewound m2; second shows [keptFirst, keptReply, optimistic(翻译成日文)] without flashing oldSecond.
  expect(messageSets[0]).toEqual({
    type: 'SET_MESSAGES',
    payload: [keptFirst, keptReply],
    convoId: 'c',
  });
  expect(messageSets[1]).toMatchObject({
    type: 'SET_MESSAGES',
    convoId: 'c',
    payload: [
      keptFirst,
      keptReply,
      { id: sentOpts!.messageId, role: 'user', content: '翻译成日文' },
    ],
  });
  expect(setMessagesForbidden).not.toHaveBeenCalled();

  const canonicalFinal: ChatMessage[] = [
    keptFirst,
    keptReply,
    { id: sentOpts!.messageId!, role: 'user', content: '翻译成日文', timestamp: 10 },
    { id: 'a2_new', role: 'assistant', content: '日本語に翻訳します', timestamp: 11 },
  ];
  await act(async () => {
    emitUpdate(canonicalFinal);
    releaseSend();
    await pending;
  });

  expect(dispatch).toHaveBeenLastCalledWith({
    type: 'SET_LOADING',
    payload: false,
    convoId: 'c',
    outcome: 'done',
  });
  expect(activeStream.current.size).toBe(0);
  expect(inflight.current.size).toBe(0);
});

it('resendManagedMessage surfaces rewind failure via SET_ERROR and skips sendManagedConversation', async () => {
  const f = setup();
  f.rewind.mockRejectedValueOnce(new Error('RUNTIME_BUSY'));
  await act(async () => {
    await f.hook.result.current.resendManagedMessage('m1', 'edited');
  });
  expect(f.managed).not.toHaveBeenCalled();
  expect(f.legacy).not.toHaveBeenCalled();
  expect(f.dispatch).toHaveBeenCalledWith({ type: 'SET_ERROR', payload: 'RUNTIME_BUSY' });
  expect(f.activeStream.current.size).toBe(0);
});

it('AiChatContext resendFrom routes managed edit and regenerate through managed rewind without touching store.setMessages', async () => {
  const m1: ChatMessage = { id: 'u1', role: 'user', content: 'first', timestamp: 1 };
  const a1: ChatMessage = { id: 'a1', role: 'assistant', content: 'reply1', timestamp: 2 };
  const m2: ChatMessage = { id: 'u2', role: 'user', content: '翻译成韩文', timestamp: 3 };
  let canonicalHistory: ChatMessage[] = [m1, a1, m2];

  const storeSetMessagesForbidden = forbidden();
  const sendStreamForbidden = forbidden();

  const rewindManagedConversation = vi.fn(async (_id: string, targetId: string) => {
    const cut = canonicalHistory.findIndex((m) => m.id === targetId);
    canonicalHistory = cut >= 0 ? canonicalHistory.slice(0, cut) : canonicalHistory;
    return canonicalHistory;
  });
  const sendManagedConversation = vi.fn(
    async (
      _id: string,
      text: string,
      onUpdate: (messages: ChatMessage[]) => void,
      _signal?: AbortSignal,
      options?: { messageId?: string },
    ) => {
      const uid = options?.messageId ?? 'u_new';
      canonicalHistory = [
        ...canonicalHistory,
        { id: uid, role: 'user', content: text, timestamp: 10 },
        { id: `reply_${uid}`, role: 'assistant', content: `answered:${text}`, timestamp: 11 },
      ];
      onUpdate(canonicalHistory);
    },
  );

  const managedIpc = {
    currentConversationId: () => 'c_managed',
    ensureConversationId: () => 'c_managed',
    isManagedConversation: (id: string) => id === 'c_managed',
    conversationStore: () => ({
      get: () => ({ id: 'c_managed', backend: 'nomi' }),
      getMessages: () => canonicalHistory,
      setMessages: storeSetMessagesForbidden,
    }),
    getChatHistory: vi.fn(async () => canonicalHistory),
    getConfig: vi.fn(async () => ({
      theme: 'light',
      language: 'zh-CN',
      fontSize: 14,
      autoSave: true,
      maxHistoryLength: 1000,
    })),
    updateConfig: vi.fn(),
    listConversations: vi.fn(async () => []),
    newConversation: vi.fn(async () => 'c_managed'),
    switchConversation: vi.fn(),
    rewindManagedConversation,
    sendManagedConversation,
    sendMessage: forbidden(),
    sendStreamMessage: sendStreamForbidden,
    saveMessage: forbidden(),
    saveMessageTo: forbidden(),
    clearChatHistory: forbidden(),
  } as unknown as IPCClient;

  const dummyClient = {
    chat: {
      sendMessage: vi.fn(async () => ({ content: '' })),
      stream: async function* () {},
      abort: vi.fn(),
    },
    memory: { userProfile: { get: () => undefined, set: vi.fn() } },
    dispose: vi.fn(),
  } as unknown as ClientAIClient;

  let api!: ReturnType<typeof useAiChat>;
  const Probe = () => {
    api = useAiChat();
    return null;
  };
  render(
    <AiChatContextProvider client={dummyClient}>
      <Probe />
    </AiChatContextProvider>,
  );

  await act(async () => {
    api.dispatch({ type: 'SET_IPC_CLIENT', payload: managedIpc });
  });
  await act(async () => {
    await api.actions.loadChatHistory();
  });
  expect(api.state.messages.map((m) => m.id)).toEqual(['u1', 'a1', 'u2', 'interrupted-u2']);

  // 1. Edit user message u2 and resend.
  await act(async () => {
    await api.actions.resendFrom('u2', '翻译成英文');
  });
  expect(storeSetMessagesForbidden).not.toHaveBeenCalled();
  expect(sendStreamForbidden).not.toHaveBeenCalled();
  expect(rewindManagedConversation).toHaveBeenCalledWith('c_managed', 'u2');
  expect(sendManagedConversation).toHaveBeenCalledWith(
    'c_managed',
    '翻译成英文',
    expect.any(Function),
    expect.any(AbortSignal),
    expect.objectContaining({ messageId: expect.any(String) }),
  );
  expect(api.state.messages.map((m) => m.content)).toEqual([
    'first',
    'reply1',
    '翻译成英文',
    'answered:翻译成英文',
  ]);

  // 2. Regenerate from the edited user message without newText.
  const latestUserId = api.state.messages[2]!.id;
  await act(async () => {
    await api.actions.resendFrom(latestUserId);
  });
  expect(rewindManagedConversation).toHaveBeenLastCalledWith('c_managed', latestUserId);
  expect(api.state.messages.map((m) => m.content)).toEqual([
    'first',
    'reply1',
    '翻译成英文',
    'answered:翻译成英文',
  ]);
});
