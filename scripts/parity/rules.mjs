// Parity cases for clients/*, intent.ts and models/rules/request/* (batch 4c).
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function recordRules({ gw, root }) {
  const cl = await gw('src/clients/index.ts');
  const it = await gw('src/intent.ts');
  const rq = await gw('src/models/rules/request/index.ts');
  const content = await gw('src/models/rules/request/content.ts');
  const { BUILTIN_GATEWAY_ENTRIES } = await import(pathToFileURL(join(root, 'packages/cli-plugins/src/gateways.ts')).href);
  for (const e of BUILTIN_GATEWAY_ENTRIES) if (e.clientSpec.id === e.client) cl.registerClientSpec(e.clientSpec);
  const extraSpec = { id: 'parity-x', strictness: 'lenient', acceptedEvents: ['a', 'b'],
    extraRequired: { a: { need: 1, other: null }, b: { z: { k: [1] } } } };
  cl.registerClientSpec(extraSpec);

  const out = { ids: cl.registeredClientIds(), extraSpec };
  out.specs = out.ids.map((id) => ({ id, spec: JSON.stringify(cl.clientSpecOf(id) ?? null), rules: JSON.stringify(cl.sessionKeyRules(id)) }));
  out.sessionKeyRules = [null, '', 'nope', 'claude'].map((id) => ({ id, rules: JSON.stringify(cl.sessionKeyRules(id)) }));
  const uas = ['', 'codex_cli_rs/0.1', 'Grok-CLI', 'DSH x', 'claude-cli', 'GeminiCLI/1', 'node'];
  out.legacy = [];
  for (const w of [null, 'messages', 'responses', 'chat', 'gemini']) for (const ua of uas) out.legacy.push({ wire: w, ua, client: cl.legacyClientOf(w, ua) });
  const names = ['claude-opus-4-1', 'claude-3-5-haiku-20241022', 'claude-sonnet-4-5', 'CLAUDE-HAIKU-4', 'claude-fable-1', 'claude-other', 'claude',
    'nomi', 'NOMI', 'grok-4.6-mini', 'grok-4', 'gpt-5', 'gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-3-pro', 'opus', 'haiku', '', 'x/claude-opus'];
  out.slot = [];
  for (const id of out.ids) for (const n of names) out.slot.push({ id, name: n, hit: cl.builtinSlot(cl.clientSpecOf(id), n) });
  const modelSets = [{}, { main: 'p/m', small: 'p/s' }, { main: '', small: '', subagent: 'p/a', tools: 'p/t', summary: 'p/y' },
    { tiers: { opus: 'p/o', haiku: '' } }, { small: 'p/s', tiers: { sonnet: 'p/so' } }, { tiers: { haiku: 'p/h' }, small: 'p/s' }];
  const slots = ['main', 'small', 'subagent', 'tools', 'summary', 'opus', 'tiers.opus', 'tiers.sonnet', 'tiers.haiku', 'tiers.fable', 'zzz'];
  out.slotModel = [];
  modelSets.forEach((m, i) => slots.forEach((s) => out.slotModel.push({ models: i, slot: s, model: cl.slotModel(m, s) ?? null, set: cl.slotIsSet(m, s) })));
  out.modelSets = modelSets;

  const streams = [
    'event: response.created\ndata: {"type":"response.created"}\n\nevent: bogus\ndata: {"type":"bogus"}\n\ndata: [DONE]\n\n',
    'data: {"type":"a"}\n\ndata: {"type":"a","need":null,"other":2}\r\n\r\ndata: {"type":"b"}\n\nevent: b\ndata: {"x":1}\n\ndata: {"type":"c"}\n\n',
    ': ping\n\ndata: {"a":1}\ndata: {"b":2}\n\ndata: [1,2]\n\ndata: {"type":"a"}',
    'event: a\ndata:   {"type":"",  "q": 1}  \n\nevent:\ndata: {"type":"a"}\n\n',
    'event: message_start\ndata: {"type":"message_start"}\n\nevent: weird\ndata: {"type":"weird"}\n\n',
  ];
  out.conform = [];
  for (const id of ['grok', 'parity-x', 'claude', 'codex']) for (const wire of ['responses', 'messages', 'chat']) streams.forEach((s, si) => {
    const spec = cl.clientSpecOf(id);
    const notes = [];
    const c = new cl.ClientConformer({ spec, wire, notes });
    let o = '';
    for (let i = 0; i < s.length; i += 7) o += c.push(s.slice(i, i + 7));
    o += c.end();
    out.conform.push({ id, wire, stream: si, needed: cl.ClientConformer.needed(spec, cl.clientHooksOf(id)), output: o, notes });
  });
  out.streams = streams;

  // intent
  const bodies = {
    messages: [{}, { thinking: { type: 'disabled' } }, { thinking: { type: 'enabled', budget_tokens: 5000 } }, { thinking: { type: 'enabled' } },
      { thinking: { type: 'adaptive' } }, { output_config: { effort: ' HIGH ' }, thinking: { type: 'adaptive', budget_tokens: 0 } },
      { output_config: { effort: 'max' }, thinking: { type: 'enabled', budget_tokens: 2048 } }, { output_config: { effort: 'bogus' } }, 'x', null, []],
    responses: [{}, { reasoning: null }, { reasoning: { effort: 'none' } }, { reasoning: { effort: 'low' } }, { reasoning: { summary: 'auto' } },
      { reasoning: { summary: 'none' } }, { reasoning: { effort: 'XHIGH', summary: 'detailed' } }, { reasoning: { effort: 'weird' } }],
    chat: [{}, { reasoning_effort: 'none' }, { reasoning_effort: 'minimal' }, { reasoning_effort: '  ', reasoning: { effort: 'high' } },
      { reasoning: { max_tokens: 3000 } }, { reasoning: { max_tokens: 0, effort: 'medium' } }, { reasoning_effort: 'bad', reasoning: { effort: 'low' } }],
    gemini: [{}, { generationConfig: {} }, { generationConfig: { thinkingConfig: {} } }, { generationConfig: { thinkingConfig: { includeThoughts: true } } },
      { generationConfig: { thinkingConfig: { thinkingBudget: 0 } } }, { generationConfig: { thinkingConfig: { thinkingBudget: -1 } } },
      { generationConfig: { thinkingConfig: { thinkingBudget: 8000, includeThoughts: true } } }, { generationConfig: { thinkingConfig: { thinkingLevel: 'HIGH' } } }],
  };
  out.intentBodies = bodies;
  out.readIntent = [];
  for (const [wire, bs] of Object.entries(bodies)) bs.forEach((b, i) => [undefined, 'claude', 'codex'].forEach((c) =>
    out.readIntent.push({ wire, body: i, client: c ?? null, intent: JSON.stringify(it.readIntent(wire, b, c)) ?? null })));
  const intents = [null, { mode: 'disabled', source: 'explicit' }, { mode: 'enabled', source: 'explicit', effort: 'low' },
    { mode: 'adaptive', source: 'client-default', includeThoughts: true }, { mode: 'enabled', budget: 3000, source: 'client-default' },
    { mode: 'enabled', source: 'binding', includeThoughts: false }];
  out.intents = intents;
  out.binding = [];
  intents.forEach((x, i) => [undefined, 'high', 'NONE', ' Max ', ''].forEach((e) => out.binding.push({ intent: i, effort: e ?? null, out: JSON.stringify(it.withBindingEffort(x, e)) ?? null })));
  out.e2b = [];
  for (const e of it.EFFORTS ?? ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']) for (const mt of [undefined, 0, 1000, 2048, 64000, 128000]) out.e2b.push({ effort: e, max: mt ?? null, budget: it.effortToBudget(e, mt) });
  out.b2e = [];
  for (const b of [0, 1024, 4096, 4097, 12000, 12001, 24000, 30000]) for (const mt of [undefined, 0, -1, 8000, 32000]) out.b2e.push({ budget: b, max: mt ?? null, effort: it.budgetToEffort(b, mt) });

  // request rules
  const base = { id: 'm', userSet: [], sources: [], strict: false, catalogVersion: 'v' };
  const models = [
    base,
    { ...base, sampling: { temperature: false, topP: false }, params: { maxTokensField: 'max_completion_tokens', requireMaxTokens: true }, limits: { maxOutput: 4000 } },
    { ...base, strict: true, sampling: { temperature: false } },
    { ...base, userSet: ['reasoning'], reasoning: { control: 'none' }, input: { images: false } },
    { ...base, params: { requireMaxTokens: true }, tools: { schema: 'gemini' } },
    { ...base, tools: { schema: 'kimi' }, reasoning: { control: 'effort', efforts: ['low', 'high'], canDisable: false } },
    { ...base, tools: { schema: 'openai-strict' }, reasoning: { control: 'budget', budget: { min: 2000, max: 9000 } } },
    { ...base, reasoning: { control: 'adaptive', efforts: ['medium', 'max'] }, limits: { maxOutput: 6000 } },
    { ...base, reasoning: { control: 'toggle', toggleStyle: 'enable-thinking' } },
    { ...base, reasoning: { control: 'toggle' } },
    { ...base, reasoning: { control: 'level', efforts: ['low', 'medium', 'high'] } },
    { ...base, id: 'gemini-3-pro', reasoning: { control: 'none' } },
    { ...base, id: 'Gemini-3-flash' },
  ];
  out.models = models;
  const schema = { type: 'object', properties: { a: { $ref: '#/$defs/A', description: 'd' }, b: { type: ['string', 'null'] }, c: { $ref: '#/definitions/C' }, r: { $ref: '#/$defs/R' } },
    $defs: { A: { type: 'object', properties: { x: { type: 'string' } } }, R: { type: 'object', properties: { self: { $ref: '#/$defs/R' } } } }, definitions: { C: { const: 1 } } };
  const simple = { type: 'object', properties: { q: { type: 'string', enum: ['a'] } }, required: ['q'] };
  const img = { type: 'image', source: {} };
  const reqs = {
    messages: [
      { model: 'm', max_tokens: 9000, temperature: 0.5, top_k: 3, top_p: 0.9, thinking: { type: 'enabled', budget_tokens: 9000 },
        messages: [{ role: 'user', content: [img, { type: 'text', text: 'hi' }, { type: 'tool_result', content: [img] }] }, { role: 'user', content: 'x' }],
        tools: [{ name: 't', input_schema: schema }, { name: 's', input_schema: simple, strict: true }] },
      { model: 'm', max_tokens: 1200, thinking: { type: 'enabled', budget_tokens: 5000, x: 1 }, output_config: { a: 1 } },
      { model: 'm', thinking: { type: 'enabled', budget_tokens: 100 }, messages: [] },
    ],
    chat: [
      { model: 'm', max_tokens: 9000, temperature: 1, top_p: 1, reasoning_effort: 'high', reasoning: {},
        messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'x' } }] }],
        tools: [{ type: 'function', function: { name: 'f', parameters: schema, strict: true } }, { type: 'function', function: { name: 'g', parameters: simple } }] },
      { model: 'm', max_tokens: 10, max_completion_tokens: 20000 },
      { model: 'm', max_completion_tokens: 3000 },
    ],
    responses: [
      { model: 'm', max_output_tokens: 99999, temperature: 0.2, reasoning: { effort: 'low' },
        input: [{ type: 'message', content: [{ type: 'input_image' }] }, { type: 'function_call_output', output: [{ type: 'input_image' }] }],
        tools: [{ type: 'function', name: 'f', parameters: schema, strict: true }] },
      { model: 'm' },
    ],
    gemini: [
      { model: 'gemini-3-pro', generationConfig: { maxOutputTokens: 70000, thinkingConfig: { thinkingBudget: 1 } },
        contents: [{ parts: [{ inlineData: { mimeType: 'image/png' } }, { fileData: { mimeType: 'application/pdf' } }, { fileData: {} }, { text: 'a' }] }],
        tools: [{ functionDeclarations: [{ name: 'a', parameters: schema }, { name: 'b', parameters: simple }, { name: 'c' }] }, { googleSearch: {} }] },
      { contents: [], generationConfig: { maxOutputTokens: 2000 } },
    ],
  };
  out.reqs = reqs;
  out.modelRequest = [];
  out.render = [];
  const renderIntents = [{ mode: 'disabled', source: 'explicit' }, { mode: 'enabled', source: 'explicit' }, { mode: 'enabled', effort: 'max', source: 'explicit' },
    { mode: 'enabled', effort: 'minimal', includeThoughts: true, source: 'binding' }, { mode: 'enabled', budget: 7000, source: 'client-default' },
    { mode: 'adaptive', effort: 'xhigh', source: 'explicit' }, { mode: 'enabled', budget: 500, effort: 'low', source: 'explicit' }];
  out.renderIntents = renderIntents;
  for (const [wire, bs] of Object.entries(reqs)) bs.forEach((b, bi) => models.forEach((m, mi) => {
    const o = { ...JSON.parse(JSON.stringify(b)) };
    const notes = [];
    let changes = null, error = null;
    try { changes = rq.modelRequest(wire, o, m, notes); } catch (e) { error = e.message; }
    out.modelRequest.push({ wire, body: bi, model: mi, output: JSON.stringify(o), changes: changes && JSON.stringify(changes), error, notes });
    renderIntents.forEach((x, ii) => {
      const n2 = [];
      const r = rq.renderReasoning(wire, JSON.parse(JSON.stringify(b)), x, m, n2);
      out.render.push({ wire, body: bi, model: mi, intent: ii, output: JSON.stringify(r.body), sent: r.sent, losses: r.losses, notes: n2 });
    });
  }));
  out.fit = [];
  for (const w of ['minimal', 'medium', 'max']) for (const es of [undefined, [], ['high'], ['max', 'low'], ['medium', 'minimal', 'xhigh']]) out.fit.push({ want: w, efforts: es ?? null, out: rq.fitLevel(w, es) });
  out.inline = [schema, simple, { $ref: '#/$defs/x' }, { $defs: { a: null }, p: { $ref: '#/$defs/a' } }, { definitions: { a: 1 }, $defs: { a: { type: 'x' } }, q: [{ $ref: '#/definitions/a', z: 1 }] }, 5]
    .map((s) => ({ in: s, out: JSON.stringify(rq.inlineRefs(s)), gemini: rq.geminiExpressible(s) }));
  out.dropReasoning = [];
  for (const wire of ['messages', 'chat', 'responses', 'gemini']) for (const b of [{ thinking: 1, reasoning: 2, reasoning_effort: 3 }, { generationConfig: { a: 1, thinkingConfig: {}, b: 2 } }, {}]) {
    const o = { ...b }; const notes = []; content.dropReasoning(o, wire, notes); out.dropReasoning.push({ wire, in: b, out: JSON.stringify(o), notes });
  }
  return out;
}
