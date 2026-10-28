// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CONVERSATIONS_CHANGED_EVENT,
  ConversationStore,
  createMemoryStorage,
} from '../src/services/conversationStore';
import { forkCrossBackend, forkSameBackend } from '../src/services/forkConversation';
import { harnessClient } from '../src/services/harnessClient';
import type { ChatMessage } from '../src/types/chat';

const msg = (id: string, role: ChatMessage['role'], content: string) =>
  ({ id, role, content, timestamp: Number(id) }) as ChatMessage;

vi.mock('../src/services/harnessClient', () => {
  const tabs: Record<string, unknown[]> = {};
  let n = 0;
  return {
    MAIN_TAB_ID: 'main',
    harnessClient: {
      available: () => true,
      activateTab: vi.fn(async () => undefined),
      setBackend: vi.fn(async () => undefined),
      tabMessages: vi.fn(async (id: string) => tabs[id] ?? []),
      createTab: vi.fn(async (o: { backend: string; title?: string; messages?: unknown[] }) => {
        const id = `tab${++n}`;
        tabs[id] = o.messages ?? [];
        return {
          id,
          title: o.title ?? o.backend,
          backend: o.backend,
          cwd: '/tmp',
          cliSessionId: null,
          status: 'idle',
          unread: 0,
          createdAt: 1,
          updatedAt: 1,
        };
      }),
    },
  };
});

describe('forkConversation', () => {
  let store: ConversationStore;
  beforeEach(() => {
    let n = 0;
    store = new ConversationStore({
      storage: createMemoryStorage(),
      now: () => 1000 + ++n,
      newId: () => `c${++n}`,
    });
  });

  it('同端分叉广播 conversations-changed（侧栏据此立即刷新，D1 回归）', async () => {
    const src = store.create({ name: '周报', backend: 'nomi' });
    store.append(msg('1', 'user', '你好'));
    const onChange = vi.fn();
    window.addEventListener(CONVERSATIONS_CHANGED_EVENT, onChange);
    try {
      await forkSameBackend(store, src.id);
      expect(onChange).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener(CONVERSATIONS_CHANGED_EVENT, onChange);
    }
  });

  it('forks same-backend Nomi with copied messages', async () => {
    const a = store.create({ name: 'A', backend: 'nomi' });
    store.append(msg('1', 'user', 'hi'));
    store.append(msg('2', 'assistant', 'hello'));
    const r = await forkSameBackend(store, a.id);
    expect(r.backend).toBe('nomi');
    expect(r.title).toContain('副本');
    expect(store.getMessages(r.conversationId).map((m) => m.content)).toEqual(['hi', 'hello']);
    expect(store.getMessages(a.id)).toHaveLength(2);
  });

  it('只带最近几轮：同端新对话与跨端标签都只有这几轮', async () => {
    const a = store.create({ name: 'A', backend: 'nomi' });
    store.append(msg('1', 'user', 'q1'));
    store.append(msg('2', 'assistant', 'a1'));
    store.append(msg('3', 'user', 'q2'));
    store.append(msg('4', 'assistant', 'a2'));
    const same = await forkSameBackend(store, a.id, { turns: 1 });
    expect(store.getMessages(same.conversationId).map((m) => m.content)).toEqual(['q2', 'a2']);
    const cross = await forkCrossBackend(store, a.id, 'gemini', { turns: 1 });
    const seeded = (await harnessClient.tabMessages(cross.tabId!)) as Array<{ content: string }>;
    expect(seeded.map((m) => m.content)).toEqual(['q2', 'a2']);
  });

  it('forks cross-backend into a CLI tab with seeded messages', async () => {
    const a = store.create({ name: 'A', backend: 'nomi' });
    store.append(msg('1', 'user', 'q'));
    store.append(msg('2', 'assistant', 'a'));
    const r = await forkCrossBackend(store, a.id, 'codex');
    expect(r.backend).toBe('codex');
    expect(r.tabId).toBeTruthy();
    const meta = store.get(r.conversationId)!;
    expect(meta.tabId).toBe(r.tabId);
    expect(meta.backend).toBe('codex');
  });
});
