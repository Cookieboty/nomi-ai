jest.unmock('fs');
jest.unmock('node:fs');
jest.unmock('path');
jest.unmock('node:path');
jest.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: jest.fn(), removeHandler: jest.fn() },
}));

import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';

import type { CliApiFormat } from '../../../src/cli/formats';
import { CliRouteService } from '../../../src/cli/routing/CliRouteService';
import { initUsageService } from '../../../src/usage/UsageService';

function upstream(handler: (res: http.ServerResponse) => void) {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => handler(res));
  });
  return new Promise<{ base: string; close: () => void }>((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({
        base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        close: () => server.close(),
      }),
    ),
  );
}

/** 带上本地路由令牌的 fetch（路由要求 x-api-key / Bearer 令牌） */
const routeFetch = (svc: CliRouteService, input: string, init: RequestInit = {}) =>
  fetch(input, {
    ...init,
    headers: { 'x-api-key': svc.authToken(), ...((init.headers as Record<string, string>) ?? {}) },
  });

async function route(kind: 'claude' | 'codex', baseUrl: string, apiFormat: CliApiFormat) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nomi-route-usage-'));
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
    resolveUpstream: () => ({ kind, baseUrl, apiKey: 'k', model: 'up-model', apiFormat }),
  });
  await svc.start();
  return { svc, url: `http://127.0.0.1:${port}` };
}

const usageSvc = () =>
  initUsageService({
    root: fs.mkdtempSync(path.join(os.tmpdir(), 'nomi-usage-route-')),
    home: fs.mkdtempSync(path.join(os.tmpdir(), 'nomi-usage-route-home-')),
    scanMs: 0,
    logger: { info: () => undefined, warn: () => undefined },
  });

describe('本地路由 → 用量记账', () => {
  it('非流式 Anthropic 直通：记一条 route 记录（响应 usage、缓存拆分、上游主机）', async () => {
    const usage = usageSvc();
    const up = await upstream((res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          model: 'claude-sonnet-4-5',
          content: [{ type: 'text', text: 'hi' }],
          usage: { input_tokens: 12, output_tokens: 8, cache_read_input_tokens: 100 },
        }),
      );
    });
    const { svc, url } = await route('claude', up.base, 'anthropic_messages');
    const r = await routeFetch(svc, `${url}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'x', messages: [] }),
    });
    expect(r.status).toBe(200);
    await r.text();
    const rec = usage.ledger.all();
    expect(rec).toHaveLength(1);
    expect(rec[0]).toMatchObject({
      source: 'claude',
      via: 'route',
      model: 'claude-sonnet-4-5',
      input: 12,
      output: 8,
      cacheRead: 100,
    });
    expect(rec[0]!.provider).toMatch(/^127\.0\.0\.1:/);
    svc.stop();
    up.close();
    usage.stop();
  });

  it('流式 Chat→Messages 转换：从上游 SSE 末包取 usage，转发内容不受影响', async () => {
    const usage = usageSvc();
    const up = await upstream((res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"model":"gpt-4o","choices":[{"delta":{"content":"hi"}}]}\n\n');
      res.write(
        'data: {"choices":[],"usage":{"prompt_tokens":30,"completion_tokens":9,"prompt_tokens_details":{"cached_tokens":10}}}\n\n',
      );
      res.end('data: [DONE]\n\n');
    });
    const { svc, url } = await route('claude', up.base, 'openai_chat_completions');
    const r = await routeFetch(svc, `${url}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'x',
        stream: true,
        messages: [{ role: 'user', content: 'a' }],
      }),
    });
    const text = await r.text();
    expect(text).toContain('message_start');
    const rec = usage.ledger.all();
    expect(rec).toHaveLength(1);
    expect(rec[0]).toMatchObject({ input: 20, cacheRead: 10, output: 9, via: 'route' });
    svc.stop();
    up.close();
    usage.stop();
  });

  it('上游没有 usage / 报错：不记账（不编造）', async () => {
    const usage = usageSvc();
    const up = await upstream((res) => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end('{"error":"boom"}');
    });
    const { svc, url } = await route('codex', up.base, 'openai_responses');
    const r = await routeFetch(svc, `${url}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'x', input: 'a' }),
    });
    expect(r.status).toBe(500);
    await r.text();
    expect(usage.ledger.size()).toBe(0);
    svc.stop();
    up.close();
    usage.stop();
  });
});
