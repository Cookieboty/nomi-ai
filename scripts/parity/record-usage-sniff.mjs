#!/usr/bin/env node
/**
 * sniff.ts parity 录制：真实源码（esbuild 去类型）。usageFromObject 片段（按 JSON 比较）、
 * mergeUsage / SseUsageTap 结果（JSON.stringify 逐字节）。Go 回放：internal/core/usage/sniff_parity_test.go。
 * Usage: node scripts/parity/record-usage-sniff.mjs
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadSrc, root } from './usage-src.mjs';

const { usageFromObject, mergeUsage, SseUsageTap, emptySniffed, hasTokens } = (await loadSrc('usage/sniff', {})).mod;

const objs = [
  null, 5, 'x', [], [{ usage: {} }], {},
  { usageMetadata: { promptTokenCount: 100, cachedContentTokenCount: 30, candidatesTokenCount: 7, thoughtsTokenCount: 3 }, modelVersion: 'gemini-2.5-pro' },
  { response: { usageMetadata: { promptTokenCount: 10, cachedContentTokenCount: 30 } }, modelVersion: 5 },
  { usageMetadata: [], usage: { prompt_tokens: 3 } },
  { type: 'message_start', message: { id: 'msg_1', model: 'claude-x', usage: { input_tokens: 12, cache_read_input_tokens: 4, cache_creation_input_tokens: 0, cache_creation: { ephemeral_5m_input_tokens: 2, ephemeral_1h_input_tokens: 6 }, output_tokens: 1 } } },
  { message: { id: '', model: '' }, model: '', id: 'top', usage: { input_tokens: 1, cache_creation_input_tokens: 5, cache_creation: { ephemeral_1h_input_tokens: 9 }, speed: 'fast' } },
  { usage: { input_tokens: -5, output_tokens: Infinity, cache_read_input_tokens: '3' } },
  { usage: { input_tokens: 50, input_tokens_details: { cached_tokens: 80 }, output_tokens: 9 }, response: { id: 'resp_1', model: 'gpt-5' } },
  { response: { id: 'resp_2', model: 'gpt-5', usage: { input_tokens: 50, input_tokens_details: { cached_tokens: 20 }, output_tokens: 9 } } },
  { usage: { input_tokens: 50, input_tokens_details: {}, cache_read_input_tokens: 1 } },
  { type: 'message_delta', usage: { output_tokens: 33, speed: 'fast' } },
  { usage: { output_tokens: 33, speed: 'slow' }, model: 'm', id: 'i' },
  { id: 'chatcmpl-1', model: 'gpt-4o', usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 40 } } },
  { usage: { input_tokens: 5, output_tokens: 2, speed: 'fast' } },
  { id: 'top', message: { id: 'mid' }, response: { id: 'rid' }, usage: { prompt_tokens: 1 } },
  { usage: { completion_tokens: 2 } }, { usage: { total_tokens: 2 } }, { usage: 5 }, { usage: [1] },
  { message: { usage: { prompt_tokens: 1 } }, response: { usage: { prompt_tokens: 2 } } },
];
const frags = objs.map((o) => usageFromObject(o) ?? '__null__');

const merges = [
  [emptySniffed(), { input: 3, output: 0, cacheRead: 0, cacheWrite: 10, cacheWrite1h: 20, model: 'a', id: 'x' }],
  [{ input: 5, output: 1, cacheRead: 2, cacheWrite: 10, model: 'a', id: 'first', cacheWrite1h: 4 }, { input: 0, output: 9, cacheRead: 3, cacheWrite: 0, model: '', id: 'second', fast: true }],
  [{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, model: '' }, { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 }],
  [{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, fast: true }, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, model: 'b' }],
].map(([a, b]) => JSON.stringify(mergeUsage(a, b)));

const ev = (o) => `data: ${JSON.stringify(o)}\n\n`;
const anth = ev({ type: 'message_start', message: { id: 'msg_9', model: 'claude-y', usage: { input_tokens: 20, cache_read_input_tokens: 5, cache_creation_input_tokens: 8, cache_creation: { ephemeral_1h_input_tokens: 8 }, output_tokens: 1 } } }) +
  'event: ping\ndata: {"type":"ping"}\n\n' + ev({ type: 'message_delta', usage: { output_tokens: 40, speed: 'fast' } }) + 'data: [DONE]\n';
const split = (s, n) => { const out = []; for (let i = 0; i < s.length; i += n) out.push(s.slice(i, i + n)); return out; };
const taps = [
  [anth], [anth, 7], [anth, 1],
  [ev({ id: 'c1', model: 'gpt', usage: null }) + ev({ id: 'c1', model: 'gpt', usage: { prompt_tokens: 9, completion_tokens: 4 } }).trimEnd()],
  ['  data:{"usageMetadata":{"promptTokenCount":4}}  \r\n', 'data: not json\n', 'data:\n', 'data:   \ufeff\u00a0{"usage":{"output_tokens":2}}\u3000'],
  ['x'.repeat(4 * 1024 * 1024 + 1), 'data: {"usage":{"output_tokens":5}}\n'],
  ['é'.repeat(3 * 1024 * 1024), 'data: {"usage":{"output_tokens":6}}\n'],
  ['data: {"usage":{"output_tokens":7}}'],
].map((spec) => {
  // spec: [text, n] = 按 n 个 UTF-16 单元切块；[{rep, n}, tail] = 大块（Go 侧重建）；否则 = 块列表
  let chunks = spec, rec = { chunks: spec };
  if (typeof spec[1] === 'number') { chunks = split(spec[0], spec[1]); rec = { text: spec[0], n: spec[1] }; }
  else if (spec[0].length > 1e5) rec = { rep: spec[0][0], n: spec[0].length, tail: spec[1] };
  const t = new SseUsageTap(); for (const c of chunks) t.push(c); const r = t.end();
  return { ...rec, r: JSON.stringify(r), has: hasTokens(r) };
});

const out = join(root, 'apps/desktop-go/internal/core/usage/testdata/usage-sniff.json');
writeFileSync(out, JSON.stringify({ objs, frags, merges, taps }, null, 1) + '\n');
console.log(`usage-sniff: ${objs.length} objs, ${merges.length} merges, ${taps.length} taps`);
