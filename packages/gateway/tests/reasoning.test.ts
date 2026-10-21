import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { stripSealedReasoning } from '../src/reasoning';
import { createGateway } from '../src/server';
import { SESSIONS_TTL_MS, SessionTable } from '../src/sessions';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

const history = {
  model: 'm',
  max_tokens: 100,
  messages: [
    { role: 'user', content: 'hi' },
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'hmm', signature: 'sig-from-vendor-a' },
        { type: 'redacted_thinking', data: 'opaque' },
        { type: 'text', text: 'hello' },
      ],
    },
    { role: 'user', content: 'again' },
  ],
};

describe('stripSealedReasoning (§9.3)', () => {
  it('Messages: drops thinking / redacted_thinking from assistant history, keeps the rest', () => {
    const out = stripSealedReasoning('messages', history) as typeof history;
    expect(out.messages[1]!.content).toEqual([{ type: 'text', text: 'hello' }]);
    expect(out.messages[0]).toBe(history.messages[0]);
    // 没东西可剥：原对象返回
    expect(stripSealedReasoning('messages', out)).toBe(out);
  });
  it('Responses: drops reasoning items; Chat untouched', () => {
    const body = {
      input: [
        { role: 'user', content: 'hi' },
        { type: 'reasoning', id: 'rs_1', encrypted_content: 'enc' },
        { type: 'message', role: 'assistant', content: [] },
      ],
    };
    expect((stripSealedReasoning('responses', body) as { input: unknown[] }).input).toHaveLength(2);
    const chat = { messages: [{ role: 'assistant', content: 'x', reasoning_content: 'r' }] };
    expect(stripSealedReasoning('chat', chat)).toBe(chat);
  });
});

describe('SessionTable (§11.4)', () => {
  it('keeps only for the same (provider, key, wire); noKeep sticks; persists across restarts; expires', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gw-sess-')), 'sessions.json');
    let now = 1_000;
    const t = new SessionTable(file, () => now);
    const own = { providerId: 'a', keyId: 'k', wire: 'messages' as const };
    expect(t.canKeep('s1', own)).toBe(false);
    t.record('s1', own);
    expect(t.canKeep('s1', own)).toBe(true);
    expect(t.canKeep('s1', { ...own, keyId: 'k2' })).toBe(false);
    expect(t.canKeep('s1', { ...own, wire: 'chat' })).toBe(false);
    expect(t.canKeep(null, own)).toBe(false);
    t.markNoKeep('s1');
    t.record('s1', own);
    expect(t.canKeep('s1', own)).toBe(false);
    t.record('s2', own);
    t.flush();
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const again = new SessionTable(file, () => now);
    expect(again.canKeep('s2', own)).toBe(true);
    now += SESSIONS_TTL_MS + 1;
    expect(again.canKeep('s2', own)).toBe(false);
  });
});

describe('gateway: sealed reasoning by session ownership', () => {
  it('first turn strips, same owner keeps, a rejection strips + retries once and stops keeping', async () => {
    const seen: Array<Record<string, unknown>> = [];
    let reject = false;
    const server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const body = JSON.parse(raw) as Record<string, unknown>;
        seen.push(body);
        const hasThinking = JSON.stringify(body).includes('"thinking"');
        res.setHeader('content-type', 'application/json');
        if (reject && hasThinking) {
          res.statusCode = 400;
          return res.end(
            JSON.stringify({
              type: 'error',
              error: { message: 'Invalid signature in thinking block' },
            }),
          );
        }
        res.end(
          JSON.stringify({
            id: 'm',
            type: 'message',
            role: 'assistant',
            model: 'm',
            content: [{ type: 'text', text: 'ok' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
        );
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    cleanups.push(() => server.close());
    const port = (server.address() as AddressInfo).port;
    const gw = createGateway({
      host: '127.0.0.1',
      port: 0,
      providers: [
        {
          id: 'a',
          name: 'A',
          enabled: true,
          urls: { messages: `http://127.0.0.1:${port}` },
          keys: [{ id: 'k', value: 'v', enabled: true }],
          models: [{ id: 'm', enabled: true }],
        },
      ],
      clients: { claude: { token: 'tok', models: { main: 'a/m' } } },
      allowedPrivateHosts: [`127.0.0.1:${port}`],
    });
    await gw.start();
    cleanups.push(() => gw.stop());
    const send = () =>
      fetch(`${gw.listenUrl()}/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': 'tok',
          'x-claude-code-session-id': 'sess-1',
        },
        body: JSON.stringify({ ...history, model: 'a/m' }),
      });
    const hasThinking = (b: Record<string, unknown>) => JSON.stringify(b).includes('"thinking"');
    // 第一轮：归属表里没有 → 剥掉
    expect((await send()).status).toBe(200);
    expect(hasThinking(seen.at(-1)!)).toBe(false);
    // 第二轮：上一轮就是这个 (供应商, Key, 协议) → 保留
    expect((await send()).status).toBe(200);
    expect(hasThinking(seen.at(-1)!)).toBe(true);
    // 上游拒绝推理：剥掉重试一次，之后不再保留
    reject = true;
    const n = seen.length;
    expect((await send()).status).toBe(200);
    expect(seen.length - n).toBe(2);
    expect(hasThinking(seen.at(-1)!)).toBe(false);
    reject = false;
    await send();
    expect(hasThinking(seen.at(-1)!)).toBe(false);
  });
});
