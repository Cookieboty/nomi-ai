import { describe, expect, it } from 'vitest';

import { ConversationStore, createMemoryStorage } from '../src/services/conversationStore';
import { nomiScopeKey } from '../src/slash/nomiScope';

const cliTab = (id: string) =>
  ({ id, title: id, backend: 'claude', createdAt: 1, updatedAt: 1 }) as never;

describe('nomiScopeKey：异步斜杠命令的 Nomi 作用域（#14）', () => {
  it('两个空会话的作用域不同（不再都是 nomi:new）', () => {
    const store = new ConversationStore({ storage: createMemoryStorage() });
    store.create('A');
    const a = nomiScopeKey(store, undefined);
    store.create('B');
    const b = nomiScopeKey(store, undefined);
    expect(a).not.toBe(b);
    expect(a).not.toBe('nomi:new');
  });

  it('停在 CLI 镜像时仍是离开前的 Nomi 会话，且不切换导航', () => {
    const store = new ConversationStore({ storage: createMemoryStorage() });
    const A = store.create('A').id;
    const scope = nomiScopeKey(store, undefined);
    const C = store.upsertFromTab(cliTab('tab-x')).id;
    store.switchTo(C);
    expect(nomiScopeKey(store, undefined)).toBe(scope);
    expect(scope).toBe(`nomi:${A}`);
    expect(store.currentId()).toBe(C);
  });

  it('同一会话重新加载（消息不变）作用域不变；没有会话存储时退回首条消息 id', () => {
    const store = new ConversationStore({ storage: createMemoryStorage() });
    store.create('A');
    expect(nomiScopeKey(store, 'm1')).toBe(nomiScopeKey(store, 'm1'));
    expect(nomiScopeKey(undefined, 'm1')).toBe('nomi:m1');
    expect(nomiScopeKey(undefined, undefined)).toBe('nomi:new');
  });
});
