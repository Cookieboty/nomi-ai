#!/usr/bin/env node
/**
 * 批次 7 golden 录制：@nomi-ai/cli-plugins 流解析器（claude / codex / grok / dsh）。
 * 语料：b7-stream-corpus.jsonl（由 b7-capture.cjs 在 streamParse / contextUsage 单测里采集）
 *      + core 单测 fixtures + 下方手写边界行。每个解析器实例独立回放，逐行记录输出。
 * 不注入宿主翻译：t() 走 cli-sdk 回退（Go clisdk.T 同款）。
 * Go 侧 apps/desktop-go/internal/cliplugins/parity_test.go 逐字节比对（JSON.stringify）。
 * Usage: (先 build packages/cli-sdk、cli-plugins) node scripts/parity/record-b7.mjs
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const req = createRequire(join(root, 'packages/core/package.json'));
const P = req('@nomi-ai/cli-plugins/main');

const streams = new Map();
const add = (fn, id, line) => {
  if (!streams.has(id)) streams.set(id, { fn, id, lines: [] });
  streams.get(id).lines.push(line);
};
for (const l of readFileSync(join(here, 'b7-stream-corpus.jsonl'), 'utf8').split('\n')) {
  if (!l) continue;
  const o = JSON.parse(l);
  add(o.fn, o.id, o.line);
}
const fx = (f) =>
  readFileSync(join(root, 'packages/core/tests/unit/cli/fixtures', f), 'utf8').split('\n').filter(Boolean);
for (const fn of ['createClaudeParser', 'parseClaudeLine+state']) {
  for (const l of fx('claude-tasks.jsonl')) add(fn, `fx-claude-${fn}`, l);
}
for (const l of fx('codex-collab.jsonl')) add('parseCodexLine+seq', 'fx-codex', l);

const J = JSON.stringify;
const edge = {
  claude: [
    'not json', '{bad', '  {"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}  ',
    J({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] } }),
    J({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'x'.repeat(7000), is_error: true }] } }),
    J({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'hmm 中文 😀' }] } }),
    J({ type: 'result', result: 'final', session_id: 's1', total_cost_usd: 0.12, duration_ms: 5, usage: { input_tokens: 10, output_tokens: 3, cache_read_input_tokens: 2 } }),
    J({ type: 'result', is_error: true, subtype: 'error_max_turns' }),
    J({ type: 'system', subtype: 'init', session_id: 's9', model: 'opus' }),
  ],
  codex: [
    J({ type: 'item.completed', item: { type: 'agent_message', text: 'done' } }),
    J({ type: 'item.started', item: { type: 'command_execution', id: 'c1', command: 'ls -la' } }),
    J({ type: 'item.completed', item: { type: 'command_execution', id: 'c1', command: 'ls', aggregated_output: 'a\nb', exit_code: 1 } }),
    J({ type: 'item.completed', item: { type: 'web_search', id: 'w1' } }),
    J({ type: 'item.completed', item: { type: 'reasoning', text: 'think' } }),
    J({ type: 'turn.completed', usage: { input_tokens: 5, cached_input_tokens: 1, output_tokens: 2 } }),
    J({ type: 'thread.started', thread_id: 'th1' }), J({ type: 'error', message: 'boom' }), J({ type: 'turn.failed', error: { message: 'x' } }),
  ],
  grok: [
    J({ type: 'text', data: 'hello' }), J({ type: 'thought', text: 'th' }),
    J({ type: 'tool_call', toolCallId: 'g1', title: 'read_file', rawInput: { path: '/a' } }),
    J({ type: 'tool_call_update', toolCallId: 'g1', status: 'in_progress' }),
    J({ type: 'tool_call_update', toolCallId: 'g1', status: 'completed', rawOutput: 'ok' }),
    J({ type: 'tool_call', toolCallId: 'g2', toolName: 'generate_image', status: 'failed', output: 'nope' }),
    J({ type: 'usage', usage: { inputTokens: 4, outputTokens: 1 }, cost: 0.5 }), J({ type: 'usage' }),
    J({ type: 'end', text: 'bye', sessionId: 'gs' }), J({ type: 'error' }), J({ type: 'plan' }),
  ],
  dsh: [
    J({ type: 'session', sessionId: 'd1' }), J({ type: 'session' }), J({ type: 'text', text: 't' }),
    J({ type: 'thinking', text: 'z' }),
    J({ type: 'tool_call', tool: 'subagent', callId: 'k1', input: { description: 'line1\nline2', run_in_background: true } }),
    J({ type: 'status', phase: 'step_end', usage: { inputTokens: 3, outputTokens: 2, cacheReadTokens: 1 } }),
    J({ type: 'tool_result', tool: 'x', callId: 'k1', status: 'error', result: 'r'.repeat(2500) }),
    J({ type: 'tool_call', tool: 'subagent_fork', callId: 'k2', input: 'plain' }),
    J({ type: 'status', phase: 'step_end', usage: { totalTokens: 50 } }),
    J({ type: 'tool_result', callId: 'k2', result: 'fine' }),
    J({ type: 'final', text: 'all done' }),
    J({ type: 'status', phase: 'turn_end', reason: { kind: 'error', error: { message: 'bad' } } }),
    J({ type: 'status', phase: 'turn_end', reason: { kind: 'error' } }), J({ type: 'error' }),
  ],
};
for (const [cli, lines] of Object.entries(edge)) {
  const C = cli[0].toUpperCase() + cli.slice(1);
  for (const l of lines) add(`parse${C}Line`, `edge-${cli}-line`, l);
  const fn = cli === 'codex' ? 'parseCodexLine+seq' : `create${C}Parser`;
  for (const l of lines) add(fn, `edge-${cli}-stream`, l);
}

const out = [];
for (const s of streams.values()) {
  let run;
  if (s.fn.startsWith('create')) run = P[s.fn]();
  else if (s.fn.endsWith('+state')) {
    const st = {};
    const base = P[s.fn.replace('+state', '')];
    run = (l) => base(l, st);
  } else run = P[s.fn.replace('+seq', '')];
  out.push({ ...s, outputs: s.lines.map((l) => run(l)) });
}
mkdirSync(join(root, 'apps/desktop-go/internal/cliplugins/testdata'), { recursive: true });
writeFileSync(join(root, 'apps/desktop-go/internal/cliplugins/testdata/streams.json'), JSON.stringify(out, null, 1) + '\n');
console.log(`streams=${out.length} lines=${out.reduce((n, s) => n + s.lines.length, 0)}`);
