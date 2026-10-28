/**
 * 类型推导测试：expectTypeOf 与 @ts-expect-error 由 `pnpm typecheck`（tsconfig.check.json 覆盖 tests/）检查；
 * 运行时部分只保证这些代码路径不会抛错。
 */
import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';

import {
  createClient,
  defineContract,
  implement,
  type CallerContext,
  type Client,
  type ContractStream,
  type Handlers,
} from '../src';
import { createInProcessTransport } from '../src/testing';

import { makeHandlers, testContract, type TestContract } from './fixtures';

function typedClient(): Client<TestContract> {
  const { client, server } = createInProcessTransport();
  server.serve(implement(testContract, makeHandlers()));
  return createClient(testContract, client, { handshake: 'off' });
}

describe('client types', () => {
  it('maps dotted names to nested, fully typed methods', () => {
    const api = typedClient();

    expectTypeOf(api.sessions.list).toBeFunction();
    expectTypeOf(api.sessions.list()).toEqualTypeOf<Promise<{ id: string; title: string }[]>>();
    expectTypeOf(api.sessions.rename).parameter(0).toEqualTypeOf<{ id: string; title: string }>();
    expectTypeOf(api.tools.confirm({ id: 'x', allow: true })).toEqualTypeOf<Promise<void>>();
    expectTypeOf(api.deep.a.b.c(1)).toEqualTypeOf<Promise<number>>();

    const s = api.chat.stream({ prompt: 'hi' }, { signal: new AbortController().signal });
    expectTypeOf(s).toEqualTypeOf<
      ContractStream<{ type: 'delta'; content: string }, { tokens: number }>
    >();
    expectTypeOf(s.result).toEqualTypeOf<Promise<{ tokens: number }>>();
    expectTypeOf(api.chat.ticks({ n: 1 }).result).toEqualTypeOf<Promise<void>>();

    // 只做类型检查，不实际调用
    const _compileOnly = () => {
      // 用 void 定义的入参可以省略
      void api.settings.reset();
      // @ts-expect-error 入参类型不符
      void api.sessions.rename({ id: 1, title: 'x' });
      // @ts-expect-error 必填入参不能省略
      void api.sessions.rename();
      // @ts-expect-error 契约里没有的过程
      void api.sessions.nope;
      // @ts-expect-error 流式过程没有 Promise 结果
      void api.chat.stream({ prompt: 'x' }).then;
    };
    void _compileOnly;
  });

  it('types events', () => {
    const api = typedClient();
    const off = api.on('usage.updated', (u) => {
      expectTypeOf(u).toEqualTypeOf<{ used: number; limit: number }>();
    });
    expectTypeOf(off).toEqualTypeOf<() => void>();
    // @ts-expect-error 未声明的事件
    expect(() => api.on('nope', () => {})).toThrow();
    off();
  });
});

describe('implement types', () => {
  it('infers handler params from the contract', () => {
    const handlers: Handlers<TestContract> = {
      ...makeHandlers(),
      'sessions.rename': (input, ctx) => {
        expectTypeOf(input).toEqualTypeOf<{ id: string; title: string }>();
        expectTypeOf(ctx.caller).toEqualTypeOf<CallerContext>();
        expectTypeOf(ctx.signal).toEqualTypeOf<AbortSignal>();
        ctx.events.publish('usage.updated', { used: 1, limit: 2 });
        // @ts-expect-error 事件数据类型不符
        ctx.events.publish('usage.updated', { used: '1' });
        // @ts-expect-error 未声明的事件
        ctx.events.publish('nope', {});
        if (input.id === 'x') ctx.fail('SESSION_NOT_FOUND', 'x');
        // @ts-expect-error 未在契约 errors 中声明的错误码
        if (input.id === 'y') ctx.fail('WHATEVER', 'x');
        return { id: input.id, title: input.title };
      },
    };
    implement(testContract, handlers);
  });

  it('rejects missing, extra and mistyped handlers at compile time', () => {
    const c = defineContract({
      version: { major: 1, minor: 0 },
      procedures: {
        'a.get': { kind: 'query', input: z.string(), output: z.number() },
        'a.stream': { kind: 'stream', input: z.void(), chunk: z.string(), output: z.number() },
      },
    });

    // @ts-expect-error 缺少 'a.stream'
    const missing: Handlers<typeof c> = { 'a.get': (s) => s.length };

    const wrongOutput: Handlers<typeof c> = {
      // @ts-expect-error 返回值应为 number
      'a.get': (s) => s,
      async *'a.stream'() {
        yield 'x';
        return 1;
      },
    };

    const wrongChunk: Handlers<typeof c> = {
      'a.get': (s) => s.length,
      // @ts-expect-error chunk 应为 string
      async *'a.stream'() {
        yield 1;
        return 1;
      },
    };

    const extra: Handlers<typeof c> = {
      'a.get': (s) => s.length,
      async *'a.stream'() {
        yield 'x';
        return 1;
      },
      // @ts-expect-error 契约里没有的处理函数
      'a.extra': () => 1,
    };

    void [missing, wrongOutput, wrongChunk, extra];
    expect(Object.keys(c.procedures)).toHaveLength(2);
  });
});
