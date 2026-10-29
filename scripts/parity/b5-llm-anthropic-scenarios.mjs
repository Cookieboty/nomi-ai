// Scripted @ai-sdk/anthropic (.messages()) scenarios for record-b5-llm.mjs (protocol "anthropic").
const user = (text) => ({ role: 'user', content: text });
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const weather = {
  name: 'get_weather',
  description: 'Get the weather',
  inputSchema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'], additionalProperties: false },
};
const search = { name: 'search', inputSchema: { type: 'object', properties: { q: { type: 'string' } } } };
const CC = { anthropic: { cacheControl: { type: 'ephemeral' } } };

export function anthropicScenarios({ sse, SSE_H, json }) {
  const P = 'anthropic';
  const ev = (type, o = {}) => `event: ${type}\ndata: ${JSON.stringify({ type, ...o })}\n\n`;
  const start = (usage = { input_tokens: 12, output_tokens: 1 }, extra = {}) =>
    ev('message_start', { message: { id: 'msg_01', type: 'message', role: 'assistant', model: 'claude-served', content: [], stop_reason: null, stop_sequence: null, usage, ...extra } });
  const tStart = (i) => ev('content_block_start', { index: i, content_block: { type: 'text', text: '' } });
  const tDelta = (i, text) => ev('content_block_delta', { index: i, delta: { type: 'text_delta', text } });
  const stop = (i) => ev('content_block_stop', { index: i });
  const mDelta = (stop_reason, usage = { output_tokens: 9 }, d = {}) => ev('message_delta', { delta: { stop_reason, stop_sequence: null, ...d }, usage });
  const mStop = () => ev('message_stop');
  const ping = () => ev('ping');
  const ok = (evs, h = {}) => ({ status: 200, headers: { ...SSE_H, 'request-id': 'req_1', ...h }, chunks: evs });
  const text = (t = 'Hello', reason = 'end_turn', usage) => [start(), tStart(0), tDelta(0, t), stop(0), mDelta(reason, usage), mStop()];
  const toolStart = (i, id, name, input = {}) => ev('content_block_start', { index: i, content_block: { type: 'tool_use', id, name, input } });
  const jsonDelta = (i, partial_json) => ev('content_block_delta', { index: i, delta: { type: 'input_json_delta', partial_json } });
  const msg = (content, stop_reason = 'end_turn', usage = { input_tokens: 10, output_tokens: 5 }, extra = {}) =>
    ({ id: 'msg_g1', type: 'message', role: 'assistant', model: 'claude-served', content, stop_reason, stop_sequence: null, usage, ...extra });
  const errBody = (type, message) => ({ type: 'error', error: { type, message } });
  const s = [];
  const add = (x) => s.push({ protocol: P, model: 'claude-sonnet-4-5', ...x, name: 'anth/' + x.name });

  // ---- request body / headers ----
  add({ name: 'text', instructions: 'be brief', messages: [user('hi')], settingsCall: { temperature: 0.3, maxOutputTokens: 256 },
    responses: [ok(text('Hel'), { 'x-extra': 'y' })] });
  add({ name: 'text-unknown-model', model: 'm-1', messages: [user('hi')], settingsCall: { temperature: 0.5, topP: 0.9, topK: 3 }, responses: [ok(text())] });
  add({ name: 'text-claude-unknown', model: 'claude-x-9', messages: [user('hi')], settingsCall: { temperature: 0.5, topP: 0.9, topK: 3 }, responses: [ok(text())] });
  add({ name: 'temp-topp-warning', messages: [user('hi')], settingsCall: { temperature: 0.5, topP: 0.9, topK: 2, maxOutputTokens: 100000, stopSequences: ['END'], seed: 3, frequencyPenalty: 0.1, presencePenalty: 0.2 }, responses: [ok(text())] });
  add({ name: 'temp-clamp-high', messages: [user('hi')], settingsCall: { temperature: 1.7 }, responses: [ok(text())] });
  add({ name: 'temp-clamp-low', model: 'claude-3-haiku-20240307', messages: [user('hi')], settingsCall: { temperature: -1, topP: 0.5 }, responses: [ok(text())] });
  add({ name: 'opus48-rejects-sampling', model: 'claude-opus-4-8', messages: [user('hi')], settingsCall: { temperature: 0.2, topP: 0.5, topK: 4 }, responses: [ok(text())] });
  add({ name: 'headers-ua', headers: { 'X-Custom': ' v1 ', 'anthropic-beta': 'Beta-A, beta-b ,' }, userAgent: 'Nomi/2.0.5', messages: [user('hi')], responses: [ok(text())] });
  add({ name: 'no-apikey', apiKey: '', messages: [user('hi')], responses: [ok(text())] });
  add({ name: 'override-xapikey', headers: { 'x-api-key': 'override', 'anthropic-version': '2099-01-01' }, messages: [user('hi')], responses: [ok(text())] });
  add({ name: 'call-headers-beta', messages: [user('hi')], settingsCall: { headers: { 'anthropic-beta': 'call-beta', 'X-Call': 'c' }, providerOptions: { anthropic: { anthropicBeta: ['opt-beta'] } } }, responses: [ok(text())] });
  add({ name: 'basepath-root', basePath: '/', messages: [user('hi')], responses: [ok(text())] });
  add({ name: 'basepath-v1-slash', basePath: '/V1/', messages: [user('hi')], responses: [ok(text())] });
  add({ name: 'basepath-proxy', basePath: '/proxy/anthropic', messages: [user('hi')], responses: [ok(text())] });
  add({ name: 'multi-system', instructions: [{ role: 'system', content: 's1', providerOptions: CC }, { role: 'system', content: 's2' }],
      messages: [user('hi'), user('again')], responses: [ok(text())] });
  add({ name: 'multi-turn', instructions: 'sys', messages: [
      user('q1'),
      { role: 'assistant', content: [
        { type: 'reasoning', text: 'think', providerOptions: { anthropic: { signature: 'sig-1' } } },
        { type: 'reasoning', text: '', providerOptions: { anthropic: { redactedData: 'red-1' } } },
        { type: 'reasoning', text: 'nometa' },
        { type: 'tool-call', toolCallId: 'toolu_1', toolName: 'get_weather', input: { city: 'SF' } },
        { type: 'text', text: 'a1' },
      ] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'toolu_1', toolName: 'get_weather', output: { type: 'json', value: { t: 20 } } }] },
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'toolu_2', toolName: 'search', input: { q: 'x' } }] },
      { role: 'tool', content: [
        { type: 'tool-result', toolCallId: 'toolu_2', toolName: 'search', output: { type: 'text', value: 'found' } },
      ] },
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'toolu_3', toolName: 'search', input: { q: 'y' } }, { type: 'tool-call', toolCallId: 'toolu_4', toolName: 'search', input: { q: 'z' } }] },
      { role: 'tool', content: [
        { type: 'tool-result', toolCallId: 'toolu_3', toolName: 'search', output: { type: 'error-text', value: 'boom' } },
        { type: 'tool-result', toolCallId: 'toolu_4', toolName: 'search', output: { type: 'error-json', value: { e: 1 } } },
      ] },
      { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image', image: PNG, mediaType: 'image/png' }, { type: 'image', image: PNG },
        { type: 'file', data: 'JVBERi0xLjQK', mediaType: 'application/pdf', filename: 'a.pdf' },
        { type: 'file', data: new TextEncoder().encode('plain text'), mediaType: 'text/plain', filename: 'n.txt' }] },
      { role: 'assistant', content: [{ type: 'text', text: '  trailing ws  ' }] },
    ], tools: [weather, search], responses: [ok(text())] });
  add({ name: 'tool-result-content', messages: [
      user('q'),
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'toolu_c', toolName: 'search', input: 'not-an-object' }] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'toolu_c', toolName: 'search', output: { type: 'content', value: [
        { type: 'text', text: 'see' }, { type: 'image-data', data: PNG, mediaType: 'image/png' }, { type: 'file-data', data: 'JVBERi0xLjQK', mediaType: 'application/pdf' },
        { type: 'file-data', data: 'aGk=', mediaType: 'text/plain' }, { type: 'image-url', url: 'https://x.test/a.png' }, { type: 'file-url', url: 'https://x.test/a.pdf' } ] } }] },
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'toolu_d', toolName: 'search', input: { q: 1 } }] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'toolu_d', toolName: 'search', output: { type: 'execution-denied', reason: 'no' } }] },
    ], tools: [search], responses: [ok(text())] });
  add({ name: 'cache-control', instructions: [{ role: 'system', content: 'sys' }, { role: 'system', content: 'cached-sys', providerOptions: CC }], messages: [
      { role: 'user', content: [{ type: 'text', text: 'a', providerOptions: { anthropic: { cacheControl: { type: 'ephemeral', ttl: '1h' } } } }, { type: 'text', text: 'b' }], providerOptions: CC },
      { role: 'assistant', content: [{ type: 'reasoning', text: 'r', providerOptions: { anthropic: { signature: 's', cacheControl: { type: 'ephemeral' } } } }, { type: 'text', text: 'x' }], providerOptions: { anthropic: { cache_control: { type: 'ephemeral' } } } },
      { role: 'user', content: [{ type: 'text', text: 'c' }], providerOptions: CC },
      { role: 'user', content: [{ type: 'text', text: 'd' }], providerOptions: CC },
    ], settingsCall: { providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' }, metadata: { userId: 'u-1' }, sendReasoning: true } } }, responses: [ok(text())] });
  add({ name: 'send-reasoning-false', messages: [user('q'), { role: 'assistant', content: [{ type: 'reasoning', text: 'r', providerOptions: { anthropic: { signature: 's' } } }, { type: 'text', text: 'a' }] }, user('q2')],
    settingsCall: { providerOptions: { anthropic: { sendReasoning: false } } }, responses: [ok(text())] });
  add({ name: 'provider-opts-misc', messages: [user('hi')], tools: [weather],
    settingsCall: { providerOptions: { anthropic: { disableParallelToolUse: true, toolStreaming: false, speed: 'fast', serviceTier: 'auto', inferenceGeo: 'us', effort: 'low' } } }, responses: [ok(text())] });
  add({ name: 'disable-parallel-no-choice', messages: [user('hi')], tools: [weather], settingsCall: { providerOptions: { anthropic: { disableParallelToolUse: true } } }, responses: [ok(text())] });
  add({ name: 'invalid-provider-opts', maxRetries: 0, messages: [user('hi')], settingsCall: { providerOptions: { anthropic: { effort: 'huge' } } }, responses: [ok(text())] });
  // ---- thinking ----
  add({ name: 'thinking-stream', thinking: true, messages: [user('think')], settingsCall: { temperature: 0.4, topP: 0.3, topK: 5, maxOutputTokens: 1000 },
    responses: [ok([start({ input_tokens: 20, cache_read_input_tokens: 3, cache_creation_input_tokens: 4, output_tokens: 1 }),
      ev('content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '' } }),
      ev('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: 'Let me ' } }), ping(),
      ev('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: 'think.' } }),
      ev('content_block_delta', { index: 0, delta: { type: 'signature_delta', signature: 'EqQBsig' } }), stop(0),
      ev('content_block_start', { index: 1, content_block: { type: 'redacted_thinking', data: 'REDACTED' } }), stop(1),
      tStart(2), ev('content_block_delta', { index: 2, delta: { type: 'signature_delta', signature: 'ignored' } }), tDelta(2, 'Answer'), stop(2),
      mDelta('end_turn', { output_tokens: 40, output_tokens_details: { thinking_tokens: 25 }, cache_read_input_tokens: 7 }), mStop()])] });
  add({ name: 'thinking-known-cap', model: 'claude-opus-4-1', thinking: true, messages: [user('t')], settingsCall: { maxOutputTokens: 31000 }, responses: [ok(text())] });
  add({ name: 'thinking-default-cap', model: 'claude-opus-4-1', thinking: true, messages: [user('t')], responses: [ok(text())] });
  add({ name: 'thinking-no-budget', messages: [user('t')], settingsCall: { providerOptions: { anthropic: { thinking: { type: 'enabled' } } } }, responses: [ok(text())] });
  add({ name: 'thinking-adaptive', model: 'claude-sonnet-4-6', messages: [user('t')], settingsCall: { temperature: 0.1, providerOptions: { anthropic: { thinking: { type: 'adaptive', display: 'updates' }, effort: 'high' } } }, responses: [ok(text())] });
  add({ name: 'thinking-disabled', messages: [user('t')], settingsCall: { providerOptions: { anthropic: { thinking: { type: 'disabled' } } } }, responses: [ok(text())] });
  add({ name: 'thinking-budget-rejected', model: 'claude-fable-5', thinking: true, messages: [user('t')], responses: [ok(text())] });
  add({ name: 'thinking-disabled-rejected', model: 'claude-sonnet-5-5', messages: [user('t')], settingsCall: { providerOptions: { anthropic: { thinking: { type: 'disabled' }, effort: 'max' } } }, responses: [ok(text())] });
  add({ name: 'thinking-disabled-fable', model: 'claude-fable-5-1', messages: [user('t')], tools: [weather], toolChoice: 'required', settingsCall: { providerOptions: { anthropic: { thinking: { type: 'disabled' } } } }, responses: [ok(text())] });
  add({ name: 'effort-xhigh-disabled', model: 'claude-haiku-5-5', messages: [user('t')], tools: [weather, search], toolChoice: { type: 'tool', toolName: 'search' }, settingsCall: { providerOptions: { anthropic: { thinking: { type: 'disabled' }, effort: 'xhigh' } } }, responses: [ok(text())] });
  for (const r of ['none', 'minimal', 'high', 'xhigh'])
    for (const m of ['claude-sonnet-4-5', 'claude-opus-4-7', 'claude-sonnet-5-5', 'm-1'])
      add({ name: `reasoning-${r}-${m}`, model: m, messages: [user('t')], settingsCall: { reasoning: r }, responses: [ok(text())] });
  // ---- tools ----
  add({ name: 'tools-stream', messages: [user('weather?')], tools: [weather, search], toolChoice: 'required',
    responses: [ok([start(), tStart(0), tDelta(0, 'Checking'), stop(0),
      toolStart(1, 'toolu_a', 'get_weather'), jsonDelta(1, ''), jsonDelta(1, '{"ci'), jsonDelta(1, 'ty":"SF"}'), stop(1),
      mDelta('tool_use', { output_tokens: 30 }), mStop()])] });
  add({ name: 'parallel-tools', messages: [user('both')], tools: [weather, search], toolChoice: { type: 'tool', toolName: 'search' },
    responses: [ok([start(), toolStart(0, 'toolu_a', 'get_weather'), jsonDelta(0, '{"city":"LA"}'), stop(0),
      toolStart(1, 'toolu_b', 'search'), stop(1),
      toolStart(2, 'toolu_c', 'search', { q: 'pre' }), stop(2),
      mDelta('tool_use'), mStop()])] });
  add({ name: 'tool-choice-auto-none', messages: [user('w')], tools: [weather], toolChoice: 'none', responses: [ok(text())] });
  add({ name: 'tool-choice-auto', messages: [user('w')], tools: [weather], toolChoice: 'auto', responses: [ok(text())] });
  add({ name: 'message-start-content', messages: [user('w')], tools: [weather],
    responses: [ok([start(undefined, { content: [{ type: 'tool_use', id: 'toolu_p', name: 'get_weather', input: { city: 'P' }, caller: { type: 'direct' } }], stop_reason: 'tool_use' }), mStop()])] });
  // ---- stop reasons / usage ----
  for (const r of ['stop_sequence', 'max_tokens', 'refusal', 'pause_turn', 'model_context_window_exceeded', 'compaction', 'weird', null])
    add({ name: `stop-${r}`, messages: [user('x')], responses: [ok(text('a', r))] });
  add({ name: 'usage-cache-iterations', messages: [user('x')],
    responses: [ok([start({ input_tokens: 100, cache_creation_input_tokens: 50, cache_read_input_tokens: 25, output_tokens: 1, service_tier: 'standard' }),
      tStart(0), tDelta(0, 'x'), stop(0),
      ev('message_delta', { delta: { stop_reason: 'stop_sequence', stop_sequence: 'END', stop_details: { type: 'refusal', category: 'cyber', explanation: null } },
        usage: { input_tokens: 101, output_tokens: 7, cache_creation_input_tokens: 51, iterations: [{ type: 'compaction', input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 3 }, { type: 'message', model: 'm', input_tokens: 20, output_tokens: 4 }] } }), mStop()])] });
  add({ name: 'no-message-stop', messages: [user('x')], responses: [ok([start(), tStart(0), tDelta(0, 'x'), stop(0), mDelta('end_turn')])] });
  add({ name: 'duplicate-message-start', messages: [user('x')], responses: [ok([start(), start(), ev('message_start', { message: { id: 'msg_02', usage: { input_tokens: 1 } } }), tStart(0), tDelta(0, 'x'), mStop()])] });
  add({ name: 'sse-crlf-comments-trailing', messages: [user('x')], responses: [ok([': c\r\n\r\n', start(), 'event: content_block_start\r\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\r\n\r\n',
    'data: {"type":"content_block_delta","index":0,', '"delta":{"type":"text_delta","text":"b"}}\n\n', stop(0), mDelta('end_turn'), mStop(), 'data: {"type":"ping"}'])] });
  // ---- errors ----
  add({ name: 'error-first-chunk', maxRetries: 0, messages: [user('x')], responses: [ok([ev('error', { error: { type: 'overloaded_error', message: 'Overloaded' } })])] });
  add({ name: 'error-first-chunk-retry', messages: [user('x')], responses: [
    ok([ev('error', { error: { type: 'api_error', message: 'Internal' } })]), ok(text('after'))] });
  add({ name: 'error-first-chunk-meta', maxRetries: 0, messages: [user('x')], responses: [ok([ev('error', { error: { type: 'custom_error', message: 'C', code: 'E1', statusCode: 418, isRetryable: true, data: { k: 1 } } })])] });
  add({ name: 'error-first-unknown-type', maxRetries: 0, messages: [user('x')], responses: [ok([ev('error', { error: { type: 'mystery', message: 'M' } })])] });
  add({ name: 'error-mid-stream', messages: [user('x')], responses: [ok([start(), tStart(0), tDelta(0, 'a'), ev('error', { error: { type: 'rate_limit_error', message: 'slow' } }), tDelta(0, 'b'), mStop()])] });
  for (const t of ['request_too_large', 'authentication_error', 'permission_error', 'not_found_error', 'billing_error', 'invalid_request_error'])
    add({ name: `error-mid-${t}`, messages: [user('x')], responses: [ok([start(), ev('error', { error: { type: t, message: t } })])] });
  add({ name: 'bad-json-chunk', maxRetries: 0, messages: [user('x')], responses: [ok([start(), 'data: {not json}\n\n', tStart(0), tDelta(0, 'x'), stop(0), mDelta('end_turn'), mStop()])] });
  add({ name: 'bad-first-chunk', maxRetries: 0, messages: [user('x')], responses: [ok(['data: {"type":"nope"}\n\n', start(), mStop()])] });
  add({ name: 'schema-mismatch-chunk', messages: [user('x')], responses: [ok([start(), ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 5 } }), mStop()])] });
  for (const [st, body, h] of [
    [400, errBody('invalid_request_error', 'max_tokens: too big')],
    [401, errBody('authentication_error', 'invalid x-api-key')],
    [404, 'not found page'],
    [413, errBody('request_too_large', 'too large')],
    [500, ''],
    [529, errBody('overloaded_error', 'Overloaded')],
    [422, { detail: 'not anthropic shaped' }],
  ]) add({ name: `http-${st}`, maxRetries: 0, messages: [user('x')], responses: [json(st, body, h)] });
  add({ name: '429-retry-then-ok', messages: [user('x')], responses: [
    json(429, errBody('rate_limit_error', 'rate limited'), { 'retry-after-ms': '0' }),
    json(529, errBody('overloaded_error', 'Overloaded'), { 'retry-after': '0' }),
    ok(text('ok'))] });
  add({ name: '529-exhausted', maxRetries: 1, messages: [user('x')], responses: [
    json(529, errBody('overloaded_error', 'Overloaded'), { 'retry-after-ms': '0' }),
    json(529, errBody('overloaded_error', 'Overloaded again'), { 'retry-after-ms': '0' })] });
  add({ name: 'mid-stream-destroy', messages: [user('x')], responses: [{ ...ok([start(), tStart(0), tDelta(0, 'partial')]), end: 'destroy' }] });
  add({ name: 'destroy-before-first', maxRetries: 0, messages: [user('x')], responses: [{ ...ok([]), end: 'destroy' }] });
  add({ name: 'abort-mid-stream', messages: [user('x')], abortAfterParts: 4, responses: [{ ...ok([start(), tStart(0), tDelta(0, 'a'), tDelta(0, 'b')]), end: 'hang' }] });
  // ---- generate ----
  add({ name: 'gen-text', call: 'generate', instructions: 'sys', messages: [user('hi')], settingsCall: { maxOutputTokens: 10, stopSequences: ['END'] },
    responses: [json(200, msg([{ type: 'thinking', thinking: 'hmm', signature: 'sg' }, { type: 'redacted_thinking', data: 'rd' }, { type: 'text', text: 'Hello' }], 'end_turn',
      { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2, cache_creation_input_tokens: null, extra_field: 1 }, { stop_sequence: 'END', container: null }), { 'x-served-model': 'z' })] });
  add({ name: 'gen-tools', call: 'generate', messages: [user('w')], tools: [weather],
    responses: [json(200, msg([{ type: 'text', text: 'calling' }, { type: 'tool_use', id: 'toolu_g', name: 'get_weather', input: { city: 'SF' } }, { type: 'tool_use', id: 'toolu_h', name: 'get_weather', input: {}, caller: { type: 'direct' } }], 'tool_use',
      { input_tokens: 3, output_tokens: 4, output_tokens_details: { thinking_tokens: 1 }, iterations: [{ type: 'fallback_message', input_tokens: 1, output_tokens: 1 }] }, { stop_details: { type: 'refusal', recommended_model: 'x' } }))] });
  add({ name: 'gen-thinking', call: 'generate', thinking: true, messages: [user('w')], responses: [json(200, msg([{ type: 'text', text: 'ok' }], 'max_tokens'))] });
  add({ name: 'gen-invalid-json', call: 'generate', maxRetries: 0, messages: [user('w')], responses: [json(200, '{"content":')] });
  add({ name: 'gen-schema-mismatch', call: 'generate', maxRetries: 0, messages: [user('w')], responses: [json(200, { type: 'message', content: [{ type: 'text', text: 5 }], usage: { input_tokens: 1, output_tokens: 1 } })] });
  add({ name: 'gen-http-529', call: 'generate', maxRetries: 0, messages: [user('w')], responses: [json(529, errBody('overloaded_error', 'Overloaded'))] });
  add({ name: 'gen-http-401', call: 'generate', messages: [user('w')], responses: [json(401, errBody('authentication_error', 'nope'))] });
  add({ name: 'gen-abort', call: 'generate', messages: [user('w')], abortBeforeGenerate: true,
    responses: [{ status: 200, headers: { 'content-type': 'application/json' }, chunks: [], end: 'hang' }] });
  return s.filter((x) => !x.skip);
}
