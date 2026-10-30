#!/usr/bin/env node
/**
 * usage/logParsers parity 录制（源码 esbuild 去类型加载，不依赖 dist）：
 * 仓库夹具（整块 + 按行切块续读）、手写边界用例、确定性变异 fuzz。
 * Go 回放：internal/core/usage/logparsers_parity_test.go。
 */
process.env.TZ = 'America/New_York';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { loadSrc, root } from './usage-src.mjs';

const lp = (await loadSrc('usage/logParsers')).mod;
const cases = [];
const clone = (v) => (v === undefined ? '__undef__' : JSON.parse(JSON.stringify(v)));
const STATEFUL = {
  codex: lp.parseCodexChunk,
  dsh: lp.parseDshChunk,
  grok: lp.parseGrokChunk,
  kimi: lp.parseKimiChunk,
};
const PLAIN = {
  claude: lp.parseClaudeChunk,
  aider: lp.parseAiderChunk,
  qwen: lp.parseQwenChunk,
  rateLimits: lp.parseCodexRateLimits,
};
const runAll = (chunks, initState = {}) => {
  for (const [fn, f] of Object.entries(STATEFUL)) {
    const state = structuredClone(initState);
    const outs = chunks.map((c) => clone(f(c, state)));
    cases.push({ fn, chunks, init: initState, out: outs, state: clone(state) });
  }
  for (const [fn, f] of Object.entries(PLAIN))
    cases.push({ fn, chunks, out: chunks.map((c) => clone(f(c))) });
  const whole = chunks.join('');
  for (const fb of [[], ['/home/u/proj/', 'fb-sess']])
    cases.push({
      fn: 'gemini',
      chunks: [whole],
      fb,
      out: [clone(lp.parseGeminiFile(whole, ...fb))],
    });
};

// ---- 夹具
const fxDir = join(root, 'apps/desktop-electron/internal/core/tests/fixtures/history');
const fixtures = readdirSync(fxDir)
  .sort()
  .map((n) => readFileSync(join(fxDir, n), 'utf8'));
for (const text of fixtures) {
  runAll([text]);
  const ls = text.split('\n');
  const mid = Math.floor(ls.length / 2);
  runAll([ls.slice(0, mid).join('\n') + '\n', ls.slice(mid).join('\n')]);
}
// 分叉：父 + 子拼接
runAll([readFileSync(join(fxDir, 'codex-fork-child.jsonl'), 'utf8')], { sid: 'pre' });

// ---- 手写边界
const J = (...os) => os.map((o) => (typeof o === 'string' ? o : JSON.stringify(o))).join('\n');
const hand = [
  J(
    {
      type: 'assistant',
      sessionId: 's1',
      cwd: '/a/b/',
      timestamp: '2025-03-09T07:30:00Z',
      message: {
        id: 'msg_1',
        model: 'claude-x',
        usage: {
          input_tokens: 5,
          output_tokens: 2,
          cache_creation: { ephemeral_5m_input_tokens: 3, ephemeral_1h_input_tokens: 9 },
          speed: 'fast',
        },
      },
    },
    {
      type: 'assistant',
      sessionId: 's1',
      message: {
        id: 'msg_1',
        model: 'claude-x',
        usage: {
          input_tokens: 7,
          output_tokens: 1,
          cache_creation_input_tokens: 4,
          cache_creation: { ephemeral_1h_input_tokens: 10 },
        },
      },
    },
    {
      type: 'assistant',
      sessionId: 's2',
      requestId: 'r9',
      message: { id: 'chatcmpl-1', model: 'gw', usage: { input_tokens: 1 } },
    },
    {
      type: 'assistant',
      uuid: 'u1',
      message: { model: 'gw', usage: { output_tokens: 1 } },
      timestamp: 1700000000,
    },
    { type: 'assistant', message: { model: '<synthetic>', usage: { input_tokens: 1 } } },
    { type: 'assistant', message: { id: 'z', model: 'm', usage: { input_tokens: 0 } } },
    {
      type: 'assistant',
      message: {
        id: 'x',
        model: 'm',
        usage: { input_tokens: -3, output_tokens: 'nine', cache_read_input_tokens: 4 },
      },
      cwd: 'C:\\w\\proj\\',
    },
    '  {"type":"assistant","message":{"id":"q","model":"m","usage":{"input_tokens":1}}}  ',
    '{broken "usage"',
    '[1,"usage"]',
    '',
  ),
  J(
    {
      type: 'session_meta',
      payload: { id: 'cx1', cwd: '/r/p', model_provider: 'openai', forked_from_id: 'par' },
      timestamp: '2025-01-01T00:00:00.000Z',
    },
    { type: 'response_item', timestamp: '2025-01-01T00:00:00.200Z' },
    {
      type: 'event_msg',
      timestamp: '2025-01-01T00:00:00.300Z',
      payload: {
        type: 'token_count',
        info: {
          last_token_usage: { input_tokens: 10, output_tokens: 1 },
          total_token_usage: { total_tokens: 11 },
        },
      },
    },
    {
      type: 'turn_context',
      payload: { model: 'gpt-5', cwd: '/r/q/' },
      timestamp: '2025-01-01T00:00:05Z',
    },
    {
      type: 'event_msg',
      timestamp: '2025-01-01T00:00:06Z',
      payload: {
        type: 'token_count',
        info: {
          last_token_usage: {
            input_tokens: 10,
            cached_input_tokens: 4,
            cache_write_input_tokens: 1,
            output_tokens: 3,
          },
          total_token_usage: { total_tokens: 24 },
        },
        rate_limits: {
          plan_type: 'plus',
          primary: { used_percent: 120, window_minutes: 300, resets_in_seconds: 60 },
          secondary: { used_percent: -1 },
        },
      },
    },
    {
      type: 'event_msg',
      timestamp: '2025-01-01T00:00:07Z',
      payload: {
        type: 'token_count',
        info: { last_token_usage: { input_tokens: 10 }, total_token_usage: { total_tokens: 24 } },
        rate_limits: { primary: { used_percent: 5, resets_at: 1735700000 } },
      },
    },
    {
      type: 'event_msg',
      timestamp: '2024-12-31T00:00:07Z',
      payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 2 } } },
    },
    {
      type: 'event_msg',
      payload: { type: 'token_count', info: { last_token_usage: { output_tokens: 2 } } },
    },
    { type: 'session_meta', payload: { session_id: 'other', cwd: '/x' } },
  ),
  J(
    { type: 'session', id: 'd1', cwd: '/w/dd' },
    { type: 'request/context', data: { model: 'ds', provider: 'p' } },
    {
      type: 'assistant/message',
      seq: 3,
      time: '2025-06-01T10:00:00Z',
      data: { usage: { inputTokens: 4, outputTokens: 1, cacheReadTokens: 2, cacheWriteTokens: 1 } },
    },
    { type: 'assistant/message', time: 1750000000000, data: { usage: { outputTokens: 1 } } },
    { type: 'assistant/message', data: {} },
  ),
  J(
    {
      params: {
        sessionId: 'g1',
        update: {
          sessionUpdate: 'turn_completed',
          prompt_id: 'p1',
          usage: {
            inputTokens: 10,
            cachedReadTokens: 3,
            cacheWriteTokens: 2,
            outputTokens: 4,
            modelUsage: { unknown: {}, 'grok-4.7-build': {} },
          },
        },
      },
      timestamp: '2025-02-02T02:02:02Z',
    },
    { sessionUpdate: 'turn_completed', usage: { inputTokens: 1, cacheReadTokens: 5 }, seq: 9 },
    {
      sessionUpdate: 'turn_completed',
      model: 'unknown',
      usage: { outputTokens: 2 },
      time: 1700000000000,
      _meta: { promptId: 'x' },
    },
    {
      params: {
        _meta: { promptId: 'pm' },
        update: {
          sessionUpdate: 'turn_completed',
          model: 'grok-z',
          timestamp: '2025-02-02',
          usage: { outputTokens: 1 },
        },
      },
    },
    { sessionUpdate: 'agent_message', model: 'grok-y' },
    { sessionUpdate: 'turn_completed' },
  ),
  J(
    { sessionId: 'gm', lastUpdated: '2025-04-04T04:04:04Z' },
    {
      type: 'gemini',
      id: 'm1',
      model: 'gemini-2.5',
      tokens: { input: 10, cached: 4, tool: 2, output: 3, thoughts: 1 },
    },
    { type: 'user', id: 'u' },
    { type: 'gemini', tokens: { input: 1 } },
    {
      type: 'model',
      id: 'm1',
      timestamp: '2025-04-05T00:00:00Z',
      tokens: { input: 20, output: 1 },
    },
    {
      messages: [
        { id: 'm2', type: 'gemini', tokens: { output: 5 } },
        { type: 'model', tokens: { cached: 3 } },
        'junk',
      ],
    },
  ),
  JSON.stringify({
    sessionId: 'old',
    lastUpdated: 1714000000,
    messages: [
      { type: 'gemini', tokens: { input: 3 } },
      { type: 'model', id: 'k', model: 'g', timestamp: 'bad', tokens: { output: 2 } },
    ],
  }),
  J(
    {
      event: 'message_send',
      time: 1712000000,
      properties: { prompt_tokens: 100, completion_tokens: 20, main_model: 'gpt-4o' },
    },
    { event: 'message_send', properties: { prompt_tokens: 1.5 } },
    { event: 'other' },
  ),
  J(
    {
      type: 'assistant',
      uuid: 'q1',
      model: 'qwen3',
      sessionId: 'qs',
      cwd: '/z/',
      timestamp: '2025-05-05T05:05:05+08:00',
      usageMetadata: {
        promptTokenCount: 10,
        cachedContentTokenCount: 4,
        toolUsePromptTokenCount: 1,
        candidatesTokenCount: 2,
        thoughtsTokenCount: 3,
      },
    },
    { type: 'assistant', uuid: 'q1', usageMetadata: { promptTokenCount: 30 } },
    { type: 'assistant', usageMetadata: { promptTokenCount: 30 } },
  ),
  J(
    { type: 'llm.request', modelAlias: 'moonshot/kimi-k2' },
    {
      type: 'step.end',
      messageId: 'k1',
      time: 1760000000000,
      usage: { inputOther: 5, output: 2, inputCacheRead: 1, inputCacheCreation: 1 },
    },
    {
      type: 'context.append_loop_event',
      time: 1760000000001,
      event: {
        type: 'step.end',
        uuid: 'k2',
        usage: { input_tokens: 10, input_tokens_details: { cached_tokens: 4 }, output_tokens: 1 },
      },
    },
    {
      type: 'context.append_loop_event',
      event: {
        type: 'step.end',
        uuid: 'k3',
        time: 1760000000002,
        usage: { input_tokens: 10, cache_read_input_tokens: 4, cache_creation_input_tokens: 2 },
      },
    },
    {
      timestamp: 1700000000,
      message: {
        type: 'StatusUpdate',
        payload: {
          message_id: 'k4',
          token_usage: { input_other: 3, output: 1, input_cache_read: null },
        },
      },
    },
    { type: 'step.end', messageId: 'k1', time: 1760000000000, usage: { inputOther: 9 } },
    { type: 'step.end', messageId: 'k5', usage: { inputOther: 9 } },
    { type: 'config.update', model: 'plain' },
  ),
  J(
    { type: 'session_meta', timestamp: 1735689600000, payload: { id: 'fk', forked_from_id: 'p' } },
    {
      type: 'event_msg',
      timestamp: 1735689601000,
      payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 3 } } },
    },
    {
      type: 'event_msg',
      timestamp: 1735689599500,
      payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 4 } } },
    },
    {
      type: 'event_msg',
      timestamp: 1735689598000,
      payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 5 } } },
    },
  ),
  J(
    {
      type: 'event_msg',
      timestamp: 1735689600000,
      payload: { type: 'token_count', rate_limits: { primary: { used_percent: 130 } } },
    },
    {
      type: 'event_msg',
      timestamp: 1735689600000,
      payload: {
        type: 'token_count',
        rate_limits: { plan_type: 'pro', secondary: { used_percent: 140, window_minutes: 10080 } },
      },
    },
  ),
  J({
    sessionUpdate: 'turn_completed',
    usage: { outputTokens: 1, modelUsage: { '': {}, 'grok-k': {} } },
  }),
];
for (const h of hand) runAll([h]);
runAll([hand[1]], { sid: 'pre', forked: true, replay: true });
runAll([hand[3]], { model: 'carried', cwd: '/c/d' });
runAll([hand[3]], { model: 'unknown' });

// ---- fuzz：对夹具与手写行做确定性变异
let seed = 20261029;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const pick = (a) => a[Math.floor(rnd() * a.length)];
const VALS = [
  null,
  0,
  -1,
  1,
  2.5,
  1e12,
  999999999999,
  '',
  'x',
  '2025-03-09T02:30:00',
  'msg_9',
  true,
  [],
  {},
  'unknown',
  'turn_completed',
  'token_count',
  'assistant',
  'gemini',
  'step.end',
];
const mutate = (v, depth = 0) => {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const o = { ...v };
    for (const k of Object.keys(o)) {
      const r = rnd();
      if (r < 0.08) delete o[k];
      else if (r < 0.16) o[k] = pick(VALS);
      else if (depth < 6) o[k] = mutate(o[k], depth + 1);
    }
    return o;
  }
  if (typeof v === 'number' && rnd() < 0.1) return pick([0, -v, v * 2, v + 0.5]);
  return v;
};
const allLines = [...fixtures, ...hand]
  .flatMap((t) => t.split('\n'))
  .filter((l) => l.trim().startsWith('{'));
for (let i = 0; i < 60; i++) {
  const ls = [];
  for (let j = 0; j < 8; j++) {
    try {
      ls.push(JSON.stringify(mutate(JSON.parse(pick(allLines)))));
    } catch {
      ls.push(pick(allLines));
    }
  }
  runAll(
    [ls.slice(0, 4).join('\n') + '\n', ls.slice(4).join('\n')],
    i % 3 ? {} : { sid: 'f', forked: true, replay: true, forkTs: 1735689600000 },
  );
}

// ---- SQLite 行
const ocRows = [
  {
    id: 'o1',
    session_id: 's',
    created: 1730000000000,
    model: 'm',
    provider: 'p',
    input: 3,
    output: 1,
    reasoning: 2,
    cache_read: 1,
    cache_write: 1,
    cwd: '/a/b',
  },
  { id: 'o2', created: 1730000000, input: 1 },
  { id: 'o3', created: 0, input: 1 },
  { id: '', input: 1 },
  { id: 'o4', created: 5, input: -1 },
  { id: 'o5', created: 'x', output: 4, cwd: '/' },
  {},
];
for (const r of ocRows)
  cases.push({ fn: 'opencode', row: r, out: [clone(lp.opencodeRowToRecord(r))] });
const cpRows = [
  {
    id: 7,
    session_id: 's',
    model: 'c',
    input_tokens: 10,
    output_tokens: 2,
    cache_read_tokens: 4,
    cache_write_tokens: 9,
    created_at: '1730000000',
  },
  {
    id: 8,
    session_id: 's',
    input_tokens: 10,
    cache_read_tokens: 20,
    created_at: '2025-01-01T00:00:00Z',
  },
  { id: 9, session_id: 's', output_tokens: 1, created_at: 1730000000000 },
  { id: 10, session_id: 's', output_tokens: 1, created_at: 'nope' },
  { id: 0, session_id: 's', output_tokens: 1 },
  { id: 11, output_tokens: 1 },
  { id: 12, session_id: 's', created_at: '5' },
];
for (const r of cpRows)
  cases.push({ fn: 'copilot', row: r, out: [clone(lp.copilotRowToRecord(r))] });
cases.push({ fn: 'LOG_SOURCES', out: [clone(lp.LOG_SOURCES)] });

const outDir =
  process.env.NOMI_GOLDEN_DIR || join(root, 'apps/desktop-go/internal/core/usage/testdata');
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'usage-logparsers.json'), JSON.stringify({ cases }, null, 1) + '\n');
console.log(`usage-logparsers: ${cases.length} cases`);
