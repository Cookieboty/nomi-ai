/**
 * 提交点（docs/design/cli-plugin-architecture.md §6.11.2）与背压（§6.11.4）：
 * 上游先回 200、第一个事件就是错误时换候选；有内容之后的错误只能变成流里的失败事件。
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { peekCommit } from '../src/commit';
import type { GatewayConfig } from '../src/config';
import { createGateway, type UsageEvent } from '../src/server';

type Script = (key: string, res: http.ServerResponse) => void;

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

const sse = (...chunks: unknown[]) =>
  chunks.map((c) => `data: ${typeof c === 'string' ? c : JSON.stringify(c)}\n\n`).join('');
const roleChunk = { id: 'c1', choices: [{ index: 0, delta: { role: 'assistant' } }] };
const hello = { id: 'c1', choices: [{ index: 0, delta: { content: 'Hello' } }] };
const stop = { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] };
const okStream = sse(roleChunk, hello, stop, '[DONE]');

async function setup(script: Script) {
  const keys: string[] = [];
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const key = String(req.headers.authorization ?? '').replace(/^Bearer key-zp-/, 'k');
      keys.push(key);
      script(key, res);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  cleanups.push(() => server.close());
  const port = (server.address() as AddressInfo).port;
  const usage: UsageEvent[] = [];
  const cfg: GatewayConfig = {
    host: '127.0.0.1',
    port: 0,
    providers: [
      {
        id: 'zp',
        name: 'ZP',
        enabled: true,
        urls: { chat: `http://127.0.0.1:${port}/v1` },
        keys: [
          { id: 'k1', value: 'key-zp-1', enabled: true },
          { id: 'k2', value: 'key-zp-2', enabled: true },
        ],
        models: [{ id: 'glm-5', enabled: true }],
      },
    ],
    clients: { codex: { token: 'tok-codex', models: { main: 'zp/glm-5' } } },
    allowedPrivateHosts: [`127.0.0.1:${port}`],
  };
  const gw = createGateway(cfg, { onUsage: (e) => usage.push(e), streamIdleTimeoutMs: 2_000 });
  await gw.start();
  cleanups.push(() => gw.stop());
  const chat = () =>
    fetch(`${gw.listenUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer tok-codex' },
      body: JSON.stringify({ model: 'zp/glm-5', stream: true, messages: [] }),
    });
  return { keys, usage, chat };
}

const sseHead = (res: http.ServerResponse) =>
  res.writeHead(200, { 'content-type': 'text/event-stream' });

describe('commit point (§6.11.2)', () => {
  it('an error event before any content falls back to the next candidate', async () => {
    const t = await setup((key, res) => {
      sseHead(res);
      if (key === 'k1') res.end(sse(roleChunk, { error: { message: 'upstream overloaded' } }));
      else res.end(okStream);
    });
    const r = await t.chat();
    expect(r.status).toBe(200);
    const text = await r.text();
    expect(text).toContain('Hello');
    expect(text).not.toContain('overloaded');
    expect(t.keys).toEqual(['k1', 'k2']);
    expect(t.usage[0]).toMatchObject({ status: 200, keyId: 'k2', attempts: 2 });
  });

  it('after the first content event an error stays in the stream (no fallback)', async () => {
    const t = await setup((_key, res) => {
      sseHead(res);
      res.end(sse(roleChunk, hello, { error: { message: 'boom mid-stream' } }));
    });
    const r = await t.chat();
    const text = await r.text();
    expect(r.status).toBe(200);
    expect(text).toContain('Hello');
    expect(text).toContain('boom mid-stream');
    expect(t.keys).toEqual(['k1']);
  });

  it('every candidate failing before commit → an HTTP error, rate limits map to 429', async () => {
    const t = await setup((_key, res) => {
      sseHead(res);
      res.end(sse({ error: { message: 'Rate limit exceeded', type: 'rate_limit_error' } }));
    });
    const r = await t.chat();
    expect(r.status).toBe(429);
    expect(await r.text()).toContain('Rate limit exceeded');
    expect(t.keys).toEqual(['k1', 'k2']);
  });

  it('a stream without any terminal marker still commits and is reported as truncated', async () => {
    const t = await setup((_key, res) => {
      sseHead(res);
      res.end(sse(roleChunk, hello));
    });
    const r = await t.chat();
    const text = await r.text();
    expect(text).toContain('Hello');
    expect(text).toContain('没有发结束标记');
    expect(t.keys).toEqual(['k1']);
  });
});

describe('peekCommit', () => {
  const bytes = (s: string) => new TextEncoder().encode(s);
  const streamOf = (parts: Array<string | (() => Promise<void>)>) =>
    new Response(
      new ReadableStream<Uint8Array>({
        async start(ctrl) {
          for (const p of parts) {
            if (typeof p === 'string') ctrl.enqueue(bytes(p));
            else await p();
          }
          ctrl.close();
        },
      }),
      { headers: { 'content-type': 'text/event-stream' } },
    );

  it('replays every byte it read, in order, after committing', async () => {
    const parts = [sse(roleChunk), sse(hello), sse(stop), 'data: [DONE]\n\n'];
    const p = await peekCommit(streamOf(parts), 'chat');
    expect(p.kind).toBe('commit');
    if (p.kind !== 'commit') return;
    expect(await p.res.text()).toBe(parts.join(''));
  });

  it('commits after maxEvents meta events without content', async () => {
    const metas = Array.from({ length: 12 }, () => sse(roleChunk));
    const p = await peekCommit(streamOf([...metas, sse(hello)]), 'chat', { maxEvents: 3 });
    expect(p.kind).toBe('commit');
    if (p.kind === 'commit') expect(await p.res.text()).toBe([...metas, sse(hello)].join(''));
  });

  it('commits on timeout and keeps the pending read; calls onWaiting once', async () => {
    let waiting = 0;
    const later = () => new Promise<void>((r) => setTimeout(r, 120));
    const p = await peekCommit(streamOf([sse(roleChunk), later, sse(hello)]), 'chat', {
      maxMs: 60,
      waitingMs: 20,
      onWaiting: () => waiting++,
    });
    expect(p.kind).toBe('commit');
    expect(waiting).toBe(1);
    if (p.kind === 'commit') expect(await p.res.text()).toBe(sse(roleChunk) + sse(hello));
  });

  it('Responses: response.failed before content is an error; Messages: error event too', async () => {
    const failed = await peekCommit(
      streamOf([
        sse({ type: 'response.created', response: { id: 'r' } }),
        sse({ type: 'response.failed', response: { error: { message: 'nope' } } }),
      ]),
      'responses',
    );
    expect(failed).toMatchObject({ kind: 'error', message: 'nope', status: 502 });
    const overloaded = await peekCommit(
      streamOf([
        'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n',
      ]),
      'messages',
    );
    expect(overloaded).toMatchObject({ kind: 'error', status: 529, upstreamStatus: 529 });
  });
});

describe('backpressure (§6.11.4)', () => {
  it('a large passthrough stream arrives complete and in order', async () => {
    const n = 4000;
    const big = 'x'.repeat(2_000);
    const chunks = Array.from({ length: n }, (_, i) => ({
      id: 'c1',
      choices: [{ index: 0, delta: { content: `${i}:${big}|` } }],
    }));
    const t = await setup((_key, res) => {
      sseHead(res);
      for (const c of chunks) res.write(sse(c));
      res.end(sse(stop, '[DONE]'));
    });
    const r = await t.chat();
    const text = await r.text();
    const seen = [...text.matchAll(/"content":"(\d+):/g)].map((m) => Number(m[1]));
    expect(seen).toHaveLength(n);
    expect(seen.every((v, i) => v === i)).toBe(true);
    expect(text).toContain('[DONE]');
  });
});
