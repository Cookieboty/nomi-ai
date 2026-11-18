// @vitest-environment happy-dom
/**
 * 应用在回复中途重启（如更新）：待发列表与已经交给这一轮的插入消息不丢。
 * - 待发（Enter 插入 / Ctrl+Enter 排队）存在会话元信息 + localStorage，重启后挂回；撤回 / 删除同步清掉；
 * - 已经交给这一轮的插入记在元信息里：打断后补成用户消息（可重试，重试带着它）；正常结束只留在回复轨迹里，不整份 replace。
 */
import type { ClientAIClient } from '@nomi-ai/ai-sdk-client';
import { act, cleanup, render, renderHook } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AiChatContextProvider, useAiChat } from '../src/contexts/AiChatContext';
import {
  INTERRUPTED_REPLY_PREFIX,
  withDeliveredSteers,
  withInterruptedReply,
} from '../src/contexts/chatTurn';
import { useSendQueue } from '../src/hooks/useSendQueue';
import {
  prepareConversationStore,
  resetPreparedConversationStore,
} from '../src/services/conversationBoot';
import { createMemoryConversationKernel } from '../src/services/conversationKernel';
import { ConversationStore } from '../src/services/conversationStore';
import { buildProviderMessages, STEER_TAG } from '../src/services/history';
import { type SdkIPCClient } from '../src/services/IPCClient';
import { openPendingSends, pendingKey, type Kv } from '../src/services/pendingSendsStore';
import type { ChatMessage, ChatSession } from '../src/types/chat';

import type { ApiMockState } from './helpers/knowledgeApi';

const apiMock = vi.hoisted(() => ({ transport: false }) as ApiMockState);
vi.mock('../src/services/api', async () =>
  (await import('./helpers/knowledgeApi')).createApiMock(apiMock),
);

type Api = ReturnType<typeof useAiChat>;

function memoryKv(init?: Map<string, string>): Kv {
  const m = init ? new Map(init) : new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => {
      m.set(k, v);
    },
    removeItem: (k) => {
      m.delete(k);
    },
  };
}

function pendingIpc(store: ConversationStore) {
  return {
    savePendingSendsTo: async (conversationId: string, items: ChatSession['pendingSends'] = []) => {
      const meta = store.get(conversationId);
      if (!meta) return;
      store.updateMeta(conversationId, {
        pendingSends: items.length ? [...items] : undefined,
        updatedAt: meta.updatedAt,
      });
    },
  };
}

const msg = (
  id: string,
  content: string,
  role: ChatMessage['role'] = 'user',
  extra: Partial<ChatMessage> = {},
): ChatMessage => ({ id, role, content, timestamp: 1, ...extra });

describe('pendingSendsStore', () => {
  it('写入 / 读回；清掉 localStorage 时元信息里那份还在；撤回后两边都空', async () => {
    const kernel = createMemoryConversationKernel();
    const store = new ConversationStore({ kernel });
    const id = store.create().id;
    const kv = memoryKv();
    const src = { store, ipc: pendingIpc(store), kv };
    const a = openPendingSends(src, pendingKey('nomi', id), id);
    a.save(pendingKey('nomi', id), [{ id: 'p1', text: '排队的一句', mode: 'queue' }]);
    await a.persist('update');
    await store.flush();
    expect(store.get(id)?.pendingSends?.map((x) => x.text)).toEqual(['排队的一句']);

    const fromMeta = openPendingSends(
      { store, ipc: pendingIpc(store), kv: memoryKv() },
      pendingKey('nomi', id),
      id,
    );
    expect(fromMeta.read().map((x) => x.text)).toEqual(['排队的一句']);

    fromMeta.save(pendingKey('nomi', id), []);
    await fromMeta.persist('update');
    await store.flush();
    expect(store.get(id)?.pendingSends).toBeUndefined();
    expect(fromMeta.read()).toEqual([]);
    store.dispose();
  });

  it('agent 标签只写 localStorage；另一组的条目互不影响', async () => {
    const kv = memoryKv();
    const tab = openPendingSends({ kv }, pendingKey('tab', 't1'));
    const other = openPendingSends({ kv }, pendingKey('tab', 't2'));
    tab.save(pendingKey('tab', 't1'), [{ id: 'a', text: '给标签一', mode: 'queue' }]);
    await tab.persist('update');
    expect(other.read()).toEqual([]);
    expect(
      openPendingSends({ kv }, pendingKey('tab', 't1'))
        .read()
        .map((x) => x.text),
    ).toEqual(['给标签一']);
  });
});

describe('useSendQueue 把待发列表存下来、重启后挂回', () => {
  it('忙碌时入列会落盘；换一个 hook（= 重启）后读得回来；删除后不再出现', async () => {
    const kernel = createMemoryConversationKernel();
    const store = new ConversationStore({ kernel });
    const id = store.create().id;
    const kv = memoryKv();
    const src = { store, ipc: pendingIpc(store), kv };
    const key = pendingKey('nomi', id);
    const first = openPendingSends(src, key, id);
    const send = vi.fn();
    const hook = renderHook(({ st }) => useSendQueue(true, send, key, undefined, st), {
      initialProps: { st: first },
    });
    act(() => hook.result.current.enqueue('重启前排队', { mode: 'queue' }));
    await act(async () => {
      await first.persist('update', hook.result.current.items);
    });
    await store.flush();
    const kept = hook.result.current.items[0]!.id;
    hook.unmount();

    const again = openPendingSends(src, key, id);
    const hook2 = renderHook(() => useSendQueue(true, send, key, undefined, again));
    expect(hook2.result.current.items.map((i) => i.text)).toEqual(['重启前排队']);
    expect(hook2.result.current.items[0]!.id).toBe(kept);

    act(() => hook2.result.current.remove(kept));
    await act(async () => {
      await again.persist('update', hook2.result.current.items);
    });
    hook2.unmount();
    expect(openPendingSends(src, key, id).read()).toEqual([]);
    store.dispose();
  });

  it('切换会话只清界面上的列表，别的会话存下的不动', async () => {
    const kernel = createMemoryConversationKernel();
    const store = new ConversationStore({ kernel });
    const a = store.create().id;
    const b = store.create().id;
    const kv = memoryKv();
    const keyA = pendingKey('nomi', a);
    const keyB = pendingKey('nomi', b);
    const storeA = openPendingSends({ store, ipc: pendingIpc(store), kv }, keyA, a);
    const send = vi.fn();
    const hook = renderHook(({ key, st }) => useSendQueue(true, send, key, undefined, st), {
      initialProps: { key: keyA, st: storeA },
    });
    act(() => hook.result.current.enqueue('给 A', { mode: 'queue' }));
    await act(async () => {
      await storeA.persist('update', hook.result.current.items);
    });
    const storeB = openPendingSends({ store, ipc: pendingIpc(store), kv }, keyB, b);
    hook.rerender({ key: keyB, st: storeB });
    expect(hook.result.current.items).toEqual([]);
    expect(
      openPendingSends({ store, ipc: pendingIpc(store), kv }, keyA, a)
        .read()
        .map((x) => x.text),
    ).toEqual(['给 A']);
    hook.unmount();
    store.dispose();
  });
});

describe('已经交给这一轮的插入：补进历史 / 可重试 / 不重复', () => {
  it('withDeliveredSteers 插在原句后面；打断卡的重试 id 仍是原来的用户消息', () => {
    const history = [msg('u1', '原句')];
    const { history: next, added } = withDeliveredSteers(history, {
      reqId: 'req1',
      afterId: 'u1',
      items: [{ id: 's1', text: '中途插入' }],
    });
    expect(added).toHaveLength(1);
    expect(next.map((m) => [m.role, m.steer === true, m.content.includes('中途插入')])).toEqual([
      ['user', false, false],
      ['user', true, true],
    ]);
    const shown = withInterruptedReply(next);
    expect(shown.at(-1)!.id).toBe(`${INTERRUPTED_REPLY_PREFIX}u1`);
    expect(shown.at(-1)!.error).toBeTruthy();
  });

  it('buildProviderMessages：轨迹里的 interject 与补上的用户消息只发一次', () => {
    const history: ChatMessage[] = [
      msg('u1', '原句'),
      msg('s1', `${STEER_TAG}\n\n中途插入`, 'user', { steer: true }),
      msg('a1', '回复', 'assistant', { trace: [{ type: 'interject', text: '中途插入', at: 1 }] }),
    ];
    const out = buildProviderMessages(history, '下一轮');
    const users = out.filter((m) => m.role === 'user').map((m) => m.content);
    expect(users.filter((c) => String(c).includes('中途插入'))).toHaveLength(1);
  });
});

describe('ConversationStore：中途插入走追加；元信息不推进更新时间', () => {
  it('upsertAfter 插在最后一条后面时只追加，不整份 replace', async () => {
    const kernel = createMemoryConversationKernel();
    const store = new ConversationStore({ kernel });
    const id = store.create().id;
    await store.upsert(msg('u1', '原句'), id);
    await store.flush();
    kernel.calls.length = 0;
    const updatedAt = store.get(id)!.updatedAt;
    await store.upsertAfter(msg('s1', '插入', 'user', { steer: true }), id, 'u1');
    await store.flush();
    expect(kernel.calls).not.toContain('replace');
    expect(kernel.calls).toContain('append');
    expect(store.get(id)!.updatedAt).toBe(updatedAt);
    expect(kernel.data.messages.get(id)!.map((m) => m.id)).toEqual(['u1', 's1']);
    store.dispose();
  });

  it('写待发列表 / 已交付的插入只改元信息，不推进更新时间', async () => {
    const kernel = createMemoryConversationKernel();
    const store = new ConversationStore({ kernel });
    const id = store.create().id;
    const updatedAt = store.get(id)!.updatedAt;
    store.updateMeta(id, {
      pendingSends: [{ id: 'p1', text: '排队', mode: 'queue' }],
      deliveredSteers: { reqId: 'r', afterId: 'u1', items: [{ id: 's1', text: '插入' }] },
      updatedAt,
    });
    expect(store.get(id)!.updatedAt).toBe(updatedAt);
    expect(store.get(id)!.pendingSends?.[0]!.text).toBe('排队');
    expect(store.get(id)!.deliveredSteers?.items[0]!.text).toBe('插入');
    store.updateMeta(id, { pendingSends: undefined, deliveredSteers: undefined, updatedAt });
    expect(store.get(id)!.pendingSends).toBeUndefined();
    expect(store.get(id)!.deliveredSteers).toBeUndefined();
    store.dispose();
  });
});

function fakeClient(opts: { hang?: boolean } = {}) {
  let release: (() => void) | undefined;
  const chat = {
    agentStream: vi.fn(() =>
      (async function* () {
        yield { type: 'delta', content: 'ok' };
        if (opts.hang) {
          await new Promise<void>((r) => {
            release = r;
          });
        }
      })(),
    ),
    stream: vi.fn(() => {
      throw new Error('stream() should not be used when agentStream exists');
    }),
    sendMessage: vi.fn(),
    abort: vi.fn(),
    steer: vi.fn(async () => true),
  };
  return {
    chat,
    memory: { userProfile: { get: () => undefined, set: vi.fn() } },
    dispose: vi.fn(),
    release: () => release?.(),
  } as unknown as ClientAIClient & { release: () => void; chat: typeof chat };
}

function mount(client: ClientAIClient) {
  const ref: { api?: Api } = {};
  const Probe = () => {
    ref.api = useAiChat();
    return null;
  };
  const r = render(
    <AiChatContextProvider client={client}>
      <Probe />
    </AiChatContextProvider>,
  );
  return { ref: ref as { api: Api }, unmount: r.unmount };
}

function snapshotKernel(from: ReturnType<typeof createMemoryConversationKernel>) {
  const to = createMemoryConversationKernel();
  const copy = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
  to.data.order.push(...from.data.order);
  for (const [k, v] of from.data.metas) to.data.metas.set(k, copy(v));
  for (const [k, v] of from.data.messages) to.data.messages.set(k, copy(v));
  Object.assign(to.data.previews, copy(from.data.previews));
  to.data.current = from.data.current;
  to.data.lastNomi = from.data.lastNomi;
  to.data.migrated = from.data.migrated;
  return to;
}

const tick = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));
const roles = (list: readonly ChatMessage[]) => list.map((m) => [m.role, m.content, !!m.steer]);

describe('应用在回复中途重启：插入的那句留在对话里；正常结束不重复、不 replace', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    resetPreparedConversationStore();
    vi.restoreAllMocks();
    cleanup();
  });

  it('回复中途插入后重启：它作为用户消息留在原句后面，打断卡仍从原句重试', async () => {
    const kernel = createMemoryConversationKernel();
    await prepareConversationStore({ kernel });
    const first = fakeClient({ hang: true });
    const ui = mount(first);
    await tick();
    const ipc = ui.ref.api.state.ipcClient as SdkIPCClient;
    const A = ipc.conversationStore().create().id;
    ipc.conversationStore().switchTo(A);
    await act(async () => {
      await ui.ref.api.actions.loadChatHistory();
    });
    await act(async () => {
      void ui.ref.api.actions.sendStreamMessage('原句');
      await new Promise((r) => setTimeout(r, 30));
    });
    const ok = await act(async () => ui.ref.api.actions.steerStream('中途插入'));
    expect(ok).toBe(true);
    await ipc.conversationStore().flush();
    expect(
      ipc
        .conversationStore()
        .get(A)
        ?.deliveredSteers?.items.map((x) => x.text),
    ).toEqual(['中途插入']);
    // 进行中不把插入再显示成一条用户消息（轨迹里已有）
    expect(ui.ref.api.state.messages.filter((m) => m.steer)).toEqual([]);

    const disk = snapshotKernel(kernel);
    ui.unmount();
    resetPreparedConversationStore();
    await prepareConversationStore({ kernel: disk });
    const second = mount(fakeClient({ hang: false }));
    await tick();
    const ipc2 = second.ref.api.state.ipcClient as SdkIPCClient;
    await ipc2.switchConversation(A);
    await act(async () => {
      await second.ref.api.actions.loadChatHistory();
    });
    const shown = second.ref.api.state.messages;
    expect(shown.map((m) => m.role)).toEqual(['user', 'user', 'assistant']);
    expect(shown[0]!.content).toBe('原句');
    expect(shown[1]!.steer).toBe(true);
    expect(shown[1]!.content).toContain('中途插入');
    expect(shown[2]!.id).toBe(`${INTERRUPTED_REPLY_PREFIX}${shown[0]!.id}`);
    await ipc2.conversationStore().flush();
    // 提示卡只在界面上；插入已落盘
    expect(disk.data.messages.get(A)!.some((m) => m.steer && m.content.includes('中途插入'))).toBe(
      true,
    );
    expect(disk.data.messages.get(A)!.some((m) => m.role === 'assistant')).toBe(false);

    await act(async () => {
      await second.ref.api.actions.resendFrom(shown[0]!.id);
    });
    await ipc2.conversationStore().flush();
    const saved = disk.data.messages.get(A)!;
    const resent = saved.find((m) => m.role === 'user');
    expect(resent?.content).toContain('原句');
    expect(resent?.content).toContain('中途插入');
  });

  it('正常结束：插入只在回复的轨迹里，元信息清掉，没有整份 replace', async () => {
    const kernel = createMemoryConversationKernel();
    await prepareConversationStore({ kernel });
    const first = fakeClient({ hang: true });
    const ui = mount(first);
    await tick();
    const ipc = ui.ref.api.state.ipcClient as SdkIPCClient;
    const A = ipc.conversationStore().create().id;
    ipc.conversationStore().switchTo(A);
    await act(async () => {
      await ui.ref.api.actions.loadChatHistory();
    });
    await act(async () => {
      void ui.ref.api.actions.sendStreamMessage('原句');
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(await act(async () => ui.ref.api.actions.steerStream('中途插入'))).toBe(true);
    await act(async () => {
      first.release();
      await new Promise((r) => setTimeout(r, 30));
    });
    await ipc.conversationStore().flush();
    expect(ipc.conversationStore().get(A)?.deliveredSteers).toBeUndefined();
    expect(kernel.calls).not.toContain('replace');
    const saved = kernel.data.messages.get(A)!;
    expect(saved.filter((m) => m.steer)).toEqual([]);
    expect(saved.map((m) => m.role)).toEqual(['user', 'assistant']);
    const ai = saved.find((m) => m.role === 'assistant')!;
    expect(ai.content).toBe('ok');
    expect(ai.trace?.some((e) => e.type === 'interject' && e.text === '中途插入')).toBe(true);
    const out = buildProviderMessages(saved, '下一轮');
    expect(
      out.filter((m) => m.role === 'user' && String(m.content).includes('中途插入')),
    ).toHaveLength(1);
  });
});
