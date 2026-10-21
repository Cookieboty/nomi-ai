/**
 * 网关服务端到端：真实监听的网关 + 本地假上游。
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import type { GatewayConfig, RuntimeProvider } from '../src/config';
import { createGateway, type GatewayServer, type UsageEvent } from '../src/server';

interface Seen {
  url: string;
  headers: http.IncomingHttpHeaders;
  body: Record<string, unknown>;
}

type Script = (s: Seen, res: http.ServerResponse) => void;

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

async function upstream(script: Script) {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const s = { url: req.url ?? '', headers: req.headers, body: raw ? JSON.parse(raw) : {} };
      seen.push(s);
      script(s, res);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  cleanups.push(() => server.close());
  return { seen, base: `http://127.0.0.1:${port}`, hostPort: `127.0.0.1:${port}` };
}

const sse = (evs: Array<[string | undefined, unknown]>) =>
  evs
    .map(
      ([e, d]) =>
        `${e ? `event: ${e}\n` : ''}data: ${typeof d === 'string' ? d : JSON.stringify(d)}\n\n`,
    )
    .join('');

const chatStream = sse([
  [undefined, { id: 'c1', model: 'glm-up', choices: [{ index: 0, delta: { content: 'Hello' } }] }],
  [
    undefined,
    {
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 7, completion_tokens: 3 },
    },
  ],
  [undefined, '[DONE]'],
]);

function provider(
  id: string,
  urls: RuntimeProvider['urls'],
  extra: Partial<RuntimeProvider> = {},
): RuntimeProvider {
  return {
    id,
    name: id.toUpperCase(),
    enabled: true,
    urls,
    keys: [{ id: 'k1', name: '主 Key', value: `key-${id}-1`, enabled: true }],
    models: [{ id: 'glm-5', enabled: true }],
    ...extra,
  };
}

async function gateway(cfg: Partial<GatewayConfig>, hosts: string[] = []) {
  const usage: UsageEvent[] = [];
  const gw: GatewayServer = createGateway(
    {
      host: '127.0.0.1',
      port: 0,
      providers: [],
      clients: {
        claude: { token: 'tok-claude', models: { main: 'zp/glm-5', small: 'zp/glm-5-air' } },
        codex: { token: 'tok-codex', models: { main: 'zp/glm-5' } },
        gemini: { token: 'tok-gemini', models: { main: 'zp/glm-5' } },
      },
      allowedPrivateHosts: hosts,
      ...cfg,
    },
    { onUsage: (e) => usage.push(e), streamIdleTimeoutMs: 300 },
  );
  await gw.start();
  cleanups.push(() => gw.stop());
  return { gw, usage, url: gw.listenUrl()! };
}

const post = (url: string, path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

function events(text: string) {
  return text
    .split('\n\n')
    .filter(Boolean)
    .map((block) => {
      const ev = /^event: (.+)$/m.exec(block)?.[1];
      const data = /^data: (.+)$/m.exec(block)?.[1] ?? '';
      let json: unknown = data;
      try {
        json = JSON.parse(data);
      } catch {
        /* [DONE] */
      }
      return { ev, data: json as Record<string, unknown> };
    });
}

describe('gateway: access control', () => {
  it('health needs no token; others need a client token; Host and Origin are checked', async () => {
    const { url } = await gateway({});
    expect(await (await fetch(`${url}/health`)).json()).toMatchObject({
      ok: true,
      service: 'nomi-gateway',
    });
    const noTok = await post(url, '/v1/messages', { model: 'x' });
    expect(noTok.status).toBe(401);
    expect(await noTok.json()).toMatchObject({
      type: 'error',
      error: { type: 'authentication_error' },
    });
    const browser = await post(
      url,
      '/v1/messages',
      {},
      { 'x-api-key': 'tok-claude', origin: 'https://evil.example' },
    );
    expect(browser.status).toBe(403);
    const port = new URL(url).port;
    const rebind = await new Promise<number>((resolve) => {
      const r = http.request(
        { host: '127.0.0.1', port, path: '/health', headers: { host: `evil.example:${port}` } },
        (res) => resolve(res.statusCode ?? 0),
      );
      r.end();
    });
    expect(rebind).toBe(421);
  });

  it('lists models in the format of the auth header / path', async () => {
    const { url } = await gateway({ providers: [provider('zp', { chat: 'http://x/v1' })] });
    const openai = await (
      await fetch(`${url}/v1/models`, { headers: { authorization: 'Bearer tok-codex' } })
    ).json();
    expect(openai).toMatchObject({ object: 'list', data: [{ id: 'zp/glm-5' }] });
    const anthropic = await (
      await fetch(`${url}/v1/models`, { headers: { 'x-api-key': 'tok-claude' } })
    ).json();
    expect(anthropic).toMatchObject({ data: [{ type: 'model', id: 'zp/glm-5' }] });
    const gemini = await (await fetch(`${url}/v1beta/models?key=tok-gemini`)).json();
    expect(gemini).toMatchObject({ models: [{ name: 'models/zp/glm-5' }] });
  });
});

describe('gateway: routing and conversion', () => {
  it('a local service without a key: routed with an empty key and no auth header', async () => {
    const up = await upstream((_s, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(chatStream);
    });
    const { url } = await gateway(
      {
        providers: [
          provider(
            'ollama',
            { chat: `${up.base}/v1` },
            { keys: [{ id: 'none', value: '', enabled: true }] },
          ),
        ],
        clients: { codex: { token: 'tok-codex', models: { main: 'ollama/glm-5' } } },
      },
      [up.hostPort],
    );
    const res = await post(
      url,
      '/v1/chat/completions',
      { model: 'ollama/glm-5', stream: true, messages: [{ role: 'user', content: 'hi' }] },
      { authorization: 'Bearer tok-codex' },
    );
    expect(res.status).toBe(200);
    await res.text();
    expect(up.seen[0]!.headers.authorization).toBeUndefined();
    expect(up.seen[0]!.headers['x-api-key']).toBeUndefined();
  });

  it('Claude Code (Messages) on a Chat-only provider: converts both ways and reports usage', async () => {
    const up = await upstream((_s, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(chatStream);
    });
    const { url, usage } = await gateway(
      {
        providers: [
          provider(
            'zp',
            { chat: `${up.base}/v1` },
            { modelMap: [{ from: 'glm-5', to: 'glm-up' }] },
          ),
        ],
      },
      [up.hostPort],
    );
    const res = await post(
      url,
      '/v1/messages?beta=true',
      {
        model: 'zp/glm-5',
        stream: true,
        max_tokens: 100,
        messages: [{ role: 'user', content: 'hi' }],
      },
      { 'x-api-key': 'tok-claude', 'x-api-key-inherited': 'should-not-leak' },
    );
    const evs = events(await res.text());
    expect(evs.find((e) => e.ev === 'content_block_delta')?.data).toMatchObject({
      delta: { text: 'Hello' },
    });
    expect(evs.at(-1)?.ev).toBe('message_stop');
    expect(up.seen[0]!.url).toBe('/v1/chat/completions');
    expect(up.seen[0]!.headers.authorization).toBe('Bearer key-zp-1');
    expect(up.seen[0]!.headers['x-api-key']).toBeUndefined();
    expect(up.seen[0]!.body).toMatchObject({
      model: 'glm-up',
      stream: true,
      stream_options: { include_usage: true },
    });
    expect(usage[0]).toMatchObject({
      client: 'claude',
      ingress: 'messages',
      wire: 'chat',
      provider: 'zp',
      model: 'zp/glm-5',
      status: 200,
      usage: { inputTokens: 7, outputTokens: 3 },
      attempts: 1,
    });
  });

  it('same protocol is passed through surgically: unknown fields kept, only the model replaced', async () => {
    const up = await upstream((_s, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(chatStream);
    });
    const { url } = await gateway({ providers: [provider('zp', { chat: `${up.base}/v1` })] }, [
      up.hostPort,
    ]);
    const res = await post(
      url,
      '/v1/chat/completions',
      { model: 'zp/glm-5', stream: true, messages: [], brand_new_param: { x: 1 } },
      { authorization: 'Bearer tok-codex' },
    );
    expect(await res.text()).toBe(chatStream);
    expect(up.seen[0]!.body).toMatchObject({ model: 'glm-5', brand_new_param: { x: 1 } });
  });

  it('a Claude model on a relay with Messages goes over Messages even from a Chat client', async () => {
    const up = await upstream((s, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'm',
          type: 'message',
          role: 'assistant',
          model: 'claude-opus',
          content: [{ type: 'text', text: 'ok' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      );
      void s;
    });
    const relay = provider(
      'relay',
      { chat: `${up.base}/v1`, messages: up.base },
      { models: [{ id: 'claude-opus', enabled: true }] },
    );
    const { url } = await gateway({ providers: [relay] }, [up.hostPort]);
    const res = await post(
      url,
      '/v1/chat/completions',
      { model: 'relay/claude-opus', messages: [{ role: 'user', content: 'hi' }] },
      { authorization: 'Bearer tok-codex' },
    );
    expect(up.seen[0]!.url).toBe('/v1/messages');
    expect(up.seen[0]!.headers['x-api-key']).toBe('key-relay-1');
    expect(await res.json()).toMatchObject({
      object: 'chat.completion',
      choices: [{ message: { content: 'ok' } }],
    });
  });

  it('falls back to the next key on 429, but does not retry a plain 400', async () => {
    let n = 0;
    const up = await upstream((s, res) => {
      n++;
      const key = s.headers.authorization;
      if (key === 'Bearer key-zp-1') {
        res.writeHead(429, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'slow down' } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(chatStream);
    });
    const p = provider(
      'zp',
      { chat: `${up.base}/v1` },
      {
        keys: [
          { id: 'k1', value: 'key-zp-1', enabled: true },
          { id: 'k2', value: 'key-zp-2', enabled: true },
        ],
      },
    );
    const { url, usage } = await gateway({ providers: [p] }, [up.hostPort]);
    const ok = await post(
      url,
      '/v1/chat/completions',
      { model: 'zp/glm-5', stream: true, messages: [] },
      { authorization: 'Bearer tok-codex' },
    );
    expect(await ok.text()).toBe(chatStream);
    expect(n).toBe(2);
    expect(usage.at(-1)).toMatchObject({ keyId: 'k2', attempts: 2 });

    const bad = await upstream((_s, res) => {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'messages must not be empty' } }));
    });
    const p2 = { ...p, urls: { chat: `${bad.base}/v1` } };
    const g2 = await gateway({ providers: [p2] }, [bad.hostPort]);
    const r = await post(
      g2.url,
      '/v1/messages',
      { model: 'zp/glm-5', max_tokens: 1, messages: [] },
      { 'x-api-key': 'tok-claude' },
    );
    expect(r.status).toBe(400);
    expect(await r.json()).toMatchObject({
      type: 'error',
      error: { type: 'invalid_request_error', message: 'messages must not be empty' },
    });
    expect(bad.seen).toHaveLength(1);
  });

  it('model names: Claude built-ins map to the configured tiers; unknown names get suggestions', async () => {
    const up = await upstream((_s, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(chatStream);
    });
    const zp = provider(
      'zp',
      { chat: `${up.base}/v1` },
      {
        models: [
          { id: 'glm-5', enabled: true },
          { id: 'glm-5-air', enabled: true },
        ],
      },
    );
    const { url } = await gateway({ providers: [zp] }, [up.hostPort]);
    await (
      await post(
        url,
        '/v1/messages',
        { model: 'claude-haiku-4-5', stream: true, max_tokens: 5, messages: [] },
        { 'x-api-key': 'tok-claude' },
      )
    ).text();
    expect(up.seen[0]!.body.model).toBe('glm-5-air');
    await (
      await post(
        url,
        '/v1/messages',
        { model: 'glm-5', stream: true, max_tokens: 5, messages: [] },
        { 'x-api-key': 'tok-claude' },
      )
    ).text();
    expect(up.seen[1]!.body.model).toBe('glm-5');
    // 带供应商前缀的名字原样转发（供应商的模型列表可能不全）；找不到的裸名才返回 404，并给出最接近的
    const nf = await post(
      url,
      '/v1/messages',
      { model: 'glm-6', max_tokens: 5, messages: [] },
      { 'x-api-key': 'tok-claude' },
    );
    expect(nf.status).toBe(404);
    expect(await nf.json()).toMatchObject({
      type: 'error',
      error: { type: 'not_found_error', message: expect.stringContaining('`zp/glm-5`') },
    });
  });

  it('Gemini CLI: model in the path, converted to an Anthropic-only upstream, Gemini SSE back', async () => {
    const up = await upstream((_s, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(
        sse([
          [
            'message_start',
            {
              type: 'message_start',
              message: { id: 'm', model: 'k3', usage: { input_tokens: 4 } },
            },
          ],
          [
            'content_block_start',
            { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          ],
          [
            'content_block_delta',
            {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'text_delta', text: 'Hi from Kimi' },
            },
          ],
          ['content_block_stop', { type: 'content_block_stop', index: 0 }],
          [
            'message_delta',
            {
              type: 'message_delta',
              delta: { stop_reason: 'end_turn' },
              usage: { output_tokens: 2 },
            },
          ],
          ['message_stop', { type: 'message_stop' }],
        ]),
      );
    });
    const kimi = provider(
      'kimi',
      { messages: up.base },
      { models: [{ id: 'kimi-k3', enabled: true }] },
    );
    const { url } = await gateway({ providers: [kimi] }, [up.hostPort]);
    const res = await post(
      url,
      '/v1beta/models/kimi/kimi-k3:streamGenerateContent?alt=sse',
      {
        contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
        generationConfig: { maxOutputTokens: 50 },
      },
      { 'x-goog-api-key': 'tok-gemini' },
    );
    const evs = events(await res.text());
    expect(evs.map((e) => e.data)).toContainEqual(
      expect.objectContaining({
        candidates: [
          expect.objectContaining({
            content: { role: 'model', parts: [{ text: 'Hi from Kimi' }] },
          }),
        ],
      }),
    );
    expect(up.seen[0]!.url).toBe('/v1/messages');
    expect(up.seen[0]!.body).toMatchObject({ model: 'kimi-k3', max_tokens: 50, stream: true });
  });

  it('count_tokens is estimated locally when the upstream is not Messages', async () => {
    const { url } = await gateway({
      providers: [provider('zp', { chat: 'https://example.invalid/v1' })],
    });
    const r = await post(
      url,
      '/v1/messages/count_tokens',
      { model: 'zp/glm-5', messages: [{ role: 'user', content: 'hello world' }] },
      { 'x-api-key': 'tok-claude' },
    );
    expect((await r.json()) as { input_tokens: number }).toMatchObject({
      input_tokens: expect.any(Number),
    });
  });

  it('refuses private upstreams that the user has not confirmed', async () => {
    const up = await upstream((_s, res) => res.end('{}'));
    const { url } = await gateway({ providers: [provider('local', { chat: `${up.base}/v1` })] });
    const r = await post(
      url,
      '/v1/chat/completions',
      { model: 'local/glm-5', messages: [] },
      { authorization: 'Bearer tok-codex' },
    );
    expect(r.status).toBe(400);
    expect(JSON.stringify(await r.json())).toContain('需要先在供应商设置里确认');
    expect(up.seen).toHaveLength(0);
  });

  it('an upstream that goes silent mid-stream gets an error event instead of hanging', async () => {
    const up = await upstream((_s, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(sse([[undefined, { choices: [{ index: 0, delta: { content: 'part' } }] }]]));
      // 之后不再发任何东西
    });
    const { url } = await gateway({ providers: [provider('zp', { chat: `${up.base}/v1` })] }, [
      up.hostPort,
    ]);
    const res = await post(
      url,
      '/v1/messages',
      { model: 'zp/glm-5', stream: true, max_tokens: 5, messages: [] },
      { 'x-api-key': 'tok-claude' },
    );
    const evs = events(await res.text());
    expect(evs.at(-1)).toMatchObject({ ev: 'error' });
    expect(JSON.stringify(evs.at(-1)?.data)).toContain('没有任何输出');
  });

  it('accepts the legacy shared token and infers the client from the path', async () => {
    const up = await upstream((_s, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(chatStream);
    });
    const { url, usage } = await gateway(
      { providers: [provider('zp', { chat: `${up.base}/v1` })], legacyToken: 'nomi-route-old' },
      [up.hostPort],
    );
    // 旧配置里写的是裸模型名，按唯一命中解析
    await (
      await post(
        url,
        '/v1/messages',
        { model: 'glm-5', stream: true, max_tokens: 5, messages: [] },
        { 'x-api-key': 'nomi-route-old' },
      )
    ).text();
    expect(up.seen[0]!.body.model).toBe('glm-5');
    expect(usage[0]).toMatchObject({ client: 'legacy' });
  });
});
