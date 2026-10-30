/**
 * 隐私模式端到端（docs/design/secret-privacy.md）：真实监听的网关 + 本地假上游。
 * 假上游在 127.0.0.1，属于本机上游，所以这里都打开 privacy.local。
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import type { GatewayConfig, PrivacyConfig, RuntimeProvider } from '../src/config';
import { allowTagOf, PLACEHOLDER_RE, shapeOf } from '../src/privacy';
import { createGateway, type UsageEvent } from '../src/server';

const SECRET = 'sk-proj-Ab3dEf6hIj9kLm2nOp5qRs8tUv';
const PRIVACY: PrivacyConfig = { enabled: true, local: true, key: 'k' };

interface Seen {
  url: string;
  body: Record<string, unknown>;
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

async function upstream(script: (s: Seen, res: http.ServerResponse) => void) {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const s = { url: req.url ?? '', body: raw ? JSON.parse(raw) : {} };
      seen.push(s);
      script(s, res);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  cleanups.push(() => server.close());
  return { seen, base: `http://127.0.0.1:${port}`, hostPort: `127.0.0.1:${port}` };
}

function provider(id: string, urls: RuntimeProvider['urls']): RuntimeProvider {
  return {
    id,
    name: id,
    enabled: true,
    urls,
    keys: [{ id: 'k1', value: `key-${id}-1`, enabled: true }],
    models: [{ id: 'glm-5', enabled: true }],
  };
}

async function gateway(cfg: Partial<GatewayConfig>, hosts: string[]) {
  const usage: UsageEvent[] = [];
  const gw = createGateway(
    {
      host: '127.0.0.1',
      port: 0,
      providers: [],
      clients: { claude: { token: 'tok-claude', models: { main: 'zp/glm-5' } } },
      allowedPrivateHosts: hosts,
      ...cfg,
    },
    { onUsage: (e) => usage.push(e), streamIdleTimeoutMs: 300 },
  );
  await gw.start();
  cleanups.push(() => gw.stop());
  return { gw, usage, url: gw.listenUrl()! };
}

const post = (url: string, body: unknown) =>
  fetch(`${url}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'tok-claude' },
    body: JSON.stringify(body),
  });

const sse = (evs: Array<Record<string, unknown>>) =>
  evs.map((d) => `event: ${d.type as string}\ndata: ${JSON.stringify(d)}\n\n`).join('');

/** 上游收到的第一个占位符 */
const placeholderIn = (body: unknown) => JSON.stringify(body).match(PLACEHOLDER_RE)?.[0] ?? '';

/** 把占位符切成两半，分两个增量发回来 */
function echoStream(p: string) {
  const delta = (text: string) => ({
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text },
  });
  return sse([
    { type: 'message_start', message: { id: 'm', model: 'glm-5', usage: { input_tokens: 3 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    delta(`key: ${p.slice(0, 7)}`),
    delta(`${p.slice(7)} done`),
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } },
    { type: 'message_stop' },
  ]);
}

const streamText = (text: string) =>
  text
    .split('\n\n')
    .map((b) => /^data: (.*)$/m.exec(b)?.[1])
    .filter((d): d is string => Boolean(d))
    .map((d) => JSON.parse(d) as { type: string; delta?: { text?: string } })
    .filter((d) => d.type === 'content_block_delta')
    .map((d) => d.delta?.text ?? '')
    .join('');

const ask = (stream: boolean) => ({
  model: 'zp/glm-5',
  max_tokens: 100,
  stream,
  messages: [{ role: 'user', content: `my key is ${SECRET}` }],
});

describe('隐私模式', () => {
  it('同协议流式：上游只见占位符，客户端拿回原值', async () => {
    const up = await upstream((s, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(echoStream(placeholderIn(s.body)));
    });
    const { url, usage } = await gateway(
      { providers: [provider('zp', { messages: up.base })], privacy: PRIVACY },
      [up.hostPort],
    );
    const res = await post(url, ask(true));
    const text = await res.text();
    expect(res.headers.get('x-nomi-redacted')).toBe('1');
    expect(JSON.stringify(up.seen[0]!.body)).not.toContain(SECRET);
    expect(placeholderIn(up.seen[0]!.body)).toMatch(/^\{\{API_KEY_[a-z2-7]{8}\}\}$/);
    expect(streamText(text)).toBe(`key: ${SECRET} done`);
    await new Promise((r) => setTimeout(r, 20));
    expect(usage[0]!.redactions).toEqual([
      expect.objectContaining({
        kind: 'API_KEY',
        masked: 1,
        restored: 1,
        len: SECRET.length,
        allowTag: allowTagOf('k', SECRET),
      }),
    ]);
  });

  it('形状保持模式：上游收到同形状的假 key，客户端拿回原值', async () => {
    const fake = shapeOf('k', 'API_KEY', SECRET)!;
    const up = await upstream((s, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(echoStream(JSON.stringify(s.body).includes(fake) ? fake : 'missing'));
    });
    const { url } = await gateway(
      { providers: [provider('zp', { messages: up.base })], privacy: { ...PRIVACY, shape: true } },
      [up.hostPort],
    );
    const text = await (await post(url, ask(true))).text();
    const sent = JSON.stringify(up.seen[0]!.body);
    expect(sent).not.toContain(SECRET);
    expect(sent).toContain(fake);
    expect(streamText(text)).toBe(`key: ${SECRET} done`);
  });

  it('跨协议（Messages 入口 → Chat 上游）也脱敏', async () => {
    const up = await upstream((s, res) => {
      const p = placeholderIn(s.body);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(
        `data: ${JSON.stringify({ id: 'c', model: 'glm-5', choices: [{ index: 0, delta: { content: `k=${p}` } }] })}\n\n` +
          `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\n` +
          'data: [DONE]\n\n',
      );
    });
    const { url } = await gateway(
      { providers: [provider('zp', { chat: `${up.base}/v1` })], privacy: PRIVACY },
      [up.hostPort],
    );
    const text = await (await post(url, ask(true))).text();
    expect(up.seen[0]!.url).toBe('/v1/chat/completions');
    expect(JSON.stringify(up.seen[0]!.body)).not.toContain(SECRET);
    expect(streamText(text)).toBe(`k=${SECRET}`);
  });

  it('非流式：响应体里的占位符还原', async () => {
    const up = await upstream((s, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'm',
          type: 'message',
          role: 'assistant',
          model: 'glm-5',
          content: [
            { type: 'text', text: `saw ${placeholderIn(s.body)}` },
            { type: 'tool_use', id: 't', name: 'w', input: { k: placeholderIn(s.body) } },
          ],
          stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      );
    });
    const { url } = await gateway(
      { providers: [provider('zp', { messages: up.base })], privacy: PRIVACY },
      [up.hostPort],
    );
    const json = (await (await post(url, ask(false))).json()) as {
      content: Array<{ text?: string; input?: { k: string } }>;
    };
    expect(json.content[0]!.text).toBe(`saw ${SECRET}`);
    expect(json.content[1]!.input).toEqual({ k: SECRET });
  });

  it('本机上游默认不脱敏；隐私模式关闭时原样发出', async () => {
    const up = await upstream((_s, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(echoStream('x'));
    });
    for (const privacy of [
      { enabled: true, key: 'k' },
      { ...PRIVACY, enabled: false },
    ]) {
      const { url, usage } = await gateway(
        { providers: [provider('zp', { messages: up.base })], privacy },
        [up.hostPort],
      );
      const res = await post(url, ask(true));
      await res.text();
      expect(res.headers.get('x-nomi-redacted')).toBeNull();
      expect(JSON.stringify(up.seen.at(-1)!.body)).toContain(SECRET);
      await new Promise((r) => setTimeout(r, 20));
      expect(usage[0]!.redactions).toBeUndefined();
    }
  });

  it('设为拦截的类型：请求不发，按入口协议回错误', async () => {
    const up = await upstream((_s, res) => res.end('{}'));
    const { url, usage } = await gateway(
      {
        providers: [provider('zp', { messages: up.base })],
        privacy: { ...PRIVACY, actions: { API_KEY: 'block' } },
      },
      [up.hostPort],
    );
    const res = await post(url, ask(false));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      type: 'error',
      error: { message: expect.stringContaining('API_KEY ×1') },
    });
    expect(up.seen).toHaveLength(0);
    await new Promise((r) => setTimeout(r, 20));
    expect(usage[0]!.blocked).toBe(true);
  });

  it('换快照后已见值还在：第二轮没有上下文的同一个值也遮', async () => {
    const up = await upstream((_s, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(echoStream('x'));
    });
    const cfg = {
      providers: [provider('zp', { messages: up.base })],
      privacy: { ...PRIVACY, strict: true },
    };
    const { url, gw } = await gateway(cfg, [up.hostPort]);
    await (
      await post(url, {
        ...ask(true),
        messages: [{ role: 'user', content: 'DB_PASSWORD=Xk29vLq8Zr4mWp7t' }],
      })
    ).text();
    gw.update({ ...gw.config });
    await (
      await post(url, {
        ...ask(true),
        messages: [{ role: 'user', content: '密码是 Xk29vLq8Zr4mWp7t' }],
      })
    ).text();
    expect(JSON.stringify(up.seen[1]!.body)).not.toContain('Xk29vLq8Zr4mWp7t');
    expect(placeholderIn(up.seen[1]!.body)).toBe(placeholderIn(up.seen[0]!.body));
  });

  describe('初选本机、重试换到云端协议（#150）', () => {
    const CLOUD = 'https://cloud.example.com/v1';
    async function setup(privacy: PrivacyConfig) {
      const up = await upstream((_s, res) => {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not Found' }));
      });
      const cloud: Seen[] = [];
      const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const u = String(input);
        if (!u.startsWith(CLOUD)) return fetch(input, init);
        cloud.push({ url: u, body: JSON.parse(String(init?.body ?? '{}')) });
        return new Response(
          JSON.stringify({
            id: 'c',
            model: 'glm-5',
            choices: [
              { index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }) as typeof fetch;
      const usage: UsageEvent[] = [];
      const gw = createGateway(
        {
          host: '127.0.0.1',
          port: 0,
          providers: [provider('zp', { messages: up.base, chat: CLOUD })],
          clients: { claude: { token: 'tok-claude', models: { main: 'zp/glm-5' } } },
          allowedPrivateHosts: [up.hostPort],
          privacy,
        },
        { onUsage: (e) => usage.push(e), fetchImpl },
      );
      await gw.start();
      cleanups.push(() => gw.stop());
      return { up, cloud, usage, url: gw.listenUrl()! };
    }

    it('云端重试用脱敏后的请求体', async () => {
      const { up, cloud, url } = await setup({ enabled: true, key: 'k' });
      const res = await post(url, ask(false));
      await res.text();
      expect(up.seen).toHaveLength(1);
      // 本机上游不在保护范围（privacy.local 关闭）：原文
      expect(JSON.stringify(up.seen[0]!.body)).toContain(SECRET);
      expect(cloud).toHaveLength(1);
      expect(JSON.stringify(cloud[0]!.body)).not.toContain(SECRET);
      expect(placeholderIn(cloud[0]!.body)).not.toBe('');
    });

    it('命中拦截：不发给云端', async () => {
      const { cloud, url } = await setup({
        enabled: true,
        key: 'k',
        actions: { API_KEY: 'block' },
      });
      const res = await post(url, ask(false));
      expect(res.status).toBe(400);
      expect(cloud).toHaveLength(0);
    });
  });
});
