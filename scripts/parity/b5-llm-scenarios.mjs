// Scripted scenarios for record-b5-llm.mjs (one list per protocol).
const user = (text) => ({ role: 'user', content: text });
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const weather = {
  name: 'get_weather',
  description: 'Get the weather',
  inputSchema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'], additionalProperties: false },
};
const search = { name: 'search', inputSchema: { type: 'object', properties: { q: { type: 'string' } } } };

export function compatibleScenarios({ sse, SSE_H, json }) {
  const P = 'openai-chat';
  const chunk = (delta, extra = {}) => ({ id: 'chatcmpl-1', object: 'chat.completion.chunk', created: 1700000000, model: 'm-1-served', choices: [{ index: 0, delta, finish_reason: null }], ...extra });
  const fin = (reason, usage) => ({ id: 'chatcmpl-1', object: 'chat.completion.chunk', created: 1700000000, model: 'm-1-served', choices: [{ index: 0, delta: {}, finish_reason: reason }], ...(usage ? { usage } : {}) });
  const usage = { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 };
  const ok = (evs) => ({ status: 200, headers: { ...SSE_H, 'x-request-id': 'req-1' }, chunks: sse([...evs, '[DONE]'].map((e) => (e === '[DONE]' ? 'data: [DONE]\n\n' : e))) });
  const s = [];
  s.push({ name: 'compat/text', protocol: P, instructions: 'be brief', messages: [user('hi')],
    settingsCall: { temperature: 0.3, topP: 0.9, maxOutputTokens: 256 },
    responses: [ok([chunk({ role: 'assistant', content: '' }), chunk({ content: 'Hel' }), chunk({ content: 'lo' }), fin('stop'), { id: 'chatcmpl-1', choices: [], usage }])] });
  s.push({ name: 'compat/text-headers-ua', protocol: P, headers: { 'X-Custom': ' v1 ', Authorization: 'Bearer override' }, userAgent: 'Nomi/2.0.5', messages: [user('hi')],
    responses: [ok([chunk({ content: 'x' }), fin('length', usage)])] });
  s.push({ name: 'compat/no-apikey-headers', protocol: P, apiKey: '', messages: [user('hi')],
    responses: [ok([chunk({ content: 'x' }), fin('content_filter')])] });
  s.push({ name: 'compat/multi-turn', protocol: P, instructions: 'sys', messages: [
      user('q1'),
      { role: 'assistant', content: [{ type: 'reasoning', text: 'think' }, { type: 'text', text: 'a1' }, { type: 'tool-call', toolCallId: 'call_1', toolName: 'get_weather', input: { city: 'SF' } }] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'call_1', toolName: 'get_weather', output: { type: 'json', value: { t: 20 } } }] },
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'call_2', toolName: 'search', input: { q: 'x' } }] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'call_2', toolName: 'search', output: { type: 'text', value: 'found' } }] },
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'call_3', toolName: 'search', input: { q: 'y' } }] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'call_3', toolName: 'search', output: { type: 'error-text', value: 'boom' } }] },
      { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image', image: PNG, mediaType: 'image/png' }, { type: 'file', data: 'JVBERi0xLjQK', mediaType: 'application/pdf', filename: 'a.pdf' }, { type: 'file', data: new TextEncoder().encode('plain text'), mediaType: 'text/plain' }] },
    ], tools: [weather, search],
    responses: [ok([chunk({ content: 'ok' }), fin('stop', usage)])] });
  s.push({ name: 'compat/tools-stream', protocol: P, messages: [user('weather?')], tools: [weather, search], toolChoice: 'required',
    responses: [ok([
      chunk({ role: 'assistant', content: null, tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'get_weather', arguments: '' } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: '{"ci' } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: 'ty":"SF"}' } }] }),
      fin('tool_calls', { ...usage, prompt_tokens_details: { cached_tokens: 4 } }),
    ])] });
  s.push({ name: 'compat/parallel-tools', protocol: P, messages: [user('both')], tools: [weather, search], toolChoice: { type: 'tool', toolName: 'search' },
    responses: [ok([
      chunk({ tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'get_weather', arguments: '{"city":' } }, { index: 1, id: 'call_b', type: 'function', function: { name: 'search', arguments: '' } }] }),
      chunk({ tool_calls: [{ index: 1, function: { arguments: '{"q":"z"}' } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: '"LA"}' } }] }),
      fin('tool_calls', usage),
    ])] });
  s.push({ name: 'compat/tool-complete-first-chunk', protocol: P, messages: [user('w')], tools: [weather], toolChoice: 'none',
    responses: [ok([
      chunk({ tool_calls: [{ index: 0, id: 'call_c', type: 'function', function: { name: 'get_weather', arguments: '{"city":"NY"}' } }] }),
      fin('tool_calls'),
    ])] });
  s.push({ name: 'compat/tool-no-id', protocol: P, messages: [user('w')], tools: [weather],
    responses: [ok([
      chunk({ tool_calls: [{ index: 0, function: { name: 'get_weather', arguments: '{"city"' } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: ':"P"}' } }] }),
      fin('function_call'),
    ])] });
  s.push({ name: 'compat/reasoning', protocol: P, thinking: true, messages: [user('think')],
    responses: [ok([
      chunk({ reasoning_content: 'Let me ' }), chunk({ reasoning_content: 'think.' }), chunk({ content: 'Answer' }),
      chunk({ reasoning: 'more' }), chunk({ content: '!' }),
      fin('stop', { prompt_tokens: 5, completion_tokens: 20, completion_tokens_details: { reasoning_tokens: 12, accepted_prediction_tokens: 1, rejected_prediction_tokens: 2 } }),
    ])] });
  s.push({ name: 'compat/reasoning-then-tool', protocol: P, messages: [user('t')], tools: [search],
    responses: [ok([chunk({ reasoning_content: 'r' }), chunk({ tool_calls: [{ index: 0, id: 'c1', function: { name: 'search', arguments: '{}' } }] }), fin('tool_calls')])] });
  s.push({ name: 'compat/unknown-finish', protocol: P, messages: [user('x')],
    responses: [ok([chunk({ content: 'a' }), fin('weird')])] });
  s.push({ name: 'compat/no-finish', protocol: P, messages: [user('x')],
    responses: [{ status: 200, headers: SSE_H, chunks: sse([chunk({ content: 'a' })]) }] });
  s.push({ name: 'compat/chunk-error', protocol: P, messages: [user('x')],
    responses: [ok([chunk({ content: 'a' }), { error: { message: 'upstream overloaded', type: 'overloaded', code: 529 } }])] });
  s.push({ name: 'compat/bad-json-chunk', protocol: P, messages: [user('x')],
    responses: [{ status: 200, headers: SSE_H, chunks: ['data: {"choices":[{"delta":{"content":"a"}}]}\n\n', 'data: {not json}\n\n', 'data: {"choices":[{"delta":{"content":"b"},"finish_reason":"stop"}]}\n\n'] }] });
  s.push({ name: 'compat/schema-mismatch-chunk', protocol: P, messages: [user('x')],
    responses: [{ status: 200, headers: SSE_H, chunks: ['data: {"choices":"nope"}\n\n', 'data: {"choices":[{"delta":{"content":"b"},"finish_reason":"stop"}]}\n\n'] }] });
  s.push({ name: 'compat/sse-crlf-comments-trailing', protocol: P, messages: [user('x')],
    responses: [{ status: 200, headers: SSE_H, chunks: [': ping\r\n\r\n', 'event: message\r\ndata: {"choices":[{"delta":{"content":"a"}}]}\r\n\r\n', 'data: {"choices":[{"delta":', '{"content":"b"},"finish_reason":"stop"}]}\n\n', 'data: {"choices":[{"delta":{"content":"dropped"}}]}'] }] });
  for (const [st, body, h] of [
    [400, { error: { message: 'bad request: model', type: 'invalid_request_error', param: 'model', code: 'model_not_found' } }],
    [401, { error: { message: 'Invalid API key' } }],
    [404, 'not found page'],
    [500, ''],
    [503, { error: { message: 'overloaded', code: 503 } }],
    [422, { detail: 'not openai shaped' }],
  ]) s.push({ name: `compat/http-${st}`, protocol: P, maxRetries: 0, messages: [user('x')], responses: [json(st, body, h)] });
  s.push({ name: 'compat/429-retry-then-ok', protocol: P, messages: [user('x')], responses: [
    json(429, { error: { message: 'rate limited' } }, { 'retry-after-ms': '0' }),
    json(500, { error: { message: 'oops' } }, { 'retry-after': '0' }),
    ok([chunk({ content: 'ok' }), fin('stop')]),
  ] });
  s.push({ name: 'compat/429-exhausted', protocol: P, maxRetries: 1, messages: [user('x')], responses: [
    json(429, { error: { message: 'rate limited' } }, { 'retry-after-ms': '0' }),
    json(429, { error: { message: 'rate limited again' } }, { 'retry-after-ms': '0' }),
  ] });
  s.push({ name: 'compat/retry-then-nonretryable', protocol: P, messages: [user('x')], responses: [
    json(502, { error: { message: 'gw' } }, { 'retry-after-ms': '0' }),
    json(400, { error: { message: 'bad' } }),
  ] });
  s.push({ name: 'compat/mid-stream-destroy', protocol: P, messages: [user('x')],
    responses: [{ status: 200, headers: SSE_H, chunks: sse([chunk({ content: 'partial' })]), end: 'destroy' }] });
  s.push({ name: 'compat/abort-mid-stream', protocol: P, messages: [user('x')], abortAfterParts: 3,
    responses: [{ status: 200, headers: SSE_H, chunks: sse([chunk({ content: 'a' }), chunk({ content: 'b' })]), end: 'hang' }] });
  // generate (non-stream) path
  s.push({ name: 'compat/gen-text', protocol: P, call: 'generate', instructions: 'sys', messages: [user('hi')], settingsCall: { maxOutputTokens: 10, seed: 7, stopSequences: ['END'] },
    responses: [json(200, { id: 'chatcmpl-9', created: 1700000001, model: 'm-1-served', choices: [{ index: 0, message: { role: 'assistant', content: 'Hello', reasoning_content: 'hmm' }, finish_reason: 'stop' }], usage: { ...usage, prompt_tokens_details: { cached_tokens: 2 } } }, { 'x-served-model': 'z' })] });
  s.push({ name: 'compat/gen-tools', protocol: P, call: 'generate', messages: [user('w')], tools: [weather],
    responses: [json(200, { choices: [{ message: { content: null, tool_calls: [{ id: 'call_g', type: 'function', function: { name: 'get_weather', arguments: '{"city":"SF"}' } }, { type: 'function', function: { name: 'get_weather', arguments: '{"city":"LA"}' } }] }, finish_reason: 'tool_calls' }] })] });
  s.push({ name: 'compat/gen-no-choices', protocol: P, call: 'generate', maxRetries: 0, messages: [user('w')], responses: [json(200, { choices: [] })] });
  s.push({ name: 'compat/gen-invalid-json', protocol: P, call: 'generate', maxRetries: 0, messages: [user('w')], responses: [json(200, '{"choices":')] });
  s.push({ name: 'compat/gen-schema-mismatch', protocol: P, call: 'generate', maxRetries: 0, messages: [user('w')], responses: [json(200, { choices: [{ message: { content: 5 } }] })] });
  s.push({ name: 'compat/gen-http-401', protocol: P, call: 'generate', messages: [user('w')], responses: [json(401, { error: { message: 'nope', code: 401 } })] });
  s.push({ name: 'compat/gen-abort', protocol: P, call: 'generate', messages: [user('w')], abortBeforeGenerate: true,
    responses: [{ status: 200, headers: JSON_H_(), chunks: [], end: 'hang' }] });
  s.push({ name: 'compat/execution-denied', protocol: P, messages: [
      user('run it'),
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'call_d', toolName: 'search', input: { q: 'rm' } }, { type: 'tool-call', toolCallId: 'call_e', toolName: 'search', input: { q: 'ls' } }] },
      { role: 'tool', content: [
        { type: 'tool-result', toolCallId: 'call_d', toolName: 'search', output: { type: 'execution-denied', reason: 'user rejected' } },
        { type: 'tool-result', toolCallId: 'call_e', toolName: 'search', output: { type: 'execution-denied' } }] },
    ], tools: [search], responses: [ok([chunk({ content: 'ok' }), fin('stop', usage)])] });
  return s;
}
function JSON_H_() { return { 'content-type': 'application/json' }; }
