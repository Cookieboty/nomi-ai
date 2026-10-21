// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';

import {
  ConversationStore,
  createMemoryStorage,
  type KeyValueStorage,
} from '../src/services/conversationStore';
import type { ChatMessage } from '../src/types/chat';

function counting(base: KeyValueStorage = createMemoryStorage()) {
  const gets = new Map<string, number>();
  const sets: string[] = [];
  const storage: KeyValueStorage = {
    getItem: (k) => {
      gets.set(k, (gets.get(k) ?? 0) + 1);
      return base.getItem(k);
    },
    setItem: (k, v) => {
      sets.push(k);
      base.setItem(k, v);
    },
    removeItem: (k) => base.removeItem(k),
  };
  return { storage, gets, sets, base };
}

const msg = (i: number, content = 'x'): ChatMessage => ({
  id: `m${i}`,
  role: i % 2 ? 'assistant' : 'user',
  content,
  timestamp: i,
});

describe('ConversationStore in-memory index', () => {
  it('does not re-read the index from storage on every list / currentId / isNomi / get', () => {
    const c = counting();
    const store = new ConversationStore({ storage: c.storage });
    const ids = Array.from({ length: 20 }, () => store.create().id);
    c.gets.clear();
    for (let i = 0; i < 100; i++) {
      store.list();
      store.currentId();
      store.isNomi(ids[i % 20]);
      store.get(ids[i % 20]!);
      store.findByTabId('none');
    }
    expect(c.gets.get('ai-chat:conversations') ?? 0).toBe(0);
    expect(c.gets.get('ai-chat:currentConversation') ?? 0).toBe(0);
  });

  it('list() returns a copy; the stored index reflects writes', () => {
    const c = counting();
    const store = new ConversationStore({ storage: c.storage });
    const a = store.create('a');
    store.list().pop();
    expect(store.get(a.id)).toBeTruthy();
    store.updateMeta(a.id, { name: 'renamed' });
    expect(JSON.parse(c.base.getItem('ai-chat:conversations')!)[0].name).toBe('renamed');
    // a fresh store over the same storage sees the same state
    expect(new ConversationStore({ storage: c.base }).get(a.id)?.name).toBe('renamed');
  });

  it('switchTo: one index lookup, writes current once, last-Nomi only when it changes', () => {
    const c = counting();
    const store = new ConversationStore({ storage: c.storage });
    const a = store.create('a');
    const b = store.create('b');
    c.sets.length = 0;
    store.switchTo(a.id);
    expect(c.sets).toEqual(['ai-chat:currentConversation', 'ai-chat:lastNomiConversation']);
    c.sets.length = 0;
    store.switchTo(a.id);
    expect(c.sets).toEqual([]);
    store.switchTo(b.id);
    expect(store.currentId()).toBe(b.id);
    expect(store.lastNomiId()).toBe(b.id);
    expect(() => store.switchTo('nope')).toThrow(/unknown conversation/);
  });

  it('a storage event from another window invalidates the mirror', () => {
    localStorage.clear();
    const store = new ConversationStore();
    const a = store.create('a');
    // another window renames it and writes localStorage directly
    const raw = JSON.parse(localStorage.getItem('ai-chat:conversations')!);
    raw[0].name = 'from-other-window';
    localStorage.setItem('ai-chat:conversations', JSON.stringify(raw));
    expect(store.get(a.id)?.name).toBe('a'); // mirror until notified
    window.dispatchEvent(new StorageEvent('storage', { key: 'ai-chat:conversations' }));
    expect(store.get(a.id)?.name).toBe('from-other-window');
    store.dispose();
  });
});

describe('ConversationStore messages LRU', () => {
  it('keeps up to 12 conversations by default', () => {
    const c = counting();
    const store = new ConversationStore({ storage: c.storage });
    const ids = Array.from({ length: 12 }, (_, i) => {
      const id = store.create().id;
      store.setMessages(id, [msg(i)]);
      return id;
    });
    c.gets.clear();
    for (const id of ids) store.getMessages(id);
    const misses = [...c.gets.keys()].filter((k) => k.startsWith('ai-chat:conversation:'));
    expect(misses).toEqual([]);
  });

  it('evicts by char budget (never the current conversation)', () => {
    const c = counting();
    const store = new ConversationStore({ storage: c.storage, maxCachedChars: 50_000 });
    const big = 'y'.repeat(20_000);
    const ids = Array.from({ length: 4 }, (_, i) => {
      const id = store.create().id;
      store.setMessages(id, [msg(i, big)]);
      return id;
    });
    // current = last created; budget holds ~2 of these
    c.gets.clear();
    store.getMessages(ids[3]);
    store.getMessages(ids[2]);
    expect([...c.gets.keys()].filter((k) => k.startsWith('ai-chat:conversation:'))).toEqual([]);
    store.getMessages(ids[0]);
    expect(c.gets.get(`ai-chat:conversation:${ids[0]}`)).toBe(1); // was evicted
    expect(store.getMessages(ids[3])[0]!.content).toBe(big);
  });
});
