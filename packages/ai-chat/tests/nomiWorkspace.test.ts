// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConversationStore } from '../src/services/conversationStore';
import { SdkIPCClient } from '../src/services/IPCClient';

afterEach(() => {
  window.localStorage.clear();
});

describe('Nomi conversation workspace (store)', () => {
  it('new Nomi conversations take the default workspace; CLI mirrors never get one', () => {
    const store = new ConversationStore();
    expect(store.create().cwd).toBeUndefined();
    store.defaultNomiCwd = () => '/docs/nomi';
    expect(store.create().cwd).toBe('/docs/nomi');
    expect(store.create({ cwd: '/proj' }).cwd).toBe('/proj');
    expect(store.create({ backend: 'codex', tabId: 't1' }).cwd).toBeUndefined();
  });

  it('persists per conversation, can be cleared, and forks keep it', () => {
    const store = new ConversationStore();
    const a = store.create({ cwd: '/proj/a' });
    const b = store.create({ cwd: '/proj/b' });
    store.updateMeta(a.id, { cwd: '/proj/a2' });
    // 重新读取（另一个窗口 / 重启）仍在
    const again = new ConversationStore();
    expect(again.get(a.id)?.cwd).toBe('/proj/a2');
    expect(again.get(b.id)?.cwd).toBe('/proj/b');
    store.updateMeta(b.id, { cwd: undefined });
    expect(new ConversationStore().get(b.id)?.cwd).toBeUndefined();
    expect(store.fork(a.id).cwd).toBe('/proj/a2');
    expect(store.fork(a.id, { cwd: '/other' }).cwd).toBe('/other');
  });
});

describe('Nomi conversation workspace (send path)', () => {
  const client = () => {
    const calls: Array<Record<string, unknown>> = [];
    const agentStream = vi.fn((opts: Record<string, unknown>) => {
      calls.push(opts);
      return (async function* () {
        yield { type: 'done', finishReason: 'stop' };
      })();
    });
    return {
      calls,
      client: {
        chat: { agentStream, stream: vi.fn(), sendMessage: vi.fn(), abort: vi.fn() },
        memory: { userProfile: { get: () => ({}), set: async () => undefined } },
        dispose: vi.fn(),
      },
    };
  };

  it('sends the current conversation workspace as extra.cwd (core validates it)', async () => {
    const c = client();
    const ipc = new SdkIPCClient(c.client as never, { defaultSystemPrompt: async () => 'sys' });
    const id = await ipc.newConversation(undefined, { cwd: '/proj/a' });
    await ipc.sendStreamMessage('hi');
    expect(c.calls[0]!.extra).toEqual({ conversationId: id, cwd: '/proj/a' });
    // 没有工作区：只带会话 id（原有行为）
    ipc.conversationStore().updateMeta(id, { cwd: undefined });
    await ipc.sendStreamMessage('again');
    expect(c.calls[1]!.extra).toEqual({ conversationId: id });
  });
});
