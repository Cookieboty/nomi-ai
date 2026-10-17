/* eslint-disable @typescript-eslint/no-explicit-any -- 测试中以动态 JSON 断言 SSE 负载 */
jest.unmock('fs');
jest.unmock('node:fs');
jest.unmock('path');
jest.unmock('node:path');
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';

import type { CliApiFormat } from '../../../../src/cli/formats';
import { CliRouteService } from '../../../../src/cli/routing/CliRouteService';
import { SseParser } from '../../../../src/cli/routing/stream';

/** 假上游：记录请求，按脚本分片吐 SSE */
function startUpstream(
  script: (req: { url: string; body: any }, res: http.ServerResponse) => void,
) {
  const seen: Array<{
    url: string;
    body: any;
    accept?: string;
    headers: http.IncomingHttpHeaders;
  }> = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(Buffer.from(c)));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      seen.push({ url: req.url ?? '', body, accept: req.headers.accept, headers: req.headers });
      script({ url: req.url ?? '', body }, res);
    });
  });
  return new Promise<{ base: string; seen: typeof seen; close: () => void }>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ base: `http://127.0.0.1:${port}`, seen, close: () => server.close() });
    });
  });
}

/** 带上本地路由令牌的 fetch（路由要求 x-api-key / Bearer 令牌） */
const routeFetch = (svc: CliRouteService, input: string, init: RequestInit = {}) =>
  fetch(input, {
    ...init,
    headers: { 'x-api-key': svc.authToken(), ...((init.headers as Record<string, string>) ?? {}) },
  });

async function startRoute(kind: 'claude' | 'codex', baseUrl: string, apiFormat: CliApiFormat) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nomi-route-'));
  const probe = http.createServer();
  const port = await new Promise<number>((r) =>
    probe.listen(0, '127.0.0.1', () => r((probe.address() as AddressInfo).port)),
  );
  await new Promise((r) => probe.close(r));
  fs.writeFileSync(
    path.join(root, 'routing.json'),
    JSON.stringify({ enabled: true, host: '127.0.0.1', port, claude: true, codex: true }),
  );
  const svc = new CliRouteService({
    root,
    logger: { info: () => undefined, warn: () => undefined },
    resolveUpstream: (k) =>
      k === kind ? { kind, baseUrl, apiKey: 'k', model: 'up-model', apiFormat } : null,
  });
  await svc.start();
  return { svc, url: `http://127.0.0.1:${port}` };
}

async function readSse(res: Response) {
  const p = new SseParser();
  const text = await res.text();
  return [...p.push(text), ...p.end()].map((e) => ({
    event: e.event,
    data: e.data === '[DONE]' ? '[DONE]' : JSON.parse(e.data),
  }));
}

function writeSlowly(res: http.ServerResponse, raw: string, size = 9) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  let i = 0;
  const tick = () => {
    if (i >= raw.length) return res.end();
    res.write(raw.slice(i, i + size));
    i += size;
    setImmediate(tick);
  };
  tick();
}

describe('CliRouteService streaming', () => {
  const cleanup: Array<() => void> = [];
  afterEach(() => {
    while (cleanup.length) cleanup.pop()!();
  });

  it('claude ← chat completions upstream: SSE converted to Messages events', async () => {
    const raw =
      'data: {"id":"c1","model":"m","choices":[{"index":0,"delta":{"content":"Hi"}}]}\n\n' +
      'data: {"id":"c1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n' +
      'data: [DONE]\n\n';
    const up = await startUpstream((_r, res) => writeSlowly(res, raw));
    const { svc, url } = await startRoute('claude', up.base, 'openai_chat_completions');
    cleanup.push(up.close, () => svc.stop());

    const res = await routeFetch(svc, `${url}/v1/messages`, {
      method: 'POST',
      body: JSON.stringify({
        model: 'x',
        stream: true,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const evs = await readSse(res);
    expect(evs.map((e) => e.event)).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ]);
    expect(up.seen[0].url).toBe('/chat/completions');
    expect(up.seen[0].accept).toBe('text/event-stream');
    expect(up.seen[0].body).toMatchObject({
      stream: true,
      stream_options: { include_usage: true },
    });
  });

  it('claude ← gemini upstream uses streamGenerateContent?alt=sse', async () => {
    const raw =
      'data: {"candidates":[{"content":{"parts":[{"text":"ok"}]},"finishReason":"STOP"}]}\r\n\r\n';
    const up = await startUpstream((_r, res) => writeSlowly(res, raw));
    const { svc, url } = await startRoute(
      'claude',
      up.base,
      'gemini_generate_content' as CliApiFormat,
    );
    cleanup.push(up.close, () => svc.stop());
    const res = await routeFetch(svc, `${url}/v1/messages`, {
      method: 'POST',
      body: JSON.stringify({ stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    });
    const evs = await readSse(res);
    expect(up.seen[0].url).toBe('/v1beta/models/up-model:streamGenerateContent?alt=sse');
    expect(up.seen[0].headers['x-goog-api-key']).toBe('k');
    expect(up.seen[0].headers.authorization).toBeUndefined();
    expect(up.seen[0].body.model).toBeUndefined();
    expect(evs.find((e) => e.event === 'content_block_delta')!.data.delta.text).toBe('ok');
  });

  it('codex ← anthropic messages upstream: Responses events', async () => {
    const raw = [
      [
        'message_start',
        { type: 'message_start', message: { id: 'msg_1', usage: { input_tokens: 1 } } },
      ],
      [
        'content_block_delta',
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'yo' } },
      ],
      [
        'message_delta',
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
      ],
      ['message_stop', { type: 'message_stop' }],
    ]
      .map(([e, d]) => `event: ${e as string}\ndata: ${JSON.stringify(d)}\n\n`)
      .join('');
    const up = await startUpstream((_r, res) => writeSlowly(res, raw));
    const { svc, url } = await startRoute('codex', up.base, 'anthropic_messages');
    cleanup.push(up.close, () => svc.stop());
    const res = await routeFetch(svc, `${url}/v1/responses`, {
      method: 'POST',
      body: JSON.stringify({ stream: true, input: [{ role: 'user', content: 'hi' }] }),
    });
    const evs = await readSse(res);
    expect(up.seen[0].url).toBe('/v1/messages');
    const last = evs[evs.length - 1];
    expect(last.event).toBe('response.completed');
    expect(last.data.response.output[0].content[0].text).toBe('yo');
  });

  it('native passthrough streams bytes unchanged', async () => {
    const raw = 'event: response.created\ndata: {"type":"response.created"}\n\n';
    const up = await startUpstream((_r, res) => writeSlowly(res, raw, 4));
    const { svc, url } = await startRoute('codex', up.base, 'openai_responses');
    cleanup.push(up.close, () => svc.stop());
    const res = await routeFetch(svc, `${url}/v1/responses`, {
      method: 'POST',
      body: JSON.stringify({ stream: true, input: [] }),
    });
    expect(await res.text()).toBe(raw);
  });

  it('upstream connection drop mid-stream → downstream error event', async () => {
    const up = await startUpstream((_r, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"id":"c","choices":[{"index":0,"delta":{"content":"pa"}}]}\n\n');
      setTimeout(() => res.socket?.destroy(), 20);
    });
    const { svc, url } = await startRoute('codex', up.base, 'openai_chat_completions');
    cleanup.push(up.close, () => svc.stop());
    const res = await routeFetch(svc, `${url}/v1/responses`, {
      method: 'POST',
      body: JSON.stringify({ stream: true, input: [{ role: 'user', content: 'hi' }] }),
    });
    const evs = await readSse(res);
    expect(evs[evs.length - 1].event).toBe('response.failed');
  });

  it('upstream HTTP error is forwarded with status', async () => {
    const up = await startUpstream((_r, res) => {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end('{"error":{"message":"bad key"}}');
    });
    const { svc, url } = await startRoute('claude', up.base, 'openai_responses');
    cleanup.push(up.close, () => svc.stop());
    const res = await routeFetch(svc, `${url}/v1/messages`, {
      method: 'POST',
      body: JSON.stringify({ stream: true, messages: [] }),
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: { message: 'bad key' } });
  });
});

describe('CliRouteService JSON → SSE fallback', () => {
  const cleanup: Array<() => void> = [];
  afterEach(() => {
    while (cleanup.length) cleanup.pop()!();
  });
  const json = (body: unknown) => (_r: unknown, res: http.ServerResponse) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  it('claude ← chat completions JSON with tool call becomes Messages SSE', async () => {
    const up = await startUpstream(
      json({
        id: 'c1',
        model: 'm',
        choices: [
          {
            message: {
              content: 'checking',
              tool_calls: [
                { id: 'call_1', type: 'function', function: { name: 'ls', arguments: '{"p":1}' } },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
        usage: { prompt_tokens: 3, completion_tokens: 4 },
      }),
    );
    const { svc, url } = await startRoute('claude', up.base, 'openai_chat_completions');
    cleanup.push(up.close, () => svc.stop());
    const res = await routeFetch(svc, `${url}/v1/messages`, {
      method: 'POST',
      body: JSON.stringify({ stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const evs = await readSse(res);
    expect(evs.map((e) => e.event)).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ]);
    expect(evs[4].data.content_block).toMatchObject({ type: 'tool_use', id: 'call_1', name: 'ls' });
    expect(evs[5].data.delta.partial_json).toBe('{"p":1}');
    expect(evs[7].data).toMatchObject({
      delta: { stop_reason: 'tool_use' },
      usage: { output_tokens: 4 },
    });
  });

  it('codex ← anthropic JSON becomes Responses SSE', async () => {
    const up = await startUpstream(
      json({
        id: 'msg_1',
        type: 'message',
        content: [{ type: 'text', text: 'hello' }],
        stop_reason: 'max_tokens',
        usage: { input_tokens: 1, output_tokens: 2 },
      }),
    );
    const { svc, url } = await startRoute('codex', up.base, 'anthropic_messages');
    cleanup.push(up.close, () => svc.stop());
    const res = await routeFetch(svc, `${url}/v1/responses`, {
      method: 'POST',
      body: JSON.stringify({ stream: true, input: 'hi' }),
    });
    const evs = await readSse(res);
    const last = evs[evs.length - 1];
    expect(last.event).toBe('response.incomplete');
    expect(last.data.response.output[0].content[0].text).toBe('hello');
  });

  it('native passthrough JSON is also turned into SSE', async () => {
    const up = await startUpstream(
      json({
        id: 'resp_1',
        status: 'completed',
        output: [{ type: 'message', content: [{ type: 'output_text', text: 'x' }] }],
      }),
    );
    const { svc, url } = await startRoute('codex', up.base, 'openai_responses');
    cleanup.push(up.close, () => svc.stop());
    const res = await routeFetch(svc, `${url}/v1/responses`, {
      method: 'POST',
      body: JSON.stringify({ stream: true, input: 'hi' }),
    });
    const evs = await readSse(res);
    expect(evs[0].event).toBe('response.created');
    expect(evs[evs.length - 1].event).toBe('response.completed');
  });

  it('non-streaming requests still get JSON', async () => {
    const up = await startUpstream(json({ id: 'c', choices: [{ message: { content: 'pong' } }] }));
    const { svc, url } = await startRoute('claude', up.base, 'openai_chat_completions');
    cleanup.push(up.close, () => svc.stop());
    const res = await routeFetch(svc, `${url}/v1/messages`, {
      method: 'POST',
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect((await res.json()).content[0].text).toBe('pong');
  });
});

describe('CliRouteService non-streaming conversion', () => {
  const cleanup: Array<() => void> = [];
  afterEach(() => {
    while (cleanup.length) cleanup.pop()!();
  });

  it('claude ← chat completions JSON keeps tool calls', async () => {
    const up = await startUpstream((_r, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'c',
          choices: [
            {
              message: {
                tool_calls: [{ id: 'call_1', function: { name: 'ls', arguments: '{}' } }],
              },
              finish_reason: 'tool_calls',
            },
          ],
        }),
      );
    });
    const { svc, url } = await startRoute('claude', up.base, 'openai_chat_completions');
    cleanup.push(up.close, () => svc.stop());
    const res = await routeFetch(svc, `${url}/v1/messages`, {
      method: 'POST',
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    });
    const body = await res.json();
    expect(body.stop_reason).toBe('tool_use');
    expect(body.content).toEqual([{ type: 'tool_use', id: 'call_1', name: 'ls', input: {} }]);
  });
});

describe('CliRouteService custom tools', () => {
  const cleanup: Array<() => void> = [];
  afterEach(() => {
    while (cleanup.length) cleanup.pop()!();
  });

  it('codex request with a custom tool gets custom_tool_call back (non-streaming)', async () => {
    const up = await startUpstream((_r, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'msg',
          content: [
            { type: 'tool_use', id: 'toolu_1', name: 'apply_patch', input: { input: 'PATCH' } },
          ],
          stop_reason: 'tool_use',
        }),
      );
    });
    const { svc, url } = await startRoute('codex', up.base, 'anthropic_messages');
    cleanup.push(up.close, () => svc.stop());
    const res = await routeFetch(svc, `${url}/v1/responses`, {
      method: 'POST',
      body: JSON.stringify({
        input: 'hi',
        tools: [{ type: 'custom', name: 'apply_patch', description: 'd' }],
      }),
    });
    const body = await res.json();
    expect(body.output[0]).toMatchObject({
      type: 'custom_tool_call',
      call_id: 'toolu_1',
      input: 'PATCH',
    });
    // 上游收到的是单字符串参数的普通工具
    expect(up.seen[0].body.tools[0].input_schema.properties.input.type).toBe('string');
  });
});
