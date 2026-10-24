/**
 * 客户端规格、标签绑定与限流（§5.5、§6.6、§6.7、§6.11.3、§6.11.5，P6 的网关部分）。
 */
import { createHash } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { sessionKey } from '../src/affinity';
import {
  ClientConformer,
  clientSpecOf,
  legacyClientOf,
  type ClientSpec,
} from '../src/clients/index';
import type { ClientModels, GatewayConfig } from '../src/config';
import { clientStatusOf } from '../src/errors';
import { withBindingEffort } from '../src/intent';
import { Limiter } from '../src/limits';
import { BindingTable, hashTabToken, isTabToken, type TabBinding } from '../src/route/binding';
import { mapModel, resolveCandidates } from '../src/route/resolve';
import { createGateway, type UsageEvent } from '../src/server';
import { runGatewayWorker, type WorkerInbound, type WorkerOutbound } from '../src/worker';

const TOKEN = `nomi-tab-${'a'.repeat(43)}`;

/* -------------------------- 与原来写死分支的一致性 -------------------------- */

describe('builtin model mapping read from client specs (unchanged behaviour)', () => {
  const m: ClientModels = {
    main: 'p/main',
    small: 'p/small',
    tiers: { opus: 'p/opus' },
    summary: 'p/cheap',
  };
  const cases: Array<[string | null, string, string | null]> = [
    ['claude', 'claude-opus-4-1', 'p/opus'],
    ['claude', 'claude-3-5-haiku-latest', 'p/small'],
    ['claude', 'claude-sonnet-4-5', 'p/main'],
    ['claude', 'sonnet', 'p/main'],
    ['claude', 'default', 'p/main'],
    ['claude', 'claude-something', 'p/main'],
    ['claude', 'gpt-5', null],
    ['claude', '', 'p/main'],
    ['codex', 'gpt-5.1-codex', 'p/main'],
    ['gemini', 'gemini-2.5-pro', 'p/main'],
    ['dsh', 'anything', 'p/main'],
    ['grok', 'grok-4.6', 'p/cheap'],
    ['grok', 'grok-code-fast', 'p/main'],
    ['nomi', 'whatever', null],
    [null, 'claude-opus', null],
  ];
  for (const [client, requested, want] of cases)
    it(`${client ?? 'legacy'}: ${requested || '(empty)'} → ${want}`, () => {
      expect(mapModel(client as never, m, requested)?.ref ?? null).toBe(want);
    });

  it('legacy identity: same order as before (Messages → claude, then UA, then Gemini path)', () => {
    expect(legacyClientOf('messages', 'codex_cli_rs/1.0')).toBe('claude');
    expect(legacyClientOf('responses', 'codex_cli_rs/1.0')).toBe('codex');
    expect(legacyClientOf('chat', 'Grok/1.0')).toBe('grok');
    expect(legacyClientOf('chat', 'dsh/2')).toBe('dsh');
    expect(legacyClientOf('gemini', 'node')).toBe('gemini');
    expect(legacyClientOf('chat', 'curl/8')).toBeNull();
  });

  it('session keys keep their old shape (sessions file stays compatible)', () => {
    expect(sessionKey('responses', {}, { prompt_cache_key: 'p1' }, 'codex')).toBe('codex:pck:p1');
    expect(sessionKey('messages', { 'x-claude-code-session-id': 's1' }, {}, 'claude')).toBe(
      'claude:cc:s1',
    );
    expect(
      sessionKey('messages', {}, { metadata: { user_id: JSON.stringify({ session_id: 'u1' }) } }),
    ).toBe('cc:u1');
    expect(sessionKey('chat', { 'x-nomi-tab': 't1' }, {}, 'dsh')).toBe('dsh:tab:t1');
  });
});

/* ------------------------------- 标签绑定的模型解析 ------------------------------- */

const cfgWith = (port = 1): GatewayConfig => ({
  host: '127.0.0.1',
  port: 0,
  providers: [
    {
      id: 'p',
      name: 'P',
      enabled: true,
      urls: { chat: `http://127.0.0.1:${port}/v1` },
      keys: [{ id: 'k1', value: 'key-1', enabled: true }],
      models: ['main', 'tab', 'cheap', 'opus'].map((id) => ({ id, enabled: true })),
    },
  ],
  clients: { claude: { token: 'tok-claude', models: { main: 'p/main' } } },
  allowedPrivateHosts: [`127.0.0.1:${port}`],
});

describe('model resolution order with a tab binding (§6.7)', () => {
  const binding = { models: { main: 'p/tab', tiers: { opus: 'p/opus' }, summary: 'p/cheap' } };
  const pick = (client: string, requested: string, b = binding) => {
    const r = resolveCandidates(cfgWith(), client, requested, 'chat', b);
    return r.ok ? { model: r.candidates[0]!.publicModel, ...r.resolution } : null;
  };
  it('explicit → tier → helper → binding main → unknown name (noted)', () => {
    expect(pick('claude', 'p/main')).toEqual({ model: 'p/main', how: 'explicit' });
    expect(pick('claude', 'claude-opus-4')).toEqual({ model: 'p/opus', how: 'tier' });
    expect(pick('grok', 'grok-4.6')).toEqual({ model: 'p/cheap', how: 'helper' });
    // Grok 的占位模型名（gateway 方式换模型）：按绑定的主模型解析，不记「未知模型名」
    expect(pick('grok', 'nomi')).toEqual({ model: 'p/tab', how: 'binding' });
    expect(pick('claude', 'claude-sonnet-4')).toEqual({ model: 'p/tab', how: 'binding' });
    expect(pick('claude', 'gpt-typo')).toEqual({
      model: 'p/tab',
      how: 'unknown',
      note: '未知模型名 gpt-typo，已按标签主模型处理',
    });
  });
  it('without a binding the client-level models are used (unknown names still 404 for Claude)', () => {
    const r = resolveCandidates(cfgWith(), 'claude', 'gpt-typo', 'chat');
    expect(r.ok).toBe(false);
  });
});

/* ------------------------------- 绑定表 ------------------------------- */

const bind = (o: Partial<TabBinding> = {}): TabBinding => ({
  tokenHash: hashTabToken(TOKEN),
  client: 'claude',
  tabId: 't1',
  generation: 1,
  models: { main: 'p/tab' },
  ...o,
});

describe('BindingTable', () => {
  it('token format, add / lookup / remove, newer generation invalidates the old token', async () => {
    expect(isTabToken(TOKEN)).toBe(true);
    expect(isTabToken('nomi-gw-abc')).toBe(false);
    const t = new BindingTable();
    t.add(bind());
    expect(await t.lookup(TOKEN, 0)).toMatchObject({ tabId: 't1' });
    const t2 = `nomi-tab-${'b'.repeat(43)}`;
    t.add(bind({ tokenHash: hashTabToken(t2), generation: 2 }));
    expect(await t.lookup(TOKEN, 0)).toBeNull();
    expect(t.handle({ type: 'binding:remove', id: 'r', tokenHash: hashTabToken(t2) })).toEqual({
      type: 'binding:ok',
      id: 'r',
    });
    expect(t.size).toBe(0);
  });

  it('an unknown token waits briefly for its binding; update of an unknown one is an error', async () => {
    const t = new BindingTable();
    const p = t.lookup(TOKEN, 1000);
    setTimeout(() => t.add(bind()), 20);
    expect(await p).toMatchObject({ client: 'claude' });
    expect(await new BindingTable().lookup(TOKEN, 30)).toBeNull();
    expect(
      t.handle({ type: 'binding:update', id: 'u', binding: bind({ tokenHash: 'f'.repeat(64) }) }),
    ).toMatchObject({ type: 'binding:error', id: 'u' });
    // 哈希不是 sha256 十六进制：拒绝
    expect(t.handle({ type: 'binding:add', id: 'a', binding: bind({ tokenHash: 'x' }) }).type).toBe(
      'binding:error',
    );
    expect(hashTabToken(TOKEN)).toBe(createHash('sha256').update(TOKEN).digest('hex'));
  });

  it('worker answers binding messages immediately and keeps them across gateway restarts', () => {
    let handler: ((e: { data: WorkerInbound }) => void) | null = null;
    const out: WorkerOutbound[] = [];
    runGatewayWorker({ on: (_e, fn) => (handler = fn), postMessage: (m) => out.push(m) });
    handler!({ data: { type: 'binding:add', id: '1', binding: bind() } });
    expect(out).toEqual([{ type: 'binding:ok', id: '1' }]);
  });
});

/* ------------------------------- 推理意图的 binding 来源 ------------------------------- */

describe('binding effort (§6.9.5)', () => {
  it('fills in when the request has no explicit intent; never overrides an explicit one', () => {
    expect(withBindingEffort(null, 'high')).toEqual({
      mode: 'enabled',
      effort: 'high',
      source: 'binding',
    });
    const cd = { mode: 'enabled' as const, budget: 16000, source: 'client-default' as const };
    expect(withBindingEffort(cd, 'low')).toMatchObject({ effort: 'low', source: 'binding' });
    const ex = { mode: 'enabled' as const, effort: 'medium' as const, source: 'explicit' as const };
    expect(withBindingEffort(ex, 'low')).toBe(ex);
    expect(withBindingEffort(null, 'bogus')).toBeNull();
  });
});

/* ------------------------------- 状态码矩阵 ------------------------------- */

describe('status code matrix (§6.11.5)', () => {
  it('maps upstream statuses so CLIs do not misread them', () => {
    expect(clientStatusOf(401)).toBe(502);
    expect(clientStatusOf(403)).toBe(502);
    expect(clientStatusOf(302)).toBe(502);
    expect(clientStatusOf(429)).toBe(429);
    expect(clientStatusOf(400)).toBe(400);
    expect(clientStatusOf(504)).toBe(504);
    expect(clientStatusOf(529)).toBe(529);
    expect(clientStatusOf(500)).toBe(502);
  });
});

/* ------------------------------- 限流 ------------------------------- */

describe('Limiter (§6.11.3)', () => {
  it('no limits: free; concurrency 1: the second waits until the first releases', async () => {
    const l = new Limiter();
    expect(await l.acquire('x', {})).toBeTypeOf('function');
    const r1 = (await l.acquire('k', { maxConcurrency: 1 }))!;
    let waiting = 0;
    const p2 = l.acquire('k', { maxConcurrency: 1 }, { onWaiting: () => waiting++ });
    await new Promise((r) => setTimeout(r, 10));
    expect(waiting).toBe(1);
    expect(l.active('k')).toBe(1);
    r1();
    const r2 = await p2;
    expect(r2).toBeTypeOf('function');
    expect(l.active('k')).toBe(1);
  });

  it('queue timeout returns null; rpm blocks within the window', async () => {
    const l = new Limiter();
    await l.acquire('k', { maxConcurrency: 1 });
    expect(await l.acquire('k', { maxConcurrency: 1 }, { timeoutMs: 20 })).toBeNull();
    let t = 0;
    const r = new Limiter(() => t);
    await r.acquire('k', { rpm: 1 });
    expect(await r.acquire('k', { rpm: 1 }, { timeoutMs: 0 })).toBeNull();
    t = 61_000;
    expect(await r.acquire('k', { rpm: 1 }, { timeoutMs: 0 })).toBeTypeOf('function');
  });
});

/* ------------------------------- 客户端校验 ------------------------------- */

describe('ClientConformer (§6.6)', () => {
  const strict: ClientSpec = {
    id: 'strict-x',
    strictness: 'strict',
    acceptedEvents: ['response.created', 'response.completed'],
    extraRequired: { 'response.created': { foo: 'bar' } },
  };
  it('drops events outside the accepted set, fills extra fields, notes which spec required it', () => {
    const notes: string[] = [];
    const c = new ClientConformer({ spec: strict, wire: 'responses', notes });
    const created = 'data: {"type":"response.created"}\n\n';
    const extra = 'data: {"type":"response.metadata"}\n\n';
    const done = 'data: {"type":"response.completed","foo":1}\n\n';
    const out = c.push(created + extra) + c.push(done) + c.end();
    expect(out).toBe('data: {"type":"response.created","foo":"bar"}\n\n' + done);
    expect(notes).toEqual([
      '已按 strict-x 的要求补齐 response.created 的字段',
      '已丢掉 strict-x 不接受的事件 response.metadata',
    ]);
  });
  it('lenient built-in clients are not conformed at all; Grok is strict', () => {
    expect(ClientConformer.needed(clientSpecOf('codex')!)).toBe(false);
    expect(ClientConformer.needed(clientSpecOf('grok')!)).toBe(true);
  });
});

/* ------------------------------- 端到端：标签令牌 ------------------------------- */

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

async function gateway(status = 200, extra: { maxConcurrency?: number; delayMs?: number } = {}) {
  const models: string[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += String(c)));
    req.on('end', () => {
      models.push(String((JSON.parse(raw) as { model?: string }).model));
      setTimeout(() => {
        if (status !== 200) {
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end('{"error":{"message":"bad key"}}');
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'c',
            choices: [{ index: 0, message: { role: 'assistant', content: 'ok' } }],
          }),
        );
      }, extra.delayMs ?? 0);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  cleanups.push(() => server.close());
  const port = (server.address() as AddressInfo).port;
  const cfg = cfgWith(port);
  if (extra.maxConcurrency) cfg.providers[0]!.keys[0]!.maxConcurrency = extra.maxConcurrency;
  const usage: UsageEvent[] = [];
  const gw = createGateway(cfg, { onUsage: (e) => usage.push(e), bindingWaitMs: 100 });
  await gw.start();
  cleanups.push(() => gw.stop());
  const call = (token: string, model = 'claude-sonnet-4') =>
    fetch(`${gw.listenUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }] }),
    });
  return { gw, usage, models, call };
}

describe('gateway with tab tokens', () => {
  it('routes a tab token to its binding and logs tab / generation / resolution', async () => {
    const g = await gateway();
    g.gw.bindings.add(bind({ client: 'claude', models: { main: 'p/tab' } }));
    const r = await g.call(TOKEN);
    expect(r.status).toBe(200);
    expect(g.models).toEqual(['tab']);
    expect(g.usage[0]).toMatchObject({ tabId: 't1', generation: 1, resolved: 'binding' });
  });

  it('an unknown tab token gets 503 + Retry-After (not 401) after a short wait', async () => {
    const g = await gateway();
    const r = await g.call(TOKEN);
    expect(r.status).toBe(503);
    expect(r.headers.get('retry-after')).toBe('2');
    expect(g.models).toEqual([]);
  });

  it('upstream 401 becomes 502 with an explanation (Claude Code would ask to log in again)', async () => {
    const g = await gateway(401);
    const r = await g.call('tok-claude', 'p/main');
    expect(r.status).toBe(502);
    expect(await r.text()).toContain('上游拒绝了这个供应商的 Key（401）');
  });

  it('per-key concurrency: the second request waits for the first instead of failing', async () => {
    const g = await gateway(200, { maxConcurrency: 1, delayMs: 50 });
    const [a, b] = await Promise.all([
      g.call('tok-claude', 'p/main'),
      g.call('tok-claude', 'p/main'),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    // 非流式请求排队时不先发 SSE 响应头：两个都是完整的 JSON 回复
    expect(await Promise.all([a.json(), b.json()])).toMatchObject([
      { choices: [{ message: { content: 'ok' } }] },
      { choices: [{ message: { content: 'ok' } }] },
    ]);
    expect(g.models).toEqual(['main', 'main']);
  });
});
