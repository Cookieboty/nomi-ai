// Parity cases for packages/gateway/src/providers/* and toolNames.ts (batch 4c).
const WIRES = ['messages', 'responses', 'chat', 'gemini'];

export async function recordProviders({ gw }) {
  const pv = await gw('src/providers/index.ts');
  const gen = await gw('src/providers/generic.ts');
  const tn = await gw('src/toolNames.ts');

  const P = (id, extra) => ({ id, name: id, enabled: true, urls: {}, keys: [{ id: 'k', value: 'v', enabled: true }], models: [], ...extra });
  const providers = [
    P('gen', { urls: { chat: 'https://proxy.example.com/v1', responses: 'https://proxy.example.com/v1' } }),
    P('ant', { preset: 'anthropic', urls: { messages: 'https://api.anthropic.com', chat: 'https://relay.example/v1' } }),
    P('oai', { urls: { responses: 'https://API.OpenAI.com:443/v1', chat: 'https://api.openai.com/v1' } }),
    P('ds', { urls: { chat: 'https://api.deepseek.com/v1', messages: 'https://api.deepseek.com/anthropic' } }),
    P('zp', { preset: 'zhipu-coding', urls: { chat: 'https://open.bigmodel.cn/api/coding/paas/v4' }, quirks: { maxTools: 64, fixes: { toolNames: false } } }),
    P('km', { urls: { chat: 'https://api.moonshot.ai/v1' }, quirks: { dropParams: ['seed', 'temperature'], userAgent: 'ua/1' } }),
    P('mm', { preset: 'minimax', urls: { chat: 'https://api.minimaxi.com/v1', responses: 'https://x.example/v1' }, quirks: { extraBody: { responses: { a: 1 }, chat: { b: 2 } }, fixes: { repetition: false } } }),
    P('amx', { urls: { responses: 'https://gateway.amux.ai/v1' } }),
    P('sp', { spec: 'kimi', urls: { chat: 'http://[::1]:8080/v1' } }),
    P('bad', { spec: 'nope', urls: { chat: 'not a url' } }),
  ];
  const specs = [];
  for (const p of providers)
    for (const w of [undefined, ...WIRES])
      specs.push({ provider: p.id, wire: w ?? null, spec: pv.specOf(p, w).id, quirks: JSON.stringify(pv.quirksOf(p, w)),
        native: w ? pv.nativeOf({ provider: p, key: p.keys[0], publicModel: p.id + '/m', upstreamModel: 'm', wire: w }) ?? null : null });

  const tools = (n) => Array.from({ length: n }, (_, i) => ({ type: 'function', function: { name: `t.${i}`, parameters: { type: 'object', properties: { a: { type: 'string', format: 'uri', default: 1 } }, additionalProperties: false, $schema: 'x' } } }));
  const bodies = {
    chat: [
      { model: 'm', messages: [{ role: 'system', content: 'a' }, { role: 'system', content: [{ type: 'text', text: 'b' }] }, { role: 'user', content: 'hi' }], temperature: 0.5, seed: 1, service_tier: 'auto', tools: tools(3) },
      { model: 'm', messages: [{ role: 'user', content: 'x' }], tools: tools(130), tool_choice: { type: 'function', function: { name: 't.1' } } },
      { model: 'm', messages: [{ role: 'assistant', content: null, tool_calls: [{ id: 'c', type: 'function', function: { name: 'my tool!', arguments: '{}' } }] }, { role: 'tool', tool_call_id: 'c', content: 'r' }], tools: [{ type: 'function', function: { name: 'my tool!' } }, { type: 'web_search' }] },
    ],
    responses: [
      { model: 'm', input: 'hi', tools: [{ type: 'function', name: 'f', parameters: { type: 'object', properties: {} } }, { type: 'web_search_preview' }], service_tier: 'flex', temperature: 1 },
      { model: 'm', input: [{ type: 'message', role: 'user', content: 'x' }], tools: [{ type: 'web_search' }], tool_choice: 'required' },
    ],
    messages: [
      { model: 'm', max_tokens: 10, system: 'x', messages: [{ role: 'user', content: 'x' }], tools: [{ name: 'a.b', input_schema: { type: 'object', properties: { q: { type: 'string', minLength: 1 } } } }, { type: 'web_search_20250305', name: 'web_search' }], context_management: {}, temperature: 0.2 },
      { model: 'm', max_tokens: 10, messages: [{ role: 'user', content: 'x' }], tools: [{ type: 'web_search_20250305', name: 'web_search' }], tool_choice: { type: 'tool', name: 'web_search' } },
    ],
    gemini: [
      { contents: [{ role: 'user', parts: [{ text: 'x' }] }], tools: [{ functionDeclarations: [{ name: 'f', parameters: { type: 'object', properties: { a: { type: 'string', examples: ['x'] } } } }] }, { googleSearch: {} }] },
    ],
  };
  const request = [];
  for (const p of providers)
    for (const w of WIRES)
      bodies[w].forEach((b, i) => {
        if (!p.urls[w] && p.id !== 'gen') return;
        const c = { provider: p, key: p.keys[0], publicModel: p.id + '/m', upstreamModel: 'm', wire: w };
        const o = structuredClone(b);
        const notes = [];
        pv.providerRequest(c, o, notes);
        request.push({ provider: p.id, wire: w, body: i, output: JSON.stringify(o), notes });
      });

  const serverTool = [];
  for (const p of providers)
    for (const w of WIRES)
      for (const ing of WIRES)
        bodies[ing].forEach((b, i) => {
          const c = { provider: p, key: p.keys[0], publicModel: p.id + '/m', upstreamModel: 'm', wire: w };
          serverTool.push({ provider: p.id, wire: w, ingress: ing, body: i, error: pv.serverToolError(c, ing, b) });
        });

  const sseTexts = [
    'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","item_id":"SSE-Keep-Alive","delta":""}\n\n' +
      'data: {"type":"response.metadata","x":1}\n\nevent: response.metadata\ndata: {"x":2}\n\n' +
      'data: {"SSE-Keep-Alive":true}\r\n\r\ndata: {"type":"response.created"}\n\n: comment\n\ndata: [DONE]\n\ndata: {"type":"a"}',
    'data: not json\n\nevent: ping\n\ndata: {"type":"response.metadata"}\ndata: more\n\n',
  ];
  const cuts = [1, 7, 1e9];
  const stage = [];
  for (const id of ['amux', 'generic', 'kimi'])
    for (const t of sseTexts)
      for (const n of cuts) {
        const spec = pv.providerSpecById(id) ?? gen.generic;
        const s = new pv.ProviderStage(spec, 'responses');
        const outs = [];
        for (let i = 0; i < t.length; i += n) outs.push(s.push(t.slice(i, i + n)));
        outs.push(s.end());
        stage.push({ spec: id, text: t, cut: n, needed: pv.ProviderStage.needed(spec), outs, alive: s.alive, changed: s.changed });
      }

  const names = ['ok_name', 'a.b', 'my tool!', 'x'.repeat(64), 'y'.repeat(65), '', '中文工具', 'a-b_c', 'emoji😀', '\ud800lone', 'mcp__srv__do.it', 'A'.repeat(56) + '.z'];
  const toolNames = names.map((n) => ({ name: n, legal: tn.isLegalChatToolName(n), chat: tn.chatToolName(n) }));
  const ingress = [];
  for (const w of WIRES) bodies[w].forEach((b, i) => ingress.push({ wire: w, body: i, names: tn.ingressToolNames(w, b) }));
  const rev = [names, ['ok', 'ok'], [], ['a.b', 'a_b']].map((ns) => { const m = tn.chatToolNameReverse(ns); return m ? [...m] : null; });
  const mapped = bodies.chat.map((b) => { const o = structuredClone(b); const notes = []; tn.mapChatToolNames(o, notes); return { output: JSON.stringify(o), notes }; });

  return { providers, bodies, specs, request, serverTool, stage, toolNames, ingress, reverseInputs: [names, ['ok', 'ok'], [], ['a.b', 'a_b']], reverse: rev, mapped,
    beta: ['a,b', 'context-management-2025-06-27, interleaved-thinking-2025-05-14 ,x', '', ' , '].map((b) => ({ in: b, out: gen.filterAnthropicBeta(b) })) };
}
