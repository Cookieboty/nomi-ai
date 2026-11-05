#!/usr/bin/env node
import { appendFileSync } from 'node:fs';

/** 可被取消打断的等待：收到取消时立即醒来（与真实 CLI 一样马上结束这一轮，测试不用白等） */
const wakers = new Map();
function sleepCancellable(key, ms) {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      wakers.delete(key);
      resolve();
    };
    const timer = setTimeout(done, ms);
    wakers.set(key, done);
  });
}
function wake(key) {
  wakers.get(key)?.();
}

/** NOMI_MOCK_SLOW_PROMPT：只有内容包含它的那一轮才按 FIRST_TOKEN / DELAY 等待（常驻进程的环境变量启动后改不了） */
function isSlow(text) {
  const marker = process.env.NOMI_MOCK_SLOW_PROMPT;
  return !marker || String(text).includes(marker);
}
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

// grok agent stdio：ACP（形状对齐 1.0.62 实测）。读模型目录用 initialize / session/new / session/close；
// 长驻会话再用 session/load / set_mode / set_model / set_config_option / prompt / cancel。
// Env: NOMI_MOCK_GROK_ACP_LOG=<file>（逐条记下请求，initialize 带 argv 与 XAI_API_KEY 状态）,
//      NOMI_MOCK_GROK_PERM=1（先请求执行命令的权限；拒绝则像真实 CLI 一样以 cancelled 结束整轮）,
//      NOMI_MOCK_GROK_SET_MODE=error / NOMI_MOCK_GROK_SET_MODEL=error（对应请求失败）,
//      NOMI_MOCK_FIRST_TOKEN_MS（回复前异步等待，期间可 session/cancel）, NOMI_MOCK_GROK_NO_ACP=1（立即退出）,
//      NOMI_MOCK_GROK_NO_COMPACT=1（没有 _x.ai/compact_conversation，像旧版一样）
if (args[0] === 'agent' && args[1] === 'stdio') {
  if (process.env.NOMI_MOCK_GROK_NO_ACP === '1') {
    process.stderr.write('error: unrecognized subcommand stdio\n');
    process.exit(2);
  }
  const { createInterface } = await import('node:readline');
  const send = (m) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`);
  const reply = (id, result) => send({ id, result });
  const fail = (id, message) => send({ id, error: { code: -32603, message } });
  const update = (sessionId, u) =>
    send({ method: 'session/update', params: { sessionId, update: u } });
  const acpLog = process.env.NOMI_MOCK_GROK_ACP_LOG;
  const log = (o) => acpLog && appendFileSync(acpLog, `${JSON.stringify(o)}\n`);
  const efforts = (...v) =>
    v.map((value) => ({ id: value, value, label: value, default: value === 'high' }));
  const models = {
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
  };
  const MODES = ['plan', 'default', 'acceptEdits', 'bypassPermissions', 'dontAsk'];
  const currentMode = process.env.NOMI_MOCK_GROK_MODE;
  const modeState = () =>
    currentMode
      ? { currentModeId: currentMode, availableModes: MODES.map((id) => ({ id, name: id })) }
      : { availableModes: MODES.map((id) => ({ id, name: id })) };
  const resumed = new Set();
  const cancelled = new Set();
  const waiting = new Map();
  let seq = 1000;
  const ask = (method, params) =>
    new Promise((resolve) => {
      const id = seq++;
      waiting.set(id, resolve);
      send({ id, method, params });
    });
  // 第三方会话的令牌由私有 GROK_HOME 配置里的 env_key（NOMI_GROK_API_KEY）指定
  const keyState = () =>
    process.env.XAI_API_KEY || process.env.NOMI_GROK_API_KEY ? 'key' : 'nokey';
  /** 多种工具调用演示（NOMI_MOCK_SCENARIO=rich，与 -p 模式的 rich 同一组工具；NOMI_MOCK_STEP_MS 控制节奏） */
  async function richTurn(sid) {
    const step = Number(process.env.NOMI_MOCK_STEP_MS || 0);
    const pause = () => (step > 0 ? new Promise((r) => setTimeout(r, step)) : Promise.resolve());
    let n = 0;
    const call = async (name, rawInput, output, failed = false) => {
      const toolCallId = `rich_${++n}`;
      update(sid, {
        sessionUpdate: 'tool_call',
        toolCallId,
        title: name,
        rawInput,
        _meta: { 'x.ai/tool': { name } },
      });
      await pause();
      update(sid, {
        sessionUpdate: 'tool_call_update',
        toolCallId,
        status: failed ? 'failed' : 'completed',
        content: [{ type: 'content', content: { type: 'text', text: output } }],
      });
      await pause();
    };
    update(sid, {
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: '先列目录，再搜索并读取相关文件。' },
    });
    await pause();
    await call('list_dir', { path: '.' }, 'src/\npackage.json');
    for (const pat of ['password', 'secret', 'token', 'api_key'])
      await call('grep', { pattern: pat, path: 'src' }, `src/a.ts:1: ${pat}`);
    await call('read_file', { path: 'src/a.ts' }, 'const a = 1;');
    await call('read_file', { path: 'src/b.ts' }, 'const b = 2;');
    await call(
      'spawn_subagent',
      { description: '检查内存泄漏', prompt: '检查监听器卸载' },
      '没有发现泄漏。',
    );
    await call(
      'edit_file',
      { path: 'src/a.ts', old_string: 'const a = 1;', new_string: 'const a = 2;\nconst c = 3;' },
      'ok',
    );
    await call('bash', { command: 'ls -la' }, 'total 0');
    await call('bash', { command: 'false' }, 'exit 1', true);
  }
  async function prompt(id, p) {
    const sid = p.sessionId;
    cancelled.delete(sid);
    const text = (p.prompt || []).map((c) => c.text || '').join('');
    if (process.env.NOMI_MOCK_PROMPT_LOG)
      appendFileSync(process.env.NOMI_MOCK_PROMPT_LOG, `${JSON.stringify(text)}\n`);
    update(sid, {
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: 'thinking…' },
    });
    if (process.env.NOMI_MOCK_SCENARIO === 'rich') await richTurn(sid);
    const tool = {
      toolCallId: 'call-1',
      title: 'read_file',
      rawInput: { target_file: 'README.md' },
    };
    update(sid, {
      sessionUpdate: 'tool_call',
      ...tool,
      _meta: { 'x.ai/tool': { name: 'read_file', kind: 'read' } },
    });
    update(sid, {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call-1',
      kind: 'read',
      title: 'Read README.md',
    });
    update(sid, {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call-1',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: '1→# Mock' } }],
    });
    if (process.env.NOMI_MOCK_GROK_PERM === '1') {
      const toolCall = {
        toolCallId: 'call-2',
        kind: 'execute',
        title: 'Execute `echo hi`',
        rawInput: { command: 'echo hi' },
      };
      update(sid, { sessionUpdate: 'tool_call', ...toolCall, title: 'run_terminal_command' });
      const r = await ask('session/request_permission', {
        sessionId: sid,
        toolCall,
        options: [
          { optionId: 'allow-once', name: 'Allow', kind: 'allow_once' },
          { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
        ],
      });
      if (r?.outcome?.optionId !== 'allow-once') return reply(id, { stopReason: 'cancelled' });
      update(sid, {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call-2',
        status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: 'hi' } }],
      });
    }
    const wait = Number(process.env.NOMI_MOCK_FIRST_TOKEN_MS || 0);
    if (wait && isSlow(text)) await sleepCancellable(sid, wait);
    if (cancelled.has(sid)) return reply(id, { stopReason: 'cancelled' });
    const answer =
      process.env.NOMI_MOCK_GROK_REPLY ||
      `【Mock Grok】acp ${resumed.has(sid) ? 'resumed' : 'new'} ${keyState()}: ${text.trim()}`;
    for (const part of [answer.slice(0, 6), answer.slice(6)])
      update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: part } });
    reply(id, {
      stopReason: 'end_turn',
      _meta: { usage: { inputTokens: 12, outputTokens: 9, cachedReadTokens: 3 } },
    });
  }
  createInterface({ input: process.stdin }).on('line', (line) => {
    let j;
    try {
      j = JSON.parse(line);
    } catch {
      return;
    }
    if (j.method)
      log({
        method: j.method,
        params: j.params,
        ...(j.method === 'initialize'
          ? {
              argv: args,
              key: keyState(),
              cwd: process.cwd(),
              grokHome: process.env.GROK_HOME ?? null,
            }
          : {}),
      });
    if (j.method === undefined && waiting.has(j.id)) {
      waiting.get(j.id)(j.result);
      waiting.delete(j.id);
      return;
    }
    const p = j.params || {};
    switch (j.method) {
      case 'initialize':
        return reply(j.id, { protocolVersion: 1, agentCapabilities: { loadSession: true } });
      case 'session/new':
        return reply(j.id, {
          sessionId: process.env.NOMI_MOCK_SESSION || 'session-mock-grok-1',
          models,
          modes: modeState(),
        });
      case 'session/load':
        if (p.sessionId === 'session-unknown') return fail(j.id, 'session not found');
        resumed.add(p.sessionId);
        return reply(j.id, {
          models,
          modes: modeState(),
        });
      case 'session/set_mode':
        if (process.env.NOMI_MOCK_GROK_SET_MODE === 'error')
          return fail(j.id, 'mode rejected (mock)');
        reply(j.id, {});
        if (MODES.includes(p.modeId))
          update(p.sessionId, { sessionUpdate: 'current_mode_update', currentModeId: p.modeId });
        return;
      case 'session/set_model':
        if (process.env.NOMI_MOCK_GROK_SET_MODEL === 'error')
          return fail(j.id, 'unknown model (mock)');
        return reply(j.id, { _meta: { model: { Ok: p.modelId } } });
      case 'session/set_config_option':
        return reply(j.id, { configOptions: [] });
      case 'session/prompt':
        void prompt(j.id, p);
        return;
      case 'session/cancel':
        cancelled.add(p.sessionId);
        wake(p.sessionId);
        return;
      case 'session/close':
        return reply(j.id, {});
      case '_x.ai/compact_conversation': {
        // 手动压缩（1.0.70 内置文档的扩展方法）；NOMI_MOCK_GROK_NO_COMPACT=1 像旧版一样没有这个方法
        if (process.env.NOMI_MOCK_GROK_NO_COMPACT === '1')
          return send({
            id: j.id,
            error: { code: -32601, message: `Method not found: ${j.method}` },
          });
        const notice = (update) =>
          send({
            method: 'x.ai/session_notification',
            params: { sessionId: p.sessionId, update },
          });
        notice({ sessionUpdate: 'auto_compact_started', tokens_used: 900, context_window: 1000 });
        notice({ sessionUpdate: 'auto_compact_completed', tokens_before: 900, tokens_after: 40 });
        return reply(j.id, {});
      }
      default:
        if (j.id !== undefined)
          send({ id: j.id, error: { code: -32601, message: `Method not found: ${j.method}` } });
    }
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
const keyState = process.env.XAI_API_KEY || process.env.NOMI_GROK_API_KEY ? 'key' : 'nokey';
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
