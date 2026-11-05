// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  prepareConversationStore,
  resetPreparedConversationStore,
} from '../src/services/conversationBoot';
import { createMemoryConversationKernel } from '../src/services/conversationKernel';
import { createMemoryStorage, type KeyValueStorage } from '../src/services/conversationStore';
import { SdkIPCClient } from '../src/services/IPCClient';
import {
  importLegacyChatHistory,
  LEGACY_IMPORT_MARKER,
  type LegacyChatHistory,
} from '../src/services/legacyChatImport';
import type { ChatMessage } from '../src/types/chat';

vi.mock('../src/services/api', async () =>
  (await import('./helpers/mascotHost')).mascotApiModule(),
);

// 旧 Electron（2.0.4）localStorage 里抽出来的键（#181）：多个会话、当前 / 最近 Nomi 会话、名称、工作区、消息
const m = (id: string, role: 'user' | 'assistant', content: string, ts: number): ChatMessage => ({
  id,
  role,
  content,
  timestamp: ts,
});
const OLD_INDEX = [
  { id: 'old1', name: '周报 🚀', createdAt: 1, updatedAt: 10, backend: 'nomi', cwd: '/Users/me/w' },
  { id: 'old2', name: 'refactor', createdAt: 2, updatedAt: 20, backend: 'nomi' },
  { id: 'old3', name: 'claude tab', createdAt: 3, updatedAt: 5, backend: 'claude', tabId: 't1' },
];
const OLD1 = [m('a', 'user', '写周报', 1), m('b', 'assistant', '好的 😀', 2)];
const OLD2 = [m('c', 'user', 'hi', 3)];
const ENTRIES: Record<string, string> = {
  'ai-chat:conversations': JSON.stringify(OLD_INDEX),
  'ai-chat:conversation:old1': JSON.stringify(OLD1),
  'ai-chat:conversation:old2': JSON.stringify(OLD2),
  'ai-chat:conversation:old3': '[]',
  'ai-chat:currentConversation': '"old2"',
  'ai-chat:lastNomiConversation': '"old1"',
  'ai-chat:config': JSON.stringify({ fontSize: 16, maxHistoryLength: 1000 }),
  'ai-chat:chatMode': '"agent"',
};
const ready = (entries = ENTRIES): LegacyChatHistory => ({ status: 'ready', entries });

function fakeClient() {
  return {
    chat: { sendMessage: vi.fn(), stream: vi.fn(), abort: vi.fn() },
    memory: { userProfile: { get: () => ({}), set: vi.fn() } },
    dispose: vi.fn(),
  };
}

type Kernel = ReturnType<typeof createMemoryConversationKernel>;

/** 启动对话窗口：会话存储准备（含旧对话导入、迁移进内核）→ 生产里的 SdkIPCClient */
async function openChat(kernel: Kernel, fetchLegacy = vi.fn(async () => ready())) {
  resetPreparedConversationStore();
  await prepareConversationStore({ kernel, storage: window.localStorage, fetchLegacy });
  return new SdkIPCClient(fakeClient() as never, { defaultSystemPrompt: async () => undefined });
}

afterEach(() => {
  window.localStorage.clear();
  resetPreparedConversationStore();
});

describe('旧 Electron 对话导入 → 内核会话存储 → 渲染入口可见', () => {
  it('全新的 Go 存储：会话、名称、工作区、消息、当前 / 最近 Nomi 会话都在', async () => {
    const kernel = createMemoryConversationKernel();
    const ipc = await openChat(kernel);
    const list = await ipc.listConversations();
    expect(list.map((c) => [c.id, c.name, c.cwd])).toEqual([
      ['old1', '周报 🚀', '/Users/me/w'],
      ['old2', 'refactor', undefined],
      ['old3', 'claude tab', undefined],
    ]);
    expect(ipc.currentConversationId()).toBe('old2');
    expect(await ipc.getChatHistory()).toEqual(OLD2);
    const store = ipc.conversationStore();
    expect(await store.loadMessages('old1')).toEqual(OLD1);
    expect(store.lastNomiId()).toBe('old1');
    // 对话设置等偏好也带过来（偏好仍在 localStorage）
    expect((await ipc.getConfig()).fontSize).toBe(16);
    expect(window.localStorage.getItem('ai-chat:chatMode')).toBe('"agent"');
    // 会话进了内核，旧会话没写进 localStorage；完成标记记下
    expect(window.localStorage.getItem('ai-chat:conversations')).toBeNull();
    expect(JSON.parse(window.localStorage.getItem(LEGACY_IMPORT_MARKER)!)).toMatchObject({
      status: 'imported',
      conversations: 3,
    });
    await ipc.dispose();
  });

  it('Go 版里已有的会话不被覆盖，当前会话保持；旧会话补进侧栏', async () => {
    const kernel = createMemoryConversationKernel();
    const before = await openChat(
      kernel,
      vi.fn(async () => ({ status: 'failed' as const, entries: {}, error: 'x' })),
    );
    const mine = await before.newConversation('go chat');
    await before.saveMessage(m('g1', 'user', 'from go', 100));
    await before.dispose();

    const ipc = await openChat(kernel);
    const ids = (await ipc.listConversations()).map((c) => c.id);
    expect(ids).toEqual([mine, 'old1', 'old2', 'old3']);
    expect(ipc.currentConversationId()).toBe(mine);
    expect((await ipc.getChatHistory()).map((x) => x.content)).toEqual(['from go']);
    expect(await ipc.conversationStore().loadMessages('old1')).toEqual(OLD1);
    await ipc.dispose();
  });

  it('同 id 已在本窗口的旧存储里：保留本窗口的消息', async () => {
    window.localStorage.setItem(
      'ai-chat:conversations',
      JSON.stringify([
        { id: 'old1', name: 'renamed', createdAt: 1, updatedAt: 99, backend: 'nomi' },
      ]),
    );
    window.localStorage.setItem(
      'ai-chat:conversation:old1',
      JSON.stringify([m('x', 'user', 'new', 9)]),
    );
    const ipc = await openChat(createMemoryConversationKernel());
    const store = ipc.conversationStore();
    expect(store.get('old1')?.name).toBe('renamed');
    expect((await store.loadMessages('old1')).map((x) => x.id)).toEqual(['x']);
    await ipc.dispose();
  });
});

describe('再次启动', () => {
  it('完成标记在：不再问内核，升级后新写的消息不被覆盖', async () => {
    const kernel = createMemoryConversationKernel();
    const ipc = await openChat(kernel);
    await ipc.saveMessage(m('after', 'user', 'after upgrade', 50));
    await ipc.dispose();

    const fetch = vi.fn(async () => ready());
    const again = await openChat(kernel, fetch);
    expect(fetch).not.toHaveBeenCalled();
    expect((await again.getChatHistory()).map((x) => x.id)).toEqual(['c', 'after']);
    await again.dispose();
  });

  it('标记丢了也只是空跑：已有的会话按 id 跳过，消息不动', async () => {
    const kernel = createMemoryConversationKernel();
    const ipc = await openChat(kernel);
    await ipc.saveMessage(m('after', 'user', 'after upgrade', 50));
    await ipc.dispose();
    window.localStorage.removeItem(LEGACY_IMPORT_MARKER);

    const fetch = vi.fn(async () => ready());
    const again = await openChat(kernel, fetch);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect((await again.getChatHistory()).map((x) => x.id)).toEqual(['c', 'after']);
    expect((await again.listConversations()).length).toBe(3);
    expect(window.localStorage.getItem(LEGACY_IMPORT_MARKER)).not.toBeNull();
    await again.dispose();
  });

  it('会话没进内核（写入失败）：不记完成，下次启动再导', async () => {
    const kernel = createMemoryConversationKernel();
    kernel.failNext = (name) => name === 'import';
    const first = await openChat(kernel);
    expect((await first.listConversations()).length).toBe(0);
    expect(window.localStorage.getItem(LEGACY_IMPORT_MARKER)).toBeNull();
    await first.dispose();
    kernel.failNext = undefined;
    const again = await openChat(kernel);
    expect((await again.listConversations()).map((c) => c.id)).toEqual(['old1', 'old2', 'old3']);
    expect(window.localStorage.getItem(LEGACY_IMPORT_MARKER)).not.toBeNull();
    await again.dispose();
  });

  it('Node 版 / 没有旧数据：记完成，之后不再问', async () => {
    const fetch = vi.fn(async (): Promise<LegacyChatHistory> => ({ status: 'none', entries: {} }));
    expect(await importLegacyChatHistory({ fetch, storage: window.localStorage })).toEqual({
      status: 'none',
    });
    expect(await importLegacyChatHistory({ fetch, storage: window.localStorage })).toEqual({
      status: 'done-before',
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('失败与重试（抽取失败、导入失败、完成三者分开）', () => {
  it('内核抽取失败：不记完成；下次内核抽到了就导入', async () => {
    const storage = createMemoryStorage();
    const failed = await importLegacyChatHistory({
      fetch: async () => ({ status: 'failed', entries: {}, error: 'leveldb locked' }),
      storage,
    });
    expect(failed).toEqual({ status: 'extract-failed', error: 'leveldb locked' });
    expect(storage.getItem(LEGACY_IMPORT_MARKER)).toBeNull();

    const ok = await importLegacyChatHistory({ fetch: async () => ready(), storage });
    expect(ok).toEqual({ status: 'imported', conversations: 3, skipped: 0 });
    expect(JSON.parse(storage.getItem(LEGACY_IMPORT_MARKER)!)).toMatchObject({
      status: 'imported',
      conversations: 3,
    });
  });

  it('写进存储失败（配额）：回滚这次写的消息、索引不动、不记完成；空间够了再试成功', async () => {
    const base = createMemoryStorage();
    base.setItem(
      'ai-chat:conversations',
      JSON.stringify([{ id: 'go', name: 'g', backend: 'nomi' }]),
    );
    let full = true;
    const storage: KeyValueStorage = {
      getItem: (k) => base.getItem(k),
      setItem: (k, v) => {
        if (full && k === 'ai-chat:conversations') throw new Error('QuotaExceededError');
        base.setItem(k, v);
      },
      removeItem: (k) => base.removeItem(k),
    };
    const res = await importLegacyChatHistory({ fetch: async () => ready(), storage });
    expect(res).toEqual({ status: 'import-failed', error: 'QuotaExceededError' });
    expect(base.getItem(LEGACY_IMPORT_MARKER)).toBeNull();
    expect(base.getItem('ai-chat:conversation:old1')).toBeNull();
    expect(JSON.parse(base.getItem('ai-chat:conversations')!)).toHaveLength(1);

    full = false;
    expect(await importLegacyChatHistory({ fetch: async () => ready(), storage })).toEqual({
      status: 'imported',
      conversations: 3,
      skipped: 0,
    });
    expect(JSON.parse(base.getItem('ai-chat:conversation:old1')!)).toEqual(OLD1);
  });

  it('存储只放得下一部分：按最近更新从新到旧导入，放不下的较旧会话跳过，并记完成', async () => {
    const base = createMemoryStorage();
    // 模拟 WebKit 配额：放下最新的 old2 之后就满了
    const storage: KeyValueStorage = {
      getItem: (k) => base.getItem(k),
      setItem: (k, v) => {
        if (k === 'ai-chat:conversation:old1' || k === 'ai-chat:conversation:old3')
          throw new Error('QuotaExceededError');
        base.setItem(k, v);
      },
      removeItem: (k) => base.removeItem(k),
    };
    const res = await importLegacyChatHistory({ fetch: async () => ready(), storage });
    expect(res).toEqual({ status: 'imported', conversations: 1, skipped: 2 });
    // 索引只含已写进消息的会话，与消息一致
    expect(
      JSON.parse(base.getItem('ai-chat:conversations')!).map((c: { id: string }) => c.id),
    ).toEqual(['old2']);
    expect(JSON.parse(base.getItem('ai-chat:conversation:old2')!)).toEqual(OLD2);
    expect(base.getItem('ai-chat:conversation:old1')).toBeNull();
    // 指针只补指向已导入会话的：current → old2 补上，lastNomi → old1（没导入）不补
    expect(base.getItem('ai-chat:currentConversation')).toBe('"old2"');
    expect(base.getItem('ai-chat:lastNomiConversation')).toBeNull();
    // 已记完成：下次启动不再重试
    expect(base.getItem(LEGACY_IMPORT_MARKER)).not.toBeNull();
    const fetch = vi.fn(async () => ready());
    expect(await importLegacyChatHistory({ fetch, storage })).toEqual({ status: 'done-before' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('问不到内核 / 超时：不记完成', async () => {
    const storage = createMemoryStorage();
    const down = await importLegacyChatHistory({
      fetch: async () => {
        throw new Error('UNAVAILABLE');
      },
      storage,
    });
    expect(down).toEqual({ status: 'unavailable', error: 'UNAVAILABLE' });
    const slow = await importLegacyChatHistory({
      fetch: () => new Promise<LegacyChatHistory>(() => undefined),
      storage,
      timeoutMs: 10,
    });
    expect(slow.status).toBe('unavailable');
    expect(storage.getItem(LEGACY_IMPORT_MARKER)).toBeNull();
  });

  it('坏数据：消息不是数组按空会话导入；没 id 的索引项跳过', async () => {
    const storage = createMemoryStorage();
    await importLegacyChatHistory({
      fetch: async () =>
        ready({
          'ai-chat:conversations': JSON.stringify([{ id: 'a', name: 'A' }, { name: 'no id' }]),
          'ai-chat:conversation:a': '{oops',
        }),
      storage,
    });
    expect(JSON.parse(storage.getItem('ai-chat:conversations')!)).toEqual([{ id: 'a', name: 'A' }]);
    expect(storage.getItem('ai-chat:conversation:a')).toBe('[]');
  });
});
