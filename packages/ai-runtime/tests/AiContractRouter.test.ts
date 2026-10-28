/**
 * createAiRouter 集成测试：AIClient → appContract router → in-process 传输 → createClient。
 *
 * 覆盖原 IPCTransportServer / EventBroadcaster 的行为：
 * - 同步 / 异步门面方法、位置参数在服务端还原；
 * - 流：chunk 顺序、16 ms 文本合批、外发检查（prepareChat）与检查期间停止（#160）；
 * - 取消：调用方 abort / 连接断开都会中止上游生成；
 * - 事件：只推给订阅了的连接（取代按窗口订阅子集）；
 * - dangerous：不可信调用者调 tools.confirm 被拒。
 */

import { AIClient } from '@nomi-ai/ai-sdk';
import { LLMRegistryKey, ToolRegistryKey, UserProfileKey } from '@nomi-ai/bundle-ig-base';
import { TtsKey } from '@nomi-ai/bundle-ig-electron-caps/seams';
import { ContractError, createClient } from '@nomi-ai/contract';
import { appContract } from '@nomi-ai/contract/app';
import { createInProcessServer } from '@nomi-ai/contract/testing';
import { describe, expect, it } from 'vitest';

import { batchTextChunks, createAiRouter, type AiRouterOptions } from '../src/AiContractRouter';
import { NoopRuntimeLogger } from '../src/logger';

import { createFakeSdkCtx } from './helpers/fakeSdkCtx';
import {
  createFakeLLM,
  createFakeLLMRegistry,
  createFakeProfileService,
  createFakeToolRegistry,
  type FakeLLM,
} from './helpers/fakeSeams';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function bootstrap(
  opts: Partial<AiRouterOptions> & {
    llm?: FakeLLM;
    seed?: (ctx: ReturnType<typeof createFakeSdkCtx>) => void;
  } = {},
) {
  const ctx = createFakeSdkCtx();
  const llm = opts.llm ?? createFakeLLM('fake');
  ctx.provide(LLMRegistryKey, createFakeLLMRegistry(llm));
  ctx.provide(ToolRegistryKey, createFakeToolRegistry());
  ctx.provide(UserProfileKey, createFakeProfileService());
  opts.seed?.(ctx);
  const client = new AIClient(ctx);
  const ai = createAiRouter({ client, logger: NoopRuntimeLogger, ...opts });
  const server = createInProcessServer();
  const stop = server.serve(ai.router);
  const connect = (caller?: Parameters<typeof server.connect>[0]) => {
    const transport = server.connect(caller);
    return { transport, api: createClient(appContract, transport) };
  };
  return { ctx, llm, client, ai, server, stop, connect };
}

const chat = (content: string, extra: Record<string, unknown> = {}) => ({
  provider: 'fake',
  messages: [{ role: 'user' as const, content }],
  ...extra,
});

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of it) out.push(v);
  return out;
}

describe('createAiRouter · 门面方法', () => {
  it('每个契约过程都有处理函数（implement 校验），sessions / userProfile 往返', async () => {
    const { connect, client } = bootstrap();
    const { api } = connect();
    const s = await api.ai.sessions.create({ title: 'hello' });
    expect(s.title).toBe('hello');
    expect(client.sessions.get(s.id)?.title).toBe('hello');
    const renamed = await api.ai.sessions.rename({ id: s.id, title: 'world' });
    expect(renamed.title).toBe('world');
    expect(await api.ai.sessions.get({ id: 'missing' })).toBeUndefined();

    const p = await api.ai.memory.userProfile.set({
      patch: { identity: { nickname: 'wataru' } },
      source: 'user',
    });
    expect(p.identity.nickname).toBe('wataru');
  });

  it('sendMessage 去掉 raw，并先过 prepareChat；检查抛错则不调用上游', async () => {
    const seen: string[] = [];
    const { connect, llm } = bootstrap({
      prepareChat: async (opts, method) => {
        seen.push(method);
        const msgs = opts.messages as Array<{ content: string }>;
        if (msgs[0]!.content === 'deny') throw new Error('blocked');
      },
    });
    const { api } = connect();
    const resp = await api.ai.chat.sendMessage(chat('hi'));
    expect(resp.content).toBe('ok');
    expect('raw' in resp).toBe(false);
    await expect(api.ai.chat.sendMessage(chat('deny'))).rejects.toThrow('blocked');
    expect(llm.chatCalls).toHaveLength(1);
    expect(seen).toEqual(['sendMessage', 'sendMessage']);
  });

  it('AIClientError 的 [CODE] 前缀随 INTERNAL 的 message 传给视图', async () => {
    const ctx = createFakeSdkCtx();
    ctx.provide(LLMRegistryKey, createFakeLLMRegistry(createFakeLLM()));
    const ai = createAiRouter({ client: new AIClient(ctx), logger: NoopRuntimeLogger });
    const server = createInProcessServer();
    server.serve(ai.router);
    const api = createClient(appContract, server.connect());
    const err = await api.ai.tools
      .setEnabled({ name: 'nope', enabled: true })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ContractError);
    expect((err as ContractError).code).toBe('INTERNAL');
    expect((err as ContractError).message).toMatch(/^\[TOOL_NOT_FOUND/);
  });

  it('tts.stream：入参的 text / opts 还原成门面的位置参数', async () => {
    const calls: unknown[][] = [];
    const { connect } = bootstrap({
      seed: (ctx) =>
        ctx.provide(TtsKey, {
          stream(...a: unknown[]) {
            calls.push(a);
            return (async function* () {
              yield { reqId: 'tts-1', seq: 0, mime: 'audio/mp3', data: new Uint8Array([1]) };
            })();
          },
        } as never),
    });
    const { api } = connect();
    const chunks = await collect(api.ai.tts.stream({ text: 'hello', opts: { voiceId: 'v1' } }));
    expect(calls).toEqual([['hello', { voiceId: 'v1' }]]);
    expect(chunks[0]!.data).toBeInstanceOf(Uint8Array);
  });
});

describe('createAiRouter · chat 流', () => {
  it('chunk 依次到达；没有 reqId 时服务端生成并交给上游', async () => {
    const { connect, llm } = bootstrap();
    const { api } = connect();
    const chunks = await collect(api.ai.chat.stream(chat('hi')));
    expect(chunks).toEqual([
      { type: 'delta', content: 'hello' },
      { type: 'done', finishReason: 'stop' },
    ]);
    expect(typeof llm.streamCalls[0]?.reqId).toBe('string');
  });

  it('逐 token 的文本片段按帧合批，其它 chunk 保持顺序', async () => {
    const llm = createFakeLLM('fake');
    llm.stream = (req) => {
      llm.streamCalls.push(req);
      return (async function* () {
        for (const c of ['你', '好', '，']) yield { type: 'delta', content: c } as never;
        yield { type: 'reasoning', content: '想' } as never;
        yield { type: 'reasoning', content: '想' } as never;
        yield { type: 'tool_call.delta', index: 0, id: 't1', name: 'x' } as never;
        for (const c of ['世', '界']) yield { type: 'delta', content: c } as never;
        yield { type: 'done', finishReason: 'stop' } as never;
      })();
    };
    const { connect } = bootstrap({ llm });
    const { api } = connect();
    const values = (await collect(api.ai.chat.stream(chat('hi')))).map(
      (v) => `${v.type}:${'content' in v ? String(v.content) : ''}`,
    );
    expect(values).toEqual([
      'delta:你好，',
      'reasoning:想想',
      'tool_call.delta:',
      'delta:世界',
      'done:',
    ]);
  });

  it('合批窗口到期就发出，不等下一个 chunk', async () => {
    const gate: { release?: () => void } = {};
    async function* source() {
      yield { type: 'delta', content: 'a' };
      await new Promise<void>((r) => (gate.release = r));
      yield { type: 'delta', content: 'b' };
    }
    const it = batchTextChunks(source(), 10)[Symbol.asyncIterator]();
    const first = await it.next();
    expect(first.value).toEqual({ type: 'delta', content: 'a' });
    gate.release?.();
    expect((await it.next()).value).toEqual({ type: 'delta', content: 'b' });
    expect((await it.next()).done).toBe(true);
  });

  it('prepareChat 可改写 messages；抛错则不调用上游，流以错误结束', async () => {
    const { connect, llm } = bootstrap({
      prepareChat: async (opts) => {
        const msgs = opts.messages as Array<{ content: string }>;
        if (msgs[0]!.content === 'deny') throw new Error('blocked');
        msgs[0]!.content = 'redacted';
      },
    });
    const { api } = connect();
    await collect(api.ai.chat.stream(chat('secret')));
    expect(llm.streamCalls[0]?.messages[0]?.content).toBe('redacted');
    await expect(collect(api.ai.chat.stream(chat('deny')))).rejects.toThrow('blocked');
    expect(llm.streamCalls).toHaveLength(1);
  });

  it('prepareChat 等待确认时 chat.abort：放行后不再创建上游请求、静默结束；新一轮不受影响（#160）', async () => {
    const gates: Array<{ release: () => void; signal?: AbortSignal }> = [];
    const { connect, llm } = bootstrap({
      prepareChat: (_opts, _method, signal) =>
        new Promise<void>((resolve) => gates.push({ release: resolve, signal })),
    });
    const { api } = connect();
    const first = collect(api.ai.chat.stream(chat('hi', { reqId: 'r1' })));
    await sleep(5);
    expect(gates[0]!.signal?.aborted).toBe(false);
    await api.ai.chat.abort({ reqId: 'r1' });
    expect(gates[0]!.signal?.aborted).toBe(true);
    gates[0]!.release(); // 用户随后在遗留的确认里点了允许
    await expect(first).resolves.toEqual([]);
    expect(llm.streamCalls).toHaveLength(0);

    const second = collect(api.ai.chat.stream(chat('again', { reqId: 'r2' })));
    await sleep(5);
    expect(gates[1]!.signal?.aborted).toBe(false);
    gates[1]!.release();
    await second;
    expect(llm.streamCalls).toHaveLength(1);
  });

  it('prepareChat 因停止而失败（撤掉确认后抛「已取消」）：静默结束，不带错误', async () => {
    const { connect, llm } = bootstrap({
      prepareChat: (_opts, _method, signal) =>
        new Promise<void>((_resolve, reject) =>
          signal?.addEventListener('abort', () => reject(new Error('cancelled'))),
        ),
    });
    const { api } = connect();
    const s = collect(api.ai.chat.stream(chat('hi', { reqId: 'r1' })));
    await sleep(5);
    await api.ai.chat.abort({ reqId: 'r1' });
    await expect(s).resolves.toEqual([]);
    expect(llm.streamCalls).toHaveLength(0);
  });

  it('调用方取消（abort 帧）与连接断开（窗口关闭）都会中止上游生成', async () => {
    const llm = createFakeLLM('fake');
    const gate: { release?: () => void } = {};
    llm.stream = (req) => {
      llm.streamCalls.push(req);
      return (async function* () {
        yield { type: 'delta', content: 'a' } as never;
        await new Promise<void>((r) => (gate.release = r));
        yield { type: 'delta', content: 'b' } as never;
      })();
    };
    const { connect } = bootstrap({ llm });

    const one = connect();
    const ctrl = new AbortController();
    const it = one.api.ai.chat.stream(chat('hi', { reqId: 'c1' }), { signal: ctrl.signal });
    const iter = it[Symbol.asyncIterator]();
    expect((await iter.next()).value).toEqual({ type: 'delta', content: 'a' });
    ctrl.abort();
    await sleep(5);
    expect(llm.aborted).toContain('c1');
    gate.release?.();

    const two = connect();
    const iter2 = two.api.ai.chat.stream(chat('hi', { reqId: 'c2' }))[Symbol.asyncIterator]();
    expect((await iter2.next()).value).toEqual({ type: 'delta', content: 'a' });
    two.transport.disconnect();
    await sleep(5);
    expect(llm.aborted).toContain('c2');
    gate.release?.();
  });
});

describe('createAiRouter · 事件与安全', () => {
  it('AIClient 事件只推给订阅了的连接；退订后不再收到', async () => {
    const { connect, ctx } = bootstrap();
    const a = connect();
    const b = connect();
    const atA: unknown[] = [];
    const atB: unknown[] = [];
    const offA = a.api.on('ai.tts.end', (d) => atA.push(d));
    b.api.on('ai.tool.executed', (d) => atB.push(d));
    await a.api.$connect();
    await b.api.$connect();
    await sleep(0);

    await ctx.triggerEvent('tts/end', { reqId: 'r1', ok: true });
    await ctx.triggerEvent('tools/post-execute', { toolName: 't', reqId: 'r1', ok: true });
    await sleep(5);
    expect(atA).toEqual([{ reqId: 'r1', ok: true }]);
    expect(atB).toEqual([{ toolName: 't', reqId: 'r1', ok: true }]);

    offA();
    await sleep(0);
    await ctx.triggerEvent('tts/end', { reqId: 'r2', ok: true });
    await sleep(5);
    expect(atA).toHaveLength(1);
  });

  it('形状不合声明的插件事件照样投递（事件 schema 有意放宽）', async () => {
    const { connect, ctx } = bootstrap();
    const { api } = connect();
    const seen: unknown[] = [];
    api.on('ai.userProfile.changed', (d) => seen.push(d));
    await api.$connect();
    await sleep(0);
    await ctx.triggerEvent('userProfile/changed', { version: 1, identity: {} });
    await sleep(5);
    expect(seen).toEqual([{ version: 1, identity: {} }]);
  });

  it('dispose 后不再发布事件', async () => {
    const { connect, ctx, ai } = bootstrap();
    const { api } = connect();
    const seen: unknown[] = [];
    api.on('ai.tts.end', (d) => seen.push(d));
    await api.$connect();
    ai.dispose();
    await ctx.triggerEvent('tts/end', { reqId: 'r1', ok: true });
    await sleep(5);
    expect(seen).toEqual([]);
  });

  it('dangerous：不可信调用者调 tools.confirm 返回 FORBIDDEN，普通过程照常', async () => {
    const { connect } = bootstrap();
    const { api } = connect({ surface: 'chat', trusted: false });
    await expect(api.ai.tools.confirm({ reqId: 'x', ok: true })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(Array.isArray(await api.ai.sessions.list())).toBe(true);
  });
});
