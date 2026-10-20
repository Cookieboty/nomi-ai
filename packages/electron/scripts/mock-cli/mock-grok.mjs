#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
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

if (args[0] === 'login' && args.includes('--device-auth')) {
  const fs = await import('node:fs');
  const path = await import('node:path');
  process.stdout.write(
    '\nTo sign in, open this URL in your browser:\n\n  https://accounts.x.ai/oauth2/device?user_code=MOCK-GROK1\n\n' +
      'Confirm this code in your browser:\n\n  MOCK-GROK1\n\nWaiting for authorization...\n',
  );
  setTimeout(
    () => {
      if (process.env.NOMI_MOCK_LOGIN_FAIL === '1') process.exit(1);
      const email = process.env.NOMI_MOCK_LOGIN_EMAIL || 'mock@x.ai';
      const dir = process.env.GROK_HOME;
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'auth.json'),
        JSON.stringify({ user_id: `u-${email}`, email, refresh_token: `rt-${email}` }),
      );
      process.stdout.write('Signed in.\n');
      process.exit(0);
    },
    Number(process.env.NOMI_MOCK_LOGIN_MS || 200),
  );
  await new Promise(() => {});
}

// grok agent stdio：最小 ACP（initialize / session/new 带 models / session/close），供 Nomi 读模型目录
if (args[0] === 'agent' && args[1] === 'stdio') {
  const { createInterface } = await import('node:readline');
  const reply = (id, result) =>
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
  const efforts = (...v) =>
    v.map((value) => ({ id: value, value, label: value, default: value === 'high' }));
  createInterface({ input: process.stdin }).on('line', (line) => {
    let j;
    try {
      j = JSON.parse(line);
    } catch {
      return;
    }
    if (j.method === 'initialize') reply(j.id, { protocolVersion: 1, agentCapabilities: {} });
    else if (j.method === 'session/new')
      reply(j.id, {
        sessionId: 'session-mock-models',
        models: {
          currentModelId: 'grok-mock',
          availableModels: [
            {
              modelId: 'grok-mock',
              name: 'Grok Mock',
              _meta: {
                supportsReasoningEffort: true,
                reasoningEfforts: efforts('xhigh', 'high', 'medium', 'low'),
              },
            },
            {
              modelId: 'grok-mock-old',
              name: 'Grok Mock Old',
              _meta: {
                supportsReasoningEffort: true,
                reasoningEfforts: efforts('high', 'medium', 'low'),
              },
            },
          ],
        },
      });
    else if (j.method === 'session/close') reply(j.id, {});
  });
  await new Promise(() => {});
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
// 模型 / 思考深度覆盖参数（与真实 CLI 的 -m / --model / --reasoning-effort 对齐）
const modelOverride = flag('-m') ?? flag('--model');
const effortOverride = flag('--reasoning-effort') ?? flag('--effort');
/** 测试用：记下这一轮实际收到的消息（验证换目录时带入的前文） */
function logPrompt(text) {
  const f = process.env.NOMI_MOCK_PROMPT_LOG;
  if (f) appendFileSync(f, `${JSON.stringify(text)}\n`);
  // 测试用：记下本轮完整 argv（验证模型 / 思考深度进程级注入）
  const argvLog = process.env.NOMI_MOCK_ARGV_LOG;
  if (argvLog) appendFileSync(argvLog, `${JSON.stringify(args)}\n`);
}
logPrompt(prompt);
if (modelOverride && !/^[A-Za-z0-9_][A-Za-z0-9._:/-]*$/.test(modelOverride)) {
  process.stderr.write(`mock-grok: invalid model ${modelOverride}\n`);
  process.exit(2);
}
const knownEfforts = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
if (effortOverride && !knownEfforts.includes(effortOverride)) {
  process.stderr.write(`mock-grok: invalid reasoning effort ${effortOverride}\n`);
  process.exit(2);
}
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
