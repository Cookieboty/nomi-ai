#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
/**
 * Mock dsh CLI for CI / headed e2e.
 * Supports: --version | --profile headless --json [--session-id <id>] <prompt>
 */
const args = process.argv.slice(2);
// 并发测试用：每轮模拟耗时（毫秒）
const delayMs = Number(process.env.NOMI_MOCK_DELAY_MS || 0);
if (args.includes('--version') || args.includes('-v')) {
  process.stdout.write('0.2.0-rc.2\n');
  process.exit(0);
}

const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
if (flag('--profile') !== 'headless' || !args.includes('--json')) {
  process.stderr.write('mock-dsh: only --profile headless --json supported\n');
  process.exit(2);
}

if (delayMs > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
const emit = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
const resumed = flag('--session-id');
if (resumed === 'session-unknown') {
  emit({ type: 'error', message: `session not found: ${resumed}` });
  process.exit(1);
}
const sessionId = resumed || process.env.NOMI_MOCK_SESSION || 'session-mock-dsh-1';
const prompt = args[args.length - 1];
/** 测试用：记下这一轮实际收到的消息（验证换目录时带入的前文） */
function logPrompt(text) {
  const f = process.env.NOMI_MOCK_PROMPT_LOG;
  if (f) appendFileSync(f, `${JSON.stringify(text)}\n`);
}
logPrompt(prompt);
const keyState = process.env.NOMI_DSH_API_KEY ? 'key' : 'nokey';
const reply =
  process.env.NOMI_MOCK_DSH_REPLY ||
  `【Mock dsh】${resumed ? 'resumed' : 'new'} ${keyState}: ${prompt}`;
const usage = { inputTokens: 10, outputTokens: 8, totalTokens: 18, cacheReadTokens: 0 };

emit({ type: 'session', sessionId, cwd: process.cwd() });
emit({ type: 'status', phase: 'turn_start', turn: 1 });
emit({ type: 'status', phase: 'step_start', turn: 1, step: 1 });
emit({ type: 'thinking', text: 'thinking…' });
emit({ type: 'tool_call', callId: 'call_1', tool: 'read_file', input: { path: 'README.md' } });
emit({ type: 'tool_result', callId: 'call_1', status: 'completed', result: 'ok' });
emit({ type: 'text', text: reply });
emit({ type: 'status', phase: 'step_end', turn: 1, step: 1, usage });
emit({ type: 'final', text: reply });
emit({ type: 'status', phase: 'turn_end', turn: 1, usage, reason: { kind: 'completed' } });
process.exit(0);
