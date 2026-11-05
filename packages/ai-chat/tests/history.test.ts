import { describe, expect, it, vi } from 'vitest';

import { createMemoryConversationKernel } from '../src/services/conversationKernel';
import { ConversationStore } from '../src/services/conversationStore';
import { buildProviderMessages } from '../src/services/history';
import { SdkIPCClient } from '../src/services/IPCClient';
import { armNomiAutoTitle, nomiAutoTitlePending } from '../src/services/sessionTitle';
import type { ChatMessage } from '../src/types/chat';

const msg = (
  id: string,
  role: ChatMessage['role'],
  content: string,
  extra: Partial<ChatMessage> = {},
) => ({ id, role, content, timestamp: Number(id), ...extra }) as ChatMessage;

describe('buildProviderMessages', () => {
  it('上一轮生成的图片、用户存进素材库的图片：以地址附在消息后面，下一轮能拿来改图', () => {
    const gen = (url: string) => ({
      type: 'tool' as const,
      name: 'image_generate',
      status: 'done' as const,
      id: url,
      output: JSON.stringify({ image: url, model: 'm' }),
    });
    const history = [
      msg('1', 'user', '画一只猫', {
        images: [{ thumb: 'data:x', width: 1, height: 1, url: 'chat-asset://images/user-a.png' }],
      }),
      msg('2', 'assistant', '画好了', { trace: [gen('chat-asset://images/nomi-1.png')] }),
      // 只有图、没有正文的回复也要保留
      msg('3', 'assistant', '', { trace: [gen('chat-asset://images/nomi-2.png')] }),
      // 失败的生图不算
      msg('4', 'assistant', '没画成', {
        trace: [{ type: 'tool', name: 'image_generate', status: 'error', id: 'x', output: 'err' }],
      }),
    ];
    const out = buildProviderMessages(history, '把背景改成蓝色');
    expect(out[0]!.content).toContain('chat-asset://images/user-a.png');
    expect(out[1]!.content).toMatch(
      /^画好了\n\n\[Image links.*chat-asset:\/\/images\/nomi-1\.png\]$/,
    );
    expect(out[2]!.content).toContain('chat-asset://images/nomi-2.png');
    expect(out[3]!.content).toBe('没画成');
  });

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
  const mk = (kernel?: ReturnType<typeof createMemoryConversationKernel>) => {
    let n = 0;
    return new ConversationStore({ kernel, now: () => 1000 + n, newId: () => `c${++n}` });
  };

  it('persists messages per conversation and supports switching / clearing', async () => {
    const kernel = createMemoryConversationKernel();
    const s = mk(kernel);
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

    // 新实例读同一内核（模拟重启）
    await s.flush();
    const reopened = new ConversationStore({ kernel, snapshot: await kernel.state() });
    expect(reopened.currentId()).toBe(first);
    expect((await reopened.loadMessages(second))[0]!.content).toBe('other');
    expect(await reopened.loadMessages(first)).toEqual([]);
  });

  it('keeps heuristic name when smart title is skipped; applySmart only while pending', () => {
    const s = mk();
    const id = s.ensureCurrent();
    s.append(msg('1', 'user', 'hello from nomi first message'));
    expect(s.get(id)!.name.startsWith('hello from nomi')).toBe(true);
  });

  it('attachments-only first message leaves default name', () => {
    const s = mk();
    const id = s.ensureCurrent();
    const defaultName = s.get(id)!.name;
    s.append(msg('1', 'user', '<attached-file name="a.ts" />'));
    expect(s.get(id)!.name).toBe(defaultName);
  });

  it('clears smart-title pending when conversation is deleted', () => {
    const s = mk();
    const id = s.ensureCurrent();
    armNomiAutoTitle(id);
    expect(nomiAutoTitlePending(id)).toBe(true);
    s.delete(id);
    expect(nomiAutoTitlePending(id)).toBe(false);
  });

  it('caches loaded messages until the conversation is changed', async () => {
    const kernel = createMemoryConversationKernel();
    await kernel.put({
      meta: { id: 'c1', name: 'cached', createdAt: 1, updatedAt: 1, backend: 'nomi' },
      messages: [msg('1', 'user', 'hello')],
    });
    const s = new ConversationStore({ kernel, snapshot: await kernel.state() });
    kernel.calls.length = 0;

    expect(await s.loadMessages('c1')).toHaveLength(1);
    expect(kernel.calls).toEqual(['messages']);
    expect(s.getMessages('c1')).toHaveLength(1);
    expect(await s.loadMessages('c1')).toHaveLength(1);
    expect(kernel.calls).toEqual(['messages']);

    s.append(msg('2', 'assistant', 'world'), 'c1');
    expect(s.getMessages('c1').map((m) => m.content)).toEqual(['hello', 'world']);
  });

  it('evicts old message caches, keeps the current one, and previews without caching', async () => {
    const kernel = createMemoryConversationKernel();
    let n = 0;
    const s = new ConversationStore({
      kernel,
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
    await s.flush();

    kernel.calls.length = 0;
    expect(s.getMessages(c).map((m) => m.content)).toEqual(['gamma']);
    expect(s.getMessages(b).map((m) => m.content)).toEqual(['beta']);
    // a 被淘汰：同步读是空的，要加载
    expect(s.isLoaded(a)).toBe(false);
    expect((await s.loadMessages(a)).map((m) => m.content)).toEqual(['alpha message']);
    expect(kernel.calls).toEqual(['messages']);

    kernel.calls.length = 0;
    // 预览随追加记下：不用再读这段历史
    expect(s.firstUserPreview(b)).toBe('beta');
    expect(kernel.calls).toEqual([]);
  });

  it('trims to maxMessages', async () => {
    const kernel = createMemoryConversationKernel();
    const s = new ConversationStore({ kernel, maxMessages: 3 });
    const id = s.ensureCurrent();
    s.setMessages(id, [msg('1', 'user', 'old'), msg('2', 'assistant', 'reply')]);
    s.append(msg('3', 'user', 'a'));
    s.append(msg('4', 'user', 'b'));
    expect(s.getMessages().map((m) => m.content)).toEqual(['reply', 'a', 'b']);
    await s.flush();
    expect(kernel.data.messages.get(id)!.map((m) => m.content)).toEqual(['reply', 'a', 'b']);
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
    const s = new ConversationStore({
      snapshot: {
        conversations: [
          { id: 'old1', name: 'legacy', createdAt: 1, updatedAt: 2 } as never,
          {
            id: 'old2',
            name: 'claude one',
            createdAt: 1,
            updatedAt: 3,
            backend: 'claude',
            tabId: 't1',
          },
        ],
        previews: {},
        counts: { old1: 1, old2: 0 },
        migrated: true,
      },
    });
    expect(s.get('old1')!.backend).toBe('nomi');
    expect(s.get('old2')!.backend).toBe('claude');
    expect(s.get('old2')!.tabId).toBe('t1');
    expect(s.listByBackend('nomi').map((c) => c.id)).toEqual(['old1']);
  });

  it('creates with backend, forks same-backend, and upserts CLI tabs', () => {
    let n = 0;
    const s = new ConversationStore({
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
    // 默认系统提示由内核拼装（契约 persona.systemPrompt）；这里替身直接给出
    const ipc = new SdkIPCClient(client as never, {
      defaultSystemPrompt: async () => 'You are Pip, a paper robot.',
    });
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
      { role: 'system', content: expect.stringContaining('You are Pip, a paper robot.') },
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'q2' },
    ]);
    expect(
      (stream!.opts.messages as Array<{ content: string }>).map((m) => m.content).slice(1),
    ).toEqual(['q1', 'a1', 'q2', 'reply', 'q3']);
  });
});
