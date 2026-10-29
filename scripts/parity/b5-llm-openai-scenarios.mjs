// openai-responses scenarios for record-b5-llm.mjs (written to b5-llm-openai-responses.json).
const user = (text) => ({ role: 'user', content: text });
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const weather = {
  name: 'get_weather', description: 'Get the weather',
  inputSchema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'], additionalProperties: false },
};
const search = { name: 'search', inputSchema: { type: 'object', properties: { q: { type: 'string' } } } };

export function responsesScenarios({ sse, SSE_H, json }) {
  const P = 'openai-responses';
  const M = 'gpt-4.1';
  const R = 'gpt-5-mini';
  let seq = 0;
  const ev = (type, o = {}) => ({ type, sequence_number: seq++, ...o });
  const created = (extra = {}) => ev('response.created', { response: { id: 'resp_1', created_at: 1700000000, model: 'gpt-4.1-2025-04-14', service_tier: null, ...extra } });
  const inProgress = () => ev('response.in_progress', { response: { id: 'resp_1', created_at: 1700000000, model: 'gpt-4.1-2025-04-14' } });
  const usage = { input_tokens: 12, input_tokens_details: { cached_tokens: 4 }, output_tokens: 9, output_tokens_details: { reasoning_tokens: 3 } };
  const completed = (extra = {}) => ev('response.completed', { response: { id: 'resp_1', incomplete_details: null, usage, service_tier: 'default', ...extra } });
  const msgAdded = (id = 'msg_1', idx = 0, phase) => ev('response.output_item.added', { output_index: idx, item: { type: 'message', id, role: 'assistant', status: 'in_progress', content: [], ...(phase ? { phase } : {}) } });
  const delta = (d, id = 'msg_1', extra = {}) => ev('response.output_text.delta', { item_id: id, output_index: 0, content_index: 0, delta: d, ...extra });
  const msgDone = (text, id = 'msg_1', idx = 0, phase) => ev('response.output_item.done', { output_index: idx, item: { type: 'message', id, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }], ...(phase ? { phase } : {}) } });
  const rsAdded = (id = 'rs_1', enc = 'enc-0') => ev('response.output_item.added', { output_index: 0, item: { type: 'reasoning', id, encrypted_content: enc, summary: [] } });
  const partAdded = (i, id = 'rs_1') => ev('response.reasoning_summary_part.added', { item_id: id, output_index: 0, summary_index: i, part: { type: 'summary_text', text: '' } });
  const rsDelta = (i, d, id = 'rs_1') => ev('response.reasoning_summary_text.delta', { item_id: id, output_index: 0, summary_index: i, delta: d });
  const partDone = (i, id = 'rs_1') => ev('response.reasoning_summary_part.done', { item_id: id, output_index: 0, summary_index: i, part: { type: 'summary_text', text: 'x' } });
  const rsDone = (id = 'rs_1', enc = 'enc-final') => ev('response.output_item.done', { output_index: 0, item: { type: 'reasoning', id, encrypted_content: enc, summary: [] } });
  const fcAdded = (id, call, name, idx = 0) => ev('response.output_item.added', { output_index: idx, item: { type: 'function_call', id, call_id: call, name, arguments: '', status: 'in_progress' } });
  const fcDelta = (id, d, idx = 0) => ev('response.function_call_arguments.delta', { item_id: id, output_index: idx, delta: d });
  const fcDone = (id, call, name, args, idx = 0) => ev('response.output_item.done', { output_index: idx, item: { type: 'function_call', id, call_id: call, name, arguments: args, status: 'completed' } });
  const ok = (evs, h = {}) => ({ status: 200, headers: { ...SSE_H, 'x-request-id': 'req-1', ...h }, chunks: sse(evs) });
  const s = [];
  const add = (o) => { s.push({ protocol: P, model: M, ...o }); seq = 0; };

  // ---- text ----
  add({ name: 'resp/text', instructions: 'be brief', messages: [user('hi')], settingsCall: { temperature: 0.3, topP: 0.9, maxOutputTokens: 256 },
    responses: [ok([created(), inProgress(), msgAdded(), delta('Hel'), delta('lo'), msgDone('Hello'), completed()])] });
  add({ name: 'resp/text-headers-ua', headers: { 'X-Custom': ' v1 ', Authorization: 'Bearer override' }, userAgent: 'Nomi/2.0.5', messages: [user('hi')],
    responses: [ok([created(), msgAdded(), delta('x'), msgDone('x'), completed()])] });
  add({ name: 'resp/no-apikey', apiKey: '', messages: [user('hi')], responses: [ok([created(), msgAdded(), delta('x'), msgDone('x'), completed()])] });
  add({ name: 'resp/text-phase-logprobs-annotations', messages: [user('cite')],
    providerOptions: { openai: { logprobs: 2, textVerbosity: 'low', user: 'u1', metadata: { a: 'b' }, safetyIdentifier: 'sid', promptCacheKey: 'pk', serviceTier: 'flex' } },
    responses: [ok([created({ service_tier: 'flex' }), msgAdded('msg_1', 0, 'final_answer'),
      delta('A', 'msg_1', { logprobs: [{ token: 'A', logprob: -0.1, top_logprobs: [{ token: 'A', logprob: -0.1 }, { token: 'B', logprob: -2 }] }] }),
      ev('response.output_text.annotation.added', { item_id: 'msg_1', output_index: 0, content_index: 0, annotation_index: 0, annotation: { type: 'url_citation', url: 'https://ex.com', title: 'Ex', start_index: 0, end_index: 1 } }),
      ev('response.output_text.annotation.added', { item_id: 'msg_1', output_index: 0, content_index: 0, annotation_index: 1, annotation: { type: 'file_citation', file_id: 'file_1', filename: 'a.pdf', index: 0 } }),
      msgDone('A', 'msg_1', 0, 'final_answer'), completed({ service_tier: 'flex' })])] });
  add({ name: 'resp/incomplete-max-tokens', messages: [user('long')], settingsCall: { maxOutputTokens: 5 },
    responses: [ok([created(), msgAdded(), delta('trunc'), msgDone('trunc'), ev('response.incomplete', { response: { incomplete_details: { reason: 'max_output_tokens' }, usage } })])] });
  add({ name: 'resp/incomplete-content-filter', messages: [user('x')],
    responses: [ok([created(), msgAdded(), delta('t'), msgDone('t'), ev('response.incomplete', { response: { incomplete_details: { reason: 'content_filter' }, usage } })])] });
  add({ name: 'resp/no-completed', messages: [user('x')], responses: [ok([created(), msgAdded(), delta('t'), msgDone('t')])] });
  add({ name: 'resp/unknown-chunk-types', messages: [user('x')],
    responses: [ok([created(), ev('response.output_text.done', { item_id: 'msg_1', text: 't' }), ev('response.content_part.added', { item_id: 'msg_1' }), msgAdded(), delta('t'), ev('response.something.new', { x: 1 }), msgDone('t'), completed()])] });
  add({ name: 'resp/sse-comments-crlf', messages: [user('x')],
    responses: [{ status: 200, headers: SSE_H, chunks: [': keepalive\r\n\r\n', `event: response.created\r\ndata: ${JSON.stringify(created())}\r\n\r\n`, `data: ${JSON.stringify(msgAdded())}\n\n`, `data: ${JSON.stringify(delta('ok'))}\n\ndata: ${JSON.stringify(msgDone('ok'))}\n\n`, `data: ${JSON.stringify(completed())}`] }] });

  // ---- reasoning ----
  add({ name: 'resp/reasoning-summary-store', model: R, thinking: true, messages: [user('think')],
    providerOptions: { openai: { reasoningEffort: 'low', reasoningSummary: 'auto' } },
    responses: [ok([created(), rsAdded(), partAdded(0), rsDelta(0, 'step '), rsDelta(0, 'one'), partDone(0), partAdded(1), rsDelta(1, 'two'), partDone(1), rsDone(),
      msgAdded('msg_2', 1), delta('ans', 'msg_2'), msgDone('ans', 'msg_2', 1), completed({ reasoning: { context: 'ctx-1' } })])] });
  add({ name: 'resp/reasoning-encrypted-nostore', model: R, messages: [user('think')],
    providerOptions: { openai: { store: false, reasoningSummary: 'detailed', include: ['reasoning.encrypted_content'] } },
    responses: [ok([created(), rsAdded('rs_1', null), partAdded(0), rsDelta(0, 'a'), partDone(0), partAdded(1), rsDelta(1, 'b'), partDone(1), rsDone('rs_1', 'enc-xyz'),
      msgAdded('msg_2', 1), delta('ok', 'msg_2'), msgDone('ok', 'msg_2', 1), completed()])] });
  add({ name: 'resp/reasoning-no-summary', model: R, messages: [user('think')],
    responses: [ok([created(), rsAdded(), rsDone(), msgAdded('msg_2', 1), delta('ok', 'msg_2'), msgDone('ok', 'msg_2', 1), completed()])] });
  add({ name: 'resp/reasoning-model-drops-temperature', model: 'o3-mini', messages: [user('x')], settingsCall: { temperature: 0.5, topP: 0.5 },
    responses: [ok([created(), msgAdded(), delta('x'), msgDone('x'), completed()])] });
  add({ name: 'resp/multi-turn-reasoning-items', model: R,
    providerOptions: { openai: { store: false } },
    messages: [
      user('q1'),
      { role: 'assistant', content: [
        { type: 'reasoning', text: 'thought a', providerOptions: { openai: { itemId: 'rs_9', reasoningEncryptedContent: 'enc-9' } } },
        { type: 'reasoning', text: 'thought b', providerOptions: { openai: { itemId: 'rs_9' } } },
        { type: 'text', text: 'a1', providerOptions: { openai: { itemId: 'msg_9', phase: 'final_answer' } } },
      ] },
      user('q2'),
    ],
    responses: [ok([created(), msgAdded(), delta('x'), msgDone('x'), completed()])] });

  // ---- previous_response_id / store ----
  add({ name: 'resp/previous-response-id', messages: [user('again')],
    providerOptions: { openai: { previousResponseId: 'resp_prev', store: true, parallelToolCalls: false, truncation: 'auto', maxToolCalls: 3 } },
    responses: [ok([created(), msgAdded(), delta('x'), msgDone('x'), completed()])] });
  add({ name: 'resp/store-item-references', messages: [
      user('q1'),
      { role: 'assistant', content: [{ type: 'text', text: 'a1', providerOptions: { openai: { itemId: 'msg_prev' } } }, { type: 'tool-call', toolCallId: 'call_p', toolName: 'search', input: { q: 'x' }, providerOptions: { openai: { itemId: 'fc_prev' } } }] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'call_p', toolName: 'search', output: { type: 'text', value: 'r' } }] },
    ], tools: [search], responses: [ok([created(), msgAdded(), delta('x'), msgDone('x'), completed()])] });

  // ---- tools ----
  add({ name: 'resp/tools-stream', messages: [user('weather?')], tools: [weather, search], toolChoice: 'required',
    responses: [ok([created(), fcAdded('fc_1', 'call_1', 'get_weather'), fcDelta('fc_1', '{"ci'), fcDelta('fc_1', 'ty":"SF"}'), fcDone('fc_1', 'call_1', 'get_weather', '{"city":"SF"}'), completed()])] });
  add({ name: 'resp/parallel-tools', messages: [user('both')], tools: [weather, search], toolChoice: { type: 'tool', toolName: 'search' },
    responses: [ok([created(), fcAdded('fc_1', 'call_1', 'get_weather', 0), fcAdded('fc_2', 'call_2', 'search', 1), fcDelta('fc_1', '{"city":"NY"}', 0), fcDelta('fc_2', '{"q":"z"}', 1),
      fcDone('fc_2', 'call_2', 'search', '{"q":"z"}', 1), fcDone('fc_1', 'call_1', 'get_weather', '{"city":"NY"}', 0), completed()])] });
  add({ name: 'resp/text-then-tool', messages: [user('t')], tools: [search], toolChoice: 'none',
    responses: [ok([created(), msgAdded(), delta('let me look'), msgDone('let me look'), fcAdded('fc_1', 'call_1', 'search', 1), fcDone('fc_1', 'call_1', 'search', '{}', 1), completed()])] });
  add({ name: 'resp/multi-turn-tools', instructions: 'sys', messages: [
      user('q1'),
      { role: 'assistant', content: [{ type: 'text', text: 'a1' }, { type: 'tool-call', toolCallId: 'call_1', toolName: 'get_weather', input: { city: 'SF' } }] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'call_1', toolName: 'get_weather', output: { type: 'json', value: { t: 20 } } }] },
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'call_2', toolName: 'search', input: { q: 'x' } }] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'call_2', toolName: 'search', output: { type: 'error-text', value: 'boom' } }] },
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'call_3', toolName: 'search', input: { q: 'y' } }] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'call_3', toolName: 'search', output: { type: 'execution-denied', reason: 'user said no' } }] },
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'call_4', toolName: 'search', input: { q: 'w' } }] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'call_4', toolName: 'search', output: { type: 'content', value: [{ type: 'text', text: 'see' }, { type: 'image-data', data: PNG, mediaType: 'image/png' }] } }] },
    ], tools: [weather, search], responses: [ok([created(), msgAdded(), delta('ok'), msgDone('ok'), completed()])] });

  // ---- images / files ----
  add({ name: 'resp/images-files', messages: [
      { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image', image: PNG, mediaType: 'image/png' },
        { type: 'image', image: new URL('https://ex.com/cat.jpg') },
        { type: 'image', image: PNG, mediaType: 'image/png', providerOptions: { openai: { imageDetail: 'low' } } },
        { type: 'file', data: 'JVBERi0xLjQK', mediaType: 'application/pdf', filename: 'a.pdf' },
        { type: 'file', data: new URL('https://ex.com/b.pdf'), mediaType: 'application/pdf' },
        { type: 'file', data: 'file-abc123', mediaType: 'application/pdf' }] },
    ], responses: [ok([created(), msgAdded(), delta('ok'), msgDone('ok'), completed()])] });
  add({ name: 'resp/unsupported-file', messages: [{ role: 'user', content: [{ type: 'file', data: new TextEncoder().encode('plain'), mediaType: 'text/plain' }] }],
    responses: [ok([created(), msgAdded(), delta('ok'), msgDone('ok'), completed()])] });

  // ---- errors ----
  for (const [st, body, h] of [
    [400, { error: { message: 'bad request', type: 'invalid_request_error', param: null, code: null } }],
    [401, { error: { message: 'Incorrect API key', type: 'invalid_request_error', code: 'invalid_api_key' } }],
    [429, { error: { message: 'Rate limit', type: 'requests', code: 'rate_limit_exceeded' } }, { 'retry-after-ms': '5' }],
    [500, 'upstream exploded'],
    [503, { error: { message: 'overloaded' } }],
  ]) add({ name: `resp/http-${st}`, maxRetries: 0, messages: [user('x')], responses: [json(st, body, h)] });
  add({ name: 'resp/429-retry-then-ok', messages: [user('x')], responses: [
    json(429, { error: { message: 'slow down' } }, { 'retry-after-ms': '5' }),
    ok([created(), msgAdded(), delta('ok'), msgDone('ok'), completed()])] });
  add({ name: 'resp/early-error-frame', maxRetries: 0, messages: [user('x')],
    responses: [ok([created(), inProgress(), ev('error', { error: { type: 'tokens', code: 'rate_limit_exceeded', message: 'Rate limit reached', param: null } })])] });
  add({ name: 'resp/early-error-flat-quota', maxRetries: 0, messages: [user('x')],
    responses: [ok([created(), ev('error', { code: 'insufficient_quota', message: 'You exceeded your quota', param: null })])] });
  add({ name: 'resp/early-error-retried', messages: [user('x')], responses: [
    ok([created(), ev('error', { error: { type: 'server_error', code: 'server_error', message: 'oops', param: null } })]),
    ok([created(), msgAdded(), delta('ok'), msgDone('ok'), completed()])] });
  add({ name: 'resp/early-response-failed', maxRetries: 0, messages: [user('x')],
    responses: [ok([created(), inProgress(), ev('response.failed', { response: { error: { code: 'server_error', message: 'The server had an error' }, incomplete_details: null, usage: null } })])] });
  add({ name: 'resp/early-failed-no-error', maxRetries: 0, messages: [user('x')],
    responses: [ok([created(), ev('response.failed', { response: { error: null, incomplete_details: { reason: 'max_output_tokens' }, usage } })])] });
  add({ name: 'resp/mid-stream-error-frame', messages: [user('x')],
    responses: [ok([created(), msgAdded(), delta('part'), ev('error', { error: { type: 'server_error', code: '502', message: 'bad gateway', param: null } })])] });
  add({ name: 'resp/mid-stream-response-failed', messages: [user('x')],
    responses: [ok([created(), msgAdded(), delta('part'), ev('response.failed', { response: { error: { code: 'context_length_exceeded', message: 'too long' }, incomplete_details: null, usage } })])] });
  add({ name: 'resp/mid-stream-destroy', messages: [user('x')],
    responses: [{ ...ok([created(), msgAdded(), delta('part')]), end: 'destroy' }] });
  add({ name: 'resp/bad-json-chunk', messages: [user('x')],
    responses: [ok([created(), msgAdded(), 'data: {"type":\n\n', delta('after'), msgDone('after'), completed()])] });
  add({ name: 'resp/schema-mismatch-chunk', messages: [user('x')],
    responses: [ok([created(), msgAdded(), ev('response.output_text.delta', { item_id: 'msg_1', delta: 5 }), completed()])] });
  add({ name: 'resp/chat-completions-mismatch', messages: [user('x')],
    responses: [ok([{ id: 'chatcmpl-1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'hi' } }] }])] });
  add({ name: 'resp/abort-mid-stream', messages: [user('x')], abortAfterParts: 4,
    responses: [{ ...ok([created(), msgAdded(), delta('a'), delta('b')]), end: 'hang' }] });
  add({ name: 'resp/abort-before-output', messages: [user('x')], abortAfterParts: 1,
    responses: [{ ...ok([created(), msgAdded(), delta('a')]), end: 'hang' }] });

  // ---- generate ----
  const genBody = (output, extra = {}) => ({ id: 'resp_g', created_at: 1700000000, model: 'gpt-4.1-2025-04-14', output, incomplete_details: null, usage, service_tier: 'default', ...extra });
  add({ name: 'resp/gen-text', call: 'generate', instructions: 'sys', messages: [user('hi')], settingsCall: { maxOutputTokens: 10, seed: 7, stopSequences: ['END'] },
    responses: [json(200, genBody([{ type: 'message', id: 'msg_g', role: 'assistant', content: [{ type: 'output_text', text: 'hello', annotations: [{ type: 'url_citation', url: 'https://ex.com', title: 'Ex', start_index: 0, end_index: 5 }] }] }]))] });
  add({ name: 'resp/gen-reasoning-tools', call: 'generate', model: R, messages: [user('w')], tools: [weather],
    providerOptions: { openai: { reasoningSummary: 'auto' } },
    responses: [json(200, genBody([
      { type: 'reasoning', id: 'rs_g', encrypted_content: 'enc-g', summary: [{ type: 'summary_text', text: 's1' }, { type: 'summary_text', text: 's2' }] },
      { type: 'function_call', id: 'fc_g', call_id: 'call_g', name: 'get_weather', arguments: '{"city":"SF"}', status: 'completed' },
      { type: 'function_call', id: 'fc_h', call_id: 'call_h', name: 'get_weather', arguments: '{"city":"LA"}', status: 'completed' },
    ]))] });
  add({ name: 'resp/gen-incomplete', call: 'generate', messages: [user('w')],
    responses: [json(200, genBody([{ type: 'message', id: 'msg_g', role: 'assistant', content: [{ type: 'output_text', text: 'cut', annotations: [] }] }], { incomplete_details: { reason: 'max_output_tokens' } }))] });
  add({ name: 'resp/gen-error-body', call: 'generate', maxRetries: 0, messages: [user('w')],
    responses: [json(200, genBody([], { error: { code: 'server_error', message: 'failed inside' } }))] });
  add({ name: 'resp/gen-invalid-json', call: 'generate', maxRetries: 0, messages: [user('w')], responses: [json(200, '{"output":')] });
  add({ name: 'resp/gen-schema-mismatch', call: 'generate', maxRetries: 0, messages: [user('w')], responses: [json(200, { output: 5 })] });
  add({ name: 'resp/gen-http-401', call: 'generate', messages: [user('w')], responses: [json(401, { error: { message: 'nope', code: 401 } })] });
  add({ name: 'resp/gen-abort', call: 'generate', messages: [user('w')], abortBeforeGenerate: true,
    responses: [{ ...json(200, genBody([])), end: 'hang', chunks: ['{'] }] });
  return s;
}
