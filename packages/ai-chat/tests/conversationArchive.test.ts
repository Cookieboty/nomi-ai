import { describe, expect, it } from 'vitest';

import { ConversationStore } from '../src/services/conversationStore';

describe('ConversationStore.setArchived', () => {
  it('archives without touching updatedAt and moves the current pointer to the next chat', () => {
    let now = 1000;
    const store = new ConversationStore({ now: () => now });
    const a = store.create({ name: 'a' }).id;
    now = 2000;
    const b = store.create({ name: 'b' }).id;
    expect(store.currentId()).toBe(b);
    const before = store.get(b)!.updatedAt;

    now = 3000;
    store.setArchived(b, true);
    expect(store.get(b)!.archivedAt).toBe(3000);
    expect(store.get(b)!.updatedAt).toBe(before);
    expect(store.currentId()).toBe(a);
    // 最近的 Nomi 会话不再是归档的那个
    expect(store.lastNomiId()).toBe(a);

    store.setArchived(b, false);
    expect(store.get(b)!.archivedAt).toBeUndefined();
    expect(store.get(b)!.updatedAt).toBe(before);
  });

  it('archiving the only chat leaves no current chat (no implicit new one)', () => {
    const store = new ConversationStore();
    const a = store.create({ name: 'a' }).id;
    store.setArchived(a, true);
    expect(store.currentId()).toBeUndefined();
    expect(store.list()).toHaveLength(1);
  });
});
