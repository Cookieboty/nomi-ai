#!/usr/bin/env node
/**
 * Mock Grok Build CLI for CI / unit tests.
 * Supports: --version | -p <prompt> --output-format streaming-json [--resume <id>] [--cwd <dir>]
 * Event shape follows docs.x.ai headless streaming-json (verified against published docs, not a live binary).
 */
const args = process.argv.slice(2);
const delayMs = Number(process.env.NOMI_MOCK_DELAY_MS || 0);
if (args.includes('--version') || args.includes('-v')) {
  process.stdout.write('1.0.60\n');
  process.exit(0);
}

const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const has = (name) => args.includes(name);

if (!has('-p') && !has('--single')) {
  process.stderr.write('mock-grok: only -p / --single headless mode supported\n');
  process.exit(2);
}
const fmt = flag('--output-format');
if (fmt && fmt !== 'streaming-json' && fmt !== 'json') {
  process.stderr.write(`mock-grok: unsupported --output-format ${fmt}\n`);
  process.exit(2);
}

if (delayMs > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
const emit = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
const resumed = flag('--resume') || flag('-r');
if (resumed === 'session-unknown') {
  emit({ type: 'error', message: `session not found: ${resumed}` });
  process.exit(1);
}
const sessionId = resumed || process.env.NOMI_MOCK_SESSION || 'session-mock-grok-1';
const pIdx = Math.max(args.indexOf('-p'), args.indexOf('--single'));
const prompt = args[pIdx + 1] ?? '';
const keyState = process.env.XAI_API_KEY ? 'key' : 'nokey';
const reply =
  process.env.NOMI_MOCK_GROK_REPLY ||
  `【Mock Grok】${resumed ? 'resumed' : 'new'} ${keyState}: ${prompt.trim()}`;

if (fmt === 'json') {
  process.stdout.write(
    `${JSON.stringify({
      text: reply,
      stopReason: 'end_turn',
      sessionId,
      usage: {
        input_tokens: 12,
        output_tokens: 9,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    })}\n`,
  );
  process.exit(0);
}

if (process.env.NOMI_MOCK_SCENARIO === 'rich') {
  const step = Number(process.env.NOMI_MOCK_STEP_MS || 0);
  const pause = () =>
    step > 0 && Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, step);
  let n = 0;
  const call = (toolName, rawInput, rawOutput, failed = false) => {
    const toolCallId = `rich_${++n}`;
    emit({ type: 'tool_call', toolCallId, toolName, status: 'in_progress', rawInput });
    pause();
    emit({
      type: 'tool_call_update',
      toolCallId,
      status: failed ? 'failed' : 'completed',
      rawOutput,
    });
    pause();
  };
  emit({ type: 'thought', data: '先列目录，再搜索并读取相关文件。' });
  pause();
  call('list_dir', { path: '.' }, 'src/\npackage.json');
  for (const pat of ['password', 'secret', 'token', 'api_key'])
    call('grep', { pattern: pat, path: 'src' }, `src/a.ts:1: ${pat}`);
  call('read_file', { path: 'src/a.ts' }, 'const a = 1;');
  call('read_file', { path: 'src/b.ts' }, 'const b = 2;');
  call(
    'spawn_subagent',
    { description: '检查内存泄漏', prompt: '检查监听器卸载' },
    '没有发现泄漏。',
  );
  call(
    'edit_file',
    { path: 'src/a.ts', old_string: 'const a = 1;', new_string: 'const a = 2;\nconst c = 3;' },
    'ok',
  );
  call('bash', { command: 'ls -la' }, 'total 0');
  call('bash', { command: 'false' }, 'exit 1', true);
}
emit({ type: 'thought', data: 'thinking…' });
emit({
  type: 'tool_call',
  toolCallId: 'call_1',
  title: 'Read',
  kind: 'read',
  status: 'in_progress',
  toolName: 'read_file',
  rawInput: { path: 'README.md' },
});
emit({
  type: 'tool_call_update',
  toolCallId: 'call_1',
  status: 'completed',
  rawOutput: { lines: 1 },
});
emit({ type: 'text', data: reply });
emit({
  type: 'usage',
  messageId: 'resp_1',
  stopReason: 'end_turn',
  usage: {
    input_tokens: 12,
    output_tokens: 9,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  },
});
emit({
  type: 'end',
  stopReason: 'end_turn',
  sessionId,
  usage: {
    input_tokens: 12,
    output_tokens: 9,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  },
  num_turns: 1,
});
process.exit(0);
