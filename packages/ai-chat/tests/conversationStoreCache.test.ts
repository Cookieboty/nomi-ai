// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';

import { createMemoryConversationKernel } from '../src/services/conversationKernel';
import { ConversationStore } from '../src/services/conversationStore';
import type { ChatMessage } from '../src/types/chat';

const msg = (i: number, content = 'x'): ChatMessage => ({
  id: `m${i}`,
  role: i % 2 ? 'assistant' : 'user',
  content,
  timestamp: i,
});

/** 同一个「内核」上重新构造（= 重启）：先等写完，再取索引 */
async function reopen(
  store: ConversationStore,
  kernel: ReturnType<typeof createMemoryConversationKernel>,
  opts: ConstructorParameters<typeof ConversationStore>[0] = {},
) {
  await store.flush();
  store.dispose();
  return new ConversationStore({ ...opts, kernel, snapshot: await kernel.state() });
}

describe('ConversationStore over the kernel', () => {
  it('reads the index from memory; writes go to the kernel in order', async () => {
    const kernel = createMemoryConversationKernel();
    const store = new ConversationStore({ kernel });
    const ids = Array.from({ length: 5 }, () => store.create().id);
    for (let i = 0; i < 50; i++) {
      store.list();
      store.currentId();
      store.isNomi(ids[i % 5]);
      store.get(ids[i % 5]!);
    }
    await store.flush();
    expect(kernel.calls.filter((c) => c === 'state' || c === 'messages')).toEqual([]);
    expect(kernel.data.order).toEqual(ids);
    expect(kernel.data.current).toBe(ids[4]);
    store.list().pop();
    expect(store.get(ids[4]!)).toBeTruthy();
  });

  it('append sends only the new message (no whole-history rewrite), coalescing queued appends', async () => {
    const kernel = createMemoryConversationKernel();
    const store = new ConversationStore({ kernel });
    const a = store.create('a').id;
    await store.flush();
    kernel.calls.length = 0;
    const sent: number[] = [];
    const append = kernel.append.bind(kernel);
    kernel.append = async (input) => {
      sent.push(input.messages.length);
      return append(input);
    };
    store.append(msg(0, 'q'), a);
    store.append(msg(1, 'r'), a);
    store.append(msg(2, 's'), a);
    // 内存里立刻是最新的
    expect(store.getMessages(a).map((m) => m.content)).toEqual(['q', 'r', 's']);
    await store.flush();
    // 第一条立刻发出，排着的两条合并成一次
    expect(sent).toEqual([1, 2]);
    expect(kernel.calls).not.toContain('replace');
    expect(kernel.data.messages.get(a)!.map((m) => m.content)).toEqual(['q', 'r', 's']);
    // 标题跟着第一条用户消息走（随追加一起写元信息）
    expect(kernel.data.metas.get(a)!.name).toBe('a');
    const again = await reopen(store, kernel);
    expect(await again.loadMessages(a)).toHaveLength(3);
  });

  it('persists, survives a restart, and keeps current / last-Nomi', async () => {
    let n = 0;
    const kernel = createMemoryConversationKernel();
    const s = new ConversationStore({ kernel, now: () => 1000 + n, newId: () => `c${++n}` });
    const first = s.ensureCurrent();
    s.append(msg(0, 'first question'));
    const second = s.create().id;
    s.append(msg(2, 'other'));
    s.switchTo(first);
    s.updateMeta(second, { name: 'renamed', cwd: '/w' });
    const r = await reopen(s, kernel);
    expect(r.currentId()).toBe(first);
    expect(r.lastNomiId()).toBe(first);
    expect(r.get(second)).toMatchObject({ name: 'renamed', cwd: '/w' });
    expect(r.get(first)!.name).toBe('first question');
    // 没加载时同步读是空的，但 hasMessages 知道它有消息；加载后才是全部
    expect(r.isLoaded(second)).toBe(false);
    expect(r.hasMessages(second)).toBe(true);
    expect(await r.loadMessages(second)).toEqual([msg(2, 'other')]);
    expect(r.getMessages(second)).toEqual([msg(2, 'other')]);
  });

  it('open() switches and loads; concurrent loads hit the kernel once', async () => {
    const kernel = createMemoryConversationKernel();
    const s = new ConversationStore({ kernel });
    const a = s.create('a').id;
    s.append(msg(0, 'hello'), a);
    const b = s.create('b').id;
    const r = await reopen(s, kernel);
    kernel.calls.length = 0;
    const [x, y] = await Promise.all([r.loadMessages(a), r.loadMessages(a)]);
    expect(x).toBe(y);
    expect(kernel.calls.filter((c) => c === 'messages')).toHaveLength(1);
    expect(await r.open(b)).toEqual([]);
    expect(r.currentId()).toBe(b);
    // 再读已缓存的不再问内核
    await r.loadMessages(a);
    expect(kernel.calls.filter((c) => c === 'messages')).toHaveLength(2);
  });

  it('appending to an unloaded conversation does not drop its history', async () => {
    const kernel = createMemoryConversationKernel();
    const s = new ConversationStore({ kernel });
    const a = s.create('a').id;
    s.append(msg(0, 'one'), a);
    s.append(msg(1, 'two'), a);
    s.create('b');
    const r = await reopen(s, kernel);
    expect(r.isLoaded(a)).toBe(false);
    // 后台回复完写进没加载的会话：只追加
    r.append(msg(3, 'three'), a);
    expect(r.isLoaded(a)).toBe(false);
    expect((await r.loadMessages(a)).map((m) => m.content)).toEqual(['one', 'two', 'three']);
  });

  it('a load racing a local write re-reads instead of caching a stale copy', async () => {
    const kernel = createMemoryConversationKernel();
    const s = new ConversationStore({ kernel });
    const a = s.create('a').id;
    s.append(msg(0, 'one'), a);
    s.create('b');
    const r = await reopen(s, kernel);
    const read = kernel.messages.bind(kernel);
    let first = true;
    kernel.messages = async (id, limit) => {
      const out = await read(id, limit);
      // 第一次读回来之前，本地又追加了一条
      if (first) {
        first = false;
        r.append(msg(1, 'two'), a);
      }
      return out;
    };
    expect((await r.loadMessages(a)).map((m) => m.content)).toEqual(['one', 'two']);
  });

  it('deletes, clears and forks through the kernel', async () => {
    const kernel = createMemoryConversationKernel();
    const s = new ConversationStore({ kernel });
    const a = s.create('a').id;
    s.append(msg(0, 'hello'), a);
    s.append(msg(1, 'hi'), a);
    const f = s.fork(a);
    s.clear(a);
    const b = s.create('b').id;
    s.delete(b);
    await s.flush();
    expect(kernel.data.messages.get(f.id)!.map((m) => m.content)).toEqual(['hello', 'hi']);
    expect(kernel.data.messages.get(a)).toEqual([]);
    expect(kernel.data.metas.has(b)).toBe(false);
    // 删掉当前会话 → 指针切到同后端最近的
    expect(kernel.data.current).toBe(s.currentId());
    // 写进已删的会话：内核拒绝，不复活
    s.append(msg(2, 'late'), b);
    await s.flush();
    expect(kernel.data.metas.has(b)).toBe(false);
  });

  it('fork refuses an unloaded source instead of copying it as empty', async () => {
    const kernel = createMemoryConversationKernel();
    const s = new ConversationStore({ kernel });
    const a = s.create('a').id;
    s.append(msg(0, 'hello'), a);
    s.create('b');
    const r = await reopen(s, kernel);
    expect(() => r.fork(a)).toThrow(/not loaded/);
    await r.loadMessages(a);
    expect(r.getMessages(r.fork(a).id)).toHaveLength(1);
  });

  it('a failed kernel write is logged and does not block later writes', async () => {
    const kernel = createMemoryConversationKernel();
    const s = new ConversationStore({ kernel });
    const a = s.create('a').id;
    await s.flush();
    kernel.failNext = (name) => name === 'append';
    s.append(msg(0, 'lost'), a);
    await s.flush();
    kernel.failNext = undefined;
    s.updateMeta(a, { name: 'still works' });
    await s.flush();
    expect(kernel.data.metas.get(a)!.name).toBe('still works');
    // 内存里那份还在（本次会话里不丢）
    expect(s.getMessages(a)).toHaveLength(1);
  });

  it('another window’s write refreshes the index and drops its cached messages', async () => {
    const kernel = createMemoryConversationKernel();
    const s = new ConversationStore({ kernel });
    const a = s.create('a').id;
    s.append(msg(0, 'mine'), a);
    await s.flush();
    // 另一个窗口（不同的 source）改了 a
    kernel.data.metas.set(a, { ...kernel.data.metas.get(a)!, name: 'from-other-window' });
    kernel.data.messages.set(a, [msg(0, 'mine'), msg(1, 'theirs')]);
    const changed = new Promise((r) =>
      window.addEventListener('nomi:conversations-changed', r, { once: true }),
    );
    // 自己写的通知不触发刷新
    await kernel.put({ meta: kernel.data.metas.get(a)! });
    expect(s.get(a)!.name).toBe('a');
    // 别的窗口来的通知：重新取索引、丢掉 a 的缓存
    kernel.emitExternal([a]);
    await changed;
    expect(s.get(a)!.name).toBe('from-other-window');
    expect(s.isLoaded(a)).toBe(false);
    expect((await s.loadMessages(a)).map((m) => m.content)).toEqual(['mine', 'theirs']);
  });
});

describe('ConversationStore messages LRU', () => {
  it('keeps up to 12 conversations by default', async () => {
    const kernel = createMemoryConversationKernel();
    const store = new ConversationStore({ kernel });
    const ids = Array.from({ length: 12 }, (_, i) => {
      const id = store.create().id;
      store.setMessages(id, [msg(i)]);
      return id;
    });
    for (const id of ids) expect(store.isLoaded(id)).toBe(true);
  });

  it('evicts by char budget (never the current conversation); evicted ones reload', async () => {
    const kernel = createMemoryConversationKernel();
    const store = new ConversationStore({ kernel, maxCachedChars: 50_000 });
    const big = 'y'.repeat(20_000);
    const ids = Array.from({ length: 4 }, (_, i) => {
      const id = store.create().id;
      store.setMessages(id, [msg(i, big)]);
      return id;
    });
    // current = last created; budget holds ~2 of these
    expect(store.isLoaded(ids[3]!)).toBe(true);
    expect(store.isLoaded(ids[0]!)).toBe(false);
    expect(store.hasMessages(ids[0]!)).toBe(true);
    expect((await store.loadMessages(ids[0]!))[0]!.content).toBe(big);
    expect(store.getMessages(ids[3])[0]!.content).toBe(big);
  });

  it('without a kernel (tests / preview) nothing is evicted', () => {
    const store = new ConversationStore({ maxCachedConversations: 1 });
    const a = store.create().id;
    store.append(msg(0, 'kept'), a);
    store.create();
    expect(store.getMessages(a).map((m) => m.content)).toEqual(['kept']);
  });
});

describe('ConversationStore first-user previews', () => {
  const user = (id: string, content: string): ChatMessage => ({
    id,
    role: 'user',
    content,
    timestamp: 1,
  });

  it('serves search from the kernel previews without loading histories', async () => {
    const kernel = createMemoryConversationKernel();
    const s = new ConversationStore({ kernel });
    const a = s.create('A').id;
    s.append(user('u', 'hello there'), a);
    s.create('B');
    const r = await reopen(s, kernel);
    kernel.calls.length = 0;
    expect(r.firstUserPreview(a)).toBe('hello there');
    expect(kernel.calls).toEqual([]);
  });

  it('follows the first user message through append, resend, trimming, clear and delete', async () => {
    const kernel = createMemoryConversationKernel();
    const store = new ConversationStore({ kernel, maxMessages: 2 });
    const a = store.create('a').id;
    expect(store.firstUserPreview(a)).toBe('');
    store.append(user('1', 'first'), a);
    store.append(msg(1, 'reply'), a);
    expect(store.firstUserPreview(a)).toBe('first');
    expect(store.firstUserPreview(a, 3)).toBe('fir');
    // trimmed past the first user message → the next one in the kept history
    store.append(user('3', 'second'), a);
    expect(store.firstUserPreview(a)).toBe('second');
    await store.flush();
    expect(kernel.data.previews[a]).toBe('second');
    expect(kernel.data.messages.get(a)).toHaveLength(2);
    store.setMessages(a, [user('9', 'edited')]);
    expect(store.firstUserPreview(a)).toBe('edited');
    store.clear(a);
    expect(store.firstUserPreview(a)).toBe('');
    store.append(user('10', 'again'), a);
    store.delete(a);
    expect(store.firstUserPreview(a)).toBe('');
    await store.flush();
    expect(kernel.data.previews[a]).toBeUndefined();
  });
});
