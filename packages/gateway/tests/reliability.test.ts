/**
 * 可靠性（docs/design/unified-gateway.md §11.1 回退与冷却、§11.2 缓存亲和、§9.6 Retry-After）：
 * 真实监听的网关 + 本地假上游 + 假时钟。
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { Affinity, sessionKey } from '../src/affinity';
import type { GatewayConfig, RuntimeProvider } from '../src/config';
import {
  AUTH_COOLDOWN_MS,
  Cooldowns,
  MAX_RETRY_AFTER_MS,
  parseRetryAfter,
  type KeyStatusEvent,
} from '../src/cooldown';
import type { Candidate } from '../src/route/resolve';
import { createGateway, SERVED_MODEL_HEADER, type UsageEvent } from '../src/server';

interface Seen {
  key: string;
  body: Record<string, unknown>;
}

type Script = (s: Seen, res: http.ServerResponse) => void;

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

async function upstream(script: Script) {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const s = {
        key: String(req.headers.authorization ?? '').replace(/^Bearer key-zp-/, 'k'),
        body: raw ? JSON.parse(raw) : {},
      };
      seen.push(s);
      script(s, res);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  cleanups.push(() => server.close());
  return { seen, base: `http://127.0.0.1:${port}`, hostPort: `127.0.0.1:${port}` };
}

const chatStream =
  `data: ${JSON.stringify({ id: 'c1', choices: [{ index: 0, delta: { content: 'Hello' } }] })}\n\n` +
  `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n` +
  'data: [DONE]\n\n';

const ok = (res: http.ServerResponse) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.end(chatStream);
};
const err = (
  res: http.ServerResponse,
  status: number,
  msg: string,
  h: http.OutgoingHttpHeaders = {},
) => {
  res.writeHead(status, { 'content-type': 'application/json', ...h });
  res.end(JSON.stringify({ error: { message: msg } }));
};

function provider(base: string): RuntimeProvider {
  return {
    id: 'zp',
    name: 'ZP',
    enabled: true,
    urls: { chat: `${base}/v1` },
    keys: [
      { id: 'k1', value: 'key-zp-1', enabled: true },
      { id: 'k2', value: 'key-zp-2', enabled: true },
    ],
    models: [{ id: 'glm-5', enabled: true }],
  };
}

async function setup(script: Script, hooks: Parameters<typeof createGateway>[1] = {}) {
  const up = await upstream(script);
  const clock = { now: 1_000_000 };
  const usage: UsageEvent[] = [];
  const status: KeyStatusEvent[] = [];
  const cfg: GatewayConfig = {
    host: '127.0.0.1',
    port: 0,
    providers: [provider(up.base)],
    clients: {
      claude: { token: 'tok-claude', models: { main: 'zp/glm-5' } },
      codex: { token: 'tok-codex', models: { main: 'zp/glm-5' } },
    },
    allowedPrivateHosts: [up.hostPort],
  };
  const gw = createGateway(cfg, {
    onUsage: (e) => usage.push(e),
    onKeyStatus: (e) => status.push(e),
    now: () => clock.now,
    streamIdleTimeoutMs: 300,
    ...hooks,
  });
  await gw.start();
  cleanups.push(() => gw.stop());
  const url = gw.listenUrl()!;
  /** Chat 入口（Codex 令牌）；messages 为空时没有会话键，不受亲和影响 */
  const chat = (body: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
    fetch(`${url}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer tok-codex',
        ...headers,
      },
      body: JSON.stringify({ model: 'zp/glm-5', stream: true, messages: [], ...body }),
    });
  const claude = (body: Record<string, unknown>, headers: Record<string, string> = {}) =>
    fetch(`${url}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'tok-claude', ...headers },
      body: JSON.stringify({ model: 'zp/glm-5', max_tokens: 5, ...body }),
    });
  /** 本次请求打到上游的 Key 顺序 */
  const keysOf = async (p: Promise<Response>) => {
    const from = up.seen.length;
    const r = await p;
    await r.text();
    return up.seen.slice(from).map((s) => s.key);
  };
  return { up, clock, usage, status, chat, claude, keysOf };
}

describe('cooldown (§11.1)', () => {
  it('429 with Retry-After cools that key; the next request starts on the other key until it expires', async () => {
    let limited = true;
    const t = await setup((s, res) => {
      if (s.key === 'k1' && limited) err(res, 429, 'slow down', { 'retry-after': '5' });
      else ok(res);
    });
    expect(await t.keysOf(t.chat())).toEqual(['k1', 'k2']);
    expect(t.status).toEqual([
      {
        providerId: 'zp',
        keyId: 'k1',
        wire: 'chat',
        status: 'limited',
        error: 'slow down',
        until: t.clock.now + 5_000,
      },
    ]);
    expect(await t.keysOf(t.chat())).toEqual(['k2']);
    t.clock.now += 4_000;
    expect(await t.keysOf(t.chat())).toEqual(['k2']);
    limited = false;
    t.clock.now += 1_500;
    expect(await t.keysOf(t.chat())).toEqual(['k1']);
    expect(t.status.at(-1)).toEqual({ providerId: 'zp', keyId: 'k1', wire: 'chat', status: 'ok' });
    // 已经恢复：再成功不再报
    await t.keysOf(t.chat());
    expect(t.status).toHaveLength(2);
  });

  it('5xx without Retry-After cools for 60 s; a cooling key is still tried when nothing else is left', async () => {
    const t = await setup((s, res) =>
      s.key === 'k1' ? err(res, 503, 'busy') : err(res, 500, 'boom'),
    );
    expect(await t.keysOf(t.chat())).toEqual(['k1', 'k2']);
    // 两个都在冷却：照样按原顺序尝试
    expect(await t.keysOf(t.chat())).toEqual(['k1', 'k2']);
    expect(t.status).toEqual([]); // 5xx 不报 Key 状态
  });

  it('401 cools the key for 10 minutes and reports auth, then ok on recovery', async () => {
    let bad = true;
    const t = await setup((s, res) =>
      s.key === 'k1' && bad ? err(res, 401, 'invalid api key') : ok(res),
    );
    const t0 = t.clock.now;
    expect(await t.keysOf(t.chat())).toEqual(['k1', 'k2']);
    expect(t.status).toEqual([
      {
        providerId: 'zp',
        keyId: 'k1',
        wire: 'chat',
        status: 'auth',
        error: 'invalid api key',
        until: t0 + AUTH_COOLDOWN_MS,
      },
    ]);
    t.clock.now += 9 * 60_000;
    expect(await t.keysOf(t.chat())).toEqual(['k2']);
    bad = false;
    t.clock.now += 61_000;
    expect(await t.keysOf(t.chat())).toEqual(['k1']);
    expect(t.status.map((e) => e.status)).toEqual(['auth', 'ok']);
  });

  it('a plain 400 is not retried on the next key', async () => {
    const t = await setup((_s, res) => err(res, 400, 'messages must not be empty'));
    const r = await t.chat();
    expect(r.status).toBe(400);
    await r.text();
    expect(t.up.seen).toHaveLength(1);
    expect(t.usage.at(-1)).toMatchObject({ attempts: 1, status: 400 });
  });

  it('does not retry once bytes have reached the client (stream breaks mid-way)', async () => {
    const t = await setup((_s, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'par' } }] })}\n\n`,
      );
      setTimeout(() => res.destroy(), 20);
    });
    const r = await t.claude({ stream: true, messages: [{ role: 'user', content: 'hi' }] });
    const text = await r.text();
    expect(r.status).toBe(200);
    expect(text).toContain('par');
    expect(text).toContain('event: error');
    expect(t.up.seen).toHaveLength(1);
  });

  it('forwards the upstream Retry-After on the final 429', async () => {
    const t = await setup((_s, res) => err(res, 429, 'quota', { 'retry-after': '7' }));
    const r = await t.claude({ messages: [] });
    expect(r.status).toBe(429);
    expect(r.headers.get('retry-after')).toBe('7');
    expect(await r.json()).toMatchObject({ type: 'error', error: { type: 'rate_limit_error' } });
    expect(t.up.seen.map((s) => s.key)).toEqual(['k1', 'k2']);
  });
});

describe('first-byte timeout (#93)', () => {
  it('only covers the wait for response headers: a steady stream longer than it completes', async () => {
    const { chat } = await setup(
      (_s, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        // writeHead alone does not put the headers on the wire until the first body write
        // (50ms later); flush so the 100ms first-byte budget measures only the header wait
        // and a loaded runner cannot push the headers past it.
        res.flushHeaders();
        let n = 0;
        const tick = setInterval(() => {
          n++;
          res.write(
            `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: `p${n}` } }] })}\n\n`,
          );
          if (n === 6) {
            clearInterval(tick);
            res.end(
              `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n` +
                'data: [DONE]\n\n',
            );
          }
        }, 50);
      },
      { firstByteTimeoutMs: 100 },
    );
    const text = await (await chat()).text();
    expect(text).toContain('p6');
    expect(text).toContain('[DONE]');
    expect(text).not.toContain('上游中断');
  });

  it('still fails over when the upstream sends no headers in time', async () => {
    const { chat } = await setup(() => undefined, { firstByteTimeoutMs: 100 });
    const r = await chat();
    expect(r.status).toBeGreaterThanOrEqual(500);
    expect(await r.text()).toContain('首字节前超时');
  });
});

describe('non-stream body read timeout', () => {
  const chatJson = JSON.stringify({
    id: 'c1',
    object: 'chat.completion',
    choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });

  it('upstream sends headers then stalls the body: fails with an error instead of hanging', async () => {
    const { chat } = await setup(
      (_s, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.write(chatJson.slice(0, 10)); // 发了一半就不再发，也不断开
      },
      { nonStreamFirstByteTimeoutMs: 200 },
    );
    const t0 = Date.now();
    const r = await chat({ stream: false });
    const text = await r.text();
    expect(r.status).toBe(502);
    expect(text).toContain('没有读完');
    expect(Date.now() - t0).toBeLessThan(3000);
  }, 8000);

  it('a body that arrives within the limit is unaffected', async () => {
    const { chat } = await setup(
      (_s, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        setTimeout(() => res.end(chatJson), 50);
      },
      { nonStreamFirstByteTimeoutMs: 1000 },
    );
    const r = await chat({ stream: false });
    expect(r.status).toBe(200);
    expect(await r.text()).toContain('"hi"');
  });
});

describe('served model header (#97)', () => {
  it('tells the client which candidate actually served the request', async () => {
    const { chat } = await setup((_s, res) => ok(res));
    const r = await chat();
    expect(r.headers.get(SERVED_MODEL_HEADER)).toBe('zp/glm-5');
    await r.text();
  });
});

describe('affinity (§11.2)', () => {
  it('keeps a session on the key that served it, and moves it when that key cools down', async () => {
    const fail = new Set<string>(['k1']);
    const t = await setup((s, res) => (fail.has(s.key) ? err(res, 500, 'boom') : ok(res)));
    const s1 = { 'x-claude-code-session-id': 'sess-1' };
    const msg = (content: string) => ({ stream: true, messages: [{ role: 'user', content }] });
    expect(await t.keysOf(t.claude(msg('a'), s1))).toEqual(['k1', 'k2']);
    fail.clear();
    t.clock.now += 61_000; // k1 的冷却已过
    // 同一个会话留在 k2；别的会话按默认顺序从 k1 开始
    expect(await t.keysOf(t.claude(msg('b'), s1))).toEqual(['k2']);
    expect(await t.keysOf(t.claude(msg('c'), { 'x-claude-code-session-id': 'sess-2' }))).toEqual([
      'k1',
    ]);
    // k2 出错：这次换到 k1，之后会话跟着 k1 走（k2 冷却中）
    fail.add('k2');
    expect(await t.keysOf(t.claude(msg('d'), s1))).toEqual(['k2', 'k1']);
    fail.clear();
    expect(await t.keysOf(t.claude(msg('e'), s1))).toEqual(['k1']);
    t.clock.now += 61_000;
    expect(await t.keysOf(t.claude(msg('f'), s1))).toEqual(['k1']);
  });

  it('without a session id, system + first user message identifies the session', async () => {
    const fail = new Set<string>(['k1']);
    const t = await setup((s, res) => (fail.has(s.key) ? err(res, 503, 'busy') : ok(res)));
    const body = { messages: [{ role: 'user', content: 'same start' }] };
    expect(await t.keysOf(t.chat(body))).toEqual(['k1', 'k2']);
    fail.clear();
    t.clock.now += 61_000;
    expect(await t.keysOf(t.chat(body))).toEqual(['k2']);
    expect(await t.keysOf(t.chat({ messages: [{ role: 'user', content: 'other' }] }))).toEqual([
      'k1',
    ]);
  });
});

describe('cooldown / affinity units', () => {
  it('parses Retry-After as seconds or an HTTP date and caps the cooldown at 10 minutes', () => {
    const now = Date.parse('2026-10-21T00:00:00Z');
    expect(parseRetryAfter('5', now)).toBe(5_000);
    expect(parseRetryAfter(new Date(now + 30_000).toUTCString(), now)).toBe(30_000);
    expect(parseRetryAfter('soon', now)).toBeNull();
    let t = now;
    const c = new Cooldowns(undefined, () => t);
    const cand = { provider: { id: 'p' }, key: { id: 'k' }, wire: 'chat' } as unknown as Candidate;
    expect(c.fail(cand, { upstreamStatus: 429, retryAfter: '86400' })).toBe(
      now + MAX_RETRY_AFTER_MS,
    );
    expect(c.isCooling(cand)).toBe(true);
    t += MAX_RETRY_AFTER_MS + 1;
    expect(c.isCooling(cand)).toBe(false);
    // 另一个 wire 不受牵连
    c.fail(cand, { upstreamStatus: 401 });
    expect(c.isCooling({ ...cand, wire: 'messages' })).toBe(false);
  });

  it('session keys: prompt_cache_key, Claude Code header / metadata.user_id, x-nomi-tab, hash', () => {
    expect(sessionKey('responses', {}, { prompt_cache_key: 'abc' }, 'codex')).toBe('codex:pck:abc');
    expect(sessionKey('messages', { 'x-claude-code-session-id': 's1' }, {})).toBe('cc:s1');
    const uid = JSON.stringify({ device_id: 'd', session_id: 's2' });
    expect(sessionKey('messages', {}, { metadata: { user_id: uid } })).toBe('cc:s2');
    expect(
      sessionKey('messages', {}, { metadata: { user_id: 'user_x_account__session_1234abcd-ef' } }),
    ).toBe('cc:1234abcd-ef');
    expect(sessionKey('chat', { 'x-nomi-tab': 't9' }, {})).toBe('tab:t9');
    const a = sessionKey(
      'messages',
      {},
      { system: 'S', messages: [{ role: 'user', content: 'x' }] },
    );
    const b = sessionKey(
      'messages',
      {},
      {
        system: 'S',
        messages: [
          { role: 'user', content: 'x' },
          { role: 'assistant', content: 'y' },
        ],
      },
    );
    expect(a).toMatch(/^h:/);
    expect(a).toBe(b);
    expect(sessionKey('messages', {}, { messages: [] })).toBeNull();
  });

  it('affinity is an LRU with a TTL', () => {
    let t = 0;
    const a = new Affinity(() => t, 2, 1_000);
    a.set('s1', { providerId: 'p', keyId: 'k1' });
    a.set('s2', { providerId: 'p', keyId: 'k2' });
    expect(a.get('s1')).toEqual({ providerId: 'p', keyId: 'k1' });
    a.set('s3', { providerId: 'p', keyId: 'k3' }); // 淘汰最久未用的 s2
    expect(a.get('s2')).toBeNull();
    t = 1_001;
    expect(a.get('s1')).toBeNull();
  });
});

describe('non-stream first-byte timeout (thinking models)', () => {
  it('does not abort a slow non-stream JSON response under the short stream first-byte limit', async () => {
    // 旧行为：FIRST_BYTE_TIMEOUT_MS=30s 对非流式也生效 → deepseek-v4-pro 思考阶段被客户端断开。
    // 这里用 hooks 把「流式首字节」压到 80ms，非流式放到 2s；上游 200ms 才出头，应成功。
    const { chat } = await setup(
      (_s, res) => {
        setTimeout(() => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              id: 'c1',
              choices: [
                { index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' },
              ],
            }),
          );
        }, 200);
      },
      { firstByteTimeoutMs: 80, nonStreamFirstByteTimeoutMs: 2_000 },
    );
    const r = await chat({ stream: false });
    expect(r.status).toBe(200);
    const j = (await r.json()) as { choices: Array<{ message: { content: string } }> };
    expect(j.choices[0]?.message.content).toBe('hi');
  });

  it('still times out non-stream when nonStreamFirstByteTimeoutMs elapses', async () => {
    const { chat } = await setup(() => undefined, {
      firstByteTimeoutMs: 5_000,
      nonStreamFirstByteTimeoutMs: 100,
    });
    const r = await chat({ stream: false });
    expect(r.status).toBeGreaterThanOrEqual(500);
    expect(await r.text()).toContain('首字节前超时');
  });
});
