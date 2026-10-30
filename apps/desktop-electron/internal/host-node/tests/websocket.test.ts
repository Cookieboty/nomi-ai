import { request } from 'node:http';

import {
  createClient,
  createWebSocketClientTransport,
  defineContract,
  implement,
  type CallerContext,
  type WebSocketFactory,
  type WebSocketLike,
} from '@nomi-ai/contract';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { z } from 'zod';

import {
  createDevToken,
  redactToken,
  serveContractOverWebSocket,
  type WebSocketContractServer,
} from '../src/websocket';

const contract = defineContract({
  version: { major: 1, minor: 0 },
  procedures: {
    'echo.bytes': {
      kind: 'query',
      input: z.object({ data: z.instanceof(Uint8Array) }),
      output: z.object({ length: z.number(), data: z.instanceof(Uint8Array) }),
    },
    whoami: { kind: 'query', input: z.void(), output: z.object({ surface: z.string() }) },
    'count.up': { kind: 'stream', input: z.object({ n: z.number() }), chunk: z.number() },
    hang: { kind: 'query', input: z.void(), output: z.null() },
  },
  events: { tick: z.object({ n: z.number() }) },
});

let seenCaller: CallerContext | undefined;
const router = implement(contract, {
  'echo.bytes': ({ data }) => ({ length: data.length, data }),
  whoami: (_input, ctx) => {
    seenCaller = ctx.caller;
    return { surface: ctx.caller.surface };
  },
  async *'count.up'({ n }) {
    for (let i = 1; i <= n; i++) yield i;
  },
  hang: () => new Promise<null>(() => undefined),
});

const ORIGIN = 'http://127.0.0.1:6128';
let server: WebSocketContractServer | undefined;
const token = createDevToken();
const warnings: unknown[] = [];

afterEach(async () => {
  await server?.close();
  server = undefined;
  warnings.length = 0;
});

async function start(opts: { port?: number; token?: string } = {}) {
  server = await serveContractOverWebSocket(router as never, {
    token: opts.token ?? token,
    ...(opts.port ? { port: opts.port } : {}),
    allowedOrigins: [ORIGIN],
    logger: { warn: (_m, data) => warnings.push(data) },
  });
  return server;
}

/** `ws` 包的客户端（能设 Origin / Host），形状满足视图侧的 WebSocketLike */
const wsFactory =
  (origin?: string, headers?: Record<string, string>): WebSocketFactory =>
  (url, protocols) =>
    new WebSocket(url, protocols, {
      ...(origin ? { origin } : {}),
      headers,
    }) as unknown as WebSocketLike;

/** 原样发一个升级请求，返回状态码 */
function upgradeStatus(port: number, headers: Record<string, string>, path = '/'): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({
      host: '127.0.0.1',
      port,
      path,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': Buffer.from('0123456789abcdef').toString('base64'),
        ...headers,
      },
    });
    req.on('upgrade', (res, socket) => {
      socket.destroy();
      resolve(res.statusCode ?? 0);
    });
    req.on('response', (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end();
  });
}

describe('serveContractOverWebSocket', () => {
  it('binds 127.0.0.1 and round-trips calls, Uint8Array, streams and events', async () => {
    const s = await start();
    expect(s.url).toBe(`ws://127.0.0.1:${s.port}`);
    const transport = createWebSocketClientTransport({
      url: s.url,
      token,
      surface: 'mascot',
      createSocket: wsFactory(ORIGIN),
    });
    const api = createClient(contract, transport, { handshake: 'off' });
    await transport.ready;
    expect(s.connectionCount).toBe(1);

    const out = await api.echo.bytes({ data: new Uint8Array([1, 2, 255]) });
    expect(out.length).toBe(3);
    expect(out.data).toBeInstanceOf(Uint8Array);
    expect([...out.data]).toEqual([1, 2, 255]);
    await expect(api.whoami()).resolves.toEqual({ surface: 'mascot' });
    expect(seenCaller).toMatchObject({ surface: 'mascot', trusted: true, id: expect.any(String) });

    const chunks: number[] = [];
    for await (const c of api.count.up({ n: 3 })) chunks.push(c);
    expect(chunks).toEqual([1, 2, 3]);

    const ticks: unknown[] = [];
    api.on('tick', (e) => ticks.push(e));
    await new Promise((r) => setTimeout(r, 20));
    router.events.publish('tick', { n: 7 });
    await new Promise((r) => setTimeout(r, 20));
    expect(ticks).toEqual([{ n: 7 }]);

    transport.close();
    // 服务端的 close 事件在客户端关闭握手之后到；整套测试并行时 20ms 不够，等到它为止
    await expect.poll(() => s.connectionCount, { timeout: 2000, interval: 10 }).toBe(0);
  });

  it('rejects a wrong token, a foreign or missing Origin, an unknown surface and a foreign Host', async () => {
    const s = await start();
    const attempt = async (opts: {
      token?: string;
      origin?: string;
      surface?: 'chat' | 'mascot' | 'settings';
      headers?: Record<string, string>;
    }) => {
      const t = createWebSocketClientTransport({
        url: s.url,
        token: opts.token ?? token,
        ...(opts.surface ? { surface: opts.surface } : {}),
        createSocket: wsFactory(opts.origin, opts.headers),
      });
      return t.ready.then(
        () => 'open',
        () => 'refused',
      );
    };
    expect(await attempt({ origin: ORIGIN })).toBe('open');
    expect(await attempt({ origin: ORIGIN, token: createDevToken() })).toBe('refused');
    expect(await attempt({ origin: 'http://evil.example' })).toBe('refused');
    expect(await attempt({ origin: 'http://127.0.0.1:6128.evil.example' })).toBe('refused');
    expect(await attempt({})).toBe('refused');
    expect(await attempt({ origin: ORIGIN, headers: { Host: `evil.example:${s.port}` } })).toBe(
      'refused',
    );
    expect(s.rejectedCount).toBe(5);

    const valid = `nomi.contract.v1, nomi-token.${token}, nomi-surface.chat`;
    expect(await upgradeStatus(s.port, { Origin: ORIGIN, 'Sec-WebSocket-Protocol': valid })).toBe(
      101,
    );
    expect(
      await upgradeStatus(s.port, {
        Origin: ORIGIN,
        'Sec-WebSocket-Protocol': `nomi.contract.v1, nomi-token.${token}, nomi-surface.test`,
      }),
    ).toBe(403);
    expect(
      await upgradeStatus(s.port, { Origin: ORIGIN, 'Sec-WebSocket-Protocol': valid }, '/x'),
    ).toBe(404);
    expect(
      await upgradeStatus(s.port, {
        Origin: ORIGIN,
        'Sec-WebSocket-Protocol': `nomi-token.${token}, nomi-surface.chat`,
      }),
    ).toBe(400);
    // 日志里没有完整 token
    expect(JSON.stringify(warnings)).not.toContain(token);
  });

  it('answers plain HTTP with 426 and refuses non-loopback binds and bad options', async () => {
    const s = await start();
    const status = await new Promise<number>((resolve, reject) => {
      request({ host: '127.0.0.1', port: s.port, path: '/' }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      })
        .on('error', reject)
        .end();
    });
    expect(status).toBe(426);
    await expect(
      serveContractOverWebSocket(router as never, {
        token,
        allowedOrigins: [ORIGIN],
        host: '0.0.0.0' as never,
      }),
    ).rejects.toThrow(/loopback/);
    await expect(
      serveContractOverWebSocket(router as never, { token: 'short', allowedOrigins: [ORIGIN] }),
    ).rejects.toThrow(/token/);
    await expect(
      serveContractOverWebSocket(router as never, { token, allowedOrigins: [] }),
    ).rejects.toThrow(/allowedOrigins/);
  });

  it('closes the connection on binary frames and drops malformed text', async () => {
    const s = await start();
    const ws = new WebSocket(
      s.url,
      ['nomi.contract.v1', `nomi-token.${token}`, 'nomi-surface.chat'],
      {
        origin: ORIGIN,
      },
    );
    await new Promise((r) => ws.once('open', r));
    expect(ws.protocol).toBe('nomi.contract.v1');
    ws.send('not json');
    const closed = new Promise<number>((r) => ws.once('close', (code) => r(code)));
    ws.send(Buffer.from([1, 2, 3]), { binary: true });
    expect(await closed).toBe(1003);
  });

  it('reconnects with backoff after the connection drops and re-subscribes active events', async () => {
    const s = await start();
    const port = s.port;
    const statuses: string[] = [];
    const transport = createWebSocketClientTransport({
      url: s.url,
      token,
      surface: 'chat',
      createSocket: wsFactory(ORIGIN),
      reconnect: { initialDelayMs: 20, maxDelayMs: 80 },
      onStatus: (st) => statuses.push(st),
    });
    const api = createClient(contract, transport, { handshake: 'off' });
    await transport.ready;
    const ticks: unknown[] = [];
    api.on('tick', (e) => ticks.push(e));
    await new Promise((r) => setTimeout(r, 20));

    // 内核断开：进行中的调用以 TRANSPORT 失败，断开期间的新调用也直接失败
    const pending = api.hang().then(
      () => null,
      (e: unknown) => e,
    );
    await new Promise((r) => setTimeout(r, 20));
    await s.close();
    server = undefined;
    await expect(pending).resolves.toMatchObject({ code: 'TRANSPORT' });
    await expect.poll(() => transport.status, { timeout: 2000, interval: 5 }).toBe('reconnecting');
    await expect(api.whoami()).rejects.toMatchObject({ code: 'TRANSPORT' });

    // 同一端口、同一 token 的内核回来：自动连上，事件订阅回来，新调用照常
    const back = await start({ port });
    await expect.poll(() => transport.status, { timeout: 3000, interval: 10 }).toBe('open');
    await expect(api.whoami()).resolves.toEqual({ surface: 'chat' });
    await new Promise((r) => setTimeout(r, 20));
    router.events.publish('tick', { n: 8 });
    await expect.poll(() => ticks, { timeout: 2000, interval: 10 }).toEqual([{ n: 8 }]);
    expect(back.connectionCount).toBe(1);
    expect(statuses).toEqual(['open', 'reconnecting', 'open']);

    transport.close();
    expect(transport.status).toBe('closed');
    await expect.poll(() => back.connectionCount, { timeout: 2000, interval: 10 }).toBe(0);
  });

  it('keeps the handshake checks on reconnect: a restarted kernel with a new token is refused', async () => {
    const s = await start();
    const port = s.port;
    const transport = createWebSocketClientTransport({
      url: s.url,
      token,
      createSocket: wsFactory(ORIGIN),
      reconnect: { initialDelayMs: 10, maxDelayMs: 30 },
    });
    await transport.ready;
    await s.close();
    server = undefined;
    const other = await start({ port, token: createDevToken() });
    // 多试几轮：每次都被拒，一直停在 reconnecting，连接数始终是 0
    await new Promise((r) => setTimeout(r, 200));
    expect(transport.status).toBe('reconnecting');
    expect(other.connectionCount).toBe(0);
    transport.close();
    expect(transport.status).toBe('closed');
  });

  it('does not reconnect when the first handshake is refused', async () => {
    const s = await start();
    const statuses: string[] = [];
    const transport = createWebSocketClientTransport({
      url: s.url,
      token: createDevToken(),
      createSocket: wsFactory(ORIGIN),
      reconnect: { initialDelayMs: 10 },
      onStatus: (st) => statuses.push(st),
    });
    await expect(transport.ready).rejects.toMatchObject({ code: 'TRANSPORT' });
    await new Promise((r) => setTimeout(r, 60));
    expect(statuses).toEqual(['closed']);
    expect(s.connectionCount).toBe(0);
  });

  it('redacts tokens for logs', () => {
    expect(redactToken(token)).toBe(`${token.slice(0, 4)}…`);
    expect(createDevToken()).toMatch(/^[0-9a-f]{64}$/);
  });
});
