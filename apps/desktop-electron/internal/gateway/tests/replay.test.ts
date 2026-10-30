/**
 * 回放夹具（docs/development/testing.md「网关回放夹具」、P11）：tests/fixtures/replay/*.json 里每个夹具
 * 都把录下的上游原文逐块回放给网关，断言给客户端的输出通过入口协议的规范校验、以结束或失败事件收尾，
 * 并对规范化后的客户端事件做快照。夹具由 scripts/trace-to-fixture.ts 从诊断追踪生成。
 */
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  splitChunks,
  stripFragment,
  stripText,
  TEXT_PLACEHOLDER,
  traceToFixture,
  type ReplayFixture,
} from '../scripts/traceFixture';
import type { GatewayConfig } from '../src/config';
import { createGateway } from '../src/server';
import { parseSpecEvents, specOf, validateSse } from '../src/spec/index';

const DIR = path.join(__dirname, 'fixtures', 'replay');
const TOKEN = 'tok-replay-abcdef';

const fixtures: ReplayFixture[] = fs
  .readdirSync(DIR)
  .filter((n) => n.endsWith('.json'))
  .sort()
  .map((n) => JSON.parse(fs.readFileSync(path.join(DIR, n), 'utf8')) as ReplayFixture);

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

/** 假上游：任何请求都按夹具逐块写出录下的原文 */
async function replayUpstream(f: ReplayFixture): Promise<{ base: string; hostPort: string }> {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(f.upstream.status, { 'content-type': f.upstream.contentType });
      const chunks = [...f.upstream.chunks];
      const next = () => {
        const c = chunks.shift();
        if (c === undefined) return void res.end();
        res.write(c);
        setImmediate(next);
      };
      next();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  cleanups.push(() => new Promise<void>((r) => server.close(() => r())));
  const port = (server.address() as AddressInfo).port;
  return { base: `http://127.0.0.1:${port}`, hostPort: `127.0.0.1:${port}` };
}

function config(f: ReplayFixture, up: { base: string; hostPort: string }): GatewayConfig {
  return {
    host: '127.0.0.1',
    port: 0,
    allowedPrivateHosts: [up.hostPort],
    providers: [
      {
        id: 'up',
        name: 'Up',
        enabled: true,
        urls: { [f.upstream.wire]: up.base },
        keys: [{ id: 'k1', name: 'k', value: 'up-secret-value-123456', enabled: true }],
        models: [{ id: f.upstream.model, enabled: true }],
      },
    ],
    clients: { [f.client]: { token: TOKEN, models: { main: `up/${f.upstream.model}` } } },
  } as GatewayConfig;
}

const authHeaders = (wire: ReplayFixture['ingress']): Record<string, string> =>
  wire === 'messages'
    ? { 'x-api-key': TOKEN }
    : wire === 'gemini'
      ? { 'x-goog-api-key': TOKEN }
      : { authorization: `Bearer ${TOKEN}` };

/** 快照用：去掉每次都变的 id / 时间戳，只留事件结构 */
const VOLATILE =
  /^(id|item_id|response_id|call_id|tool_use_id|created|created_at|system_fingerprint)$/;
function normalize(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(normalize);
  if (!v || typeof v !== 'object') return v;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>))
    out[k] =
      VOLATILE.test(k) && (typeof x === 'string' || typeof x === 'number') ? '<id>' : normalize(x);
  return out;
}

async function replay(f: ReplayFixture) {
  const up = await replayUpstream(f);
  const gw = createGateway(config(f, up));
  await gw.start();
  cleanups.push(() => gw.stop());
  const r = await fetch(`${gw.listenUrl()}${f.path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders(f.ingress) },
    body: JSON.stringify(f.request),
  });
  return {
    status: r.status,
    contentType: r.headers.get('content-type') ?? '',
    body: await r.text(),
  };
}

describe('gateway replay fixtures', () => {
  it('has fixtures', () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });

  for (const f of fixtures) {
    it(`${f.name}: client output passes the ${f.ingress} spec and ends cleanly`, async () => {
      const out = await replay(f);
      if (!out.contentType.includes('text/event-stream')) {
        // 提交前就失败（一个内容事件都没有）：按状态码矩阵回 HTTP 错误，不是 200 里带错误
        expect(out.status).toBeGreaterThanOrEqual(400);
        expect(() => JSON.parse(out.body)).not.toThrow();
        expect({ status: out.status, body: normalize(JSON.parse(out.body)) }).toMatchSnapshot();
        return;
      }
      expect(out.status).toBe(200);
      expect(validateSse(f.ingress, out.body)).toEqual([]);
      const events = parseSpecEvents(out.body);
      const spec = specOf(f.ingress);
      const last = [...events].reverse().find((e) => e.done || e.data);
      expect(last && (last.done || spec.isTerminal(last))).toBeTruthy();
      expect(events.map((e) => normalize(e))).toMatchSnapshot();
    });
  }
});

describe('trace → fixture conversion', () => {
  const trace = {
    version: 2,
    traceId: 'abc123',
    client: 'claude',
    ingress: 'messages',
    path: '/v1/messages?key=secret-query-value',
    request: {
      body: {
        model: 'claude-x',
        system: 'You are private',
        api_key: 'plain-secret',
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'my private question' }] },
          {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 't1', name: 'read', input: { path: 'a.ts' } }],
          },
        ],
      },
    },
    upstream: [
      { wire: 'chat', body: { model: 'up-a' }, status: 500 },
      { wire: 'responses', body: { model: 'up-b' }, status: 200 },
    ],
    response: {
      status: 200,
      body:
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"secret answer"}\n\n' +
        'event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","delta":"{\\"p\\":1}"}\n\n' +
        'data: {"type":"response.output_text.delta","delta":"","SSE-Keep-Alive":true}\n\n' +
        'data: {"type":"response.output_text.delta","delta":"half sk-abcdefghijklmnop',
    },
  };

  it('replays the last upstream attempt, strips text and secrets, keeps tool args', () => {
    const f = traceToFixture(trace, { name: 't' });
    const all = JSON.stringify(f);
    for (const leak of [
      'my private question',
      'You are private',
      'secret answer',
      'half',
      'sk-abcdefghijklmnop',
      'plain-secret',
      'secret-query-value',
    ])
      expect(all).not.toContain(leak);
    expect(f.upstream).toMatchObject({
      wire: 'responses',
      model: 'up-b',
      contentType: 'text/event-stream',
    });
    expect(f.upstream.chunks).toHaveLength(4);
    expect(f.upstream.chunks[1]).toContain('{\\"p\\":1}');
    // 保活靠 delta: '' 识别，空字符串不能被换掉
    expect(f.upstream.chunks[2]).toContain('"delta":""');
    expect(JSON.stringify(f.request)).toContain('"input":{"path":"a.ts"}');
    expect(f.traceId).toBe('abc123');
  });

  it('--keep-text keeps conversation text but still redacts secrets', () => {
    const f = traceToFixture(trace, { name: 't', keepText: true });
    const all = JSON.stringify(f);
    expect(all).toContain('my private question');
    expect(all).not.toContain('sk-abcdefghijklmnop');
    expect(all).not.toContain('plain-secret');
  });

  it('rejects traces it cannot replay', () => {
    expect(() => traceToFixture({ version: 1 }, { name: 'x' })).toThrow(/version/);
    expect(() => traceToFixture({ ...trace, upstream: [] }, { name: 'x' })).toThrow(/upstream/);
  });

  it('helpers: SSE splitting keeps a trailing partial event; fragments and Responses input', () => {
    expect(splitChunks('data: a\n\ndata: b\n\ndata: c')).toEqual([
      'data: a\n\n',
      'data: b\n\n',
      'data: c',
    ]);
    expect(splitChunks('{"a":1}')).toEqual(['{"a":1}']);
    expect(stripFragment('data: {"delta":{"content":"half wor')).toBe(
      `data: {"delta":{"content":"${TEXT_PLACEHOLDER}`,
    );
    expect(stripText({ input: 'hello', model: 'm' })).toEqual({
      input: TEXT_PLACEHOLDER,
      model: 'm',
    });
    expect(stripText({ input: [{ role: 'user', content: 'hi' }] })).toEqual({
      input: [{ role: 'user', content: TEXT_PLACEHOLDER }],
    });
  });
});
