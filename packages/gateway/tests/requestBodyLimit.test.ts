/**
 * 入站请求体上限：Content-Length 早拒绝 + 流式计数 → 413。
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import {
  clampMaxRequestBodyBytes,
  DEFAULT_MAX_REQUEST_BODY_BYTES,
  MAX_MAX_REQUEST_BODY_BYTES,
  MIN_MAX_REQUEST_BODY_BYTES,
  type GatewayConfig,
  type RuntimeProvider,
} from '../src/config';
import { createGateway } from '../src/server';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

describe('clampMaxRequestBodyBytes', () => {
  it('defaults and clamps to 1 MiB .. 256 MiB', () => {
    expect(clampMaxRequestBodyBytes(undefined)).toBe(DEFAULT_MAX_REQUEST_BODY_BYTES);
    expect(clampMaxRequestBodyBytes(100)).toBe(MIN_MAX_REQUEST_BODY_BYTES);
    expect(clampMaxRequestBodyBytes(999 * 1024 * 1024)).toBe(MAX_MAX_REQUEST_BODY_BYTES);
    expect(clampMaxRequestBodyBytes(16 * 1024 * 1024)).toBe(16 * 1024 * 1024);
  });
});

async function startGateway(maxBytes: number) {
  const up = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'u',
          choices: [{ message: { role: 'assistant', content: 'ok' } }],
        }),
      );
    });
  });
  await new Promise<void>((r) => up.listen(0, '127.0.0.1', () => r()));
  const upPort = (up.address() as AddressInfo).port;
  cleanups.push(() => up.close());

  const provider: RuntimeProvider = {
    id: 'p',
    name: 'P',
    enabled: true,
    urls: { chat: `http://127.0.0.1:${upPort}/v1` },
    keys: [{ id: 'k1', name: 'k', value: 'secret', enabled: true }],
    models: [{ id: 'm1', enabled: true }],
  };
  const cfg: GatewayConfig = {
    host: '127.0.0.1',
    port: 0,
    providers: [provider],
    clients: {
      claude: {
        token: 'tok',
        models: { main: 'p/m1' },
      },
    },
    allowedPrivateHosts: [`127.0.0.1:${upPort}`],
    maxRequestBodyBytes: maxBytes,
  };
  const gw = createGateway(cfg);
  await gw.start();
  cleanups.push(() => gw.stop());
  return { base: gw.listenUrl()! };
}

describe('readBody size limit', () => {
  it('returns 413 when Content-Length exceeds the limit', async () => {
    const limit = MIN_MAX_REQUEST_BODY_BYTES;
    const { base } = await startGateway(limit);
    const url = new URL(`${base}/v1/chat/completions`);
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        {
          hostname: url.hostname,
          port: url.port,
          path: url.pathname,
          method: 'POST',
          headers: {
            authorization: 'Bearer tok',
            'content-type': 'application/json',
            'content-length': String(limit + 1),
          },
        },
        (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode ?? 0));
        },
      );
      req.on('error', reject);
      // 不必真传满 body：网关看 Content-Length 即 413
      req.end('{}');
    });
    expect(status).toBe(413);
  });

  it('returns 413 when streamed body exceeds the limit', async () => {
    const limit = MIN_MAX_REQUEST_BODY_BYTES;
    const { base } = await startGateway(limit);
    const url = new URL(`${base}/v1/chat/completions`);
    // 超过 1 MiB 的假 JSON（chunked，无 Content-Length）
    const pad = 'y'.repeat(limit);
    const body = `{"model":"p/m1","messages":[{"role":"user","content":"${pad}"}]}`;
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        {
          hostname: url.hostname,
          port: url.port,
          path: url.pathname,
          method: 'POST',
          headers: {
            authorization: 'Bearer tok',
            'content-type': 'application/json',
            'transfer-encoding': 'chunked',
          },
        },
        (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode ?? 0));
        },
      );
      req.on('error', reject);
      // 分块写，确保流式累计触发
      const chunk = 64 * 1024;
      for (let i = 0; i < body.length; i += chunk) {
        req.write(body.slice(i, i + chunk));
      }
      req.end();
    });
    expect(status).toBe(413);
  });

  it('accepts a body under the limit', async () => {
    const { base } = await startGateway(32 * 1024 * 1024);
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer tok',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model: 'p/m1', messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(res.status).toBe(200);
  });
});
