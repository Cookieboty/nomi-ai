/**
 * 重连策略（docs/design/unified-gateway.md §11.1，src/retry.ts）：临时性错误先在同一个 Key 上退避重连，
 * 每个 Key 重连 3 次（只有一个 Key 时 5 次），同一家累计失败 10 次换同一个模型的下一家；
 * 401 / 403 不重连直接换 Key。测试里退避为 0（tests/setup）。
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import type { GatewayConfig, RuntimeProvider } from '../src/config';
import {
  isTransientFailure,
  keyRetryLimit,
  retryAfterMs,
  retryDelayMs,
  RETRY_AFTER_MAX_MS,
  RETRY_MAX_DELAY_MS,
  waitRetry,
} from '../src/retry';
import { createGateway, type UsageEvent } from '../src/server';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

const chatStream =
  `data: ${JSON.stringify({ id: 'c1', choices: [{ index: 0, delta: { content: 'Hello' } }] })}\n\n` +
  `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n` +
  'data: [DONE]\n\n';

/** 上游：按「供应商:Key」脚本化返回；seen 记下每次打到的「供应商:Key」 */
async function upstream(script: (who: string, n: number) => number) {
  const seen: string[] = [];
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      // Bearer key-<供应商>-<序号> → <供应商>:k<序号>
      const m = /^Bearer key-(\w+)-(\d+)$/.exec(String(req.headers.authorization ?? ''));
      const who = m ? `${m[1]}:k${m[2]}` : '?';
      seen.push(who);
      const status = script(who, seen.filter((x) => x === who).length);
      if (status === 200) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(chatStream);
        return;
      }
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `upstream ${status}` } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  cleanups.push(() => server.close());
  return { seen, base: `http://127.0.0.1:${port}`, hostPort: `127.0.0.1:${port}` };
}

const prov = (id: string, base: string, keys: number): RuntimeProvider => ({
  id,
  name: id.toUpperCase(),
  enabled: true,
  urls: { chat: `${base}/v1` },
  keys: Array.from({ length: keys }, (_, i) => ({
    id: `k${i + 1}`,
    value: `key-${id}-${i + 1}`,
    enabled: true,
  })),
  models: [{ id: 'glm-5', enabled: true }],
});

async function setup(script: (who: string, n: number) => number, keys: Record<string, number>) {
  const up = await upstream(script);
  const usage: UsageEvent[] = [];
  const cfg: GatewayConfig = {
    host: '127.0.0.1',
    port: 0,
    providers: Object.entries(keys).map(([id, n]) => prov(id, up.base, n)),
    clients: { codex: { token: 'tok-codex', models: { main: 'a/glm-5' } } },
    allowedPrivateHosts: [up.hostPort],
  };
  const gw = createGateway(cfg, { onUsage: (e) => usage.push(e), streamIdleTimeoutMs: 300 });
  await gw.start();
  cleanups.push(() => gw.stop());
  const chat = async () => {
    const r = await fetch(`${gw.listenUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer tok-codex' },
      body: JSON.stringify({ model: 'a/glm-5', stream: true, messages: [] }),
    });
    return { status: r.status, text: await r.text() };
  };
  return { up, usage, chat };
}

const times = (who: string, n: number) => Array.from({ length: n }, () => who);

describe('gateway reconnect policy (§11.1)', () => {
  it('a 503 is retried on the same key instead of being reported', async () => {
    const t = await setup((_who, n) => (n <= 2 ? 503 : 200), { a: 2 });
    const r = await t.chat();
    expect(r.status).toBe(200);
    expect(r.text).toContain('Hello');
    expect(t.up.seen).toEqual(times('a:k1', 3));
  });

  it('each key is retried 3 times before moving to the next key', async () => {
    const t = await setup((who) => (who === 'a:k1' ? 503 : 200), { a: 2 });
    expect((await t.chat()).status).toBe(200);
    expect(t.up.seen).toEqual([...times('a:k1', 4), 'a:k2']);
  });

  it('a provider with a single key retries it 5 times, then moves to the next provider with the same model', async () => {
    const t = await setup((who) => (who.startsWith('a:') ? 502 : 200), { a: 1, b: 1 });
    expect((await t.chat()).status).toBe(200);
    expect(t.up.seen).toEqual([...times('a:k1', 6), 'b:k1']);
  });

  it('after 10 failures on one provider the rest of its keys are skipped', async () => {
    const t = await setup((who) => (who.startsWith('a:') ? 503 : 200), { a: 3, b: 1 });
    expect((await t.chat()).status).toBe(200);
    expect(t.up.seen).toEqual([
      ...times('a:k1', 4),
      ...times('a:k2', 4),
      ...times('a:k3', 2),
      'b:k1',
    ]);
  });

  it('401 is not retried on the same key: it moves straight to the next key', async () => {
    const t = await setup((who) => (who === 'a:k1' ? 401 : 200), { a: 2 });
    expect((await t.chat()).status).toBe(200);
    expect(t.up.seen).toEqual(['a:k1', 'a:k2']);
  });

  it('a plain 400 is still not retried', async () => {
    const t = await setup(() => 400, { a: 2, b: 1 });
    expect((await t.chat()).status).toBe(400);
    expect(t.up.seen).toEqual(['a:k1']);
  });
});

describe('retry helpers', () => {
  it('classifies transient failures', () => {
    for (const s of [408, 429, 500, 502, 503, 504, 529])
      expect(isTransientFailure({ status: 502, upstreamStatus: s })).toBe(true);
    for (const s of [400, 401, 403, 404, 422])
      expect(isTransientFailure({ status: s, upstreamStatus: s })).toBe(false);
    expect(isTransientFailure({ status: 502, network: true })).toBe(true);
    expect(isTransientFailure({ status: 429, errorKind: 'local-limit' })).toBe(false);
    expect(keyRetryLimit(1)).toBe(5);
    expect(keyRetryLimit(3)).toBe(3);
  });

  it('backs off exponentially with jitter, honours Retry-After, and caps both', () => {
    const mid = () => 0.5; // 抖动系数 1.0
    expect(retryDelayMs(1, { random: mid })).toBe(500);
    expect(retryDelayMs(2, { random: mid })).toBe(1000);
    expect(retryDelayMs(3, { random: mid })).toBe(2000);
    expect(retryDelayMs(10, { random: mid })).toBe(RETRY_MAX_DELAY_MS);
    expect(retryDelayMs(1, { random: () => 0 })).toBe(400);
    expect(retryDelayMs(1, { random: () => 1 })).toBe(600);
    expect(retryDelayMs(1, { retryAfter: '3' })).toBe(3000);
    expect(retryDelayMs(1, { retryAfter: '600' })).toBe(RETRY_AFTER_MAX_MS);
    expect(retryDelayMs(1, { baseMs: 0, retryAfter: '3' })).toBe(0);
    const now = Date.UTC(2026, 0, 1);
    expect(retryAfterMs(new Date(now + 2000).toUTCString(), now)).toBe(2000);
    expect(retryAfterMs('soon')).toBeUndefined();
  });

  it('waitRetry stops early when the client goes away', async () => {
    const ctrl = new AbortController();
    const p = waitRetry(10_000, ctrl.signal);
    ctrl.abort();
    expect(await p).toBe(false);
    expect(await waitRetry(0, new AbortController().signal)).toBe(true);
  });
});
