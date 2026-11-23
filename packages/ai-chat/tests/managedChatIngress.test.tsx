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
    { images: ['data:image/png;base64,iVBOR'] },
  );
  expect(f.dispatch.mock.calls.filter(([a]) => a.type === 'SET_ERROR' && a.payload)).toHaveLength(
    0,
  );
});
