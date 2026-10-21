import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { detect, normalizeBases } from '../src/probe/detect';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

describe('normalizeBases (§8.1)', () => {
  it.each([
    [
      'https://api.deepseek.com',
      {
        chat: 'https://api.deepseek.com/v1',
        messages: 'https://api.deepseek.com',
        gemini: 'https://api.deepseek.com/v1beta',
      },
    ],
    [
      'https://api.deepseek.com/v1/',
      {
        chat: 'https://api.deepseek.com/v1',
        messages: 'https://api.deepseek.com',
        gemini: 'https://api.deepseek.com/v1beta',
      },
    ],
    [
      'https://relay.example.com/v1/chat/completions',
      { chat: 'https://relay.example.com/v1', messages: 'https://relay.example.com' },
    ],
    [
      'https://dashscope.aliyuncs.com/compatible-mode/v1',
      { chat: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
    ],
    [
      'api.example.com/v1/messages',
      { chat: 'https://api.example.com/v1', messages: 'https://api.example.com' },
    ],
    [
      'https://g.example/v1beta/models/gemini-3:generateContent',
      { gemini: 'https://g.example/v1beta' },
    ],
  ])('%s', (raw, want) => {
    expect(normalizeBases(raw)).toMatchObject(want);
  });
  it('garbage in, nothing out', () => {
    expect(normalizeBases('   ')).toEqual({});
  });
});

describe('detect (§8.2)', () => {
  it('probes each wire per key, learns auth styles and models, keeps only working URLs', async () => {
    const seen: string[] = [];
    const server = http.createServer((req, res) => {
      const auth = String(req.headers.authorization ?? req.headers['x-api-key'] ?? '');
      seen.push(
        `${req.method} ${req.url} ${req.headers.authorization ? 'bearer' : req.headers['x-api-key'] ? 'x-api-key' : '-'}`,
      );
      req.resume();
      req.on('end', () => {
        const bad = auth.includes('bad');
        if (req.url === '/v1/models') {
          if (!req.headers.authorization) return void res.writeHead(401).end();
          res.writeHead(200, { 'content-type': 'application/json' });
          return void res.end(JSON.stringify({ data: [{ id: 'glm-5' }, { id: 'claude-x' }] }));
        }
        if (bad)
          return void res
            .writeHead(401, { 'content-type': 'application/json' })
            .end('{"error":{"message":"bad key"}}');
        if (req.url === '/v1/chat/completions')
          return void res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
        if (req.url === '/v1/messages') {
          // 只认 Bearer 的 Anthropic 兼容接口
          if (!req.headers.authorization) return void res.writeHead(401).end('{}');
          return void res
            .writeHead(400, { 'content-type': 'application/json' })
            .end('{"type":"error","error":{"type":"invalid_request_error"}}');
        }
        res.writeHead(404, { 'content-type': 'text/html' });
        res.end('<html>not found</html>');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    cleanups.push(() => server.close());
    const port = (server.address() as AddressInfo).port;
    const bases = normalizeBases(`http://127.0.0.1:${port}/v1`);
    const r = await detect({
      bases,
      keys: [
        { id: 'k1', value: 'good' },
        { id: 'k2', value: 'bad' },
      ],
      allowedPrivateHosts: [`127.0.0.1:${port}`],
    });
    expect(r.models).toEqual(['glm-5', 'claude-x']);
    expect(r.wires.chat).toMatchObject({ ok: true, auth: 'bearer', model: 'glm-5' });
    // messages：先用 x-api-key 被拒，换 Bearer 后是参数错误 → 接口存在；测试模型优先 Claude
    expect(r.wires.messages).toMatchObject({ ok: true, auth: 'bearer', model: 'claude-x' });
    expect(r.wires.responses).toMatchObject({ ok: false, status: 404 });
    expect(r.wires.gemini).toMatchObject({ ok: false });
    expect(Object.keys(r.urls).sort()).toEqual(['chat', 'messages']);
    expect(r.byKey.k2!.chat).toMatchObject({
      ok: false,
      error: expect.stringContaining('Key 无效'),
    });
  });

  it('refuses unconfirmed private hosts without sending anything', async () => {
    const r = await detect({
      bases: { chat: 'http://127.0.0.1:9/v1' },
      keys: [{ id: 'k', value: 'x' }],
      fallbackModel: 'm',
    });
    expect(r.wires.chat).toMatchObject({ ok: false, error: expect.stringContaining('确认') });
    expect(r.urls).toEqual({});
  });
});
