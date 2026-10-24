/**
 * 模型规格与路由计划（§6.9，P7）：目录快照、EffectiveModel 合并顺序与学到结论的有效期、
 * 换算与贴合的性质、§6.9.10 典型转换路径、错误修正器回放、严格模式、schema 清理器、影子模式。
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import type { ClientId, GatewayConfig, RuntimeProvider } from '../src/config';
import { budgetToEffort, effortToBudget, type ReasoningIntent } from '../src/intent';
import type { Wire } from '../src/ir';
import type { LearnEvent } from '../src/learn';
import { CATALOG_VERSION, catalogEntry, catalogSize } from '../src/models/catalog';
import { effectiveModel, LEARNED_TTL_MS } from '../src/models/effective';
import {
  fitLevel,
  geminiExpressible,
  inlineRefs,
  renderReasoning,
} from '../src/models/rules/request/index';
import type { Effort } from '../src/models/types';
import { applyRectifiers, rectifierFor } from '../src/route/rectifiers';
import { resolveCandidates } from '../src/route/resolve';
import { createGateway } from '../src/server';
import { upstreamBody } from '../src/upstream';

const prov = (
  o: Partial<RuntimeProvider> & { urls: RuntimeProvider['urls'] },
): RuntimeProvider => ({
  id: 'p',
  name: 'P',
  enabled: true,
  keys: [{ id: 'k', value: 'key', enabled: true }],
  models: [],
  ...o,
});

/* ------------------------------- 目录 ------------------------------- */

describe('built-in catalog (models.dev)', () => {
  it('is versioned and covers the main model families', () => {
    expect(CATALOG_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(catalogSize()).toBeGreaterThan(150);
    const sample = Object.fromEntries(
      ['claude-sonnet-4-6', 'gemini-2.5-pro', 'deepseek-v4-flash', 'glm-5.3', 'kimi-k3'].map(
        (id) => [id, catalogEntry(id)],
      ),
    );
    expect(sample).toMatchSnapshot();
  });
  it('lookup ignores provider prefixes and case', () => {
    expect(catalogEntry('anthropic/Claude-Sonnet-4-6')).toEqual(catalogEntry('claude-sonnet-4-6'));
    expect(catalogEntry('totally-unknown-model')).toBeUndefined();
  });
});

/* ------------------------------- 合并 ------------------------------- */

describe('EffectiveModel merge (family → catalog → provider → learned → user)', () => {
  it('family only for unknown names, catalog over family, user over everything', () => {
    const p = prov({
      urls: { chat: 'https://relay.example/v1' },
      models: [
        { id: 'claude-house-9', enabled: true },
        { id: 'claude-sonnet-4-6', enabled: true, maxOutput: 1000, vision: false },
      ],
    });
    const fam = effectiveModel(p, 'claude-house-9');
    expect(fam.sources).toEqual(['family']);
    expect(fam.wires?.prefer).toEqual(['messages']);
    const full = effectiveModel(p, 'claude-sonnet-4-6');
    expect(full.sources).toEqual(['family', 'catalog', 'user']);
    expect(full.reasoning?.control).toBe('adaptive');
    expect(full.limits).toMatchObject({ context: 1000000, maxOutput: 1000 });
    expect(full.input?.images).toBe(false);
  });

  it('learned conclusions apply until they expire or the catalog changes; user settings win', () => {
    const now = 1_000_000_000_000;
    const p = prov({
      urls: { chat: 'https://relay.example/v1' },
      models: [{ id: 'glm-5.3', enabled: true }],
    });
    const learned = (at: number, catalogVersion = CATALOG_VERSION) => ({
      models: { 'glm-5.3': { at, catalogVersion, efforts: ['low'] as Effort[] } },
    });
    expect(effectiveModel(p, 'glm-5.3', learned(now), { now }).reasoning?.efforts).toEqual(['low']);
    expect(
      effectiveModel(p, 'glm-5.3', learned(now - LEARNED_TTL_MS - 1), { now }).reasoning?.efforts,
    ).toEqual(['low', 'high', 'max']);
    expect(effectiveModel(p, 'glm-5.3', learned(now, '1999-01-01'), { now }).sources).not.toContain(
      'learned',
    );
    const userP = prov({
      urls: { chat: 'https://relay.example/v1' },
      models: [{ id: 'glm-5.3', enabled: true, efforts: ['high'] }],
    });
    expect(effectiveModel(userP, 'glm-5.3', learned(now), { now }).reasoning?.efforts).toEqual([
      'high',
    ]);
  });
});

/* ------------------------------- 换算与贴合的性质 ------------------------------- */

const EFFORTS: Effort[] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

describe('conversion properties', () => {
  it('effort → budget is monotonic and clamped below max_tokens', () => {
    for (const max of [2048, 8192, 32000, 128000, undefined]) {
      const budgets = EFFORTS.map((e) => effortToBudget(e, max));
      for (let i = 1; i < budgets.length; i++)
        expect(budgets[i]!).toBeGreaterThanOrEqual(budgets[i - 1]!);
      for (const b of budgets) {
        expect(b).toBeGreaterThanOrEqual(1024);
        if (max && max > 1025) expect(b).toBeLessThan(max);
      }
    }
  });
  it('effort → budget → effort round trip does not drift (low … xhigh)', () => {
    for (const max of [16000, 64000, undefined])
      for (const e of ['low', 'medium', 'high', 'xhigh'] as const)
        expect(budgetToEffort(effortToBudget(e, max), max)).toBe(e);
  });
  it('fitLevel picks an available level, never above the request when one exists', () => {
    const sets: Effort[][] = [
      ['low', 'high', 'max'],
      ['medium'],
      ['minimal', 'low', 'medium', 'high'],
    ];
    for (const set of sets)
      for (const want of EFFORTS) {
        const got = fitLevel(want, set);
        expect(set).toContain(got);
        const below = set.filter((e) => EFFORTS.indexOf(e) <= EFFORTS.indexOf(want));
        if (below.length) expect(EFFORTS.indexOf(got)).toBeLessThanOrEqual(EFFORTS.indexOf(want));
      }
    expect(fitLevel('xhigh', ['low', 'high', 'max'])).toBe('high');
    expect(fitLevel('minimal', ['low', 'high'])).toBe('low');
  });
});

/* ------------------------------- §6.9.10 典型转换路径 ------------------------------- */

interface Row {
  name: string;
  client: ClientId;
  ingress: Wire;
  model: string;
  urls: RuntimeProvider['urls'];
  body: Record<string, unknown>;
  wire: Wire;
  reasoning: (b: Record<string, unknown>) => unknown;
  want: unknown;
  losses: string[];
}

const msgs = [{ role: 'user', content: 'hi' }];
const relay = (wires: Wire[]) =>
  Object.fromEntries(
    wires.map((w) => [w, w === 'messages' ? 'https://relay.example' : 'https://relay.example/v1']),
  ) as RuntimeProvider['urls'];

const ROWS: Row[] = [
  {
    name: 'Claude Code → claude (relay): Messages, untouched',
    client: 'claude',
    ingress: 'messages',
    model: 'claude-sonnet-4-6',
    urls: relay(['messages', 'chat']),
    body: {
      model: 'x',
      max_tokens: 32000,
      thinking: { type: 'enabled', budget_tokens: 16000 },
      messages: msgs,
    },
    wire: 'messages',
    reasoning: (b) => b.thinking,
    want: { type: 'enabled', budget_tokens: 16000 },
    losses: [],
  },
  {
    name: 'Claude Code → gpt: Responses (model-native), budget → effort fitted',
    client: 'claude',
    ingress: 'messages',
    model: 'gpt-5.6-terra',
    urls: relay(['messages', 'responses']),
    body: {
      model: 'x',
      max_tokens: 32000,
      thinking: { type: 'enabled', budget_tokens: 30000 },
      messages: msgs,
    },
    wire: 'responses',
    reasoning: (b) => b.reasoning,
    want: { effort: 'xhigh' },
    losses: ['signature', 'cache-control'],
  },
  {
    name: 'Claude Code → deepseek: Chat, reasoning passback, effort fitted to the model',
    client: 'claude',
    ingress: 'messages',
    model: 'deepseek-v4-flash',
    urls: relay(['chat']),
    body: {
      model: 'x',
      max_tokens: 32000,
      output_config: { effort: 'medium' },
      thinking: { type: 'enabled', budget_tokens: 8000 },
      messages: msgs,
    },
    wire: 'chat',
    reasoning: (b) => b.reasoning_effort,
    want: 'low',
    losses: ['signature', 'cache-control'],
  },
  {
    name: 'Codex → glm-5.x: Chat, effort fitted',
    client: 'codex',
    ingress: 'responses',
    model: 'glm-5.3',
    urls: relay(['chat']),
    body: { model: 'x', reasoning: { effort: 'medium' }, input: 'hi' },
    wire: 'chat',
    reasoning: (b) => b.reasoning_effort,
    want: 'low',
    losses: ['sealed-reasoning', 'freeform-tools', 'images'],
  },
  {
    name: 'Codex → claude: Messages, adaptive + effort',
    client: 'codex',
    ingress: 'responses',
    model: 'claude-sonnet-4-6',
    urls: relay(['messages', 'responses']),
    body: { model: 'x', reasoning: { effort: 'high' }, input: 'hi' },
    wire: 'messages',
    reasoning: (b) => [
      b.thinking,
      (b.output_config as Record<string, unknown> | undefined)?.effort,
    ],
    // 第三方 Messages 中转：output_config 是 Anthropic 专有字段，generic 适配器去掉，只留 adaptive
    want: [{ type: 'adaptive' }, undefined],
    losses: ['sealed-reasoning', 'freeform-tools'],
  },
  {
    name: 'Grok → gpt: Responses passthrough, lossless',
    client: 'grok',
    ingress: 'responses',
    model: 'gpt-5.6-terra',
    urls: relay(['responses', 'chat']),
    body: { model: 'x', reasoning: { effort: 'high' }, input: 'hi' },
    wire: 'responses',
    reasoning: (b) => b.reasoning,
    want: { effort: 'high' },
    losses: [],
  },
  {
    name: 'Gemini CLI → gpt: Responses, thinkingBudget → effort',
    client: 'gemini',
    ingress: 'gemini',
    model: 'gpt-5.6-terra',
    urls: relay(['responses', 'gemini']),
    body: {
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
      generationConfig: { thinkingConfig: { thinkingBudget: 24000 } },
    },
    wire: 'responses',
    reasoning: (b) => (b.reasoning as Record<string, unknown> | undefined)?.effort,
    want: 'high',
    losses: ['thought-signature'],
  },
  {
    name: 'any → gemini-3.x: Gemini, effort → thinkingLevel',
    client: 'codex',
    ingress: 'responses',
    model: 'gemini-3.1-pro-preview',
    urls: relay(['gemini', 'responses']),
    body: { model: 'x', reasoning: { effort: 'xhigh' }, input: 'hi' },
    wire: 'gemini',
    reasoning: (b) =>
      ((b.generationConfig as Record<string, unknown>).thinkingConfig as Record<string, unknown>)
        .thinkingLevel,
    want: 'high',
    losses: ['sealed-reasoning', 'freeform-tools'],
  },
];

describe('typical conversion paths (§6.9.10) with routePlan: active', () => {
  for (const row of ROWS)
    it(row.name, () => {
      const cfg: GatewayConfig = {
        host: '127.0.0.1',
        port: 0,
        routePlan: 'active',
        providers: [prov({ urls: row.urls, models: [{ id: row.model, enabled: true }] })],
        clients: {},
      };
      const r = resolveCandidates(cfg, row.client, `p/${row.model}`, row.ingress);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const c = r.candidates[0]!;
      expect(c.wire).toBe(row.wire);
      expect(c.plan?.losses).toEqual(row.losses);
      const body = upstreamBody(row.ingress, c, row.body, {
        stream: true,
        client: row.client,
      }) as Record<string, unknown>;
      const got = row.reasoning(body);
      if (row.want && typeof row.want === 'object' && !Array.isArray(row.want))
        expect(got).toMatchObject(row.want as object);
      else expect(got).toEqual(row.want);
      if (row.model.startsWith('deepseek'))
        expect(JSON.stringify(body)).not.toContain('"budget_tokens"');
    });

  it('shadow mode keeps the current choice and records the planned one', () => {
    const cfg: GatewayConfig = {
      host: '127.0.0.1',
      port: 0,
      routePlan: 'shadow',
      providers: [
        prov({
          urls: relay(['messages', 'responses']),
          models: [{ id: 'gpt-5.6-terra', enabled: true }],
        }),
      ],
      clients: {},
    };
    const r = resolveCandidates(cfg, 'claude', 'p/gpt-5.6-terra', 'messages');
    expect(r.ok && r.candidates[0]!.wire).toBe('messages');
    expect(r.ok && r.candidates[0]!.plan).toMatchObject({
      upstream: 'responses',
      legacy: 'messages',
    });
  });

  it('default (unset routePlan) is active: plan.upstream wins', () => {
    const cfg: GatewayConfig = {
      host: '127.0.0.1',
      port: 0,
      providers: [
        prov({
          urls: relay(['messages', 'responses']),
          models: [{ id: 'gpt-5.6-terra', enabled: true }],
        }),
      ],
      clients: {},
    };
    const r = resolveCandidates(cfg, 'claude', 'p/gpt-5.6-terra', 'messages');
    expect(r.ok && r.candidates[0]!.wire).toBe('responses');
    expect(r.ok && r.candidates[0]!.plan?.upstream).toBe('responses');
  });
});

/* ------------------------------- 推理渲染的边界 ------------------------------- */

describe('reasoning rendering edge cases', () => {
  const p = prov({ urls: relay(['chat']), models: [{ id: 'kimi-k2.7-code', enabled: true }] });
  it('a model without a reasoning control gets no reasoning fields (recorded as a loss)', () => {
    const m = effectiveModel(p, 'kimi-k2.7-code');
    expect(m.reasoning?.control).toBe('none');
    const notes: string[] = [];
    const intent: ReasoningIntent = { mode: 'enabled', effort: 'high', source: 'explicit' };
    const r = renderReasoning('chat', { model: 'x' }, intent, m, notes);
    expect(r.body).toEqual({ model: 'x' });
    expect(r.losses).toEqual(['reasoning-control']);
  });
});

/* ------------------------------- schema 清理器 ------------------------------- */

describe('tool schema cleaners', () => {
  it('gemini: keeps parameters when expressible, switches to parametersJsonSchema otherwise', () => {
    expect(geminiExpressible({ type: 'object', properties: { a: { type: 'string' } } })).toBe(true);
    expect(geminiExpressible({ type: 'object', additionalProperties: false })).toBe(false);
    expect(geminiExpressible({ type: ['string', 'null'] })).toBe(false);
    const p = prov({
      urls: { gemini: 'https://relay.example/v1beta' },
      models: [{ id: 'gemini-2.5-pro', enabled: true }],
    });
    const cfg: GatewayConfig = { host: '127.0.0.1', port: 0, providers: [p], clients: {} };
    const r = resolveCandidates(cfg, 'gemini', 'p/gemini-2.5-pro', 'gemini');
    if (!r.ok) throw new Error('no candidate');
    const body = upstreamBody(
      'gemini',
      r.candidates[0]!,
      {
        contents: [],
        tools: [
          {
            functionDeclarations: [
              { name: 'ok', parameters: { type: 'object', properties: { a: { type: 'string' } } } },
              { name: 'odd', parameters: { type: 'object', oneOf: [{ required: ['a'] }] } },
            ],
          },
        ],
      },
      { stream: false },
    ) as { tools: Array<{ functionDeclarations: Array<Record<string, unknown>> }> };
    const [ok, odd] = body.tools[0]!.functionDeclarations;
    expect(ok).toHaveProperty('parameters');
    expect(odd).not.toHaveProperty('parameters');
    expect(odd).toHaveProperty('parametersJsonSchema');
  });
  it('kimi / deepseek: local $refs are inlined', () => {
    const s = {
      type: 'object',
      $defs: { P: { type: 'string' } },
      properties: { a: { $ref: '#/$defs/P', description: 'x' } },
    };
    expect(inlineRefs(s)).toEqual({
      type: 'object',
      properties: { a: { type: 'string', description: 'x' } },
    });
  });
});

/* ------------------------------- 修正器 ------------------------------- */

describe('rectifiers (§6.9.8)', () => {
  it('recognises budget and effort rejections only when the request carried them', () => {
    const sentEffort = { reasoning_effort: 'xhigh' };
    expect(
      rectifierFor(
        400,
        "reasoning_effort 'xhigh' is not supported; must be one of low, high",
        sentEffort,
      ),
    ).toEqual({ fix: 'effort', rejected: 'xhigh' });
    expect(rectifierFor(400, 'reasoning_effort is not supported', {})).toBeNull();
    const sentBudget = { max_tokens: 4000, thinking: { type: 'enabled', budget_tokens: 8000 } };
    expect(rectifierFor(400, 'budget_tokens must be less than max_tokens', sentBudget)).toEqual({
      fix: 'budget',
    });
    const fixed = applyRectifiers('messages', sentBudget, ['budget'], 64000, []) as Record<
      string,
      unknown
    >;
    expect(fixed).toMatchObject({ max_tokens: 4000, thinking: { budget_tokens: 2000 } });
    expect(applyRectifiers('chat', sentEffort, ['effort'], undefined, [])).toEqual({
      reasoning_effort: 'high',
    });
  });
});

/* ------------------------------- 端到端：修正重试、严格模式 ------------------------------- */

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

async function upstream(script: (body: Record<string, unknown>, n: number) => [number, unknown]) {
  const bodies: Array<Record<string, unknown>> = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += String(c)));
    req.on('end', () => {
      const b = JSON.parse(raw) as Record<string, unknown>;
      bodies.push(b);
      const [status, out] = script(b, bodies.length);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  cleanups.push(() => server.close());
  return { port: (server.address() as AddressInfo).port, bodies };
}

const okChat = { id: 'c', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' } }] };

async function gw(port: number, model: string, extra: Partial<GatewayConfig> = {}) {
  const learned: LearnEvent[] = [];
  const g = createGateway(
    {
      host: '127.0.0.1',
      port: 0,
      providers: [
        prov({
          urls: { chat: `http://127.0.0.1:${port}/v1` },
          models: [{ id: model, enabled: true }],
        }),
      ],
      clients: { codex: { token: 'tok', models: { main: `p/${model}` } } },
      allowedPrivateHosts: [`127.0.0.1:${port}`],
      ...extra,
    },
    { onLearn: (e) => learned.push(e) },
  );
  await g.start();
  cleanups.push(() => g.stop());
  const call = (body: Record<string, unknown>) =>
    fetch(`${g.listenUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer tok' },
      body: JSON.stringify({ model: `p/${model}`, messages: msgs, ...body }),
    });
  return { call, learned };
}

describe('rectifier replay and strict mode through the gateway', () => {
  it('effort rejected → retried one level lower, conclusion reported with the catalog version', async () => {
    const up = await upstream((b, n) =>
      n === 1
        ? [
            400,
            {
              error: {
                message: `reasoning_effort '${String(b.reasoning_effort)}' is not supported, must be one of low, medium`,
              },
            },
          ]
        : [200, okChat],
    );
    const g = await gw(up.port, 'house-model');
    const r = await g.call({ reasoning_effort: 'high' });
    expect(r.status).toBe(200);
    expect(up.bodies.map((b) => b.reasoning_effort)).toEqual(['high', 'medium']);
    expect(g.learned).toContainEqual(
      expect.objectContaining({
        type: 'model-efforts',
        model: 'house-model',
        efforts: ['minimal', 'low', 'medium'],
        catalogVersion: CATALOG_VERSION,
      }),
    );
  });

  it('default: a reasoning model silently loses temperature (noted); strict mode refuses with 400', async () => {
    const up = await upstream(() => [200, okChat]);
    const g = await gw(up.port, 'gpt-5.6-terra');
    expect((await g.call({ temperature: 0.2 })).status).toBe(200);
    expect(up.bodies[0]).not.toHaveProperty('temperature');
    const strict = await gw(up.port, 'gpt-5.6-terra', { strictParams: true });
    const r = await strict.call({ temperature: 0.2 });
    expect(r.status).toBe(400);
    expect(await r.text()).toContain('不支持参数 temperature');
    expect(up.bodies).toHaveLength(1);
  });

  it('gpt family on Chat: max_tokens is sent as max_completion_tokens', async () => {
    const up = await upstream(() => [200, okChat]);
    const g = await gw(up.port, 'gpt-5.6-terra');
    await g.call({ max_tokens: 500 });
    expect(up.bodies[0]).toMatchObject({ max_completion_tokens: 500 });
    expect(up.bodies[0]).not.toHaveProperty('max_tokens');
  });
});
