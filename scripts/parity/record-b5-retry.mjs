// Records ai's retryWithExponentialBackoffRespectingRetryHeaders behaviour
// (delays requested + final error) for Go llm.Retry parity.
// Run: node scripts/parity/record-b5-retry.mjs
import { writeFileSync } from 'node:fs';
import { generateText } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { APICallError } from '@ai-sdk/provider';

const api = (status, headers, retryable) => new APICallError({
  message: `HTTP ${status}`, url: 'http://x/v1', requestBodyValues: {}, statusCode: status,
  responseHeaders: headers, isRetryable: retryable ?? (status === 429 || status >= 500),
});
const OK = { content: [{ type: 'text', text: 'ok' }], finishReason: { unified: 'stop', raw: 'stop' },
  usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } }, warnings: [] };
// step: {status, headers?, retryable?} | {plain:'msg'} | 'ok'
const S = [
  ['exhausted-default', undefined, [{ status: 500 }, { status: 500 }, { status: 500 }]],
  ['exhausted-3', 3, [{ status: 503 }, { status: 503 }, { status: 503 }, { status: 503 }]],
  ['no-retries', 0, [{ status: 500 }]],
  ['ok-after-two', undefined, [{ status: 429 }, { status: 500 }, 'ok']],
  ['retry-after-ms', undefined, [{ status: 429, headers: { 'retry-after-ms': '150' } }, 'ok']],
  ['retry-after-ms-zero', undefined, [{ status: 429, headers: { 'retry-after-ms': '0' } }, 'ok']],
  ['retry-after-ms-float', undefined, [{ status: 429, headers: { 'retry-after-ms': '12.5abc' } }, 'ok']],
  ['retry-after-s', undefined, [{ status: 429, headers: { 'retry-after': '3' } }, 'ok']],
  ['retry-after-both', undefined, [{ status: 429, headers: { 'retry-after-ms': '40', 'retry-after': '9' } }, 'ok']],
  ['retry-after-ms-nan-fallback', undefined, [{ status: 429, headers: { 'retry-after-ms': 'abc', 'retry-after': '1.5' } }, 'ok']],
  ['retry-after-too-long', undefined, [{ status: 429, headers: { 'retry-after-ms': '70000' } }, 'ok']],
  ['retry-after-long-but-below-backoff', 6, [{ status: 500 }, { status: 500 }, { status: 500 }, { status: 500 }, { status: 500 }, { status: 429, headers: { 'retry-after-ms': '61000' } }, 'ok']],
  ['retry-after-negative', undefined, [{ status: 429, headers: { 'retry-after-ms': '-5' } }, 'ok']],
  ['retry-after-garbage', undefined, [{ status: 429, headers: { 'retry-after': 'soon' } }, 'ok']],
  ['non-retryable-first', undefined, [{ status: 400 }]],
  ['retryable-then-non-retryable', undefined, [{ status: 500 }, { status: 401 }]],
  ['retryable-flag-false-500', undefined, [{ status: 500, retryable: false }]],
  ['plain-error', undefined, [{ plain: 'boom' }]],
  ['plain-after-retry', undefined, [{ status: 502 }, { plain: 'boom' }]],
];

const realST = globalThis.setTimeout;
const out = [];
for (const [name, maxRetries, steps] of S) {
  const delays = [];
  globalThis.setTimeout = (fn, ms, ...a) => { delays.push(ms); return realST(fn, 0, ...a); };
  let i = 0;
  const model = new MockLanguageModelV4({ doGenerate: async () => {
    const st = steps[i++];
    if (st === 'ok') return OK;
    if (st.plain) throw new Error(st.plain);
    throw api(st.status, st.headers, st.retryable);
  } });
  let result, error;
  try {
    const r = await generateText({ model, prompt: 'x', ...(maxRetries === undefined ? {} : { maxRetries }) });
    result = r.text;
  } catch (e) {
    error = { name: e.name, message: e.message, reason: e.reason,
      errors: e.errors?.map((x) => ({ name: x.name, message: x.message, statusCode: x.statusCode })),
      statusCode: e.statusCode };
  }
  globalThis.setTimeout = realST;
  out.push({ name, maxRetries, steps, calls: i, delays, result, error });
}
writeFileSync(new URL('../../apps/desktop-go/internal/ai/llm/testdata/b5-retry.json', import.meta.url), JSON.stringify(out, null, 1) + '\n');
console.log(out.map((o) => `${o.name}: calls=${o.calls} delays=${JSON.stringify(o.delays)} ${o.error ? o.error.name + ':' + (o.error.reason ?? '') : o.result}`).join('\n'));
