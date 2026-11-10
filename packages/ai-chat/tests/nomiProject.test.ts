// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createMemoryConversationKernel } from '../src/services/conversationKernel';
import { ConversationStore } from '../src/services/conversationStore';
import { SdkIPCClient } from '../src/services/IPCClient';

afterEach(() => {
  window.localStorage.clear();
});

describe('Nomi conversation project (store)', () => {
  it('new Nomi conversations keep the current Nomi conversation project; null = none; CLI mirrors never get one', () => {
    const store = new ConversationStore();
    expect(store.create().projectId).toBeUndefined();
    const a = store.create({ projectId: 'p1' });
    expect(a.projectId).toBe('p1');
    // a 是当前会话：没指定项目的新对话接着在 p1 里
    expect(store.create().projectId).toBe('p1');
    store.switchTo(a.id);
    expect(store.create({ projectId: null }).projectId).toBeUndefined();
    store.switchTo(a.id);
    expect(store.create({ backend: 'codex', tabId: 't1' }).projectId).toBeUndefined();
  });

  it('persists per conversation, can be cleared, and forks keep it', async () => {
    const kernel = createMemoryConversationKernel();
    const store = new ConversationStore({ kernel });
    const a = store.create({ projectId: 'p_a' });
    const b = store.create({ projectId: 'p_b' });
    store.updateMeta(a.id, { projectId: 'p_a2' });
    // 重新读取（重启）仍在
    const reopen = async () => {
      await store.flush();
      return new ConversationStore({ kernel, snapshot: await kernel.state() });
    };
    const again = await reopen();
    expect(again.get(a.id)?.projectId).toBe('p_a2');
    expect(again.get(b.id)?.projectId).toBe('p_b');
    store.updateMeta(b.id, { projectId: undefined });
    expect((await reopen()).get(b.id)?.projectId).toBeUndefined();
    expect(store.fork(a.id).projectId).toBe('p_a2');
    expect(store.fork(a.id, { projectId: 'p_other' }).projectId).toBe('p_other');
  });

  it('forking a conversation without a project keeps it without one, whatever is open (#308)', () => {
    const store = new ConversationStore();
    const b = store.create({ projectId: null });
    const a = store.create({ projectId: 'p_a' });
    store.switchTo(a.id);
    const copy = store.fork(b.id, { messages: [] });
    expect(copy.projectId).toBeUndefined();
    expect(store.get(a.id)?.projectId).toBe('p_a');
    // 源有项目：沿用源的，不是当前会话的
    const c = store.create({ projectId: 'p_c' });
    store.switchTo(a.id);
    expect(store.fork(c.id, { messages: [] }).projectId).toBe('p_c');
    // CLI 源分到 Nomi（源 meta 没有项目）也不落进当前会话的项目
    const cli = store.create({ backend: 'codex', tabId: 't1', activate: false });
    store.switchTo(a.id);
    expect(store.fork(cli.id, { backend: 'nomi', messages: [] }).projectId).toBeUndefined();
  });
});

describe('Nomi conversation project (send path)', () => {
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

  it('sends only the project id (the core resolves its folders); never a cwd', async () => {
    const c = client();
    const ipc = new SdkIPCClient(c.client as never, { defaultSystemPrompt: async () => 'sys' });
    const id = await ipc.newConversation(undefined, { projectId: 'p_a' });
    await ipc.sendStreamMessage('hi');
    expect(c.calls[0]!.extra).toEqual({ conversationId: id, projectId: 'p_a' });
    // 没有项目：只带会话 id
    ipc.conversationStore().updateMeta(id, { projectId: undefined });
    await ipc.sendStreamMessage('again');
    expect(c.calls[1]!.extra).toEqual({ conversationId: id });
  });
});
