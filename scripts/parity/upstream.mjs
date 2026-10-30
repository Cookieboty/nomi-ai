// Parity cases for upstream.ts, fixes.ts, customTools.ts, ingress.ts, responseFixes.ts,
// timeouts.ts, cooldown.ts, limits.ts (batch 4c).
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function recordUpstream({ gw, root }) {
  const cl = await gw('src/clients/index.ts');
  const { BUILTIN_GATEWAY_ENTRIES } = await import(
    pathToFileURL(join(root, 'apps/desktop-electron/internal/cli-plugins/src/gateways.ts')).href
  );
  for (const e of BUILTIN_GATEWAY_ENTRIES)
    if (e.clientSpec.id === e.client) cl.registerClientSpec(e.clientSpec);
  const up = await gw('src/upstream.ts');
  const fx = await gw('src/fixes.ts');
  const ct = await gw('src/customTools.ts');
  const ing = await gw('src/ingress.ts');
  const rf = await gw('src/responseFixes.ts');
  const to = await gw('src/timeouts.ts');
  const cd = await gw('src/cooldown.ts');
  const lim = await gw('src/limits.ts');
  const rs = await gw('src/route/resolve.ts');
  const out = {};

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
      urls: { messages: 'https://api.anthropic.com/' },
      models: [M('claude-opus-4-1', { reasoning: true }), M('claude-3-5-haiku-20241022')],
    }),
    P('oai', {
      urls: { responses: 'https://api.openai.com/v1', chat: 'https://api.openai.com/v1//' },
      keys: [K('k1', { maxConcurrency: 2 }), K('k2', { rpm: 0 })],
      models: [M('gpt-5', { reasoning: true, efforts: ['low', 'high'] }), M('gpt-4o')],
    }),
    P('gen', {
      urls: {
        chat: 'https://proxy.example.com/v1',
        messages: 'https://proxy.example.com/v1',
        gemini: 'https://g.example/v1beta/',
        responses: 'https://proxy.example.com/v1',
      },
      headers: { 'X-Extra': '1', Accept: 'custom/any' },
      detected: { chat: { ok: true, auth: 'x-api-key' } },
      quirks: {
        maxTools: 2,
        userAgent: 'quirk-ua',
        reasoningPassback: true,
        dropParams: ['seed'],
        fixes: { toolNames: false, repetition: false },
        maxConcurrency: 3,
        rpm: 10,
      },
      models: [
        M('gpt-4o'),
        M('deepseek-chat', { reasoning: false }),
        M('gemini-2.5-pro', { reasoning: true }),
        M('google/gemini-3 flash'),
        M('qwen3-coder', { strict: true }),
      ],
    }),
    P('ds', {
      urls: {
        chat: 'https://api.deepseek.com/v1',
        messages: 'https://api.deepseek.com/anthropic/v1',
      },
      userAgent: '',
      keys: [K('k1', { value: '' })],
      models: [M('deepseek-reasoner')],
    }),
    P('mm', {
      preset: 'minimax',
      userAgent: 'pinned/1',
      urls: { chat: 'https://api.minimaxi.com/v1' },
      models: [M('MiniMax-M2')],
    }),
  ];
  const clients = {
    claude: { token: 't', models: { main: 'ant/claude-opus-4-1' } },
    codex: { token: 't', models: { main: 'oai/gpt-5' } },
  };
  const cfg = { host: '127.0.0.1', port: 1, providers, clients, learned: {} };
  out.providers = providers;
  out.clients = clients;

  const reqs = [
    [null, 'ant/claude-opus-4-1', 'messages'],
    ['claude', 'claude-3-5-haiku-20241022', 'messages'],
    [null, 'oai/gpt-5', 'responses'],
    [null, 'oai/gpt-5', 'chat'],
    [null, 'gen/gpt-4o', 'messages'],
    [null, 'gen/gpt-4o', 'chat'],
    [null, 'gen/gemini-2.5-pro', 'gemini'],
    [null, 'gen/google/gemini-3 flash', 'gemini'],
    [null, 'gen/deepseek-chat', 'responses'],
    [null, 'gen/qwen3-coder', 'chat'],
    [null, 'ds/deepseek-reasoner', 'messages'],
    [null, 'ds/deepseek-reasoner', 'chat'],
    [null, 'mm/MiniMax-M2', 'messages'],
    [null, 'mm/MiniMax-M2', 'chat'],
    ['codex', 'gpt-5', 'responses'],
  ];
  const mutations = [
    {},
    { rectify: ['budget', 'effort'] },
    { customToolsAsFunctions: true },
    { dropParams: ['temperature', 'tools'] },
  ];
  const tools = {
    messages: [
      {
        name: 'get_weather',
        description: 'w',
        input_schema: { type: 'object', properties: { c: { type: 'string' } } },
      },
      { name: 'read.file', input_schema: { type: 'object' } },
      { type: 'web_search_20250305', name: 'web_search' },
    ],
    chat: [
      {
        type: 'function',
        function: { name: 'get_weather', parameters: { type: 'object', properties: {} } },
      },
      { type: 'function', function: { name: 'x y', parameters: { type: 'object' } } },
      { type: 'function', function: { name: 'z' } },
    ],
    responses: [
      { type: 'function', name: 'get_weather', parameters: { type: 'object' } },
      { type: 'custom', name: 'apply_patch', description: 'patch' },
      { type: 'custom', name: 'shell' },
    ],
    gemini: [
      { functionDeclarations: [{ name: 'a', parameters: { type: 'object' } }, { name: 'b' }] },
      { googleSearch: {} },
    ],
  };
  const bodies = {
    messages: [
      { model: 'm', max_tokens: 1024, messages: [{ role: 'user', content: 'hi' }] },
      {
        model: 'm',
        max_tokens: 8000,
        stream: true,
        thinking: { type: 'enabled', budget_tokens: 32000 },
        temperature: 0.3,
        seed: 1,
        tools: tools.messages,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'q' },
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
            ],
          },
        ],
      },
      {
        model: 'm',
        max_tokens: 100,
        output_config: { effort: 'max' },
        messages: [
          { role: 'user', content: 'x' },
          {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'tu_1', name: 'get_weather', input: {} }],
          },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'ok' }] },
        ],
        tools: tools.messages.slice(0, 1),
      },
    ],
    chat: [
      { model: 'm', messages: [{ role: 'user', content: 'hi' }] },
      {
        model: 'm',
        stream: true,
        reasoning_effort: 'medium',
        temperature: 1,
        seed: 2,
        max_tokens: 50,
        tools: tools.chat,
        messages: [
          { role: 'system', content: 's' },
          { role: 'user', content: 'q' },
        ],
      },
      {
        model: 'm',
        reasoning_effort: 'xhigh',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'a' },
              { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
            ],
          },
        ],
      },
    ],
    responses: [
      { model: 'm', input: 'hi' },
      {
        model: 'm',
        stream: true,
        reasoning: { effort: 'minimal', summary: 'auto' },
        tools: tools.responses,
        tool_choice: { type: 'custom', name: 'shell' },
        seed: 3,
        input: [
          { role: 'user', content: 'q' },
          { type: 'custom_tool_call', call_id: 'c1', name: 'shell', input: 'ls' },
          { type: 'custom_tool_call_output', call_id: 'c1', output: 'a' },
          { type: 'custom_tool_call', call_id: 'c2', name: 'shell', input: 5 },
        ],
      },
      {
        model: 'm',
        max_output_tokens: 999,
        reasoning: { effort: 'high' },
        input: [{ role: 'user', content: [{ type: 'input_text', text: 't' }] }],
      },
    ],
    gemini: [
      { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] },
      {
        contents: [{ role: 'user', parts: [{ text: 'q' }] }],
        tools: tools.gemini,
        generationConfig: {
          thinkingConfig: { thinkingBudget: 2048, includeThoughts: true },
          temperature: 0.5,
        },
      },
    ],
  };
  out.bodies = bodies;
  const chs = [
    {},
    {
      'anthropic-version': '2024-01-01',
      'anthropic-beta': 'context-1m-2025-08-07,prompt-caching-2024-07-31',
      'user-agent': 'claude-cli/1.0',
    },
    { 'user-agent': ['a', 'b'], 'anthropic-beta': '' },
  ];
  out.chs = chs;
  const ser = (c) => ({
    p: c.provider.id,
    k: c.key.id,
    pm: c.publicModel,
    um: c.upstreamModel,
    w: c.wire,
  });
  const errStr = (e) => ({ error: String(e?.message ?? e) });
  out.cases = [];
  for (const [ri, [client, model, ingress]] of reqs.entries()) {
    const r = rs.resolveCandidates(cfg, client, model, ingress);
    if (!r.ok) {
      out.cases.push({ r: ri, req: [client, model, ingress], err: r.message });
      continue;
    }
    const cands = r.candidates.slice(0, 3);
    const cc = { r: ri, req: [client, model, ingress], cands: cands.map(ser), per: [] };
    out.cases.push(cc);
    for (const [ci, c0] of cands.entries())
      for (const [mi, mut] of mutations.entries()) {
        const c = { ...c0, ...mut };
        const sameWire = ingress === c.wire;
        const e = {
          c: ci,
          m: mi,
          url: [
            up.upstreamUrl(c.wire, c.provider.urls[c.wire] ?? '', c.upstreamModel),
            up.upstreamUrl(c.wire, c.provider.urls[c.wire] ?? '', c.upstreamModel, {
              stream: true,
            }),
            up.upstreamUrl(c.wire, c.provider.urls[c.wire] ?? '', c.upstreamModel, {
              countTokens: true,
            }),
          ],
        };
        e.headers = [];
        for (const ch of chs)
          for (const stream of [false, true])
            e.headers.push(
              Object.entries(up.upstreamHeaders(c, { stream, clientHeaders: ch, sameWire })),
            );
        e.official = [
          fx.isAnthropicOfficial(c),
          fx.isOpenAIOfficial(c),
          fx.candidateModel(c)?.id ?? null,
          to.candidateIsReasoning(c),
        ];
        e.bodies = [];
        for (const [bi, b] of bodies[ingress].entries())
          for (const stream of [false, true])
            for (const be of [undefined, 'low', 'max']) {
              const notes = [];
              let res;
              try {
                res = {
                  body:
                    JSON.stringify(
                      up.upstreamBody(ingress, c, b, {
                        stream,
                        ingressModel: 'in-model',
                        notes,
                        client: client ?? undefined,
                        bindingEffort: be,
                      }),
                    ) ?? null,
                };
              } catch (err) {
                res = errStr(err);
              }
              e.bodies.push({ b: bi, stream, be: be ?? null, ...res, notes });
            }
        e.tl = bodies[ingress].map((b) => fx.toolLimitError(c, b));
        e.rf = bodies[ingress].map((b) => {
          const o = rf.responseFixOptions(ingress, c, b);
          return {
            chatStream: o.chatStream,
            toolNames: o.toolNames ? [...o.toolNames] : null,
            textTools: o.textTools ? [...o.textTools] : null,
            repetition: o.repetition,
            seed: o.callIds.seed,
          };
        });
        cc.per.push(e);
      }
  }
  out.toolCount = [];
  for (const w of ['messages', 'gemini'])
    for (const b of [
      null,
      {},
      { tools: 'x' },
      { tools: tools.gemini },
      { tools: [null, 1, { functionDeclarations: 'x' }] },
    ])
      out.toolCount.push({ w, b, n: fx.toolCount(w, b) });

  // customTools
  const ctBodies = [
    null,
    'x',
    [],
    {},
    { tools: [] },
    {
      tools: [
        null,
        { type: 'custom', name: 1 },
        { type: 'custom', name: 'a' },
        { type: 'custom', name: 'a' },
      ],
    },
    bodies.responses[1],
    {
      tools: [{ type: 'custom', name: 'p' }],
      tool_choice: 'auto',
      input: [null, 'x', { type: 'custom_tool_call', input: 'z', name: 'p', id: 'i' }],
    },
  ];
  out.ct = ctBodies.map((b) => {
    const r = ct.customToolsToFunctions(b);
    return { b, names: [...ct.customToolNames(b)], same: r === b, r: JSON.stringify(r) ?? null };
  });
  const texts = [
    'Unsupported custom tool',
    "Invalid value: 'custom'. Supported values are: 'function'",
    'tool type custom is not supported',
    'custom_tool_call invalid',
    'invalid "custom" type',
    'invalid `custom`',
    'custom tools are great',
    'unknown parameter custom-tools',
    'CUSTOM TOOL NOT SUPPORTED',
    'invalid request',
    '不支持 custom tool',
    '',
  ];
  out.refusal = [];
  for (const st of [400, 422, 500])
    for (const t of texts)
      for (const s of [undefined, {}, bodies.responses[1]])
        out.refusal.push({
          st,
          t,
          s: s === undefined ? -1 : s === bodies.responses[1] ? 1 : 0,
          r: ct.isCustomToolRefusal(st, t, s),
        });

  // ingress
  const paths = [
    '/v1/messages',
    '/v1/messages/',
    '/v1/messages/count_tokens',
    '/x/v1/responses?a=b',
    '/v1/chat/completions//',
    '/v1beta/models/gemini-2.5-pro:generateContent',
    '/v1beta/models/gen%2Fgemini:streamGenerateContent?alt=sse',
    '/v1beta/models/a%zz:countTokens',
    '/v1beta/models/%E4%B8%AD:generateContent',
    '/v1beta/models/%C3:generateContent',
    '/models/a/b:generateContent',
    '/v1/models',
    '',
    '?',
    '/v1/messagesX',
    '/models/:generateContent',
    '/v1beta/models/x:generateContent/',
  ];
  out.ingress = paths.map((p) => ({ p, r: ing.ingressFromPath(p) }));
  out.gpath = [
    'models/gemini-2.5-pro',
    'google/gemini-3 flash',
    'a/b/c',
    "x!~*'()?#&é",
    'models/models/x',
    '',
    '/',
  ].map((m) => ({ m, r: ing.geminiModelPath(m) }));

  // timeouts
  const envs = [
    {},
    {
      NOMI_GATEWAY_FIRST_BYTE_TIMEOUT_MS: ' 1234 ',
      NOMI_GATEWAY_NON_STREAM_FIRST_BYTE_TIMEOUT_MS: '0x10',
      NOMI_GATEWAY_STREAM_IDLE_TIMEOUT_MS: '1e3',
    },
    {
      NOMI_GATEWAY_REASONING_NON_STREAM_FIRST_BYTE_TIMEOUT_MS: '-5',
      NOMI_GATEWAY_NON_STREAM_FIRST_BYTE_TIMEOUT_MS: '7.5',
      NOMI_GATEWAY_FIRST_BYTE_BUDGET_MS: 'Infinity',
      NOMI_GATEWAY_NON_STREAM_FIRST_BYTE_BUDGET_MS: 'abc',
    },
    {
      NOMI_GATEWAY_FIRST_BYTE_BUDGET_MS: '.5',
      NOMI_GATEWAY_STREAM_IDLE_TIMEOUT_MS: '\u00a0',
      NOMI_GATEWAY_REASONING_NON_STREAM_FIRST_BYTE_TIMEOUT_MS: '0b11',
      NOMI_GATEWAY_FIRST_BYTE_TIMEOUT_MS: '+2',
    },
  ];
  const hooks = [
    {},
    { firstByteTimeoutMs: 1, nonStreamFirstByteTimeoutMs: 2 },
    { reasoningNonStreamFirstByteTimeoutMs: 3, firstByteBudgetMs: 4 },
    { nonStreamFirstByteBudgetMs: 5, streamIdleTimeoutMs: 6 },
  ];
  out.envs = envs;
  out.hooks = hooks;
  out.timeouts = [];
  const names = Object.keys(Object.assign({}, ...envs));
  for (const [ei, env] of envs.entries()) {
    for (const n of names) delete process.env[n];
    Object.assign(process.env, env);
    for (const [hi, h] of hooks.entries())
      for (const s of [false, true])
        for (const r of [false, true])
          out.timeouts.push({
            e: ei,
            h: hi,
            s,
            r,
            fb: to.resolveFirstByteTimeoutMs(s, r, h),
            bud: to.resolveFirstByteBudgetMs(s, h),
            idle: to.resolveStreamIdleTimeoutMs(h),
          });
  }
  for (const n of names) delete process.env[n];

  // cooldown
  const now = Date.parse('2026-01-01T00:00:00Z');
  out.now = now;
  // Date.parse reads asctime / bare years in local time: pin TZ so the fixture is machine-independent.
  const prevTZ = process.env.TZ;
  process.env.TZ = out.tz = 'America/New_York';
  out.retryAfter = [
    undefined,
    null,
    '',
    ' 5 ',
    '1.5',
    '0',
    '1.2345',
    '-1',
    '1e3',
    'Wed, 01 Jan 2026 00:00:30 GMT',
    'Wednesday, 31-Dec-25 23:59:00 GMT',
    'Thu Jan  1 00:01:00 2026',
    '2026-01-01T00:02:00Z',
    '2026-01-01T00:02:00.500+01:00',
    'soon',
    '12abc',
    '2026',
    '-2026',
    'Jan 1 2026 00:03:00',
    '2026/01/01 00:04',
    '1 January 2026 10:00 PST',
    'Thu, 01 Jan 2026 00:00:40 +0100',
    'Mar 8 2026 02:30:00',
    'Nov 1 2026 01:30:00',
    '2026-01-01',
    '2026-13-01',
    'Thursday January 1, 2026',
    '01 Jan 2026 00:05:00 UT',
    '2026-01-01 00:06:00',
    '-5',
    '-0',
    'Jan 5',
    'x 2026 5',
    'x 5 2026',
    '-13',
    '-32',
  ].map((v) => ({ v: v ?? null, r: cd.parseRetryAfter(v, now) }));
  if (prevTZ === undefined) delete process.env.TZ;
  else process.env.TZ = prevTZ;
  out.coolsDown = [
    {},
    { network: true },
    { upstreamStatus: 429 },
    { upstreamStatus: 500 },
    { upstreamStatus: 404 },
    { upstreamStatus: 401 },
    { upstreamStatus: 403 },
    { upstreamStatus: 499 },
    { upstreamStatus: 529 },
    { network: false, upstreamStatus: 200 },
  ].map((f) => ({ f, r: cd.coolsDown(f) }));
  const ca = { provider: { id: 'p' }, key: { id: 'k' }, wire: 'chat' };
  const cb = { provider: { id: 'p' }, key: { id: 'k' }, wire: 'messages' };
  let t = now;
  const events = [];
  const cool = new cd.Cooldowns(
    (e) => events.push(e),
    () => t,
  );
  const script = [
    ['fail', 0, { upstreamStatus: 429, retryAfter: '5', message: 'slow' }],
    ['is', 0],
    ['until', 0],
    ['is', 1],
    ['adv', 5000],
    ['is', 0],
    ['fail', 0, { upstreamStatus: 401, message: 'bad' }],
    ['fail', 0, { upstreamStatus: 403, message: 'bad' }],
    ['fail', 0, { upstreamStatus: 401, message: 'worse' }],
    ['until', 0],
    ['success', 0],
    ['success', 0],
    ['fail', 1, { upstreamStatus: 500, retryAfter: '9999' }],
    ['until', 1],
    ['fail', 1, {}],
    ['fail', 1, { upstreamStatus: 429, retryAfter: 'Wed, 01 Jan 2026 00:00:00 GMT' }],
    ['success', 1],
    ['adv', 60000],
    ['is', 1],
    ['fail', 0, { upstreamStatus: 401 }],
    ['fail', 0, { upstreamStatus: 401 }],
  ];
  out.cdScript = script;
  out.cdOut = script.map(([op, i, f]) => {
    const c = i ? cb : ca;
    const r =
      op === 'fail'
        ? cool.fail(c, f)
        : op === 'is'
          ? cool.isCooling(c)
          : op === 'until'
            ? cool.coolingUntil(c)
            : op === 'success'
              ? (cool.success(c), null)
              : ((t += i), null);
    return { r, ev: events.splice(0) };
  });

  // limits
  out.limitsOf = [];
  for (const p of providers)
    for (const k of [...p.keys, K('x', { maxConcurrency: 5, rpm: -1 }), K('y', { rpm: 7 })])
      out.limitsOf.push({ p: p.id, k, r: lim.limitsOf(p, k) });
  return out;
}
