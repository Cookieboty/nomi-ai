/**
 * 未知模型按已知模型处理（RuntimeModel.like）与长上下文 beta（context-1m）：
 * 第三方 Messages 上游、Claude 系列、窗口超过 200K 时补上 beta；上游拒绝就去掉重试并记住。
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import type { GatewayConfig, RuntimeProvider } from '../src/config';
import { classifyFailure } from '../src/learn';
import { effectiveModel } from '../src/models/effective';
import { CONTEXT_1M_BETA, rectifierFor } from '../src/route/rectifiers';
import type { Candidate } from '../src/route/resolve';
import { createGateway } from '../src/server';
import { upstreamHeaders, wantsContext1m } from '../src/upstream';

const provider = (
  models: RuntimeProvider['models'],
  base = 'https://relay.example',
): RuntimeProvider => ({
  id: 'maas',
  name: 'MAAS',
  enabled: true,
  urls: { messages: base },
  keys: [{ id: 'k1', value: 'sk-test-1', enabled: true }],
  models,
});

const cand = (p: RuntimeProvider, model: string, extra: Partial<Candidate> = {}): Candidate => ({
  provider: p,
  key: p.keys[0]!,
  publicModel: `${p.id}/${model}`,
  upstreamModel: model,
  wire: 'messages',
  model: effectiveModel(p, model),
  ...extra,
});

describe('like：按已知模型处理', () => {
  it('族默认与目录规格按 like 查，用户手填的仍然优先', () => {
    const p = provider([
      { id: 'Aerith-opus-5.5', enabled: true, like: 'claude-opus-4-8' },
      { id: 'Aerith-opus-small', enabled: true, like: 'claude-opus-4-8', ctx: 300_000 },
      { id: 'Aerith-unknown', enabled: true },
    ]);
    expect(effectiveModel(p, 'Aerith-opus-5.5').limits?.context).toBe(1_000_000);
    expect(effectiveModel(p, 'Aerith-opus-5.5').family).toMatch(/^claude/);
    expect(effectiveModel(p, 'Aerith-opus-small').limits?.context).toBe(300_000);
    expect(effectiveModel(p, 'Aerith-unknown').limits?.context).toBeUndefined();
  });
});

describe('context-1m beta', () => {
  const headers = (c: Candidate, clientHeaders: Record<string, string> = {}) =>
    upstreamHeaders(c, { stream: true, clientHeaders, sameWire: true });

  it('第三方上游、Claude 系列、窗口超过 200K：补上 beta（保留客户端的其它 beta）', () => {
    const p = provider([{ id: 'Aerith-opus-5.5', enabled: true, like: 'claude-opus-4-8' }]);
    const c = cand(p, 'Aerith-opus-5.5');
    expect(wantsContext1m(c)).toBe(true);
    expect(headers(c)['anthropic-beta']).toBe(CONTEXT_1M_BETA);
    expect(
      headers(c, { 'anthropic-beta': 'fine-grained-tool-streaming-2025-05-14' }),
    ).toMatchObject({
      'anthropic-beta': `fine-grained-tool-streaming-2025-05-14,${CONTEXT_1M_BETA}`,
    });
  });

  it('不补：窗口不超过 200K、不是 Claude、不是 Messages、已经拒绝过', () => {
    const p = provider([
      { id: 'small', enabled: true, like: 'claude-opus-4-8', ctx: 200_000 },
      { id: 'gpt', enabled: true, like: 'gpt-5', ctx: 1_000_000 },
      { id: 'big', enabled: true, like: 'claude-opus-4-8' },
    ]);
    expect(wantsContext1m(cand(p, 'small'))).toBe(false);
    expect(wantsContext1m(cand(p, 'gpt'))).toBe(false);
    expect(wantsContext1m(cand(p, 'big', { wire: 'chat' }))).toBe(false);
    expect(wantsContext1m(cand(p, 'big', { rectify: ['beta'] }))).toBe(false);
    expect(headers(cand(p, 'big', { rectify: ['beta'] }))['anthropic-beta']).toBeUndefined();
  });

  it('上游拒绝我们补的 beta：识别成 beta 修正；没补时不误判', () => {
    const text =
      '{"error":{"message":"Unexpected value(s) `context-1m-2025-08-07` for the `anthropic-beta` header"}}';
    expect(rectifierFor(400, text, {}, { sentBeta: true })).toEqual({ fix: 'beta' });
    expect(rectifierFor(400, text, {}, { sentBeta: false })).toBeNull();
    expect(classifyFailure(400, text, {}, { sentBeta: true })).toMatchObject({
      kind: 'rectify',
      fix: 'beta',
    });
    // 已经去掉重试过一次：按普通规则处理
    expect(classifyFailure(400, text, {}, { sentBeta: true, applied: ['beta'] }).kind).not.toBe(
      'rectify',
    );
  });
});

describe('context-1m beta：经网关的真实请求', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    for (const c of cleanups.splice(0)) c();
  });

  it('上游拒绝 beta：去掉重试成功，之后的请求直接不带', async () => {
    const seen: Array<string | undefined> = [];
    const server = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        const beta = req.headers['anthropic-beta'];
        seen.push(typeof beta === 'string' ? beta : undefined);
        if (typeof beta === 'string' && beta.includes('context-1m')) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'unsupported anthropic-beta: context-1m' } }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'm1',
            type: 'message',
            role: 'assistant',
            model: 'Aerith-opus-5.5',
            content: [{ type: 'text', text: 'ok' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 3, output_tokens: 1 },
          }),
        );
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    cleanups.push(() => server.close());
    const port = (server.address() as AddressInfo).port;
    const cfg: GatewayConfig = {
      host: '127.0.0.1',
      port: 0,
      providers: [
        provider(
          [{ id: 'Aerith-opus-5.5', enabled: true, like: 'claude-opus-4-8' }],
          `http://127.0.0.1:${port}`,
        ),
      ],
      clients: { claude: { token: 'tok-claude', models: { main: 'maas/Aerith-opus-5.5' } } },
      allowedPrivateHosts: [`127.0.0.1:${port}`],
    };
    const gw = createGateway(cfg);
    await gw.start();
    cleanups.push(() => void gw.stop());
    const send = async () => {
      const r = await fetch(`${gw.listenUrl()!}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': 'tok-claude' },
        body: JSON.stringify({
          model: 'maas/Aerith-opus-5.5',
          max_tokens: 5,
          messages: [{ role: 'user', content: 'hi' }],
        }),
      });
      await r.text();
      return r.status;
    };
    expect(await send()).toBe(200);
    expect(seen).toEqual([CONTEXT_1M_BETA, undefined]);
    expect(await send()).toBe(200);
    expect(seen.slice(2)).toEqual([undefined]);
  });
});
