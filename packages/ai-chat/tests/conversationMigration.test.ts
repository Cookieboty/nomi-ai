// @vitest-environment happy-dom
import { appContract } from '@nomi-ai/contract/app';
import { createTestClient } from '@nomi-ai/contract/testing';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createConversationStore,
  prepareConversationStore,
  resetPreparedConversationStore,
} from '../src/services/conversationBoot';
import {
  createContractConversationKernel,
  createMemoryConversationKernel,
  type ConversationKernel,
} from '../src/services/conversationKernel';
import {
  LEGACY_HISTORY_ID,
  migrateConversationsToKernel,
} from '../src/services/conversationMigration';
import { createMemoryStorage } from '../src/services/conversationStore';
import type { ChatMessage } from '../src/types/chat';

const m = (id: string, role: 'user' | 'assistant', content: string, ts = 1): ChatMessage => ({
  id,
  role,
  content,
  timestamp: ts,
});

/** 2.2.0 及以前对话窗口 localStorage 里的旧布局 */
function oldLayout() {
  const s = createMemoryStorage();
  s.setItem(
    'ai-chat:conversations',
    JSON.stringify([
      { id: 'a', name: 'A', createdAt: 1, updatedAt: 5, backend: 'nomi', cwd: '/w' },
      { id: 'b', name: 'B', createdAt: 2, updatedAt: 6 }, // 没 backend 的旧行
      { id: 't', name: 'tab', createdAt: 3, updatedAt: 7, backend: 'codex', tabId: 'tab1' },
      { id: 'bad/id', name: 'x', createdAt: 1, updatedAt: 1, backend: 'nomi' },
      { name: 'no id' },
    ]),
  );
  s.setItem(
    'ai-chat:conversation:a',
    JSON.stringify([m('1', 'user', 'hello'), m('2', 'assistant', 'hi')]),
  );
  s.setItem('ai-chat:conversation:b', '{broken');
  s.setItem('ai-chat:conversation:t', '[]');
  // 存储满了索引没写进去、消息还在的会话
  s.setItem('ai-chat:conversation:orphan', JSON.stringify([m('9', 'user', 'lost index', 42)]));
  s.setItem('ai-chat:conversationPreviews', JSON.stringify({ a: 'hello' }));
  s.setItem('ai-chat:currentConversation', '"b"');
  s.setItem('ai-chat:lastNomiConversation', '"a"');
  s.setItem('ai-chat:history', JSON.stringify([m('h', 'user', 'ancient')]));
  s.setItem('ai-chat:chatMode', '"agent"');
  return s;
}

const EMPTY = { conversations: [], previews: {}, counts: {}, migrated: false };

afterEach(() => {
  resetPreparedConversationStore();
  window.localStorage.clear();
});

describe('localStorage → 内核会话存储', () => {
  it('导入全部会话（含索引外的消息键、更早的单会话历史），核对后记完成；旧键不动', async () => {
    const kernel = createMemoryConversationKernel();
    const source = oldLayout();
    const before = new Map(
      [...Array(source.length).keys()].map((i) => [source.key(i)!, source.getItem(source.key(i)!)]),
    );
    const r = await migrateConversationsToKernel({ kernel, source, snapshot: EMPTY, mark: true });
    expect(r).toMatchObject({ status: 'complete', total: 5, imported: 5, invalid: 1 });
    expect(kernel.data.order).toEqual(['a', 'b', 't', 'orphan', LEGACY_HISTORY_ID]);
    expect(kernel.data.messages.get('a')).toEqual([
      m('1', 'user', 'hello'),
      m('2', 'assistant', 'hi'),
    ]);
    expect(kernel.data.messages.get('b')).toEqual([]); // 坏 JSON 按空会话
    expect(kernel.data.metas.get('b')!.backend).toBe('nomi');
    expect(kernel.data.metas.get('a')!.cwd).toBe('/w');
    expect(kernel.data.metas.get('orphan')).toMatchObject({ name: 'lost index', updatedAt: 42 });
    expect(kernel.data.previews).toMatchObject({ a: 'hello', orphan: 'lost index' });
    expect(kernel.data.current).toBe('b');
    expect(kernel.data.lastNomi).toBe('a');
    expect(kernel.data.migrated).toBe(5);
    expect(r.snapshot.migrated).toBe(true);
    // 旧键保留（降级回旧版还能看到）
    for (const [k, v] of before) expect(source.getItem(k)).toBe(v);
  });

  it('幂等：再跑一次什么都不变；已有的 id 不覆盖、不重复', async () => {
    const kernel = createMemoryConversationKernel();
    await kernel.put({
      meta: { id: 'a', name: 'newer', createdAt: 1, updatedAt: 99, backend: 'nomi' },
      messages: [m('x', 'user', 'kept')],
    });
    const source = oldLayout();
    await migrateConversationsToKernel({
      kernel,
      source,
      snapshot: await kernel.state(),
      mark: true,
    });
    expect(kernel.data.metas.get('a')!.name).toBe('newer');
    expect(kernel.data.messages.get('a')).toEqual([m('x', 'user', 'kept')]);
    const again = await migrateConversationsToKernel({
      kernel,
      source,
      snapshot: await kernel.state(),
      mark: true,
    });
    expect(again).toMatchObject({ status: 'complete', imported: 0 });
    expect(kernel.data.order.filter((id) => id === 'a')).toHaveLength(1);
  });

  it('中途失败：不记完成；下次启动补齐', async () => {
    const kernel = createMemoryConversationKernel();
    let n = 0;
    kernel.failNext = (name) => name === 'import' && ++n === 2;
    const r = await migrateConversationsToKernel({
      kernel,
      source: oldLayout(),
      snapshot: EMPTY,
      mark: true,
    });
    expect(r.status).toBe('incomplete');
    expect(kernel.data.migrated).toBeUndefined();
    kernel.failNext = undefined;
    const r2 = await migrateConversationsToKernel({
      kernel,
      source: oldLayout(),
      snapshot: await kernel.state(),
      mark: true,
    });
    expect(r2.status).toBe('complete');
    expect(kernel.data.order).toHaveLength(5);
  });

  it('大会话分几次发，消息一条不少、顺序不变', async () => {
    const kernel = createMemoryConversationKernel();
    const source = createMemoryStorage();
    const big = Array.from({ length: 50 }, (_, i) =>
      m(`m${i}`, i % 2 ? 'assistant' : 'user', 'x'.repeat(100)),
    );
    source.setItem(
      'ai-chat:conversations',
      JSON.stringify([{ id: 'big', name: 'Big', createdAt: 1, updatedAt: 1, backend: 'nomi' }]),
    );
    source.setItem('ai-chat:conversation:big', JSON.stringify(big));
    const imports: number[] = [];
    const orig = kernel.importConversation.bind(kernel);
    kernel.importConversation = async (input) => {
      imports.push(input.messages.length);
      return orig(input);
    };
    await migrateConversationsToKernel({
      kernel,
      source,
      snapshot: EMPTY,
      mark: true,
      maxChunkChars: 1000,
    });
    expect(imports.length).toBeGreaterThan(1);
    expect(kernel.data.messages.get('big')).toEqual(big);
  });
});

describe('启动（conversationBoot）', () => {
  it('首次启动迁移；之后删掉的会话不会被旧键复活', async () => {
    const kernel = createMemoryConversationKernel();
    const ls = window.localStorage;
    const old = oldLayout();
    for (let i = 0; i < old.length; i++) ls.setItem(old.key(i)!, old.getItem(old.key(i)!)!);
    const r = await prepareConversationStore({ kernel, storage: ls });
    expect(r.migration).toBe('complete');
    const store = createConversationStore();
    expect(store.list().map((c) => c.id)).toEqual(['a', 'b', 't', 'orphan', LEGACY_HISTORY_ID]);
    expect(store.currentId()).toBe('b');
    store.delete('a');
    await store.flush();
    resetPreparedConversationStore();
    const again = await prepareConversationStore({ kernel, storage: ls });
    expect(again.migration).toBeUndefined();
    expect(createConversationStore().get('a')).toBeUndefined();
    // 旧键还在
    expect(ls.getItem('ai-chat:conversation:a')).not.toBeNull();
  });

  it('内核读不到：不迁移、照常给出空的存储', async () => {
    const kernel = createMemoryConversationKernel();
    kernel.failNext = (name) => name === 'state';
    window.localStorage.setItem('ai-chat:conversations', '[]');
    const r = await prepareConversationStore({ kernel, storage: window.localStorage });
    expect(r.migration).toBe('skipped');
    expect(kernel.calls).not.toContain('import');
    expect(createConversationStore().list()).toEqual([]);
  });
});

/** 假传输：契约的 in-process 服务端，处理函数接到内存「内核」上 */
function contractKernel() {
  const mem = createMemoryConversationKernel();
  const H = (fn: (input: never) => unknown) => fn;
  const handlers = {
    'conversations.state': H(() => mem.state()),
    'conversations.messages': H((i: { id: string; limit?: number }) => mem.messages(i.id, i.limit)),
    'conversations.append': H((i: Parameters<ConversationKernel['append']>[0]) => mem.append(i)),
    'conversations.replace': H((i: Parameters<ConversationKernel['replace']>[0]) => mem.replace(i)),
    'conversations.put': H((i: Parameters<ConversationKernel['put']>[0]) => mem.put(i)),
    'conversations.delete': H((i: { id: string }) => mem.remove(i.id)),
    'conversations.setPointers': H((i: Parameters<ConversationKernel['setPointers']>[0]) =>
      mem.setPointers(i),
    ),
    'conversations.import': H((i: Parameters<ConversationKernel['importConversation']>[0]) =>
      mem.importConversation(i),
    ),
    'conversations.markMigrated': H((i: { count: number }) => mem.markMigrated(i.count)),
  };
  const chat = createTestClient(appContract, handlers as never, {
    caller: { surface: 'chat', trusted: true },
  });
  const mascot = createTestClient(appContract, handlers as never, {
    caller: { surface: 'mascot', trusted: true },
  });
  return { mem, chat, mascot };
}

describe('契约适配（假传输）', () => {
  it('store → 契约 → 内核：追加只带新消息，消息原样往返；变更事件带 source', async () => {
    const { mem, chat, mascot } = contractKernel();
    try {
      const kernel = createContractConversationKernel(chat.api as never, 'win1');
      const events: unknown[] = [];
      const off = kernel.onChanged!((e) => events.push(e));
      resetPreparedConversationStore();
      await prepareConversationStore({ kernel });
      const store = createConversationStore();
      const id = store.create('x').id;
      const weird: ChatMessage = {
        ...m('1', 'user', 'emoji 😀   "quotes"'),
        trace: [{ type: 'text', text: 'deep' } as never],
      };
      store.append(weird, id);
      await store.flush();
      expect(mem.data.messages.get(id)).toEqual([weird]);
      expect(mem.data.current).toBe(id);
      // 别的窗口（这里直接从服务端推）写了 → 事件到达
      chat.router.events.publish('conversations.changed', {
        source: 'other',
        ids: [id],
        index: true,
      });
      await new Promise((r) => setTimeout(r, 0));
      expect(events).toContainEqual({ source: 'other', ids: [id], index: true });
      off();
      // 重启后读回来的一样
      resetPreparedConversationStore();
      await prepareConversationStore({ kernel });
      expect(await createConversationStore().loadMessages(id)).toEqual([weird]);
      // 只给对话窗口
      await expect(mascot.api.conversations.state()).rejects.toMatchObject({ code: 'FORBIDDEN' });
      // id 不能当文件名的在契约层就拒绝
      await expect(chat.api.conversations.messages({ id: '../x' })).rejects.toBeTruthy();
    } finally {
      chat.close();
      mascot.close();
    }
  });
});
