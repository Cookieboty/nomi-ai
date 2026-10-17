/**
 * IPCTransportServer 集成测试。
 *
 * 4 关键场景：
 * 1. 同步方法：`ai:sessions:create` 立即返回 Session；
 * 2. 异步方法：`ai:userProfile:set` await 生效并广播 插件事件（间接触发 `userProfile:changed`）；
 * 3. 流式方法：`ai:chat:stream` 返回 `{ ok, reqId }`，且 chunk 通过 sender.send 分发；
 * 4. 权限：`isSenderAllowed=false` 时抛错；`ai:tools:confirm` 通道存在。
 */

import { AIClient } from '@nomi-ai/ai-sdk';
import { LLMRegistryKey, ToolRegistryKey, UserProfileKey } from '@nomi-ai/bundle-ig-base';
import { describe, it, expect } from 'vitest';

import { IPC_METHODS, channelName, chunkChannelName } from '../src/channels';
import { IPCTransportServer } from '../src/IPCTransportServer';
import { NoopRuntimeLogger } from '../src/logger';

import { createFakeIpcAdapter } from './helpers/fakeIpc';
import { createFakeSdkCtx } from './helpers/fakeSdkCtx';
import {
  createFakeLLM,
  createFakeLLMRegistry,
  createFakeProfileService,
  createFakeToolRegistry,
} from './helpers/fakeSeams';

function bootstrap() {
  const ctx = createFakeSdkCtx();
  const llm = createFakeLLM('fake');
  ctx.provide(LLMRegistryKey, createFakeLLMRegistry(llm));
  ctx.provide(ToolRegistryKey, createFakeToolRegistry());
  ctx.provide(UserProfileKey, createFakeProfileService());

  const client = new AIClient(ctx);
  const adapter = createFakeIpcAdapter();
  const server = new IPCTransportServer({ client, adapter, logger: NoopRuntimeLogger });
  server.start();
  return { ctx, client, adapter, server, llm };
}

describe('IPCTransportServer', () => {
  it('registers all IPC_METHODS as ai:<facade>:<method>', () => {
    const { server, adapter } = bootstrap();
    for (const spec of IPC_METHODS) {
      expect(adapter.handlers.has(channelName(spec))).toBe(true);
    }
    expect(server.channels.length).toBe(IPC_METHODS.length);
  });

  it('scenario#1 · sync handler returns session synchronously', async () => {
    const { adapter, client } = bootstrap();
    const s = (await adapter.invoke(10, 'ai:sessions:create', { title: 'hello' })) as {
      id: string;
      title: string;
    };
    expect(s.title).toBe('hello');
    expect(client.sessions.get(s.id)?.title).toBe('hello');
  });

  it('scenario#2 · async userProfile.set awaits and returns patched profile', async () => {
    const { adapter } = bootstrap();
    const p = (await adapter.invoke(10, 'ai:userProfile:set', {
      patch: { identity: { nickname: 'wataru' } },
      source: 'user',
    })) as { identity?: { nickname?: string } };
    expect(p.identity?.nickname).toBe('wataru');
  });

  it('scenario#3 · stream method returns { ok, reqId } and dispatches chunks via sender.send', async () => {
    const { adapter, llm } = bootstrap();
    const ack = (await adapter.invoke(42, 'ai:chat:stream', {
      provider: 'fake',
      messages: [{ role: 'user', content: 'hi' }],
    })) as { ok: true; reqId: string };
    expect(ack.ok).toBe(true);
    expect(typeof ack.reqId).toBe('string');
    expect(llm.streamCalls[0]?.reqId).toBe(ack.reqId);

    // 等 microtask 队列，让 async iterator 消费完
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    const chunkCh = chunkChannelName({ facade: 'chat', method: 'stream' });
    const stream = adapter.senderStreams.get(42) ?? [];
    const onChunk = stream.filter((s) => s.channel === chunkCh);
    expect(onChunk.length).toBeGreaterThanOrEqual(2);
    const last = onChunk[onChunk.length - 1]!.payload as { done: boolean };
    expect(last.done).toBe(true);
  });

  it('窗口中途销毁：停止推送 chunk，并中止上游生成（不抛未处理异常）', async () => {
    const ctx = createFakeSdkCtx();
    const llm = createFakeLLM('fake');
    const gate: { release?: () => void } = {};
    llm.stream = (req) => {
      llm.streamCalls.push(req);
      return (async function* () {
        yield { type: 'delta', content: 'a' } as never;
        await new Promise<void>((r) => (gate.release = r));
        yield { type: 'delta', content: 'b' } as never;
        yield { type: 'delta', content: 'c' } as never;
      })();
    };
    ctx.provide(LLMRegistryKey, createFakeLLMRegistry(llm));
    ctx.provide(ToolRegistryKey, createFakeToolRegistry());
    ctx.provide(UserProfileKey, createFakeProfileService());
    const adapter = createFakeIpcAdapter();
    new IPCTransportServer({
      client: new AIClient(ctx),
      adapter,
      logger: NoopRuntimeLogger,
    }).start();

    const ack = (await adapter.invoke(7, 'ai:chat:stream', {
      provider: 'fake',
      messages: [{ role: 'user', content: 'hi' }],
    })) as { reqId: string };
    await new Promise((r) => setTimeout(r, 5));
    adapter.destroySender(7);
    gate.release?.();
    await new Promise((r) => setTimeout(r, 10));

    const sent = (adapter.senderStreams.get(7) ?? []).map(
      (s) => (s.payload as { value?: { content?: string } }).value?.content,
    );
    expect(sent).toEqual(['a']); // 销毁之后的 b / c / done 都不再发送
    expect(llm.aborted).toContain(ack.reqId);
  });

  it('scenario#4 · isSenderAllowed=false → reject with error', async () => {
    const ctx = createFakeSdkCtx();
    ctx.provide(LLMRegistryKey, createFakeLLMRegistry(createFakeLLM()));
    ctx.provide(ToolRegistryKey, createFakeToolRegistry());
    ctx.provide(UserProfileKey, createFakeProfileService());
    const client = new AIClient(ctx);
    const adapter = createFakeIpcAdapter();
    const server = new IPCTransportServer({
      client,
      adapter,
      logger: NoopRuntimeLogger,
      isSenderAllowed: (_, spec) => spec.dangerous !== true, // 拒绝所有 dangerous
    });
    server.start();

    await expect(
      adapter.invoke(1, 'ai:tools:confirm', { reqId: 'x', decision: 'allow' }),
    ).rejects.toThrow(/not allowed/);
    // 非 dangerous 通道正常
    const list = await adapter.invoke(1, 'ai:sessions:list');
    expect(Array.isArray(list)).toBe(true);
  });

  it('stop() removes all handlers', () => {
    const { server, adapter } = bootstrap();
    server.stop();
    for (const spec of IPC_METHODS) {
      expect(adapter.handlers.has(channelName(spec))).toBe(false);
    }
  });
});
