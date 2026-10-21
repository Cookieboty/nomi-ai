/**
 * 网关服务端：count_tokens 的校准（§10.3）与服务端工具的预检（§12.7.3）。
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import type { GatewayConfig } from '../src/config';
import { createGateway } from '../src/server';
import { recordUsage, resetCalibration } from '../src/tokens';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
  resetCalibration();
});

async function upstream() {
  const seen: string[] = [];
  const server = http.createServer((req, res) => {
    seen.push(req.url ?? '');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  cleanups.push(() => server.close());
  const port = (server.address() as AddressInfo).port;
  return { seen, base: `http://127.0.0.1:${port}`, hostPort: `127.0.0.1:${port}` };
}

async function gateway(urls: Record<string, string>, hosts: string[] = []) {
  const cfg: GatewayConfig = {
    host: '127.0.0.1',
    port: 0,
    providers: [
      {
        id: 'zp',
        name: '智谱',
        enabled: true,
        urls,
        keys: [{ id: 'k1', value: 'key', enabled: true }],
        models: [{ id: 'glm-5', enabled: true }],
      },
    ],
    clients: { claude: { token: 'tok', models: { main: 'zp/glm-5' } } },
    allowedPrivateHosts: hosts,
  };
  const gw = createGateway(cfg);
  await gw.start();
  cleanups.push(() => void gw.stop());
  return gw.listenUrl()!;
}

const post = (url: string, path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'tok', ...headers },
    body: JSON.stringify(body),
  });

describe('gateway: count_tokens calibration', () => {
  it('uses usage recorded for the same session, provider and model', async () => {
    const url = await gateway({ chat: 'https://example.invalid/v1' });
    const body = { model: 'zp/glm-5', messages: [{ role: 'user', content: 'hello world' }] };
    recordUsage({
      sessionKey: 'cc:s1',
      providerId: 'zp',
      model: 'glm-5',
      wire: 'messages',
      body,
      inputTokens: 20_000,
    });
    const hit = await post(url, '/v1/messages/count_tokens', body, {
      'x-claude-code-session-id': 's1',
    });
    expect(await hit.json()).toEqual({ input_tokens: 21_000 });
    const miss = await post(url, '/v1/messages/count_tokens', body, {
      'x-claude-code-session-id': 's2',
    });
    expect(((await miss.json()) as { input_tokens: number }).input_tokens).toBeLessThan(100);
  });
});

describe('gateway: server tools on a third-party upstream', () => {
  it('a dedicated web search request fails before sending, in the Messages error shape', async () => {
    const up = await upstream();
    const url = await gateway({ messages: up.base }, [up.hostPort]);
    const res = await post(url, '/v1/messages', {
      model: 'zp/glm-5',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'Perform a web search for: nomi' }],
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 8 }],
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      type: 'error',
      error: { type: 'invalid_request_error', message: '当前模型不支持联网搜索（智谱）' },
    });
    expect(up.seen).toHaveLength(0);
  });
});
