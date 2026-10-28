import {
  createIpcServerTransport,
  type IpcInvokeEventLike,
  type IpcMainLike,
} from '@nomi-ai/contract';
import { describe, expect, it } from 'vitest';

import { ClientAIClient } from '../src/ClientAIClient';
import { SDKError, SDKErrorCodes } from '../src/errors';
import type { IPCBridge } from '../src/IPCBridge';

import { createFakeServer, flush, makeProfile } from './fakeServer';

type StreamFn = (...a: unknown[]) => AsyncIterable<unknown>;

const session = { id: 'a', title: 't', createdAt: 1, updatedAt: 1 };

describe('ClientAIClient · 门面 → 契约过程', () => {
  it('无参方法调用对应过程，返回值原样', async () => {
    const server = createFakeServer({ 'ai.sessions.list': () => [session] });
    const client = new ClientAIClient({ transport: server.connect() });
    const sessions = client.sessions as { list: () => Promise<unknown> };
    await expect(sessions.list()).resolves.toEqual([session]);
    expect(server.calls.map((c) => c.name)).toEqual(['ai.sessions.list']);
  });

  it('位置参数按 AI_METHODS 打包成具名入参', async () => {
    const server = createFakeServer({
      'ai.sessions.rename': (input) => ({ ...session, title: (input as { title: string }).title }),
      'ai.tools.confirm': () => undefined,
      'ai.avatar.playMotion': () => undefined,
    });
    const client = new ClientAIClient({ transport: server.connect() });
    const sessions = client.sessions as { rename: (id: string, t: string) => Promise<unknown> };
    await expect(sessions.rename('a', 'new')).resolves.toMatchObject({ title: 'new' });
    const tools = client.tools as { confirm: (...a: unknown[]) => Promise<void> };
    await tools.confirm('c1', false, 'nope');
    const avatar = client.avatar as { playMotion: (g: string) => Promise<void> };
    await avatar.playMotion('idle');
    expect(server.calls.map((c) => c.input)).toEqual([
      { id: 'a', title: 'new' },
      { reqId: 'c1', ok: false, reason: 'nope' },
      { group: 'idle' },
    ]);
  });

  it('不在契约里的方法返回 undefined，调用即抛 TypeError', () => {
    const client = new ClientAIClient({ transport: createFakeServer().connect() });
    const chat = client.chat as { nonexistent?: () => void };
    expect(chat.nonexistent).toBeUndefined();
    expect('stream' in client.chat).toBe(true);
    expect(() => (chat.nonexistent as () => void)()).toThrowError();
  });

  it('memory.userProfile 走 ai.memory.userProfile.*', async () => {
    const server = createFakeServer({
      'ai.memory.userProfile.get': () => makeProfile({ chat: { x: 1 } }),
    });
    const client = new ClientAIClient({ transport: server.connect() });
    const profile = client.memory.userProfile as { get: () => Promise<unknown> };
    // 顶层 loose：视图写进画像的额外字段原样返回
    await expect(profile.get()).resolves.toMatchObject({ version: 1, chat: { x: 1 } });
  });

  it('内核抛出的 [CODE] 错误还原成 SDKError', async () => {
    const server = createFakeServer({
      'ai.tools.list': () => {
        throw new Error('[TOOL_NOT_FOUND] tool `x` missing');
      },
    });
    const client = new ClientAIClient({ transport: server.connect() });
    const tools = client.tools as { list: () => Promise<unknown> };
    await expect(tools.list()).rejects.toMatchObject({
      name: 'SDKError',
      code: SDKErrorCodes.TOOL_NOT_FOUND,
    });
  });

  it('入参不合契约：本地校验失败，SDKError(IPC_ERROR)，不发到内核', async () => {
    const server = createFakeServer({ 'ai.sessions.get': () => undefined });
    const client = new ClientAIClient({ transport: server.connect() });
    const sessions = client.sessions as { get: (id: unknown) => Promise<unknown> };
    await expect(sessions.get(42)).rejects.toMatchObject({ code: SDKErrorCodes.IPC_ERROR });
    expect(server.calls).toHaveLength(0);
  });

  it('dangerous：不可信调用者调 tools.confirm 被拒', async () => {
    const server = createFakeServer({ 'ai.tools.confirm': () => undefined });
    const client = new ClientAIClient({
      transport: server.connect({ surface: 'chat', trusted: false }),
    });
    const tools = client.tools as { confirm: (...a: unknown[]) => Promise<void> };
    await expect(tools.confirm('c1', true)).rejects.toMatchObject({
      code: SDKErrorCodes.IPC_ERROR,
      message: expect.stringContaining('FORBIDDEN'),
    });
    expect(server.calls).toHaveLength(0);
  });

  it('avatar.isAvailable 使用本地缓存', () => {
    const client = new ClientAIClient({
      transport: createFakeServer().connect(),
      avatarAvailable: true,
    });
    expect((client.avatar as { isAvailable: () => boolean }).isAvailable()).toBe(true);
  });

  it('dispose 后调用 on / 方法抛出 DISPOSED', async () => {
    const client = new ClientAIClient({ transport: createFakeServer().connect() });
    await client.dispose();
    expect(() => client.on('agent:step', () => undefined)).toThrowError(SDKError);
    const sessions = client.sessions as { list: () => Promise<unknown> };
    await expect(sessions.list()).rejects.toMatchObject({ code: SDKErrorCodes.DISPOSED });
  });
});

describe('ClientAIClient · 流', () => {
  it('chat.stream 迭代 chunk 直到结束；没有 reqId 时生成并写回选项', async () => {
    const server = createFakeServer({
      'ai.chat.stream': async function* () {
        yield { type: 'delta', content: 'hi ' };
        yield { type: 'delta', content: 'nya' };
      },
    });
    const client = new ClientAIClient({ transport: server.connect() });
    const opts: { messages: unknown[]; reqId?: string } = { messages: [] };
    const collected: unknown[] = [];
    for await (const chunk of (client.chat as { stream: StreamFn }).stream(opts)) {
      collected.push(chunk);
    }
    expect(collected).toEqual([
      { type: 'delta', content: 'hi ' },
      { type: 'delta', content: 'nya' },
    ]);
    expect(typeof opts.reqId).toBe('string');
    expect((server.calls[0]!.input as { reqId: string }).reqId).toBe(opts.reqId);
  });

  it('消费方提前 return：取消契约流（内核的 ctx.signal 触发），挂起的 next() 以 done 结束', async () => {
    let cancelled = false;
    const server = createFakeServer({
      'ai.chat.stream': async function* (_input, ctx) {
        yield { type: 'delta', content: 'a' };
        await new Promise<void>((r) => ctx.signal.addEventListener('abort', () => r()));
        cancelled = true;
      },
    });
    const client = new ClientAIClient({ transport: server.connect() });
    const stream = (client.chat as { stream: StreamFn }).stream({ reqId: 'r-abort', messages: [] });
    const it = stream[Symbol.asyncIterator]();
    await expect(it.next()).resolves.toEqual({
      value: { type: 'delta', content: 'a' },
      done: false,
    });
    const pending = it.next(); // 挂起：没有更多 chunk
    await it.return?.();
    await expect(pending).resolves.toEqual({ value: undefined, done: true });
    await flush();
    expect(cancelled).toBe(true);
  });

  it('chat 选项里的 signal 不跨进程，作为这条流的取消信号', async () => {
    let cancelled = false;
    let sawSignal = true;
    const server = createFakeServer({
      'ai.chat.agentStream': async function* (input, ctx) {
        sawSignal = 'signal' in (input as object);
        yield { type: 'delta', content: 'a' };
        await new Promise<void>((r) => ctx.signal.addEventListener('abort', () => r()));
        cancelled = true;
      },
    });
    const client = new ClientAIClient({ transport: server.connect() });
    const ctrl = new AbortController();
    const stream = (client.chat as { agentStream: StreamFn }).agentStream({
      messages: [],
      signal: ctrl.signal,
    });
    const it = stream[Symbol.asyncIterator]();
    await it.next();
    ctrl.abort();
    await expect(it.next()).resolves.toMatchObject({ done: true });
    await flush();
    expect(sawSignal).toBe(false);
    expect(cancelled).toBe(true);
  });

  it('内核报错：已收到的 chunk 先排空，再抛 SDKError(IPC_STREAM_ABORTED)', async () => {
    const server = createFakeServer({
      'ai.tts.stream': async function* () {
        yield { reqId: 'r', seq: 0, mime: 'audio/mp3', data: new Uint8Array([1]) };
        throw new Error('boom');
      },
    });
    const client = new ClientAIClient({ transport: server.connect() });
    const iter = (client.tts as { stream: StreamFn }).stream('x')[Symbol.asyncIterator]();
    const first = await iter.next();
    expect((first.value as { data: unknown }).data).toBeInstanceOf(Uint8Array);
    await expect(iter.next()).rejects.toMatchObject({
      code: SDKErrorCodes.IPC_STREAM_ABORTED,
      message: expect.stringContaining('boom'),
    });
    expect(server.calls[0]!.input).toEqual({ text: 'x' });
  });

  it('dispose：唤醒挂起的 next()，并取消所有进行中的流', async () => {
    const cancelled: string[] = [];
    const server = createFakeServer({
      'ai.chat.stream': async function* (input, ctx) {
        yield { type: 'delta', content: 'x' };
        await new Promise<void>((r) => ctx.signal.addEventListener('abort', () => r()));
        cancelled.push((input as { reqId: string }).reqId);
      },
    });
    const client = new ClientAIClient({ transport: server.connect() });
    const chat = client.chat as { stream: StreamFn };
    const a = chat.stream({ reqId: 'd1', messages: [] })[Symbol.asyncIterator]();
    const b = chat.stream({ reqId: 'd2', messages: [] })[Symbol.asyncIterator]();
    await a.next();
    await b.next();
    const pending = a.next();
    await client.dispose();
    await expect(pending).resolves.toEqual({ value: undefined, done: true });
    await flush();
    expect(cancelled.sort()).toEqual(['d1', 'd2']);
  });

  it('并发流互不影响：一条结束不影响另一条继续收 chunk', async () => {
    const gate: { release?: () => void } = {};
    const server = createFakeServer({
      'ai.chat.stream': async function* (input) {
        if ((input as { reqId: string }).reqId === 'c1') return;
        await new Promise<void>((r) => (gate.release = r));
        yield { type: 'delta', content: 'still' };
      },
    });
    const client = new ClientAIClient({ transport: server.connect() });
    const chat = client.chat as { stream: StreamFn };
    const one = chat.stream({ reqId: 'c1', messages: [] })[Symbol.asyncIterator]();
    const two = chat.stream({ reqId: 'c2', messages: [] })[Symbol.asyncIterator]();
    await expect(one.next()).resolves.toMatchObject({ done: true });
    await flush();
    gate.release?.();
    await expect(two.next()).resolves.toEqual({
      value: { type: 'delta', content: 'still' },
      done: false,
    });
  });
});

describe('ClientAIClient · 事件', () => {
  it('on(evt) 按需订阅对应的契约事件；无关事件名不会触发', async () => {
    const server = createFakeServer();
    const client = new ClientAIClient({ transport: server.connect() });
    const seen: unknown[] = [];
    const off = client.on('agent:step', (p) => seen.push(p));
    client.on('irrelevant', (p) => seen.push(p));
    await flush();
    server.publish('ai.agent.step', { step: 1 });
    server.publish('ai.tts.end', { reqId: 'r' });
    await flush();
    expect(seen).toEqual([{ step: 1 }]);

    off();
    await flush();
    server.publish('ai.agent.step', { step: 2 });
    await flush();
    expect(seen).toHaveLength(1);
  });

  it('avatar.on / userProfile.subscribe 映射到 avatar:* / userProfile:changed', async () => {
    const server = createFakeServer();
    const client = new ClientAIClient({ transport: server.connect() });
    const touches: unknown[] = [];
    const profiles: unknown[] = [];
    (client.avatar as { on: (e: string, f: (p: unknown) => void) => void }).on('touch', (p) =>
      touches.push(p),
    );
    (client.memory.userProfile as { subscribe: (f: (p: unknown) => void) => void }).subscribe((p) =>
      profiles.push(p),
    );
    await flush();
    server.publish('ai.avatar.touch', { hitArea: 'head', at: 1 });
    server.publish('ai.userProfile.changed', { profile: { version: 2 } });
    server.publish('ai.userProfile.changed', { version: 3 });
    await flush();
    expect(touches).toEqual([{ hitArea: 'head', at: 1 }]);
    expect(profiles).toEqual([{ version: 2 }, { version: 3 }]);
  });

  it('dispose 释放订阅与连接', async () => {
    const server = createFakeServer({ 'ai.sessions.list': () => [] });
    const client = new ClientAIClient({ transport: server.connect() });
    const seen: unknown[] = [];
    client.on('tts:end', (p) => seen.push(p));
    await (client.sessions as { list: () => Promise<unknown> }).list();
    await client.dispose();
    await flush();
    server.publish('ai.tts.end', { reqId: 'late' });
    await flush();
    expect(seen).toEqual([]);
  });
});

describe('ClientAIClient · IPC 桥（window.nomiTransport 的形状）', () => {
  it('bridge 选项经 contract:request / contract:frame 两个通道访问内核', async () => {
    const server = createFakeServer({ 'ai.sessions.list': () => [session] });
    // 模拟 ipcMain + preload：一条渲染窗口连接
    let handler: ((e: IpcInvokeEventLike, ...a: unknown[]) => unknown) | undefined;
    const frameListeners = new Set<(p: unknown) => void>();
    const ipcMain: IpcMainLike = {
      handle: (_ch, h) => {
        handler = h;
      },
      removeHandler: () => {
        handler = undefined;
      },
    };
    const transport = createIpcServerTransport(ipcMain, {
      resolveCaller: () => ({ surface: 'chat', trusted: true }),
    });
    transport.serve(server.router);
    const channels: string[] = [];
    const bridge: IPCBridge = {
      invoke: async <T>(channel: string, ...args: unknown[]) => {
        channels.push(channel);
        const event: IpcInvokeEventLike = {
          senderId: 1,
          send: (_ch, payload) => queueMicrotask(() => frameListeners.forEach((f) => f(payload))),
        };
        return handler!(event, ...args) as T;
      },
      on: (channel, fn) => {
        channels.push(channel);
        frameListeners.add(fn as (p: unknown) => void);
        return () => frameListeners.delete(fn as (p: unknown) => void);
      },
    };
    const client = new ClientAIClient({ bridge });
    await expect((client.sessions as { list: () => Promise<unknown> }).list()).resolves.toEqual([
      session,
    ]);
    expect(new Set(channels)).toEqual(new Set(['contract:request', 'contract:frame']));
  });

  it('默认读 window.nomiTransport：用到时才读，缺失时调用以 BRIDGE_MISSING 失败、订阅不生效', async () => {
    const client = new ClientAIClient();
    expect(() => client.on('agent:step', () => undefined)).not.toThrow();
    const sessions = client.sessions as { list: () => Promise<unknown> };
    await expect(sessions.list()).rejects.toMatchObject({
      code: SDKErrorCodes.BRIDGE_MISSING,
      message: expect.stringContaining('nomiTransport'),
    });
    const stream = (client.chat as { stream: StreamFn }).stream({ messages: [] });
    await expect(stream[Symbol.asyncIterator]().next()).rejects.toMatchObject({
      code: SDKErrorCodes.BRIDGE_MISSING,
    });
  });
});
