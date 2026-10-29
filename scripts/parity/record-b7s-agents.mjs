#!/usr/bin/env node
/**
 * 批次 7s：agents/parsers.ts 纯函数 golden（会话解析 + decideStatus + dsh projcache）。
 * 输出 apps/desktop-go/internal/core/agents/testdata/b7s-parsers.json：[{fn,args,out}]，
 * out 为 {v}（键排序、undefined 字段省略）或 {err,name}。CI 由 record-b7-drivers.mjs 链式录制（NOMI_GOLDEN_DIR）。
 * Usage: node --import tsx scripts/parity/record-b7s-agents.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');
const P = await import(pathToFileURL(path.join(root, 'packages/core/src/agents/parsers.ts')).href);

const sortKeys = (v) =>
  Array.isArray(v) ? v.map(sortKeys) : v && typeof v === 'object'
    ? Object.fromEntries(Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => [k, sortKeys(v[k])])) : v;
const cases = [];
const add = (fn, ...args) => {
  let out;
  try {
    const r = P[fn](...args);
    out = r === undefined ? { undef: true } : { v: sortKeys(r) };
  } catch (e) {
    out = { err: String(e?.message ?? e), ...(e?.name && e.name !== 'Error' ? { name: e.name } : {}) };
  }
  cases.push({ fn, args, out });
};
const J = JSON.stringify;
const L = (...xs) => xs.map((x) => (typeof x === 'string' ? x : J(x))).join('\n');
const T = '2025-01-02T03:04:05.678Z';
const T2 = '2025-01-02T03:09:05Z';

/* ---------------- jsonlEvents ---------------- */
add('jsonlEvents', '\uFEFF{"a":1}\r\n  {"b":2}\nnope\n{bad\n[1]\n{"c":3}', 400);
add('jsonlEvents', L({ a: 1 }, { a: 2 }, { a: 3 }), 2);
add('jsonlEvents', '', 400);

/* ---------------- Claude ---------------- */
const cHead = L(
  { type: 'system', sessionId: 'sid-1', cwd: '/w', model: 'top-model', permissionMode: 'plan' },
  { type: 'user', isMeta: true, message: { content: 'meta' } },
  { type: 'user', message: { content: [{ type: 'tool_result', content: 'x' }] } },
  { type: 'user', message: { content: [{ type: 'image' }, { type: 'text', text: '  Fix   the\nbug please  ' }], model: 'm1', effort: 'high' } },
);
add('parseClaudeSession', cHead, L({ type: 'assistant', timestamp: T, message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'done!' }] } }));
add('parseClaudeSession', L({ type: 'summary', summary: 'Sum title' }, { isSidechain: true, sessionId: 'side' }), L({ type: 'assistant', timestamp: 1735787045, message: { content: [{ type: 'tool_use', name: 'Bash' }] } }));
add('parseClaudeSession', '', L({ type: 'assistant', message: { stop_reason: 'tool_use', content: [] } }));
add('parseClaudeSession', '', L({ type: 'assistant', message: { stop_reason: null } }, { type: 'system' }));
add('parseClaudeSession', '', L({ type: 'assistant', isApiErrorMessage: true, message: { content: 'API Error: 500 '.repeat(20) } }));
add('parseClaudeSession', '', L({ type: 'assistant', message: { model: '<synthetic>', content: [{ type: 'text', text: 'synthetic' }] } }));
add('parseClaudeSession', '', L({ type: 'assistant', message: { stop_reason: 'max_tokens' } }, { type: 'file-history-snapshot' }));
add('parseClaudeSession', '', L({ type: 'result', subtype: 'success', result: 'ok', timestamp: T, sessionId: 'r' }));
add('parseClaudeSession', '', L({ type: 'result', subtype: 'error_max_turns', error: 'boom' }));
add('parseClaudeSession', '', L({ type: 'result', is_error: true }));
add('parseClaudeSession', '', L({ type: 'user', timestamp: T, message: { content: [{ type: 'tool_result' }] } }));
add('parseClaudeSession', '', L({ type: 'user', timestamp: 'bad', message: { content: '[Request interrupted by user for tool use]' } }));
add('parseClaudeSession', '', L({ type: 'user' }));
add('parseClaudeSession', '', L({ type: 'progress', timestamp: T }, { type: 'assistant' }));
add('parseClaudeSession', '', L({ type: 'tool_result' }));
add('parseClaudeSession', '', L({ type: 'user', message: { content: [null] } }));
add('parseClaudeSession', L({ type: 'user', message: { content: [{ type: 'input_text', text: '<command-name>/clear</command-name>' }] } }), '');
add('parseClaudeSession', L({ type: 'user', message: 'str' }, { type: 'user', message: { content: 'second' } }), L({ type: ['result'] }));
add('parseClaudeSession', '', L({ type: 'system', message: { model: 'tail-model', effort: 'low', permissionMode: 'default' }, perTurnEffort: 'max' }));

/* ---------------- Codex ---------------- */
const meta = (payload) => ({ type: 'session_meta', timestamp: T, payload: { id: 'cx', cwd: '/c', model: 'gpt-5', ...payload } });
add('parseCodexSession', L(meta({ reasoning_effort: 'high', sandbox_policy: { type: 'workspace-write' }, approval_policy: 'on-request' }),
  { type: 'event_msg', payload: { type: 'user_message', message: 'hello codex' } }),
  L({ type: 'event_msg', timestamp: T2, payload: { type: 'task_complete', last_agent_message: 'All done' } }, { type: 'event_msg', payload: { type: 'token_count' } }));
for (const sb of ['danger-full-access', 'DangerFullAccess', 'read_only', 'readonly', 'workspace write', 'custom-mode', '']) add('parseCodexSession', L(meta({ sandbox_policy: sb })), '');
add('parseCodexSession', L(meta({ sandboxPolicy: { mode: 'workspace-write' }, approvalPolicy: 'never' })), '');
add('parseCodexSession', L(meta({ sandbox_mode: { type: '' }, approval_policy: 'on_request' })), '');
add('parseCodexSession', L(meta({ permission_mode: 'explicit', sandbox_policy: 'read-only' })), '');
add('parseCodexSession', L(meta({ sandbox_policy: [1] , approvalPolicy: 'untrusted' })), '');
add('parseCodexSession', L({ id: 'old-format', timestamp: T, instructions: '' }, { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>x</environment_context>' }] } },
  { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'real q' }] } }), '');
add('parseCodexSession', L({ type: 'thread.started', thread_id: 'th' }, { type: 'turn_context', payload: { model: 'ctx-model', cwd: '/ctx', effort: 'minimal' } }), '');
for (const pt of ['error', 'stream_error', 'turn_aborted', 'exec_command_begin', 'patch_apply_begin', 'mcp_tool_call_begin', 'task_started', 'user_message', 'agent_reasoning', 'agent_message', 'other'])
  add('parseCodexSession', '', L({ type: 'response_item', payload: { type: 'message' } }, { type: 'event_msg', timestamp: T, payload: { type: pt, message: 'msg ' + pt, reason: 'why' } }));
add('parseCodexSession', '', L({ type: 'event_msg', payload: { type: 'turn_aborted', reason: 'interrupted' } }));
for (const pt of ['function_call', 'local_shell_call', 'custom_tool_call', 'reasoning']) add('parseCodexSession', '', L({ type: 'response_item', timestamp: 1735787045678, payload: { type: pt, name: pt === 'custom_tool_call' ? 'apply_patch' : undefined } }));
for (const t of ['turn.failed', 'error', 'turn.completed', 'turn.started', 'item.started', 'item.completed', 'thread.started', 'weird'])
  add('parseCodexSession', '', L({ type: t, message: t === 'error' ? undefined : 'm', error: { message: 'inner' } }));
add('parseCodexSession', '', L({ type: 'turn_context', payload: { model: 'late', sandbox_policy: 'workspace-write', approval_policy: 'on-request' } }, { type: 'compacted' }));

/* ---------------- Grok ---------------- */
add('parseGrokSession', L(
  { method: 'session/update', params: { sessionId: 'g1', cwd: '/g', update: { sessionUpdate: 'user_message', prompt: 'grok question', timestamp: T } } },
  { params: { update: { usage: { modelUsage: { unknown: {}, 'grok-4': {} } }, reasoningEffort: 'high', currentModeId: 'auto' } } },
  { sessionUpdate: 'turn_completed', time: T2 },
  { usage: { model: 'u-model' }, timestamp: 0 },
), 'fallback');
add('parseGrokSession', L({ params: null, sessionId: 'top', prompt: 'top prompt', model: 'top-m', currentModeId: 'plan' }, { params: 'str', usage: { modelUsage: 'ab' } }), undefined);
add('parseGrokSession', L({ update: { userMessage: '  ' }, usage: { modelUsage: { 2: 1, 1: 1, b: 1 } } }, { params: { update: { sessionUpdate: 'turn_completed' } } }), 'fb');
add('parseGrokSession', '', undefined);
add('parseGrokSession', L({ usage: { modelUsage: { unknown: {}, '': {}, 'grok-code': {} } }, prompt: 'A long grok prompt that definitely exceeds the eighty character title limit for sure ok', timestamp: 1e12 }), 'fb');
add('parseGrokSession', L({ usage: { modelUsage: { unknown: {} } }, timestamp: 1e12 + 1 }), 'fb');

/* ---------------- Gemini ---------------- */
const gem = (o) => J({ sessionId: 'gm', lastUpdated: T2, ...o });
add('parseGeminiSession', gem({ summary: 'Gem summary', messages: [
  { type: 'user', content: [{ text: 'first q' }] },
  { type: 'gemini', model: 'gemini-2.5-pro', thinkingConfig: { thinkingLevel: 'HIGH' }, approvalMode: 'yolo', content: 'answer', timestamp: T } ] }));
add('parseGeminiSession', gem({ messages: [{ type: 'user', content: 'q' }, { type: 'model', content: [{ text: 'a' }], toolCalls: [{ result: [] }, { status: 'error' }] }] }));
add('parseGeminiSession', gem({ messages: [{ type: 'gemini', toolCalls: [{ result: [] }, { status: 'pending' }], metadata: { model: 'meta-m' }, reasoning_effort: 'low', permission_mode: 'auto' }] }));
add('parseGeminiSession', gem({ messages: [{ type: 'gemini', toolCalls: [null] }] }));
add('parseGeminiSession', gem({ messages: [{ type: 'gemini', toolCalls: [{ status: 'x' }, null] }] }));
add('parseGeminiSession', gem({ messages: [{ type: 'error', content: 'e', modelName: 'mn', effort: 'e1', thinkingConfig: { effort: 'te' }, mode: 'm' }] }));
add('parseGeminiSession', gem({ messages: [{ type: 'info', content: 'i', reasoning: 'r', thinkingConfig: { thinking_level: 'tl' } }] }));
add('parseGeminiSession', gem({ messages: [] }));
add('parseGeminiSession', L({ sessionId: 'jl', startTime: T }, { $set: { summary: 'set sum', lastUpdated: T } }, { id: 'a', type: 'user', content: 'jsonl q' }, { id: 'b', type: 'gemini', content: 'r1' }, { id: 'b', type: 'gemini', content: 'r2', toolCalls: [] }));
add('parseGeminiSession', 'not json');
add('parseGeminiSession', gem({ messages: [{ type: 'gemini', toolCalls: [{ result: null }] }] }));

/* ---------------- dsh ---------------- */
add('parseDshSession', L(
  { type: 'session/start', id: 'd1', cwd: '/d', time: T },
  { type: 'approval/policy', data: { policy: 'on-request' } },
  { type: 'sandbox/mode', data: { mode: 'workspace-write' } },
  { type: 'permission/preset', data: { preset: 'auto' } },
  { type: 'approval/policy', data: { policy: 'never' } },
  { type: 'user/message', data: { content: [{ text: 'dsh q' }], model: 'ds-v3', reasoningEffort: 'high' } },
  { type: 'assistant/message', data: { message: { model: 'msg-m' } }, timestamp: 1735787045 },
  { type: 'turn/end', time: 0 },
), 'fb');
add('parseDshSession', L({ type: 'sandbox/mode', data: { mode: 'read-only', context: { model: 'cm', effort: 'ce' } } }, { type: 'approval/policy', data: { policy: 'x' } },
  { type: 'agent/inbox/spliced', data: { inserted: [{ content: 'spliced q' }], request: { thinkingLevel: 'tl' } } }), undefined);
add('parseDshSession', L({ type: 'session/title', data: { title: 'Dsh title' } }, { type: 'user/message', data: { content: 'later' } }, { type: 'assistant/message' }), 's');
add('parseDshSession', L({ type: 'user/message', data: { content: [null] } }), 's');
add('parseDshSession', L({ type: 'user/message', data: { content: [{ type: 'input_text', text: '' }] } }, { type: 'user/message', data: { inserted: { 0: { content: 'objidx' } } } }), 's');
add('parseDshSession', L({ type: 'user/message', data: 'str', sessionId: 'sx', modelAlias: 'no' }, { data: { modelAlias: 'alias', reasoning_effort: 're', cwd: '/dc' } }), undefined);

/* ---------------- decideStatus ---------------- */
for (const phase of ['error', 'turn-done', 'task-done', 'working', 'tool', 'unknown'])
  for (const alive of [true, false, undefined])
    for (const ageMs of [0, 1000, 59_999, 60_000, 200_000])
      add('decideStatus', { phase, alive, ageMs, stallMs: 1000 });

/* ---------------- parseDshProjcache ---------------- */
add('parseDshProjcache', J({ record: { identity: { cwd: '/p', createdAt: 1 }, rows: { title: { val: 'T'.repeat(100) }, permissions: { val: { preset: '', sandbox: 'ro', approval: 'a' } } } } }));
add('parseDshProjcache', J({ record: { identity: { cwd: '' }, rows: { title: { val: '' }, titleInput: { val: { first: { text: 'from input' } } }, permissions: { val: { approval: 'ap' } } } } }));
add('parseDshProjcache', J({ record: { identity: { cwd: 5 }, rows: {} } }));
add('parseDshProjcache', 'null');
add('parseDshProjcache', '{bad');
add('parseDshProjcache', '7');

const out = { cases };
const outDir = process.env.NOMI_GOLDEN_DIR || path.join(root, 'apps/desktop-go/internal/core/agents/testdata');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'b7s-parsers.json'), `${JSON.stringify(out, null, 1)}\n`);
console.log(`recorded ${cases.length} agents/parsers cases`);
