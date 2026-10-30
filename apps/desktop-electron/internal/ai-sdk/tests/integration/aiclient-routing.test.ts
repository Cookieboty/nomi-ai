/**
 * ChatFacade · 多 provider 路由：registry.resolve(role) 决定默认 provider 与模型。
 */
import { LLMRegistryKey, type LLMProvider, type LLMRole } from '@nomi-ai/bundle-ig-base';
import { describe, expect, it } from 'vitest';

import { AIClient } from '../../src/AIClient';
import { createFakeSdkCtx } from '../helpers/fakeSdkCtx';
import { createFakeLLM } from '../helpers/fakeSeams';

describe('AIClient · provider routing', () => {
  it('uses resolve(role) when no provider is given; explicit id wins', async () => {
    const a = createFakeLLM('a');
    const b = createFakeLLM('b');
    const roles: Array<LLMRole | undefined> = [];
    const ctx = createFakeSdkCtx();
    ctx.provide(LLMRegistryKey, {
      register() {},
      get: (id: string) => ({ a, b })[id as 'a' | 'b'] as LLMProvider | undefined,
      list: () => [a, b],
      resolve(role?: LLMRole) {
        roles.push(role);
        return role === 'agent-tools' ? { provider: b, model: 'tool-model' } : { provider: b };
      },
    });
    const client = new AIClient(ctx);
    await client.chat.sendMessage({ messages: [{ role: 'user', content: 'x' }] });
    expect(b.chatCalls).toHaveLength(1);
    await client.chat.agent({ messages: [{ role: 'user', content: 'x' }] });
    expect(b.chatCalls[1]!.model).toBe('tool-model');
    await client.chat.sendMessage({ role: 'summary', messages: [{ role: 'user', content: 'x' }] });
    expect(roles).toEqual(['chat', 'agent-tools', 'summary']);
    await client.chat.sendMessage({ provider: 'a', messages: [{ role: 'user', content: 'x' }] });
    expect(a.chatCalls).toHaveLength(1);
    await client.dispose();
  });
});

describe('AIClient · abort reaches the provider that is actually running (#92)', () => {
  /** 流在 abort 前一直挂着；abort 记录 reqId 并结束流 */
  const slowLLM = (id: string) => {
    const aborted: string[] = [];
    let wake: () => void = () => undefined;
    const p: LLMProvider & { aborted: string[] } = {
      id,
      aborted,
      async chat() {
        await new Promise<void>((r) => (wake = r));
        return { reqId: 'x', provider: id, model: 'm', content: '', finishReason: 'stop' } as never;
      },
      async *stream() {
        yield { type: 'delta', content: 'hi' } as never;
        await new Promise<void>((r) => (wake = r));
      },
      abort(reqId: string) {
        aborted.push(reqId);
        wake();
      },
    } as never;
    return p;
  };

  it('stream: the routed instance was replaced in the registry, abort still reaches it', async () => {
    const old = slowLLM('gw-old');
    const fresh = slowLLM('gw-new');
    let current: LLMProvider = old;
    const ctx = createFakeSdkCtx();
    ctx.provide(LLMRegistryKey, {
      register() {},
      get: () => undefined,
      list: () => [current],
      resolve: () => ({ provider: current }),
    });
    const client = new AIClient(ctx);
    const stream = client.chat.agentStream({
      reqId: 'r1',
      messages: [{ role: 'user', content: 'x' }],
    });
    const it = stream[Symbol.asyncIterator]();
    expect((await it.next()).value).toMatchObject({ type: 'delta' });
    // 另一个角色的请求把网关单槽缓存换成了新实例
    current = fresh;
    const done = it.next();
    client.chat.abort('r1');
    await done;
    expect(old.aborted).toEqual(['r1']);
    // 结束后释放：之后的 abort 只按当前路由兜底
    client.chat.abort('r1');
    expect(old.aborted).toEqual(['r1']);
    await client.dispose();
  });

  it('sendMessage: abort reaches the instance even after the registry moved on', async () => {
    const old = slowLLM('gw-old');
    let current: LLMProvider = old;
    const ctx = createFakeSdkCtx();
    ctx.provide(LLMRegistryKey, {
      register() {},
      get: () => undefined,
      list: () => [current],
      resolve: () => ({ provider: current }),
    });
    const client = new AIClient(ctx);
    const run = client.chat.sendMessage({
      reqId: 'r2',
      role: 'summary',
      messages: [{ role: 'user', content: 'x' }],
    });
    current = slowLLM('gw-new');
    await Promise.resolve();
    client.chat.abort('r2');
    await run;
    expect(old.aborted).toEqual(['r2']);
    await client.dispose();
  });
});
