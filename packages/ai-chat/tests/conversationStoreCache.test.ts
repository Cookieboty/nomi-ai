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

describe('ConversationStore coalesced message writes', () => {
  it('append serializes once per flush; reads and switches see pending data', () => {
    const c = counting();
    const store = new ConversationStore({ storage: c.storage, maxCachedConversations: 1 });
    const a = store.create('a').id;
    c.sets.length = 0;
    store.append(msg(0, 'q'), a);
    store.append(msg(1, 'r'), a);
    expect(c.sets.filter((k) => k === `ai-chat:conversation:${a}`)).toEqual([]);
    // in-memory copy is current right away
    expect(store.getMessages(a).map((m) => m.content)).toEqual(['q', 'r']);
    // another conversation becomes current → a is evicted from the cache; reading it must see pending
    const b = store.create('b').id;
    store.append(msg(2, 'other'), b);
    expect(store.getMessages(a).map((m) => m.content)).toEqual(['q', 'r']);
    expect(JSON.parse(c.base.getItem(`ai-chat:conversation:${a}`)!)).toHaveLength(2);
    // switching flushes everything pending
    store.switchTo(a);
    expect(JSON.parse(c.base.getItem(`ai-chat:conversation:${b}`)!)[0].content).toBe('other');
    store.dispose();
  });

  it('flushes on pagehide and drops pending writes of a deleted conversation', () => {
    const c = counting();
    const store = new ConversationStore({ storage: c.storage });
    const a = store.create('a').id;
    store.append(msg(0, 'q'), a);
    window.dispatchEvent(new Event('pagehide'));
    expect(JSON.parse(c.base.getItem(`ai-chat:conversation:${a}`)!)).toHaveLength(1);
    store.append(msg(1, 'r'), a);
    store.delete(a);
    store.flush();
    expect(c.base.getItem(`ai-chat:conversation:${a}`)).toBeNull();
    store.dispose();
  });

  it('a full storage is retried only after a backoff (no reserialization every turn)', () => {
    const base = createMemoryStorage();
    let attempts = 0;
    const storage: KeyValueStorage = {
      getItem: (k) => base.getItem(k),
      setItem: (k, v) => {
        if (k.startsWith('ai-chat:conversation:') && v.length > 2) {
          attempts++;
          const e = new Error('full');
          e.name = 'QuotaExceededError';
          throw e;
        }
        base.setItem(k, v);
      },
      removeItem: (k) => base.removeItem(k),
    };
    let now = 1000;
    const store = new ConversationStore({ storage, now: () => now });
    const a = store.create('a').id;
    store.append(msg(0), a);
    store.flush();
    expect(attempts).toBe(1);
    store.append(msg(1), a);
    store.flush();
    expect(attempts).toBe(1); // backing off, still pending
    expect(store.getMessages(a)).toHaveLength(2);
    now += 61_000;
    store.flush();
    expect(attempts).toBe(2);
    store.dispose();
  });
});

describe('ConversationStore first-user previews', () => {
  const user = (id: string, content: string): ChatMessage => ({
    id,
    role: 'user',
    content,
    timestamp: 1,
  });

  it('backfills an old conversation once, then serves search without reading its history', () => {
    const c = counting();
    c.base.setItem(
      'ai-chat:conversations',
      JSON.stringify([{ id: 'old', name: 'Old', createdAt: 1, updatedAt: 1, backend: 'nomi' }]),
    );
    c.base.setItem('ai-chat:conversation:old', JSON.stringify([user('u', 'hello there')]));
    const store = new ConversationStore({ storage: c.storage });
    expect(store.firstUserPreview('old')).toBe('hello there');
    store.flush();
    expect(JSON.parse(c.base.getItem('ai-chat:conversationPreviews')!)).toEqual({
      old: 'hello there',
    });
    // a fresh store (next launch) uses the stored preview
    c.gets.clear();
    const next = new ConversationStore({ storage: c.storage });
    expect(next.firstUserPreview('old')).toBe('hello there');
    expect(c.gets.get('ai-chat:conversation:old') ?? 0).toBe(0);
    store.dispose();
    next.dispose();
  });

  it('follows the first user message through append, resend, trimming, clear and delete', () => {
    const store = new ConversationStore({ storage: createMemoryStorage(), maxMessages: 2 });
    const a = store.create('a').id;
    expect(store.firstUserPreview(a)).toBe('');
    store.append(user('1', 'first'), a);
    store.append(msg(1, 'reply'), a);
    expect(store.firstUserPreview(a)).toBe('first');
    expect(store.firstUserPreview(a, 3)).toBe('fir');
    // trimmed past the first user message → the next one in the kept history
    store.append(user('3', 'second'), a);
    expect(store.firstUserPreview(a)).toBe('second');
    store.setMessages(a, [user('9', 'edited')]);
    expect(store.firstUserPreview(a)).toBe('edited');
    store.clear(a);
    expect(store.firstUserPreview(a)).toBe('');
    store.append(user('10', 'again'), a);
    store.delete(a);
    expect(store.firstUserPreview(a)).toBe('');
    store.dispose();
  });
});
