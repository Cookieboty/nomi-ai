import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { Wire } from '../src/ir';
import { hasSealedReasoning, isReasoningRejection, stripSealedReasoning } from '../src/reasoning';
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
  it('recognizes sealed history rejection without treating unsupported reasoning parameters as history errors', () => {
    expect(isReasoningRejection(400, 'invalid_encrypted_content')).toBe(true);
    expect(isReasoningRejection(404, "Item 'rs_123' not found.")).toBe(true);
    expect(isReasoningRejection(422, 'Invalid thought_signature in function call')).toBe(true);
    expect(isReasoningRejection(400, 'reasoning_effort not supported')).toBe(false);
    expect(isReasoningRejection(400, 'thinking budget is not supported')).toBe(false);
    expect(isReasoningRejection(401, 'Invalid signature')).toBe(false);
    expect(isReasoningRejection(500, 'Failed to decrypt encrypted_content')).toBe(false);
  });
  it('strips Gemini signatures in Chat and native Gemini, preserving ordinary reasoning and tool arguments', () => {
    const assistant = {
      role: 'assistant',
      content: 'answer',
      reasoning_content: 'plain reasoning',
      tool_calls: [
        {
          function: { arguments: { thought_signature: 'business-data' } },
          extra_content: { google: { thought_signature: 'sealed' } },
        },
      ],
    };
    const chat = {
      messages: [assistant, { role: 'user', content: 'again', thought_signature: 'user-data' }],
    };
    const out = stripSealedReasoning('chat', chat) as typeof chat;
    expect(hasSealedReasoning('chat', chat)).toBe(true);
    expect(out.messages[0]).toMatchObject({
      content: 'answer',
      reasoning_content: 'plain reasoning',
      tool_calls: [
        {
          function: { arguments: { thought_signature: 'business-data' } },
          extra_content: { google: {} },
        },
      ],
    });
    expect(out.messages[1]).toBe(chat.messages[1]);
    const gemini = {
      contents: [
        {
          role: 'model',
          parts: [
            {
              functionCall: { args: { thoughtSignature: 'business-data' } },
              thoughtSignature: 'sealed',
            },
          ],
        },
      ],
    };
    expect(stripSealedReasoning('gemini', gemini)).toEqual({
      contents: [
        {
          role: 'model',
          parts: [{ functionCall: { args: { thoughtSignature: 'business-data' } } }],
        },
      ],
    });
  });
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
    // Windows does not expose POSIX permission bits; the file is still persisted and reloaded.
    if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const again = new SessionTable(file, () => now);
    expect(again.canKeep('s2', own)).toBe(true);
    now += SESSIONS_TTL_MS + 1;
    expect(again.canKeep('s2', own)).toBe(false);
  });
});

describe('gateway: sealed reasoning by session ownership', () => {
  it.each([
    ['messages', 400, 'Invalid signature in thinking block'],
    ['responses', 404, "Item 'rs_123' not found."],
    ['chat', 422, 'Invalid thought_signature'],
    ['gemini', 400, 'Invalid thoughtSignature'],
  ] as const)(
    '%s: first turn strips, same owner keeps, rejection %s retries once and stops keeping',
    async (wire: Wire, status, message) => {
      const seen: Array<Record<string, unknown>> = [];
      let reject = false;
      const server = http.createServer((req, res) => {
        let raw = '';
        req.on('data', (c) => (raw += c));
        req.on('end', () => {
          const body = JSON.parse(raw) as Record<string, unknown>;
          seen.push(body);
          const hasThinking = JSON.stringify(body).includes('sig-from-vendor-a');
          res.setHeader('content-type', 'application/json');
          if (reject && hasThinking) {
            res.statusCode = status;
            return res.end(
              JSON.stringify({
                type: 'error',
                error: { message },
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
            urls: { [wire]: `http://127.0.0.1:${port}` },
            keys: [{ id: 'k', value: 'v', enabled: true }],
            models: [{ id: 'm', enabled: true }],
          },
        ],
        clients: { nomi: { token: 'tok', models: { main: 'a/m' } } },
        allowedPrivateHosts: [`127.0.0.1:${port}`],
      });
      await gw.start();
      cleanups.push(() => gw.stop());
      const bodies = {
        messages: history,
        responses: {
          input: [
            { type: 'reasoning', id: 'rs_123', encrypted_content: 'sig-from-vendor-a' },
            { role: 'user', content: 'again' },
          ],
        },
        chat: {
          messages: [
            {
              role: 'assistant',
              content: 'hi',
              extra_content: { google: { thought_signature: 'sig-from-vendor-a' } },
            },
            { role: 'user', content: 'again' },
          ],
        },
        gemini: {
          contents: [
            { role: 'model', parts: [{ text: 'hi', thoughtSignature: 'sig-from-vendor-a' }] },
            { role: 'user', parts: [{ text: 'again' }] },
          ],
        },
      };
      const route =
        wire === 'gemini'
          ? '/v1beta/models/a/m:generateContent'
          : wire === 'chat'
            ? '/v1/chat/completions'
            : `/v1/${wire}`;
      const send = () =>
        fetch(`${gw.listenUrl()}${route}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: 'Bearer tok',
            'x-nomi-tab': 'sess-1',
          },
          body: JSON.stringify({ ...bodies[wire], model: 'a/m' }),
        });
      const hasThinking = (b: Record<string, unknown>) =>
        JSON.stringify(b).includes('sig-from-vendor-a');
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
    },
  );
});
