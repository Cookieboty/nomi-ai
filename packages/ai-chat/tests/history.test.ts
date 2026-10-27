import { describe, expect, it, vi } from 'vitest';

import { ConversationStore, createMemoryStorage } from '../src/services/conversationStore';
import { buildProviderMessages } from '../src/services/history';
import { SdkIPCClient } from '../src/services/IPCClient';
import type { ChatMessage } from '../src/types/chat';

const msg = (
  id: string,
  role: ChatMessage['role'],
  content: string,
  extra: Partial<ChatMessage> = {},
) => ({ id, role, content, timestamp: Number(id), ...extra }) as ChatMessage;

describe('buildProviderMessages', () => {
  it('prepends system prompt, keeps prior turns, appends the new user input', () => {
    const history = [msg('1', 'user', 'hi'), msg('2', 'assistant', 'hello')];
    expect(buildProviderMessages(history, 'how are you?', '  be brief ')).toEqual([
      { role: 'system', content: 'be brief' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
      { role: 'user', content: 'how are you?' },
    ]);
  });

  it('wraps delegate results in a <cli-output> boundary so the main process can filter them (#117)', () => {
    const history = [
      msg('1', 'user', 'go'),
      msg('delegate-t1-42', 'assistant', 'did it', { origin: 'background' }),
      msg('3', 'assistant', 'plain', { origin: 'background' }),
    ];
    const out = buildProviderMessages(history, 'next');
    expect(out[1]!.content).toMatch(/^<cli-output>\n.+\ndid it\n<\/cli-output>$/);
    expect(out[2]!.content).toBe('plain');
  });

  it('drops empty and failed messages; no system prompt when blank', () => {
    const history = [
      msg('1', 'user', 'q'),
      msg('2', 'assistant', ''),
      msg('3', 'assistant', 'partial', { error: 'boom' }),
    ];
    expect(buildProviderMessages(history, 'again', '')).toEqual([
      { role: 'user', content: 'q' },
      { role: 'user', content: 'again' },
    ]);
  });
});

describe('ConversationStore', () => {
  const mk = (storage = createMemoryStorage()) => {
    let n = 0;
    return new ConversationStore({ storage, now: () => 1000 + n, newId: () => `c${++n}` });
  };

  it('persists messages per conversation and supports switching / clearing', () => {
    const storage = createMemoryStorage();
    const s = mk(storage);
    const first = s.ensureCurrent();
    s.append(msg('1', 'user', 'first question'));
    const second = s.create().id;
    s.append(msg('2', 'user', 'other'));

    expect(s.getMessages(first).map((m) => m.content)).toEqual(['first question']);
    expect(s.getMessages().map((m) => m.content)).toEqual(['other']);
    expect(s.list().find((c) => c.id === first)!.name).toBe('first question');

    s.switchTo(first);
    expect(s.currentId()).toBe(first);
    s.clear();
    expect(s.getMessages()).toEqual([]);
    expect(s.getMessages(second)).toHaveLength(1);

    // 新实例读同一存储（模拟重启）
    const reopened = new ConversationStore({ storage });
    expect(reopened.currentId()).toBe(first);
    expect(reopened.getMessages(second)[0]!.content).toBe('other');
  });

  it('caches loaded messages until the conversation is changed', () => {
    const base = createMemoryStorage();
    base.setItem(
      'ai-chat:conversations',
      JSON.stringify([{ id: 'c1', name: 'cached', createdAt: 1, updatedAt: 1, backend: 'nomi' }]),
    );
    base.setItem('ai-chat:conversation:c1', JSON.stringify([msg('1', 'user', 'hello')]));
    let reads = 0;
    const storage = {
      getItem: (key: string) => {
        reads++;
        return base.getItem(key);
      },
      setItem: base.setItem,
      removeItem: base.removeItem,
    };
    const s = new ConversationStore({ storage });
    reads = 0;

    expect(s.getMessages('c1')).toHaveLength(1);
    // 一次读消息，一次读当前会话 id（淘汰时要保住当前会话）
    expect(reads).toBe(2);
    expect(s.getMessages('c1')).toHaveLength(1);
    expect(reads).toBe(2);

    s.append(msg('2', 'assistant', 'world'), 'c1');
    expect(s.getMessages('c1').map((m) => m.content)).toEqual(['hello', 'world']);
  });

  it('evicts old message caches, keeps the current one, and previews without caching', () => {
    const base = createMemoryStorage();
    let reads = 0;
    const storage = {
      getItem: (key: string) => {
        if (key.startsWith('ai-chat:conversation:')) reads++;
        return base.getItem(key);
      },
      setItem: base.setItem.bind(base),
      removeItem: base.removeItem.bind(base),
    };
    let n = 0;
    const s = new ConversationStore({
      storage,
      maxCachedConversations: 2,
      now: () => 1,
      newId: () => `c${++n}`,
    });
    const a = s.create({ name: 'A' }).id;
    s.append(msg('1', 'user', 'alpha message'), a);
    const b = s.create({ name: 'B' }).id;
    s.append(msg('2', 'user', 'beta'), b);
    const c = s.create({ name: 'C' }).id;
    s.append(msg('3', 'user', 'gamma'), c);

    reads = 0;
    expect(s.getMessages(c).map((m) => m.content)).toEqual(['gamma']);
    expect(s.getMessages(b).map((m) => m.content)).toEqual(['beta']);
    expect(reads).toBe(0);

    expect(s.getMessages(a).map((m) => m.content)).toEqual(['alpha message']);
    expect(reads).toBe(1);

    reads = 0;
    expect(s.firstUserPreview(b)).toBe('beta');
    expect(reads).toBe(1);
    expect(s.getMessages(c).map((m) => m.content)).toEqual(['gamma']);
    expect(s.getMessages(a).map((m) => m.content)).toEqual(['alpha message']);
    expect(reads).toBe(1);
  });

  it('trims to maxMessages and migrates the legacy single-history key', () => {
    const storage = createMemoryStorage();
    storage.setItem(
      'ai-chat:history',
      JSON.stringify([msg('1', 'user', 'old'), msg('2', 'assistant', 'reply')]),
    );
    const s = new ConversationStore({ storage, maxMessages: 3 });
    expect(storage.getItem('ai-chat:history')).toBeNull();
    expect(s.getMessages().map((m) => m.content)).toEqual(['old', 'reply']);
    s.append(msg('3', 'user', 'a'));
    s.append(msg('4', 'user', 'b'));
    expect(s.getMessages().map((m) => m.content)).toEqual(['reply', 'a', 'b']);
  });

  it('delete: removing the current conversation switches to the same-backend most recent one', () => {
    const s = mk();
    const a = s.create({ name: 'A', backend: 'nomi' }).id;
    const b = s.create({ name: 'B', backend: 'nomi' }).id;
    s.create({ name: 'C', backend: 'codex' });
    s.updateMeta(a, { updatedAt: 5000 });
    s.updateMeta(b, { updatedAt: 9000 });
    s.switchTo(a);
    s.delete(a);
    expect(s.currentId()).toBe(b);
  });

  it('delete: no same-backend conversation left leaves current empty instead of cross-backend jump', () => {
    const s = mk();
    const a = s.create({ name: 'A', backend: 'nomi' }).id;
    s.create({ name: 'C', backend: 'codex' });
    s.switchTo(a);
    s.delete(a);
    expect(s.currentId()).toBeUndefined();
    expect(s.list()).toHaveLength(1);
  });

  it('delete: removing the last conversation leaves no current instead of creating one', () => {
    const s = mk();
    const id = s.ensureCurrent();
    s.delete(id);
    expect(s.list()).toEqual([]);
    expect(s.currentId()).toBeUndefined();
    // 读取 / 清空不存在的当前会话是安全的空操作
    expect(s.getMessages()).toEqual([]);
    s.clear();
    expect(s.list()).toEqual([]);
  });

  it('delete: removing a non-current conversation keeps the current one', () => {
    const s = mk();
    const a = s.ensureCurrent();
    const b = s.create().id;
    s.delete(b);
    expect(s.currentId()).toBe(a);
  });

  it('append without a current conversation is a no-op until ensureCurrent', () => {
    const s = mk();
    s.append(msg('1', 'user', 'lost'));
    expect(s.list()).toEqual([]);
    const id = s.ensureCurrent();
    s.append(msg('2', 'user', 'kept'), id);
    expect(s.getMessages(id).map((m) => m.content)).toEqual(['kept']);
  });

  it('tags migrated rows without backend as nomi', () => {
    const storage = createMemoryStorage();
    storage.setItem(
      'ai-chat:conversations',
      JSON.stringify([
        { id: 'old1', name: 'legacy', createdAt: 1, updatedAt: 2 },
        {
          id: 'old2',
          name: 'claude one',
          createdAt: 1,
          updatedAt: 3,
          backend: 'claude',
          tabId: 't1',
        },
      ]),
    );
    storage.setItem('ai-chat:conversation:old1', JSON.stringify([msg('1', 'user', 'hi')]));
    storage.setItem('ai-chat:conversation:old2', JSON.stringify([]));
    const s = new ConversationStore({ storage });
    expect(s.get('old1')!.backend).toBe('nomi');
    expect(s.get('old2')!.backend).toBe('claude');
    expect(s.get('old2')!.tabId).toBe('t1');
    expect(s.listByBackend('nomi').map((c) => c.id)).toEqual(['old1']);
  });

  it('creates with backend, forks same-backend, and upserts CLI tabs', () => {
    let n = 0;
    const s = new ConversationStore({
      storage: createMemoryStorage(),
      now: () => 1000 + n,
      newId: () => `c${++n}`,
    });
    const a = s.create({ name: 'Nomi A', backend: 'nomi' });
    s.append(msg('1', 'user', 'hello'));
    s.append(msg('2', 'assistant', 'hi there'));
    const forked = s.fork(a.id);
    expect(forked.id).not.toBe(a.id);
    expect(forked.backend).toBe('nomi');
    expect(forked.name).toContain('副本');
    expect(s.getMessages(forked.id).map((m) => m.content)).toEqual(['hello', 'hi there']);
    expect(s.getMessages(a.id)).toHaveLength(2);

    const cross = s.fork(a.id, { backend: 'codex', name: 'A on Codex', messages: [] });
    expect(cross.backend).toBe('codex');
    expect(s.getMessages(cross.id)).toEqual([]);

    const tabMeta = s.upsertFromTab({
      id: 'tab-uuid',
      title: 'Codex',
      backend: 'codex',
      createdAt: 10,
      updatedAt: 20,
      cliSessionId: 'session-1',
    });
    expect(tabMeta.tabId).toBe('tab-uuid');
    expect(tabMeta.backend).toBe('codex');
    expect(tabMeta.cliSessionId).toBe('session-1');
    const again = s.upsertFromTab({
      id: 'tab-uuid',
      title: 'Codex renamed',
      backend: 'codex',
      createdAt: 10,
      updatedAt: 30,
      cliSessionId: 'session-1',
    });
    expect(again.id).toBe(tabMeta.id);
    expect(again.name).toBe('Codex renamed');
    // 标签被重建但仍绑定原 CLI 会话时，不能新建第二条镜像。
    const rebound = s.upsertFromTab({
      id: 'new-tab-uuid',
      title: 'CLI session renamed',
      backend: 'codex',
      createdAt: 10,
      updatedAt: 40,
      cliSessionId: 'session-1',
    });
    expect(rebound.id).toBe(tabMeta.id);
    expect(rebound.tabId).toBe('new-tab-uuid');
    expect(rebound.name).toBe('CLI session renamed');
    expect(s.list().filter((x) => x.cliSessionId === 'session-1')).toHaveLength(1);
    s.removeByTabId('new-tab-uuid');
    expect(s.findByTabId('new-tab-uuid')).toBeUndefined();
  });
});

describe('SdkIPCClient · multi-turn', () => {
  function fakeClient() {
    const calls: Array<{ kind: string; opts: { messages: unknown[]; provider?: string } }> = [];
    const client = {
      chat: {
        async sendMessage(opts: { messages: unknown[] }) {
          calls.push({ kind: 'send', opts });
          return { content: 'reply' };
        },
        stream(opts: { messages: unknown[] }) {
          calls.push({ kind: 'stream', opts });
          return (async function* () {
            yield { type: 'delta', content: 'str' };
            yield { type: 'done', finishReason: 'stop' };
          })();
        },
        abort: vi.fn(),
      },
      memory: { userProfile: { get: () => undefined, set: vi.fn() } },
      dispose: vi.fn(),
    };
    return { client, calls };
  }

  it('sends system prompt + prior turns for both non-stream and stream', async () => {
    const { client, calls } = fakeClient();
    const ipc = new SdkIPCClient(client as never);
    const history = [msg('1', 'user', 'q1'), msg('2', 'assistant', 'a1')];

    await expect(ipc.sendMessage('q2', history)).resolves.toBe('reply');
    const chunks: string[] = [];
    await ipc.sendStreamMessage('q3', (c) => chunks.push(c), [
      ...history,
      msg('3', 'user', 'q2'),
      msg('4', 'assistant', 'reply'),
    ]);

    expect(chunks).toEqual(['str']);
    const [send, stream] = calls;
    expect(send!.opts.messages).toEqual([
      { role: 'system', content: expect.stringContaining('Nomi') },
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'q2' },
    ]);
    expect(
      (stream!.opts.messages as Array<{ content: string }>).map((m) => m.content).slice(1),
    ).toEqual(['q1', 'a1', 'q2', 'reply', 'q3']);
  });
});
