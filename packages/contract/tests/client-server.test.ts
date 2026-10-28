import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
  ContractError,
  createClient,
  createServerSession,
  defineContract,
  implement,
  type CallerContext,
  type CallInfo,
  type ClientTransport,
  type ServerFrame,
  type ClientOptions,
  type ImplementOptions,
  type Middleware,
} from '../src';
import {
  createInProcessServer,
  createInProcessTransport,
  type InProcessOptions,
} from '../src/testing';

import { makeRouter, sleep, testContract, type Probe } from './fixtures';

function setup(
  opts: {
    server?: ImplementOptions;
    client?: ClientOptions;
    transport?: InProcessOptions & { caller?: CallerContext };
  } = {},
) {
  const probe: Probe = { aborted: [], streamFinally: 0 };
  const router = makeRouter(opts.server, probe);
  const { server, client } = createInProcessTransport(opts.transport);
  const stop = server.serve(router);
  const api = createClient(testContract, client, opts.client);
  return { api, router, server, client, stop, probe };
}

async function rejection(p: Promise<unknown>): Promise<ContractError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(ContractError);
    return err as ContractError;
  }
  throw new Error('expected rejection');
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of it) out.push(v);
  return out;
}

describe('query / mutation', () => {
  it('round-trips through the wire protocol', async () => {
    const { api } = setup();
    await expect(api.sessions.list()).resolves.toEqual([{ id: 's1', title: 'Hello' }]);
    await expect(api.sessions.rename({ id: 's1', title: 'New' })).resolves.toEqual({
      id: 's1',
      title: 'New',
    });
    await expect(api.deep.a.b.c(21)).resolves.toBe(42);
    await expect(api.tools.confirm({ id: 't', allow: true })).resolves.toBeUndefined();
  });

  it('propagates contract errors with code and data', async () => {
    const { api } = setup();
    const err = await rejection(api.sessions.rename({ id: 'missing', title: 'x' }));
    expect(err.code).toBe('SESSION_NOT_FOUND');
    expect(err.message).toBe('no session missing');
    expect(err.data).toEqual({ id: 'missing' });
  });

  it('validates input on the client before sending', async () => {
    const reached = vi.fn(async (_call: CallInfo, next: () => Promise<unknown>) => next());
    const { api } = setup({ server: { middleware: [reached] } });
    const err = await rejection(
      (api.sessions.rename as (i: unknown) => Promise<unknown>)({ id: 1 }),
    );
    expect(err.code).toBe('BAD_INPUT');
    expect(reached).not.toHaveBeenCalled();
    expect((err.data as { issues: unknown[] }).issues.length).toBeGreaterThan(0);
  });

  it('validates input on the server even when the client skips validation', async () => {
    const { api } = setup({ client: { validate: { input: false } } });
    const err = await rejection(
      (api.sessions.rename as (i: unknown) => Promise<unknown>)({ id: 1 }),
    );
    expect(err.code).toBe('BAD_INPUT');
    expect(err.message).toBe('Invalid input');
  });

  it('maps unknown throws to INTERNAL and bad results to BAD_OUTPUT', async () => {
    const c = defineContract({
      version: { major: 1, minor: 0 },
      procedures: {
        'x.boom': { kind: 'query', input: z.void(), output: z.string() },
        'x.wrong': { kind: 'query', input: z.void(), output: z.string() },
        'x.fn': { kind: 'query', input: z.void(), output: z.any() },
      },
    });
    const warn = vi.fn();
    const router = implement(c, {
      'x.boom': () => {
        throw new Error('kaboom');
      },
      'x.wrong': () => 1 as unknown as string,
      'x.fn': () => ({ cb: () => 1 }),
    });
    const { server, client } = createInProcessTransport({ logger: { warn } });
    server.serve(router);
    const api = createClient(c, client);
    const boom = await rejection(api.x.boom());
    expect(boom.code).toBe('INTERNAL');
    expect(boom.message).toBe('kaboom');
    expect(warn).toHaveBeenCalled();
    expect((await rejection(api.x.wrong())).code).toBe('BAD_OUTPUT');
    // 不可序列化的结果（函数）：strict in-process 传输拒绝，和真实 IPC 一样失败
    const fn = await rejection(api.x.fn());
    expect(fn.code).toBe('BAD_OUTPUT');
    expect(fn.message).toMatch(/Unserializable res/);
  });

  it('reports NOT_FOUND for procedures the server does not know', async () => {
    const { client, server } = createInProcessTransport();
    server.serve(makeRouter());
    await expect(client.call('nope.nope', undefined)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(client.call('chat.stream', { prompt: 'x' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
  });

  it('fails with TRANSPORT when nobody serves or after disconnect', async () => {
    const server = createInProcessServer();
    const client = server.connect();
    const api = createClient(testContract, client, { handshake: 'off' });
    expect((await rejection(api.sessions.list())).code).toBe('TRANSPORT');
    client.disconnect();
    expect((await rejection(api.sessions.list())).code).toBe('TRANSPORT');
  });
});

describe('stream', () => {
  it('yields chunks and resolves the final result', async () => {
    const { api } = setup();
    const s = api.chat.stream({ prompt: 'a b c' });
    const chunks = await collect(s);
    expect(chunks.map((c) => c.content)).toEqual(['a', 'b', 'c']);
    await expect(s.result).resolves.toEqual({ tokens: 3 });
  });

  it('resolves undefined when the stream has no output schema', async () => {
    const { api } = setup();
    const s = api.chat.ticks({ n: 3 });
    expect(await collect(s)).toEqual([0, 1, 2]);
    await expect(s.result).resolves.toBeUndefined();
  });

  it('can be awaited via result without iterating', async () => {
    const { api } = setup();
    await expect(api.chat.stream({ prompt: 'x y' }).result).resolves.toEqual({ tokens: 2 });
  });

  it('cannot be iterated twice', async () => {
    const { api } = setup();
    const s = api.chat.ticks({ n: 1 });
    await collect(s);
    expect(() => s[Symbol.asyncIterator]()).toThrow(/once/);
  });

  it('aborts via signal: iterator throws ABORTED and the server sees the abort', async () => {
    const { api, probe } = setup();
    const ctrl = new AbortController();
    const s = api.chat.ticks({ n: 1000 }, { signal: ctrl.signal });
    const seen: number[] = [];
    const err = await (async () => {
      try {
        for await (const v of s) {
          seen.push(v);
          if (v === 2) ctrl.abort();
        }
      } catch (e) {
        return e as ContractError;
      }
      throw new Error('expected abort');
    })();
    expect(err.code).toBe('ABORTED');
    expect(seen).toEqual([0, 1, 2]);
    expect((await rejection(s.result)).code).toBe('ABORTED');
    await vi.waitFor(() => expect(probe.aborted).toContain('chat.ticks'));
  });

  it('aborts when the consumer breaks out early and runs the generator finally', async () => {
    const { api, probe } = setup();
    const s = api.chat.stream({ prompt: 'a b c d e f g h' });
    for await (const chunk of s) {
      if (chunk.content === 'b') break;
    }
    expect((await rejection(s.result)).code).toBe('ABORTED');
    await vi.waitFor(() => expect(probe.streamFinally).toBe(1));
  });

  it('rejects immediately with an already-aborted signal', async () => {
    const { api } = setup();
    const ctrl = new AbortController();
    ctrl.abort();
    expect((await rejection(api.chat.ticks({ n: 3 }, { signal: ctrl.signal }).result)).code).toBe(
      'ABORTED',
    );
    expect((await rejection(api.sessions.list(undefined, { signal: ctrl.signal }))).code).toBe(
      'ABORTED',
    );
  });

  it('turns handler errors mid-stream into a failed iterator', async () => {
    const c = defineContract({
      version: { major: 1, minor: 0 },
      procedures: { 's.fail': { kind: 'stream', input: z.void(), chunk: z.number() } },
      errors: ['BROKEN'],
    });
    const router = implement(c, {
      async *'s.fail'(_i, ctx) {
        yield 1;
        ctx.fail('BROKEN', 'pipe broke', { at: 1 });
      },
    });
    const { server, client } = createInProcessTransport();
    server.serve(router);
    const api = createClient(c, client);
    const seen: number[] = [];
    const s = api.s.fail();
    await expect(
      (async () => {
        for await (const v of s) seen.push(v);
      })(),
    ).rejects.toMatchObject({ code: 'BROKEN', data: { at: 1 } });
    expect(seen).toEqual([1]);
  });

  it('validates chunks on the server', async () => {
    const c = defineContract({
      version: { major: 1, minor: 0 },
      procedures: { 's.bad': { kind: 'stream', input: z.void(), chunk: z.number() } },
    });
    const router = implement(c, {
      async *'s.bad'() {
        yield 'nope' as unknown as number;
      },
    });
    const { server, client } = createInProcessTransport();
    server.serve(router);
    const s = createClient(c, client).s.bad();
    expect((await rejection(s.result)).code).toBe('BAD_OUTPUT');
  });

  it('runs the generator finally when a chunk fails server validation', async () => {
    const c = defineContract({
      version: { major: 1, minor: 0 },
      procedures: { 's.bad': { kind: 'stream', input: z.void(), chunk: z.number() } },
    });
    let cleaned = 0;
    let after = false;
    const router = implement(c, {
      async *'s.bad'() {
        try {
          yield 1;
          yield 'nope' as unknown as number;
          after = true;
          yield 3;
        } finally {
          cleaned++;
        }
      },
    });
    const { server, client } = createInProcessTransport();
    server.serve(router);
    const s = createClient(c, client).s.bad();
    expect((await rejection(s.result)).code).toBe('BAD_OUTPUT');
    await vi.waitFor(() => expect(cleaned).toBe(1));
    expect(after).toBe(false);
  });

  it('stops the stream and runs finally when a chunk is not serializable', async () => {
    const c = defineContract({
      version: { major: 1, minor: 0 },
      procedures: { 's.date': { kind: 'stream', input: z.void(), chunk: z.unknown() } },
    });
    let cleaned = 0;
    let yielded = 0;
    const router = implement(c, {
      async *'s.date'() {
        try {
          for (;;) {
            yielded++;
            yield new Date(0);
          }
        } finally {
          cleaned++;
        }
      },
    });
    const { server, client } = createInProcessTransport();
    server.serve(router);
    const s = createClient(c, client).s.date();
    expect((await rejection(s.result)).code).toBe('BAD_OUTPUT');
    await vi.waitFor(() => expect(cleaned).toBe(1));
    expect(yielded).toBe(1);
  });
});

describe('strictSerialize on the server session', () => {
  const c = defineContract({
    version: { major: 1, minor: 0 },
    procedures: { 'x.get': { kind: 'query', input: z.void(), output: z.unknown() } },
    events: { 'x.changed': z.unknown() },
  });
  const run = async (value: unknown, strictSerialize?: boolean) => {
    const router = implement(c, { 'x.get': () => value });
    const frames: ServerFrame[] = [];
    const warn = vi.fn();
    const session = createServerSession(router, {
      caller: { surface: 'test', trusted: true },
      send: (f) => {
        frames.push(f);
      },
      logger: { warn },
      strictSerialize,
    });
    session.receive({ t: 'req', id: '1', kind: 'call', name: 'x.get' });
    session.receive({ t: 'sub', event: 'x.changed' });
    await vi.waitFor(() => expect(frames.length).toBeGreaterThan(0));
    router.events.publish('x.changed', value);
    return { frame: frames[0], frames, warn };
  };

  it.each([
    ['Date', new Date(0)],
    ['Map', new Map([[1, 2]])],
    ['Set', new Set([1])],
  ])('rejects %s with BAD_OUTPUT and drops such events (on by default in tests)', async (_l, v) => {
    const { frame, frames, warn } = await run({ v });
    expect(frame).toMatchObject({ t: 'err', id: '1', error: { code: 'BAD_OUTPUT' } });
    expect(frames.some((f) => f.t === 'event')).toBe(false);
    expect(warn).toHaveBeenCalled();
  });

  it('strips unserializable error data instead of dropping the error', async () => {
    const router = implement(c, {
      'x.get': (_i, ctx) => ctx.fail('BAD_REQUEST', 'nope', { at: new Date(0) }),
    });
    const frames: ServerFrame[] = [];
    const session = createServerSession(router, {
      caller: { surface: 'test', trusted: true },
      send: (f) => {
        frames.push(f);
      },
      strictSerialize: true,
    });
    session.receive({ t: 'req', id: '1', kind: 'call', name: 'x.get' });
    await vi.waitFor(() => expect(frames).toHaveLength(1));
    expect(frames[0]).toEqual({
      t: 'err',
      id: '1',
      error: { code: 'BAD_REQUEST', message: 'nope' },
    });
  });

  it('lets values through when turned off', async () => {
    const date = new Date(0);
    const { frame, frames } = await run(date, false);
    expect(frame).toEqual({ t: 'res', id: '1', output: date });
    expect(frames.some((f) => f.t === 'event')).toBe(true);
  });

  it('accepts JSON values and Uint8Array', async () => {
    const value = { a: [1, 'x', null, true], b: new Uint8Array([1, 2]) };
    const { frame } = await run(value);
    expect(frame).toEqual({ t: 'res', id: '1', output: value });
  });
});

describe('abort for query / mutation', () => {
  it('rejects with ABORTED and aborts the handler signal', async () => {
    const { api, probe } = setup();
    const ctrl = new AbortController();
    const p = api.sessions.slow({ ms: 10_000 }, { signal: ctrl.signal });
    await sleep(5);
    ctrl.abort();
    expect((await rejection(p)).code).toBe('ABORTED');
    await vi.waitFor(() => expect(probe.aborted).toContain('sessions.slow'));
  });

  it('disconnect cancels in-flight calls on the server', async () => {
    const { api, client, probe, server } = setup();
    const p = api.sessions.slow({ ms: 10_000 });
    await sleep(5);
    expect(server.sessionCount).toBe(1);
    client.disconnect();
    expect((await rejection(p)).code).toBe('TRANSPORT');
    await vi.waitFor(() => expect(probe.aborted).toContain('sessions.slow'));
    expect(server.sessionCount).toBe(0);
  });
});

describe('events', () => {
  it('delivers published events to subscribers only, typed and validated', async () => {
    const { api, router } = setup();
    const usage = vi.fn();
    const off = api.on('usage.updated', usage);
    await api.sessions.list(); // 订阅帧已送达
    router.events.publish('usage.updated', { used: 1, limit: 10 });
    router.events.publish('persona.changed', { name: 'x' });
    await vi.waitFor(() => expect(usage).toHaveBeenCalledWith({ used: 1, limit: 10 }));
    off();
    await api.sessions.list();
    router.events.publish('usage.updated', { used: 2, limit: 10 });
    await sleep(5);
    expect(usage).toHaveBeenCalledTimes(1);
  });

  it('shares one wire subscription between listeners', async () => {
    const { api, router } = setup();
    const a = vi.fn();
    const b = vi.fn();
    const offA = api.on('persona.changed', a);
    const offB = api.on('persona.changed', b);
    await api.sessions.list();
    router.events.publish('persona.changed', { name: 'n' });
    await vi.waitFor(() => expect(b).toHaveBeenCalledTimes(1));
    expect(a).toHaveBeenCalledTimes(1);
    offA();
    offA(); // 重复退订无副作用
    await api.sessions.list();
    router.events.publish('persona.changed', { name: 'm' });
    await vi.waitFor(() => expect(b).toHaveBeenCalledTimes(2));
    expect(a).toHaveBeenCalledTimes(1);
    offB();
  });

  it('counts the wire subscriptions of an event (one per connection)', async () => {
    const { api, router } = setup();
    expect(router.events.subscribers('persona.changed')).toBe(0);
    const offA = api.on('persona.changed', vi.fn());
    const offB = api.on('persona.changed', vi.fn());
    await api.sessions.list();
    expect(router.events.subscribers('persona.changed')).toBe(1);
    offA();
    offB();
    await api.sessions.list();
    expect(router.events.subscribers('persona.changed')).toBe(0);
  });

  it('rejects undeclared or invalid events at publish time', () => {
    const router = makeRouter();
    expect(() =>
      router.events.publish('usage.updated', { used: 'x' } as unknown as {
        used: number;
        limit: number;
      }),
    ).toThrow(ContractError);
    expect(() => (router.events.publish as (n: string, d: unknown) => void)('nope', {})).toThrow(
      /not declared/,
    );
  });

  it('lets handlers publish through ctx.events', async () => {
    const c = defineContract({
      version: { major: 1, minor: 0 },
      procedures: { 'p.go': { kind: 'mutation', input: z.number(), output: z.void() } },
      events: { 'p.went': z.number() },
    });
    const router = implement(c, {
      'p.go': (n, ctx) => ctx.events.publish('p.went', n),
    });
    const { server, client } = createInProcessTransport();
    server.serve(router);
    const api = createClient(c, client);
    const seen = vi.fn();
    api.on('p.went', seen);
    await api.p.go(7);
    await vi.waitFor(() => expect(seen).toHaveBeenCalledWith(7));
  });
});

describe('security guard and middleware (§8)', () => {
  it('refuses dangerous procedures for untrusted callers', async () => {
    const { api } = setup({ transport: { caller: { surface: 'chat', trusted: false } } });
    const err = await rejection(api.tools.confirm({ id: 't', allow: true }));
    expect(err.code).toBe('FORBIDDEN');
    await expect(api.sessions.list()).resolves.toBeDefined();
  });

  it('refuses procedures outside the declared surfaces', async () => {
    const { api } = setup({ transport: { caller: { surface: 'mascot', trusted: true } } });
    expect((await rejection(api.settings.reset())).code).toBe('FORBIDDEN');
    const ok = setup({ transport: { caller: { surface: 'settings', trusted: true } } });
    await expect(ok.api.settings.reset()).resolves.toBe(true);
  });

  it('runs middleware in order with the caller context, after the guard', async () => {
    const order: string[] = [];
    const infos: CallInfo[] = [];
    const mw =
      (tag: string): Middleware =>
      async (call, next) => {
        order.push(`${tag}>`);
        infos.push(call);
        const out = await next();
        order.push(`<${tag}`);
        return out;
      };
    const { api } = setup({
      server: { middleware: [mw('a'), mw('b')] },
      transport: { caller: { surface: 'chat', trusted: false } },
    });
    await api.sessions.rename({ id: 's1', title: 'T' });
    expect(order).toEqual(['a>', 'b>', '<b', '<a']);
    expect(infos[0]).toMatchObject({
      name: 'sessions.rename',
      kind: 'mutation',
      input: { id: 's1', title: 'T' },
      caller: { surface: 'chat', trusted: false },
    });
    order.length = 0;
    await rejection(api.tools.confirm({ id: 'x', allow: true }));
    expect(order).toEqual([]); // 守卫在中间件之前拒绝
  });

  it('lets middleware reject or replace results', async () => {
    const deny: Middleware = async (call, next) => {
      if (call.name === 'sessions.list') throw new ContractError('FORBIDDEN', 'rate limited');
      if (call.name === 'deep.a.b.c') return 99;
      return next();
    };
    const { api } = setup({ server: { middleware: [deny] } });
    expect((await rejection(api.sessions.list())).message).toBe('rate limited');
    await expect(api.deep.a.b.c(1)).resolves.toBe(99);
    const s = api.chat.ticks({ n: 2 });
    expect(await collect(s)).toEqual([0, 1]);
  });

  it('rejects calling next() twice', async () => {
    const twice: Middleware = async (_call, next) => {
      await next();
      return next();
    };
    const { api } = setup({ server: { middleware: [twice] } });
    expect((await rejection(api.deep.a.b.c(1))).code).toBe('INTERNAL');
  });
});

describe('handshake (§4.3)', () => {
  const v2 = defineContract({
    version: { major: 2, minor: 0 },
    procedures: { 'sessions.list': testContract.procedures['sessions.list'] },
  });

  it('connects and reports the server version', async () => {
    const { api } = setup({ client: { handshake: 'manual' } });
    await expect(api.$connect()).resolves.toEqual({ version: { major: 1, minor: 2 }, protocol: 1 });
  });

  it('fails every call with VERSION_MISMATCH when majors differ (auto)', async () => {
    const { server, client } = createInProcessTransport();
    server.serve(makeRouter());
    const api = createClient(v2, client);
    const err = await rejection(api.sessions.list());
    expect(err.code).toBe('VERSION_MISMATCH');
    expect(err.data).toEqual({ client: { major: 2, minor: 0 }, server: { major: 1, minor: 2 } });
    expect((await rejection(api.sessions.list())).code).toBe('VERSION_MISMATCH');
    expect((await rejection(api.$connect())).code).toBe('VERSION_MISMATCH');
  });

  it('drops events after a major mismatch', async () => {
    const withEvents = defineContract({
      version: { major: 2, minor: 0 },
      procedures: {},
      events: { 'persona.changed': testContract.events['persona.changed'] },
    });
    const { server, client } = createInProcessTransport();
    const router = makeRouter();
    server.serve(router);
    const api = createClient(withEvents, client);
    const seen = vi.fn();
    api.on('persona.changed', seen);
    await expect(api.$connect()).rejects.toMatchObject({ code: 'VERSION_MISMATCH' });
    router.events.publish('persona.changed', { name: 'x' });
    await sleep(5);
    expect(seen).not.toHaveBeenCalled();
  });

  it('buffers events until the handshake succeeds (auto)', async () => {
    const h = fakeHandshakeTransport();
    const api = createClient(testContract, h.transport);
    const seen = vi.fn();
    api.on('persona.changed', seen);
    h.emit('persona.changed', { name: 'a' });
    h.emit('persona.changed', { name: 'b' });
    await sleep(1);
    expect(seen).not.toHaveBeenCalled();
    h.answer({ version: { major: 1, minor: 0 }, protocol: 1 });
    await vi.waitFor(() => expect(seen).toHaveBeenCalledTimes(2));
    expect(seen.mock.calls.map((c) => c[0])).toEqual([{ name: 'a' }, { name: 'b' }]);
    h.emit('persona.changed', { name: 'c' });
    expect(seen).toHaveBeenLastCalledWith({ name: 'c' });
  });

  it('drops buffered events when the handshake finds a major mismatch (auto)', async () => {
    const h = fakeHandshakeTransport();
    const api = createClient(testContract, h.transport);
    const seen = vi.fn();
    api.on('persona.changed', seen);
    h.emit('persona.changed', { name: 'early' });
    h.answer({ version: { major: 9, minor: 0 }, protocol: 1 });
    await expect(api.$connect()).rejects.toMatchObject({ code: 'VERSION_MISMATCH' });
    h.emit('persona.changed', { name: 'late' });
    await sleep(1);
    expect(seen).not.toHaveBeenCalled();
  });

  it('does not deliver buffered events after unsubscribing', async () => {
    const h = fakeHandshakeTransport();
    const api = createClient(testContract, h.transport);
    const seen = vi.fn();
    const off = api.on('persona.changed', seen);
    h.emit('persona.changed', { name: 'a' });
    off();
    h.answer({ version: { major: 1, minor: 0 }, protocol: 1 });
    await api.$connect();
    expect(seen).not.toHaveBeenCalled();
  });

  it('accepts a different minor version', async () => {
    const older = defineContract({
      version: { major: 1, minor: 0 },
      procedures: { 'sessions.list': testContract.procedures['sessions.list'] },
    });
    const { server, client } = createInProcessTransport();
    server.serve(makeRouter());
    await expect(createClient(older, client).sessions.list()).resolves.toHaveLength(1);
  });

  it('checks on the client even if the server does not', async () => {
    const { server, client } = createInProcessTransport();
    server.serve(makeRouter());
    // 不带版本的握手（旧客户端）服务端直接回版本，由客户端比对
    await expect(client.call('meta.version', undefined)).resolves.toMatchObject({
      version: { major: 1 },
    });
    await expect(client.call('meta.version', { major: 3, minor: 0 })).rejects.toMatchObject({
      code: 'VERSION_MISMATCH',
    });
  });

  it('retries the handshake after a transport failure', async () => {
    const server = createInProcessServer();
    const client = server.connect();
    const api = createClient(testContract, client);
    expect((await rejection(api.sessions.list())).code).toBe('TRANSPORT');
    server.serve(makeRouter());
    await expect(api.sessions.list()).resolves.toHaveLength(1);
  });
});

describe('deprecation', () => {
  it('warns once per deprecated procedure', async () => {
    const warn = vi.fn();
    const { api } = setup({ client: { logger: { warn } } });
    await api.legacy.ping();
    await api.legacy.ping();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatch(/deprecated: use sessions.list/);
  });
});

describe('implement runtime checks', () => {
  it('throws for missing or extra handlers even when types are bypassed', () => {
    const c = defineContract({
      version: { major: 1, minor: 0 },
      procedures: { 'a.b': { kind: 'query', input: z.void(), output: z.void() } },
    });
    expect(() => implement(c, {} as never)).toThrow(/missing handler/);
    expect(() => implement(c, { 'a.b': () => {}, 'a.c': () => {} } as never)).toThrow(
      /not declared/,
    );
  });
});

/** 可控的传输：握手（meta.version）由测试决定何时回答，事件由测试直接推送 */
function fakeHandshakeTransport() {
  const listeners = new Map<string, Set<(data: unknown) => void>>();
  let resolveHandshake: (v: unknown) => void = () => {};
  const handshake = new Promise<unknown>((r) => (resolveHandshake = r));
  const transport: ClientTransport = {
    call: (name) =>
      name === 'meta.version' ? handshake : Promise.reject(new Error(`unexpected ${name}`)),
    stream: () => {
      throw new Error('unexpected stream');
    },
    subscribe(event, fn) {
      let set = listeners.get(event);
      if (!set) listeners.set(event, (set = new Set()));
      set.add(fn);
      return () => set.delete(fn);
    },
  };
  return {
    transport,
    answer: (info: unknown) => resolveHandshake(info),
    emit: (event: string, data: unknown) => listeners.get(event)?.forEach((fn) => fn(data)),
  };
}

describe('event surfaces', () => {
  const contract = defineContract({
    version: { major: 1, minor: 0 },
    procedures: { ping: { kind: 'query', input: z.void(), output: z.string() } },
    events: { 'mascot.only': z.number(), 'any.one': z.number() },
    eventSurfaces: { 'mascot.only': ['mascot'] },
  });

  function connect(surface: CallerContext['surface']) {
    const router = implement(contract, { ping: () => 'pong' });
    const server = createInProcessServer();
    server.serve(router);
    const api = createClient(contract, server.connect({ surface, trusted: true }));
    return { api, router };
  }

  it('只把列了界面的事件推给这些界面；其它界面的订阅被忽略', async () => {
    const mascot = connect('mascot');
    const chat = connect('chat');
    const seen = { mascot: vi.fn(), chat: vi.fn(), chatAny: vi.fn() };
    mascot.api.on('mascot.only', seen.mascot);
    chat.api.on('mascot.only', seen.chat);
    chat.api.on('any.one', seen.chatAny);
    await mascot.api.ping();
    await chat.api.ping();
    for (const r of [mascot.router, chat.router]) {
      r.events.publish('mascot.only', 1);
      r.events.publish('any.one', 2);
    }
    await vi.waitFor(() => expect(seen.mascot).toHaveBeenCalledWith(1));
    await vi.waitFor(() => expect(seen.chatAny).toHaveBeenCalledWith(2));
    await sleep(5);
    expect(seen.chat).not.toHaveBeenCalled();
  });
});
