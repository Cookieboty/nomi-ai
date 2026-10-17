import { describe, expect, it } from 'vitest';

import { AI_EVENT_CHANNEL, chunkChannelName, IPC_METHODS, channelName } from '../src/channels';
import { ClientAIClient } from '../src/ClientAIClient';
import { SDKError, SDKErrorCodes } from '../src/errors';

import { FakeBridge } from './FakeBridge';

describe('ClientAIClient · IPC 通道映射', () => {
  it('sync-return 方法直接路由到 invoke，且返回原样', async () => {
    const bridge = new FakeBridge();
    bridge.handle('ai:sessions:list', () => [{ id: 'a' }]);
    const client = new ClientAIClient({ bridge });

    const sessions = client.sessions as { list: () => Promise<unknown> };
    await expect(sessions.list()).resolves.toEqual([{ id: 'a' }]);
    expect(bridge.invokeLog[0]?.channel).toBe('ai:sessions:list');
  });

  it('未在白名单里的 method 返回 undefined，调用会抛 TypeError', () => {
    const client = new ClientAIClient({ bridge: new FakeBridge() });
    const chat = client.chat as { nonexistent?: () => void };
    expect(chat.nonexistent).toBeUndefined();
    expect(() => (chat.nonexistent as () => void)()).toThrowError();
  });

  it('memory.userProfile 走扁平化 userProfile 通道', async () => {
    const bridge = new FakeBridge();
    bridge.handle('ai:userProfile:get', () => ({ id: 'u1', nickname: 'nya' }));
    const client = new ClientAIClient({ bridge });
    const profile = client.memory.userProfile as { get: () => Promise<unknown> };
    await expect(profile.get()).resolves.toEqual({ id: 'u1', nickname: 'nya' });
  });

  it('chat.stream 迭代 chunk，直到 done', async () => {
    const bridge = new FakeBridge();
    const specStream = IPC_METHODS.find((s) => s.facade === 'chat' && s.method === 'stream');
    if (!specStream) throw new Error('stream spec not found');
    const chunkCh = chunkChannelName(specStream);
    bridge.handle(channelName(specStream), async (opts) => {
      const reqId = (opts as { reqId?: string })?.reqId ?? 'auto';
      queueMicrotask(() => {
        bridge.emit(chunkCh, { reqId, done: false, value: { deltaText: 'hi ' } });
        bridge.emit(chunkCh, { reqId, done: false, value: { deltaText: 'nya' } });
        bridge.emit(chunkCh, { reqId, done: true });
      });
      return { ok: true, reqId };
    });

    const client = new ClientAIClient({ bridge });
    const chat = client.chat as { stream: (o: unknown) => AsyncIterable<unknown> };
    const collected: unknown[] = [];
    for await (const chunk of chat.stream({ reqId: 'r1', messages: [] })) {
      collected.push(chunk);
    }
    expect(collected).toEqual([{ deltaText: 'hi ' }, { deltaText: 'nya' }]);
  });

  it('chat.stream 被消费方提前放弃（return）时通知主进程 ai:chat:abort，并唤醒挂起的 next()', async () => {
    const bridge = new FakeBridge();
    const specStream = IPC_METHODS.find((s) => s.facade === 'chat' && s.method === 'stream')!;
    const chunkCh = chunkChannelName(specStream);
    bridge.handle(channelName(specStream), async () => ({ ok: true }));
    const aborted: unknown[] = [];
    bridge.handle('ai:chat:abort', (id) => {
      aborted.push(id);
    });
    const client = new ClientAIClient({ bridge });
    const chat = client.chat as { stream: (o: unknown) => AsyncIterable<unknown> };
    const it = chat.stream({ reqId: 'r-abort', messages: [] })[Symbol.asyncIterator]();
    bridge.emit(chunkCh, { reqId: 'r-abort', done: false, value: { n: 1 } });
    await expect(it.next()).resolves.toEqual({ value: { n: 1 }, done: false });
    const pending = it.next(); // 挂起：没有更多 chunk
    await it.return?.();
    await expect(pending).resolves.toEqual({ value: undefined, done: true });
    await Promise.resolve();
    expect(aborted).toEqual(['r-abort']);
  });

  it('chat.stream 自然结束后 return() 不再发 abort', async () => {
    const bridge = new FakeBridge();
    const specStream = IPC_METHODS.find((s) => s.facade === 'chat' && s.method === 'stream')!;
    const chunkCh = chunkChannelName(specStream);
    bridge.handle(channelName(specStream), async () => {
      queueMicrotask(() => bridge.emit(chunkCh, { reqId: 'r-ok', done: true }));
      return { ok: true };
    });
    bridge.handle('ai:chat:abort', () => undefined);
    const client = new ClientAIClient({ bridge });
    const chat = client.chat as { stream: (o: unknown) => AsyncIterable<unknown> };
    const it = chat.stream({ reqId: 'r-ok', messages: [] })[Symbol.asyncIterator]();
    await expect(it.next()).resolves.toMatchObject({ done: true });
    await it.return?.();
    expect(bridge.invokeLog.some((c) => c.channel === 'ai:chat:abort')).toBe(false);
  });

  it('stream 结束时如带 error，则 iterator 抛 SDKError', async () => {
    const bridge = new FakeBridge();
    const spec = IPC_METHODS.find((s) => s.facade === 'tts' && s.method === 'stream');
    if (!spec) throw new Error('tts stream spec missing');
    const chunkCh = chunkChannelName(spec);
    bridge.handle(channelName(spec), async (opts) => {
      const reqId = (opts as { reqId?: string }).reqId ?? 'auto';
      queueMicrotask(() => bridge.emit(chunkCh, { reqId, done: true, error: 'boom' }));
      return { ok: true, reqId };
    });
    const client = new ClientAIClient({ bridge });
    const tts = client.tts as { stream: (o: unknown) => AsyncIterable<unknown> };
    const iter = tts.stream({ reqId: 'r2', text: 'x' })[Symbol.asyncIterator]();
    await expect(iter.next()).rejects.toBeInstanceOf(SDKError);
  });

  it('ai:event 单一入口二次分发到 on(evt)', () => {
    const bridge = new FakeBridge();
    const client = new ClientAIClient({ bridge });
    const seen: unknown[] = [];
    client.on('agent:step', (p) => seen.push(p));
    bridge.emit(AI_EVENT_CHANNEL, { evt: 'agent:step', data: { step: 1 } });
    bridge.emit(AI_EVENT_CHANNEL, { evt: 'irrelevant', data: 'x' });
    expect(seen).toEqual([{ step: 1 }]);
  });

  it('IPC 抛错通过 SDKError.fromIpc 还原 code', async () => {
    const bridge = new FakeBridge();
    bridge.handle('ai:tools:list', () => {
      throw new Error('[TOOL_NOT_FOUND] tool `x` missing');
    });
    const client = new ClientAIClient({ bridge });
    const tools = client.tools as { list: () => Promise<unknown> };
    await expect(tools.list()).rejects.toMatchObject({
      name: 'SDKError',
      code: SDKErrorCodes.TOOL_NOT_FOUND,
    });
  });

  it('dispose 后调用 on 抛出 DISPOSED', async () => {
    const client = new ClientAIClient({ bridge: new FakeBridge() });
    await client.dispose();
    expect(() => client.on('agent:step', () => undefined)).toThrowError(SDKError);
  });

  it('live2d.isAvailable 使用本地缓存', () => {
    const bridge = new FakeBridge();
    const client = new ClientAIClient({ bridge, live2dAvailable: true });
    const l = client.live2d as { isAvailable: () => boolean };
    expect(l.isAvailable()).toBe(true);
  });
});
