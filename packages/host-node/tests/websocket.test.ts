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

async function start() {
  server = await serveContractOverWebSocket(router as never, {
    token,
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

  it('redacts tokens for logs', () => {
    expect(redactToken(token)).toBe(`${token.slice(0, 4)}…`);
    expect(createDevToken()).toMatch(/^[0-9a-f]{64}$/);
  });
});
