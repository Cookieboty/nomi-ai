/**
 * 模型质量的网关层采集（docs/design/model-quality.md §2、§4.1）：每个客户端请求恰好一个用量事件，
 * 结果分类、各阶段时间、每次尝试、突发度。
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import type { GatewayConfig } from '../src/config';
import { isBurst } from '../src/quality';
import { createGateway, type GatewayHooks, type UsageEvent } from '../src/server';

type Script = (key: string, res: http.ServerResponse, n: number) => void;

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

const sse = (...chunks: unknown[]) =>
  chunks.map((c) => `data: ${typeof c === 'string' ? c : JSON.stringify(c)}\n\n`).join('');
const role = { id: 'c1', choices: [{ index: 0, delta: { role: 'assistant' } }] };
const text = (t: string) => ({ id: 'c1', choices: [{ index: 0, delta: { content: t } }] });
const stop = { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] };
const usage = (out: number) => ({
  choices: [],
  usage: { prompt_tokens: 10, completion_tokens: out, total_tokens: 10 + out },
});
const okStream = sse(role, text('Hello'), stop, usage(1), '[DONE]');
const sseHead = (res: http.ServerResponse) =>
  res.writeHead(200, { 'content-type': 'text/event-stream' });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function setup(script: Script, hooks: GatewayHooks = {}) {
  let n = 0;
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const key = String(req.headers.authorization ?? '').replace(/^Bearer key-zp-/, 'k');
      script(key, res, n++);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  cleanups.push(() => server.closeAllConnections());
  cleanups.push(() => server.close());
  const port = (server.address() as AddressInfo).port;
  const events: UsageEvent[] = [];
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
  const gw = createGateway(cfg, {
    onUsage: (e) => events.push(e),
    streamIdleTimeoutMs: 2_000,
    ...hooks,
  });
  await gw.start();
  cleanups.push(() => gw.stop());
  const send = (body: unknown, signal?: AbortSignal, raw?: string) =>
    fetch(`${gw.listenUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer tok-codex' },
      body: raw ?? JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });
  const chat = (o: { stream?: boolean; model?: string; signal?: AbortSignal } = {}) =>
    send({ model: o.model ?? 'zp/glm-5', stream: o.stream ?? true, messages: [] }, o.signal);
  /** 等到恰好一个事件（再多等一会儿，确认不会有第二个） */
  const one = async (): Promise<UsageEvent> => {
    for (let i = 0; i < 200 && events.length === 0; i++) await sleep(10);
    await sleep(60);
    expect(events).toHaveLength(1);
    return events[0]!;
  };
  return { events, chat, send, one };
}

/** 时间点单调：响应头 ≤ 第一个内容 ≤ 第一个正文 / 最后一个内容 ≤ 结束 */
function monotonic(e: UsageEvent) {
  const t = e.timing;
  const seq = [t.headersMs, t.firstContentMs, t.lastContentMs, t.endMs].filter(
    (v): v is number => v !== undefined,
  );
  for (let i = 1; i < seq.length; i++) expect(seq[i]).toBeGreaterThanOrEqual(seq[i - 1]!);
  if (t.firstTextMs !== undefined && t.firstContentMs !== undefined)
    expect(t.firstTextMs).toBeGreaterThanOrEqual(t.firstContentMs);
  expect(t.endMs).toBe(e.ms);
}

describe('model quality · gateway capture', () => {
  it('ok stream: outcome, timing, attempt, mode, upstream model; firstByteMs kept', async () => {
    const t = await setup((_k, res) => {
      sseHead(res);
      res.write(sse(role));
      // Windows CI 定时器分辨率粗，20/60 常被合并成同一 tick → last−first < 20；拉开间隔
      setTimeout(() => res.write(sse(text('Hel'))), 100);
      setTimeout(() => res.end(sse(text('lo'), stop, usage(2), '[DONE]')), 250);
    });
    await (await t.chat()).text();
    const e = await t.one();
    expect(e).toMatchObject({
      outcome: 'ok',
      stream: true,
      mode: 'passthrough',
      upstreamModel: 'glm-5',
      attempts: 1,
      // chat→chat 透传：RoutePlan lossless，无 losses
      routeQuality: 'lossless',
    });
    expect(e.losses).toBeUndefined();
    expect(e.attemptsDetail).toEqual([
      expect.objectContaining({ provider: 'zp', keyId: 'k1', outcome: 'ok', status: 200 }),
    ]);
    expect(e.timing.headersMs).toBeDefined();
    expect(e.timing.firstContentMs).toBeDefined();
    expect(e.timing.lastContentMs! - e.timing.firstContentMs!).toBeGreaterThanOrEqual(50);
    expect(e.firstByteMs).toBe(e.timing.firstContentMs);
    expect(e.burst).toBeUndefined();
    monotonic(e);
  });

  it('commit forced by metadata events (no content yet): first content = real content time, not the commit (#136)', async () => {
    const t = await setup((_k, res) => {
      sseHead(res);
      // 9 个元事件：超过提交点的缓存上限，兜底提交；真正的内容 300ms 后才来
      res.write(sse(...Array.from({ length: 9 }, () => role)));
      setTimeout(() => res.write(sse(text('Hel'))), 300);
      setTimeout(() => res.end(sse(text('lo'), stop, usage(2), '[DONE]')), 400);
    });
    await (await t.chat()).text();
    const e = await t.one();
    expect(e.outcome).toBe('ok');
    expect(e.timing.firstContentMs).toBeGreaterThanOrEqual(250);
    expect(e.firstByteMs).toBe(e.timing.firstContentMs);
    monotonic(e);
  });

  it('commit forced but the stream ends without content: no first-content time', async () => {
    const t = await setup((_k, res) => {
      sseHead(res);
      res.end(sse(...Array.from({ length: 9 }, () => role), stop, usage(0), '[DONE]'));
    });
    await (await t.chat()).text();
    const e = await t.one();
    expect(e.timing.firstContentMs).toBeUndefined();
    expect(e.firstByteMs).toBeUndefined();
  });

  it('upstream ends without a terminal marker after content → stream-break (no-terminal)', async () => {
    const t = await setup((_k, res) => {
      sseHead(res);
      res.end(sse(role, text('Hello')));
    });
    await (await t.chat()).text();
    const e = await t.one();
    expect(e).toMatchObject({ outcome: 'stream-break', errorKind: 'no-terminal', attempts: 1 });
    expect(e.attemptsDetail.at(-1)).toMatchObject({ outcome: 'stream-break' });
    monotonic(e);
  });

  it('upstream error event after content → stream-break', async () => {
    const t = await setup((_k, res) => {
      sseHead(res);
      res.end(sse(role, text('Hello'), { error: { message: 'boom mid-stream' } }));
    });
    await (await t.chat()).text();
    expect(await t.one()).toMatchObject({ outcome: 'stream-break' });
  });

  it('no output for the idle window after content → idle-timeout', async () => {
    const t = await setup(
      (_k, res) => {
        sseHead(res);
        res.write(sse(role, text('Hello')));
      },
      { streamIdleTimeoutMs: 150 },
    );
    await (await t.chat()).text();
    const e = await t.one();
    expect(e).toMatchObject({ outcome: 'idle-timeout' });
    monotonic(e);
  });

  it('client aborts before the first content → client-cancel (before-first)', async () => {
    const t = await setup(() => {
      /* 上游一直不回响应头 */
    });
    const ac = new AbortController();
    const p = t.chat({ signal: ac.signal }).catch(() => null);
    await sleep(80);
    ac.abort();
    await p;
    const e = await t.one();
    expect(e).toMatchObject({ outcome: 'client-cancel', cancelPhase: 'before-first' });
    expect(e.attemptsDetail.at(-1)).toMatchObject({ outcome: 'client-cancel' });
  });

  it('client aborts during output → client-cancel (during)', async () => {
    const t = await setup((_k, res) => {
      sseHead(res);
      res.write(sse(role, text('Hello')));
      const timer = setInterval(() => res.write(sse(text('.'))), 20);
      res.on('close', () => clearInterval(timer));
    });
    const ac = new AbortController();
    const r = await t.chat({ signal: ac.signal });
    const reader = r.body!.getReader();
    await reader.read();
    ac.abort();
    await reader.read().catch(() => undefined);
    const e = await t.one();
    expect(e).toMatchObject({ outcome: 'client-cancel', cancelPhase: 'during' });
    expect(e.timing.firstContentMs).toBeDefined();
  });

  it.each([
    [401, 'auth', 502],
    [429, 'rate-limit', 429],
    [500, 'upstream-5xx', 502],
  ])('every candidate HTTP %i → %s (attempts per key)', async (status, outcome, client) => {
    const t = await setup((_k, res) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `upstream ${status}` } }));
    });
    const r = await t.chat();
    expect(r.status).toBe(client);
    await r.text();
    const e = await t.one();
    expect(e.outcome).toBe(outcome);
    expect(e.attemptsDetail.map((a) => [a.keyId, a.outcome, a.status])).toEqual([
      ['k1', outcome, status],
      ['k2', outcome, status],
    ]);
  });

  it('error event before any content on every candidate → pre-commit-error', async () => {
    const t = await setup((_k, res) => {
      sseHead(res);
      res.end(sse(role, { error: { message: 'something broke' } }));
    });
    await (await t.chat()).text();
    const e = await t.one();
    expect(e.outcome).toBe('pre-commit-error');
    expect(e.attemptsDetail.map((a) => a.outcome)).toEqual([
      'pre-commit-error',
      'pre-commit-error',
    ]);
  });

  it('fallback: key 1 fails, key 2 succeeds → ok with two attempts', async () => {
    const t = await setup((key, res) => {
      if (key === 'k1') {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end('{"error":{"message":"busy"}}');
        return;
      }
      sseHead(res);
      res.end(okStream);
    });
    await (await t.chat()).text();
    const e = await t.one();
    expect(e).toMatchObject({ outcome: 'ok', keyId: 'k2', attempts: 2 });
    expect(e.attemptsDetail.map((a) => [a.keyId, a.outcome])).toEqual([
      ['k1', 'upstream-5xx'],
      ['k2', 'ok'],
    ]);
  });

  it('first-byte timeout → first-byte-timeout', async () => {
    const t = await setup(
      () => {
        /* 不回响应头 */
      },
      { firstByteTimeoutMs: 100, firstByteBudgetMs: 10_000 },
    );
    const r = await t.chat();
    await r.text();
    const e = await t.one();
    expect(e.outcome).toBe('first-byte-timeout');
    expect(e.attemptsDetail.every((a) => a.outcome === 'first-byte-timeout')).toBe(true);
  });

  it('repetition guard stops the stream → repetition-stop', async () => {
    const loop = '我需要再检查一下这个文件。'.repeat(45);
    const t = await setup((_k, res) => {
      sseHead(res);
      res.end(sse(role, ...loop.match(/.{1,20}/gs)!.map((c) => text(c)), stop, '[DONE]'));
    });
    await (await t.chat()).text();
    expect(await t.one()).toMatchObject({ outcome: 'repetition-stop' });
  });

  it('burst: all content within 100 ms with ≥ 20 output tokens; a paced stream is not', async () => {
    const chunks = Array.from({ length: 30 }, (_, i) => text(`w${i} `));
    const burst = await setup((_k, res) => {
      sseHead(res);
      res.end(sse(role, ...chunks, stop, usage(30), '[DONE]'));
    });
    await (await burst.chat()).text();
    expect((await burst.one()).burst).toBe(true);

    const paced = await setup((_k, res) => {
      sseHead(res);
      res.write(sse(role));
      chunks.forEach((c, i) => setTimeout(() => res.write(sse(c)), 10 + i * 8));
      setTimeout(() => res.end(sse(stop, usage(30), '[DONE]')), 10 + chunks.length * 8 + 20);
    });
    await (await paced.chat()).text();
    expect((await paced.one()).burst).toBeUndefined();
    expect(isBurst(0, 99, 20)).toBe(true);
    expect(isBurst(0, 100, 20)).toBe(false);
    expect(isBurst(0, 10, 19)).toBe(false);
  });

  it('non-stream ok: content arrives at once; stream=false', async () => {
    const t = await setup((_k, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'c1',
          choices: [
            { index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' },
          ],
          usage: { prompt_tokens: 3, completion_tokens: 1 },
        }),
      );
    });
    await (await t.chat({ stream: false })).text();
    const e = await t.one();
    expect(e).toMatchObject({ outcome: 'ok', stream: false });
    expect(e.timing.firstContentMs).toBe(e.timing.lastContentMs);
    expect(e.burst).toBeUndefined();
    monotonic(e);
  });

  it('non-stream 400 from upstream → request-rejected (no fallback)', async () => {
    const t = await setup((_k, res) => {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end('{"error":{"message":"maximum context length exceeded"}}');
    });
    const r = await t.chat({ stream: false });
    expect(r.status).toBe(400);
    await r.text();
    const e = await t.one();
    expect(e).toMatchObject({ outcome: 'request-rejected', errorKind: 'context-length' });
    expect(e.attemptsDetail).toHaveLength(1);
  });

  it('requests rejected before any candidate are still reported exactly once', async () => {
    const t = await setup(() => undefined);
    const bad = await t.send(null, undefined, '{not json');
    expect(bad.status).toBe(400);
    await bad.text();
    expect(await t.one()).toMatchObject({
      outcome: 'request-rejected',
      attempts: 0,
      attemptsDetail: [],
    });
  });

  it('reasoning flag follows the request', async () => {
    const t = await setup((_k, res) => {
      sseHead(res);
      res.end(okStream);
    });
    await (
      await t.send({
        model: 'zp/glm-5',
        stream: true,
        messages: [],
        reasoning_effort: 'high',
      })
    ).text();
    expect((await t.one()).reasoning).toBe(true);
  });
});
