// Parity cases for apps/desktop-electron/internal/gateway/src/route/* (batch 4c).
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function recordRoute({ gw, root }) {
  const cl = await gw('src/clients/index.ts');
  const nat = await gw('src/route/native.ts');
  const plan = await gw('src/route/plan.ts');
  const rect = await gw('src/route/rectifiers.ts');
  const rs = await gw('src/route/resolve.ts');
  const bd = await gw('src/route/binding.ts');
  const eff = await gw('src/models/effective.ts');
  const { BUILTIN_GATEWAY_ENTRIES } = await import(
    pathToFileURL(join(root, 'apps/desktop-electron/internal/cli-plugins/src/gateways.ts')).href
  );
  for (const e of BUILTIN_GATEWAY_ENTRIES)
    if (e.clientSpec.id === e.client) cl.registerClientSpec(e.clientSpec);

  const K = (id, extra) => ({ id, value: 'v-' + id, enabled: true, ...extra });
  const M = (id, extra) => ({ id, enabled: true, ...extra });
  const P = (id, extra) => ({
    id,
    name: 'N-' + id,
    enabled: true,
    urls: {},
    keys: [K('k1')],
    models: [],
    ...extra,
  });
  const providers = [
    P('ant', {
      preset: 'anthropic',
      aliases: ['anthropic'],
      urls: { messages: 'https://api.anthropic.com', chat: 'https://relay.example/v1' },
      models: [
        M('claude-opus-4-1'),
        M('claude-sonnet-4-5', { wires: ['chat'] }),
        M('claude-3-5-haiku-20241022'),
      ],
      fallback: ['oai/gpt-5', 'nope/x', 'gpt-4o'],
    }),
    P('oai', {
      urls: { responses: 'https://api.openai.com/v1', chat: 'https://api.openai.com/v1' },
      keys: [K('k1'), K('k2', { wire: 'chat' }), K('k3', { enabled: false })],
      models: [M('gpt-5'), M('gpt-4o', { enabled: false }), M('o3-mini'), M('codex-mini')],
      modelMap: [{ from: 'gpt-5', to: 'gpt-5-2025' }],
    }),
    P('gen', {
      urls: {
        chat: 'https://proxy.example.com/v1',
        responses: 'https://proxy.example.com/v1',
        messages: '',
        gemini: 'https://g.example/v1beta',
      },
      detected: { gemini: { ok: false } },
      models: [
        M('gpt-4o'),
        M('deepseek-chat'),
        M('gemini-2.5-pro'),
        M('grok-4'),
        M('qwen3-coder', { wires: ['responses', 'chat'] }),
      ],
    }),
    P('mm', {
      preset: 'minimax',
      urls: { chat: 'https://api.minimaxi.com/v1', responses: 'https://x.example/v1' },
      models: [M('MiniMax-M2'), M('deepseek-chat')],
    }),
    P('ds', {
      urls: { chat: 'https://api.deepseek.com/v1', messages: 'https://api.deepseek.com/anthropic' },
      models: [M('deepseek-reasoner'), M('claude-x')],
    }),
    P('amx', {
      urls: { responses: 'https://gateway.amux.ai/v1', chat: 'https://gateway.amux.ai/v1' },
      models: [M('kimi-k2')],
    }),
    P('off', {
      enabled: false,
      urls: { chat: 'https://off.example/v1' },
      models: [M('gpt-5'), M('solo')],
    }),
    P('nokey', {
      urls: { chat: 'https://nk.example/v1' },
      keys: [K('k', { enabled: false })],
      models: [M('nk-model')],
    }),
  ];
  const learned = {
    gen: {
      wireDown: { responses: { at: 1e15, reason: 'x' } },
      droppedParams: { chat: ['seed', 'top_k'] },
      modelWire: { 'deepseek-chat': ['chat'] },
    },
    oai: {
      customToolsRefused: ['gpt-5'],
      droppedParams: { responses: ['seed'] },
      wireDown: { chat: { at: 0, reason: 'old' } },
    },
  };
  const clients = {
    claude: {
      token: 't',
      models: {
        main: 'ant/claude-opus-4-1',
        small: 'ant/claude-3-5-haiku-20241022',
        tiers: { sonnet: 'oai/gpt-5' },
      },
    },
    codex: { token: 't', models: { main: 'oai/gpt-5', summary: 'gen/gpt-4o' } },
    grok: { token: 't', models: { main: 'gen/grok-4' } },
    nomi: { token: 't', models: {} },
  };
  const cfgs = [
    { host: '127.0.0.1', port: 1, providers, clients, learned },
    {
      host: '127.0.0.1',
      port: 1,
      providers,
      clients,
      learned,
      routePlan: 'shadow',
      strictParams: true,
    },
  ];

  const out = {
    providers,
    learned,
    cfgs: cfgs.map((c) => ({
      routePlan: c.routePlan ?? null,
      strictParams: c.strictParams ?? null,
    })),
    clients,
  };
  const WIRES = [null, 'messages', 'responses', 'chat', 'gemini'];
  const learnedFor = (p) => learned[p.id];

  out.bare = [
    'claude-x',
    'Anthropic/Claude-Opus',
    'a/b/GPT-5',
    'o3',
    'O1-mini',
    'codex',
    'gpt4',
    'x/',
    '',
    'İclaude',
  ].map((m) => ({ m, claude: nat.isClaudeModel(m), openai: nat.isOpenAIModel(m) }));

  out.wires = [];
  out.pick = [];
  out.plan = [];
  for (const p of providers) {
    const keys = [undefined, ...p.keys];
    for (const model of [...p.models.map((m) => m.id), 'unknown-model', 'claude-y', 'gpt-5']) {
      for (const [ki, key] of keys.entries()) {
        for (const now of [1e15 + 1, 1e15 + 60 * 60_000]) {
          out.wires.push({
            p: p.id,
            model,
            key: ki - 1,
            now,
            wires: nat.wiresFor(p, model, key, learnedFor(p), now),
          });
        }
      }
      const usables = [
        Object.keys(p.urls),
        ['chat'],
        ['messages', 'chat'],
        ['gemini', 'responses'],
        [],
      ];
      const m = eff.effectiveModel(p, model, learnedFor(p));
      for (const u of usables)
        for (const ing of WIRES) {
          out.pick.push({
            p: p.id,
            model,
            ingress: ing,
            usable: u,
            wire: nat.pickWire(p, model, ing, u),
          });
          out.plan.push({
            p: p.id,
            model,
            ingress: ing,
            usable: u,
            plan: plan.makePlan(p, m, ing, u),
            noModel: plan.makePlan(p, undefined, ing, u),
          });
        }
    }
  }
  const effs = [
    undefined,
    { tools: { freeform: false } },
    { input: { images: false } },
    { reasoning: { control: 'none' } },
    { tools: { freeform: true }, input: { images: true } },
  ];
  out.losses = [];
  for (const [ei, e] of effs.entries())
    for (const a of WIRES)
      for (const b of WIRES.slice(1)) out.losses.push({ e: ei, a, b, l: plan.lossesOf(a, b, e) });
  out.effs = effs.map((e) => e ?? null);
  out.quality = [
    [],
    ['signature'],
    ['cache-control', 'passthrough'],
    ['images'],
    ['signature', 'images'],
  ].map((l) => ({ l, q: plan.qualityOf(l) }));

  const sents = [
    { thinking: { type: 'enabled', budget_tokens: 32000 }, max_tokens: 20000 },
    { thinking: { type: 'enabled', budget_tokens: 32000 } },
    { thinking: { budget_tokens: 5000 }, max_tokens: 1500 },
    { thinking_budget: 9000 },
    { generationConfig: { thinkingConfig: { thinkingBudget: 2048, includeThoughts: true }, x: 1 } },
    { generationConfig: { thinkingConfig: { thinkingBudget: 0, thinkingLevel: 'high' } } },
    { reasoning: { effort: 'xhigh', summary: 'auto' } },
    { reasoning_effort: 'minimal' },
    { output_config: { effort: 'max' } },
    { generationConfig: { thinkingConfig: { thinkingLevel: 'medium' } } },
    { reasoning: { effort: 'bogus' }, reasoning_effort: 'low' },
    { reasoning: 'high' },
    null,
    [],
    'x',
    {},
  ];
  const texts = [
    'budget_tokens must be less than max_tokens',
    'thinking.budget invalid',
    'Invalid reasoning effort: xhigh',
    'thinking_level not supported',
    'reasoning_effort: one of low, medium, high expected',
    'thinkingBudget out of range',
    '参数 effort 不支持',
    'effort is great',
    'unsupported\u00a0value for effort',
    'must\u3000be effort',
    'INVALID THINKINGLEVEL',
    '',
  ];
  out.sents = sents;
  out.rectifier = [];
  for (const st of [400, 422, 500, 404])
    for (const t of texts)
      for (const [si, s] of sents.entries())
        out.rectifier.push({ st, t, s: si, r: rect.rectifierFor(st, t, s) });
  out.sentEffort = sents.map((s) => rect.sentEffort(s) ?? null);
  out.lower = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'zz'].map(
    (e) => rect.lowerEffort(e) ?? null,
  );
  out.remaining = [];
  for (const r of ['minimal', 'low', 'high', 'max', 'zz'])
    for (const k of [undefined, [], ['low', 'high', 'zz'], ['max', 'minimal']])
      out.remaining.push({ r, k: k ?? null, out: rect.remainingEfforts(r, k) });
  out.apply = [];
  for (const w of ['messages', 'chat', 'responses', 'gemini'])
    for (const [si, s] of sents.entries())
      for (const fx of [[], ['budget'], ['effort'], ['budget', 'effort']])
        for (const mo of [undefined, 0, 4000, 64000]) {
          const notes = [];
          const r = rect.applyRectifiers(w, s, fx, mo, notes);
          out.apply.push({
            w,
            s: si,
            fx,
            mo: mo ?? null,
            same: r === s,
            body: JSON.stringify(r) ?? null,
            notes,
          });
        }

  const modelSets = [
    undefined,
    {},
    { main: 'ant/claude-opus-4-1' },
    {
      main: 'oai/gpt-5',
      small: 'gen/gpt-4o',
      subagent: 'ds/deepseek-reasoner',
      summary: '',
      tiers: { opus: 'ant/claude-opus-4-1', haiku: '' },
    },
    { main: '', small: 'x/y' },
  ];
  const reqs = [
    '',
    'claude-opus-4-1-20250805',
    'claude-3-5-haiku-x',
    'claude-sonnet-4',
    'gpt-5',
    'gpt-5-codex',
    'codex-mini-latest',
    'grok-4.6-mini',
    'zzz',
    'opus',
    'haiku',
    'nomi',
  ];
  out.modelSets = modelSets.map((m) => m ?? null);
  out.mapModel = [];
  for (const c of [null, 'nope', 'nomi', 'claude', 'codex', 'grok', 'dsh', 'gemini'])
    for (const [mi, m] of modelSets.entries())
      for (const r of reqs)
        for (const b of [false, true])
          out.mapModel.push({ c, m: mi, r, b, out: rs.mapModel(c, m, r, b) });
  out.split = ['a/b', '/b', 'a/', 'ab', 'a/b/c', ''].map((r) => ({ r, ...rs.splitRef(r) }));

  out.modelJSON = [];
  const modelIdx = (j) => {
    let i = out.modelJSON.indexOf(j);
    if (i < 0) {
      i = out.modelJSON.length;
      out.modelJSON.push(j);
    }
    return i;
  };
  const ser = (c) => ({
    provider: c.provider.id,
    key: c.key.id,
    publicModel: c.publicModel,
    upstreamModel: c.upstreamModel,
    wire: c.wire,
    dropParams: c.dropParams ?? null,
    customToolsAsFunctions: c.customToolsAsFunctions ?? null,
    model: c.model ? modelIdx(JSON.stringify(c.model)) : null,
    plan: c.plan ?? null,
    rectify: c.rectify ?? null,
  });
  const serR = (r) =>
    r.ok ? { ok: true, candidates: r.candidates.map(ser), resolution: r.resolution } : r;
  out.resolve = [];
  const names = [
    '',
    'ant/claude-opus-4-1',
    'anthropic/claude-sonnet-4-5',
    'claude-3-5-haiku-20241022',
    'gpt-5',
    'gpt-4o',
    'deepseek-chat',
    'oai/gpt-5',
    'oai/unknown',
    'gen/qwen3-coder',
    'mm/MiniMax-M2',
    'solo',
    'off/gpt-5',
    'nokey/nk-model',
    'nk-model',
    'claude-opus-4-1-20250805',
    'claude-sonnet-4',
    'gpt-5-codex',
    'grok-4',
    'grok-4.6-mini',
    'deepseek',
    'mini',
    'kimi-k2',
    'ds/claude-x',
    'gemini-2.5-pro',
    'zz-top',
  ];
  const bindings = [
    null,
    { models: { main: 'amx/kimi-k2' } },
    { models: { main: 'gen/gpt-4o', small: 'ds/deepseek-reasoner' } },
  ];
  for (const [ci, cfg] of cfgs.entries())
    for (const c of [null, 'claude', 'codex', 'grok', 'nomi'])
      for (const n of names)
        for (const ing of WIRES)
          for (const [bi, b] of bindings.entries()) {
            if (bi && ing !== 'messages' && ing !== null) continue;
            out.resolve.push({
              cfg: ci,
              c,
              n,
              ing,
              b: bi,
              r: serR(rs.resolveCandidates(cfg, c, n, ing, b)),
            });
          }
  out.bindings = bindings;
  out.alt = [];
  for (const [ci, cfg] of cfgs.entries())
    for (const n of [
      'ant/claude-opus-4-1',
      'oai/gpt-5',
      'gen/qwen3-coder',
      'mm/MiniMax-M2',
      'ds/claude-x',
    ]) {
      const r = rs.resolveCandidates(cfg, null, n, 'chat');
      for (const [i, c] of r.candidates.entries())
        for (const ex of [
          [],
          ['chat'],
          ['messages', 'responses'],
          ['chat', 'responses', 'messages'],
        ])
          for (const ing of ['chat', 'messages', 'responses']) {
            const a = rs.alternateWire(cfg, c, ing, ex);
            out.alt.push({ cfg: ci, n, i, ex, ing, a: a ? ser(a) : null });
          }
    }
  out.preferred = [];
  for (const [ci, cfg] of cfgs.entries())
    for (const c of ['nomi', 'claude', 'codex'])
      for (const n of names) out.preferred.push({ cfg: ci, c, n, p: rs.preferredWire(cfg, c, n) });

  // Binding table
  const tokA = 'nomi-tab-' + 'a'.repeat(43),
    tokB = 'nomi-tab-' + 'B_-9'.repeat(8);
  out.tokens = [
    tokA,
    tokB,
    'nomi-tab-short',
    'nomi-tab-' + 'a'.repeat(31),
    'x' + tokA,
    tokA + '!',
    '',
  ].map((t) => ({ t, ok: bd.isTabToken(t), h: bd.hashTabToken(t) }));
  const t = new bd.BindingTable();
  const hA = bd.hashTabToken(tokA),
    hB = bd.hashTabToken(tokB);
  const B = (h, gen, extra) => ({
    tokenHash: h,
    client: 'claude',
    tabId: 'tab1',
    generation: gen,
    models: { main: 'ant/claude-opus-4-1' },
    ...extra,
  });
  const msgs = [
    { type: 'binding:update', id: '1', binding: B(hA, 1) },
    { type: 'binding:add', id: '2', binding: B(hA, 1) },
    { type: 'binding:add', id: '3', binding: B('ZZ', 1) },
    { type: 'binding:add', id: '4', binding: B(hA, 1.5) },
    { type: 'binding:add', id: '5', binding: B(hA, 1, { client: '' }) },
    { type: 'binding:add', id: '6', binding: B(hA, 1, { models: null }) },
    { type: 'binding:add', id: '7', binding: B(hB, 2) },
    { type: 'binding:add', id: '8', binding: B(hA, 1) },
    { type: 'binding:add', id: '9', binding: B(hA, 3, { tabId: 'tab2' }) },
    { type: 'binding:update', id: '10', binding: B(hA, 4, { tabId: 'tab2', effort: 'high' }) },
    { type: 'binding:update', id: '11', binding: B(hA, 4, { tabId: 'tab2', generation: 'x' }) },
    { type: 'binding:add', id: '12', binding: B(hB, 5, { tabId: 'tab2' }) },
    { type: 'binding:remove', id: '13', tokenHash: hB },
    { type: 'binding:remove', id: '14', tokenHash: 'nope' },
  ];
  out.binding = [];
  for (const m of msgs) {
    const ack = t.handle(m);
    out.binding.push({ m, ack, size: t.size, a: t.get(hA), b: t.get(hB) });
  }
  out.lookup = [];
  for (const tok of [tokA, tokB, 'bad']) out.lookup.push({ tok, b: await t.lookup(tok, 0) });
  return out;
}
