// Parity cases for packages/gateway/src server helpers (batch 4d):
// tokens, learn.classifyFailure, quality, reasoning, affinity.sessionKey.
export async function recordHelpers({ gw }) {
  const tk = await gw('src/tokens.ts');
  const ln = await gw('src/learn.ts');
  const q = await gw('src/quality.ts');
  const rs = await gw('src/reasoning.ts');
  const af = await gw('src/affinity.ts');
  let seed = 5;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const al = [...'ab 中文日本한국ひカ{}":,.', '😀', '\ud800', 'ſ', 'K', '\u3400', '\u4dbf', '\u9fff', '\ua000'];
  const texts = [''];
  for (let i = 0; i < 400; i++) {
    let s = '';
    for (let j = 0, n = Math.floor(rnd() * 40); j < n; j++) s += pick(al);
    texts.push(s);
  }
  const estimate = texts.map((t) => [t, tk.estimateTokens(t)]);

  const bodies = [
    null, {}, [], 'x', { messages: [{ role: 'user', content: 'hi 中文' }] },
    { system: 'S', messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'yo' }] },
    { input: 'just text' }, { input: null }, { contents: [{ role: 'user', parts: [{ text: 'g' }] }], systemInstruction: { parts: [{ text: 's' }] } },
    { instructions: 'I', input: [{ role: 'user', content: 'a' }, { role: 'user', content: 'b' }], tools: [{ type: 'function', name: 'f' }] },
  ];
  const reqTokens = bodies.map((b) => [b, tk.estimateRequestTokens(b)]);

  // calibration sequence
  tk.resetCalibration();
  const calib = [];
  const key = { sessionKey: 's1', providerId: 'p', model: 'm', wire: 'chat' };
  const m1 = { messages: [{ role: 'user', content: 'hello there' }] };
  const m2 = { messages: [...m1.messages, { role: 'assistant', content: 'hi' }, { role: 'user', content: 'and more text here 中文' }] };
  const steps = [
    ['count', key, m1, 1000], ['record', key, m1, 120, 1000], ['count', key, m1, 2000], ['count', key, m2, 2000],
    ['record', key, m2, 300, 3000], ['count', key, m2, 4000], ['count', { ...key, model: 'x' }, m2, 4000],
    ['count', key, m2, 4000 + 31 * 60_000], ['record', { ...key, wire: 'messages' }, { system: 'z', messages: m2.messages }, 0, 5000],
    ['count', { ...key, wire: 'messages' }, { system: 'z', messages: m2.messages }, 5000],
    ['record', { ...key, wire: 'responses' }, { input: 'abc' }, 50, 6000], ['count', { ...key, wire: 'responses' }, { input: 'abc' }, 6000],
    ['count', { ...key, wire: 'responses' }, { input: null }, 6000],
  ];
  for (const [op, k, body, a, b] of steps) {
    if (op === 'record') { tk.recordUsage({ ...k, body, inputTokens: a, now: b }); calib.push([op, k, body, a, b, null]); }
    else calib.push([op, k, body, 0, a, tk.calibratedCount({ ...k, body, now: a })]);
  }
  const measured = [['messages', { inputTokens: 5, cacheReadTokens: 2, cacheWriteTokens: 3 }], ['chat', { inputTokens: 5, cacheReadTokens: 2, cacheWriteTokens: 3 }], ['chat', null], ['gemini', {}]]
    .map(([w, us]) => [w, us, tk.measuredInputTokens(w, us ?? undefined)]);

  const ftexts = [
    'model gpt-x not found', 'Not Found', 'unknown model', '模型 abc 不存在', 'parameter seed is not supported', 'Unrecognized request argument supplied: store',
    'unknown parameter: top_k', 'extra inputs are not permitted: metadata', 'model does not support this endpoint /responses', 'the model is unsupported on this api',
    'not found: no route for chat/completions', 'unknown url /v1/messages', 'Unsupported value: reasoning_effort high', "thinking.budget_tokens: invalid value",
    'reasoning_effort "xhigh" is not supported; invalid value', 'seed_x unsupported', 'unſupported seed', 'not supported 😀 model endpoint', 'invalid value for reasoning.effort',
    'Model' + 'x'.repeat(70) + ' not found', 'model ' + '😀'.repeat(29) + ' not found', 'model ' + '😀'.repeat(31) + ' not found',
  ];
  const sents = [null, { seed: 1, store: true, metadata: {}, top_k: 2 }, { reasoning_effort: 'xhigh', model: 'o3' }, { thinking: { type: 'enabled', budget_tokens: 100 } }, { reasoning: { effort: 'high' } }, [1]];
  const failures = [];
  for (const st of [400, 404, 405, 422, 500])
    for (const t of ftexts)
      for (const s of sents) {
        failures.push([st, t, s, [], ln.classifyFailure(st, t, s)]);
        failures.push([st, t, s, ['effort', 'budget'], ln.classifyFailure(st, t, s, { applied: ['effort', 'budget'] })]);
      }

  const attempts = [];
  for (const status of [400, 429, 500, 502, 504])
    for (const upstreamStatus of [undefined, 301, 401, 403, 404, 413, 429, 503])
      for (const network of [undefined, true])
        for (const text of [undefined, 'maximum context length exceeded', 'prompt is too long', 'x'])
          attempts.push([{ status, upstreamStatus, network, text, message: text ? undefined : 'context_length_exceeded' }, q.classifyAttemptFailure({ status, upstreamStatus, network, text, message: text ? undefined : 'context_length_exceeded' })]);
  const precommit = [[400, undefined], [429, undefined], [500, 529], [500, 429], [529, undefined], [500, 400]].map(([s, us]) => [s, us ?? null, q.classifyPreCommit({ status: s, upstreamStatus: us })]);
  const streamErr = [['Invalid Tool Call x', ''], ['response blocked', 'x'], ['Prompt Blocked', undefined], ['stream ended before completion', ''], ['ended without any data', 'e'], ['boom', 'overloaded_error'], ['boom', '']]
    .map(([m, t]) => [m, t ?? '', q.classifyStreamError(m, t)]);
  const burst = [[0, 50, 30], [0, 150, 30], [0, 50, 10], [null, 50, 30], [10, 10, 20], [0, 100, 20]].map(([a, b, c]) => [a, b, c, q.isBurst(a ?? undefined, b, c)]);

  const sealedBodies = [
    ['messages', { messages: [{ role: 'assistant', content: [{ type: 'thinking', thinking: 't', signature: 's' }, { type: 'redacted_thinking', data: 'd' }, { type: 'text', text: 'x' }] }] }],
    ['messages', { messages: [{ role: 'assistant', content: 'plain' }, { role: 'user', content: [{ type: 'text', text: 'u' }] }] }],
    ['responses', { input: [{ type: 'reasoning', id: 'r', encrypted_content: 'e', summary: [] }, { type: 'message', role: 'user', content: 'x' }] }],
    ['responses', { input: 'str' }], ['chat', { messages: [{ role: 'assistant', content: 'x', reasoning_content: 'r' }] }],
    ['gemini', { contents: [{ role: 'model', parts: [{ text: 'a', thoughtSignature: 'sig' }, { thought: true, text: 'th' }] }] }],
    ['messages', null], ['messages', { messages: [{ role: 'assistant', content: [{ type: 'text', text: 'x', signature: 'q' }] }] }],
  ];
  const sealed = sealedBodies.map(([w, b]) => [w, b, rs.hasSealedReasoning(w, b), rs.stripSealedReasoning(w, structuredClone(b))]);
  const rejections = [[400, 'Invalid signature in thinking block'], [400, 'encrypted content could not be verified'], [500, 'invalid signature'], [400, 'nope']]
    .map(([s, t]) => [s, t, rs.isReasoningRejection(s, t)]);

  const sk = [];
  const hdrs = [{}, { 'x-claude-code-session-id': 'abc' }, { 'session_id': 'S1' }, { 'x-nomi-tab': 'T' }, { 'conversation_id': 'c' }];
  const skBodies = [...bodies, { metadata: { user_id: 'user_x_account__session_1234-ab' } }, { metadata: { user_id: '{"session_id":"js1"}' } }, { prompt_cache_key: 'pck' }];
  for (const w of ['messages', 'chat', 'responses', 'gemini'])
    for (const h of hdrs)
      for (const b of skBodies)
        for (const c of ['', 'claude', 'codex', 'nomi'])
          for (const hf of [true, false]) sk.push([w, h, b, c, hf, af.sessionKey(w, h, b, c, { hashFallback: hf })]);

  return { estimate, reqTokens, calib, measured, failures, attempts, precommit, streamErr, burst, sealed, rejections, sk };
}
