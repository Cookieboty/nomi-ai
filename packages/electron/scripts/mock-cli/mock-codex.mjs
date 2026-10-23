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
 * Mock Codex CLI for CI / headed e2e.
 * Supports: --version | exec --json [prompt] | update
 */
const args = process.argv.slice(2);
// 并发测试用：每轮模拟耗时（毫秒）
const delayMs = Number(process.env.NOMI_MOCK_DELAY_MS || 0);
if (args.includes('--version') || args.includes('-v')) {
  process.stdout.write('codex-cli 0.0.0-mock\n');
  process.exit(0);
}
// codex debug models：与真实 CLI 同形的模型目录 JSON（NOMI_MOCK_MODELS_FAIL=1 模拟失败）
if (args[0] === 'debug' && args[1] === 'models') {
  if (process.env.NOMI_MOCK_MODELS_FAIL === '1') {
    process.stderr.write('Error: failed to refresh models\n');
    process.exit(1);
  }
  const lv = (...e) => e.map((effort) => ({ effort, description: effort }));
  process.stdout.write(
    JSON.stringify({
      models: [
        {
          slug: 'mock-pro',
          display_name: 'Mock Pro',
          visibility: 'list',
          priority: 2,
          default_reasoning_level: 'medium',
          supported_reasoning_levels: lv('low', 'medium', 'high', 'xhigh', 'max'),
        },
        {
          slug: 'mock-mini',
          display_name: 'Mock Mini',
          visibility: 'list',
          priority: 1,
          default_reasoning_level: 'low',
          supported_reasoning_levels: lv('low', 'medium', 'high'),
        },
        {
          slug: 'mock-plain',
          display_name: 'Mock Plain',
          visibility: 'list',
          priority: 3,
          supported_reasoning_levels: [],
        },
        {
          slug: 'mock-hidden',
          display_name: 'Mock Hidden',
          visibility: 'hide',
          priority: 0,
          supported_reasoning_levels: lv('low'),
        },
      ],
    }),
  );
  process.exit(0);
}
if (args.includes('update')) {
  process.stdout.write('Already up to date\n');
  process.exit(0);
}

/**
 * codex app-server（stdio JSON-RPC，形状对齐 0.163.0 实测）：initialize / thread/start / thread/resume /
 * turn/start / turn/interrupt；条目经 item/started、item/agentMessage/delta、item/completed 推送，
 * 线程累计用量经 thread/tokenUsage/updated，一轮以 turn/completed 结束。
 * Env: NOMI_MOCK_CODEX_APP_LOG=<file>（逐条记下请求）, NOMI_MOCK_CODEX_PERM=1（逐项确认档下先请求执行命令的审批）,
 *      NOMI_MOCK_FIRST_TOKEN_MS（回复前异步等待，期间可 turn/interrupt）, NOMI_MOCK_CODEX_FAIL=1（这一轮 failed）,
 *      NOMI_MOCK_CODEX_NO_APP=1（像旧版 CLI 一样不认识 app-server）
 */
if (args[0] === 'app-server') {
  if (process.env.NOMI_MOCK_CODEX_NO_APP === '1') {
    process.stderr.write("error: unrecognized subcommand 'app-server'\n");
    process.exit(2);
  }
  const { createInterface } = await import('node:readline');
  const send = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
  const reply = (id, result) => send({ id, result });
  const notify = (method, params) => send({ method, params });
  const appLog = process.env.NOMI_MOCK_CODEX_APP_LOG;
  const own = process.env.NOMI_MOCK_SESSION || 'mock-codex-thread-1';
  const resumedThreads = new Set();
  const interrupted = new Set();
  const waiting = new Map();
  const totals = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
  let seq = 1;
  let reqSeq = 9000;
  const ask = (method, params) =>
    new Promise((resolve) => {
      const id = reqSeq++;
      waiting.set(id, resolve);
      send({ id, method, params });
    });
  const usage = (threadId, turnId) => {
    totals.inputTokens += 10;
    totals.cachedInputTokens += 2;
    totals.outputTokens += 8;
    notify('thread/tokenUsage/updated', {
      threadId,
      turnId,
      tokenUsage: { total: { ...totals, totalTokens: 0 }, last: {}, modelContextWindow: null },
    });
  };
  async function runTurn(threadId, turnId, p) {
    const text = (p.input || []).map((c) => c.text || '').join('');
    if (process.env.NOMI_MOCK_PROMPT_LOG)
      appendFileSync(process.env.NOMI_MOCK_PROMPT_LOG, `${JSON.stringify(text)}\n`);
    const item = (stage, it) => notify(`item/${stage}`, { threadId, turnId, item: it });
    item('started', { type: 'userMessage', id: `user-${turnId}`, content: p.input });
    item('completed', {
      type: 'reasoning',
      id: `rs-${turnId}`,
      summary: ['thinking…'],
      content: [],
    });
    const cmd = {
      type: 'commandExecution',
      id: `cmd-${turnId}`,
      command: 'ls',
      cwd: '/',
      status: 'inProgress',
    };
    item('started', cmd);
    let status = 'completed';
    if (process.env.NOMI_MOCK_CODEX_PERM === '1' && p.approvalPolicy === 'untrusted') {
      const r = await ask('item/commandExecution/requestApproval', {
        threadId,
        turnId,
        itemId: cmd.id,
        command: 'ls',
        cwd: '/',
        startedAtMs: Date.now(),
      });
      status = r?.decision === 'accept' ? 'completed' : 'declined';
    }
    item('completed', {
      ...cmd,
      status,
      aggregatedOutput: 'a.txt',
      exitCode: status === 'completed' ? 0 : null,
    });
    // NOMI_MOCK_DELAY_MS 与 exec 模式同义（并发 / 排队测试用），这里异步等待、期间可 turn/interrupt
    const wait =
      Number(process.env.NOMI_MOCK_FIRST_TOKEN_MS || 0) +
      Number(process.env.NOMI_MOCK_DELAY_MS || 0);
    if (wait && isSlow(text)) await sleepCancellable(turnId, wait);
    if (interrupted.has(turnId)) return;
    if (process.env.NOMI_MOCK_CODEX_FAIL === '1') {
      return notify('turn/completed', {
        threadId,
        turn: {
          id: turnId,
          items: [],
          status: 'failed',
          error: { message: 'Mock: quota exceeded' },
        },
      });
    }
    const foreign = resumedThreads.has(threadId) && threadId !== own;
    const answer =
      process.env.NOMI_MOCK_CODEX_REPLY ||
      (foreign ? `【Mock Codex】已续接会话 ${threadId}` : '【Mock Codex】任务完成。');
    const msgId = `msg-${turnId}`;
    item('started', { type: 'agentMessage', id: msgId, text: '' });
    for (const delta of [answer.slice(0, 5), answer.slice(5)])
      notify('item/agentMessage/delta', { threadId, turnId, itemId: msgId, delta });
    item('completed', { type: 'agentMessage', id: msgId, text: answer });
    usage(threadId, turnId);
    notify('turn/completed', {
      threadId,
      turn: { id: turnId, items: [], status: 'completed', error: null },
    });
  }
  createInterface({ input: process.stdin }).on('line', (line) => {
    let j;
    try {
      j = JSON.parse(line);
    } catch {
      return;
    }
    if (j.method && appLog)
      appendFileSync(appLog, `${JSON.stringify({ method: j.method, params: j.params })}\n`);
    if (j.method === undefined && waiting.has(j.id)) {
      waiting.get(j.id)(j.result);
      waiting.delete(j.id);
      return;
    }
    const p = j.params || {};
    switch (j.method) {
      case 'initialize':
        return reply(j.id, {
          userAgent: 'mock-codex/0.0.0',
          codexHome: '/tmp',
          platformFamily: 'unix',
          platformOs: 'macos',
        });
      case 'initialized':
        return;
      case 'thread/start':
        notify('thread/started', { thread: { id: own } });
        return reply(j.id, { thread: { id: own }, model: 'mock-pro', reasoningEffort: 'medium' });
      case 'thread/resume':
        if (p.threadId === 'thread-unknown')
          return send({
            id: j.id,
            error: { code: -32600, message: `no rollout found for thread id ${p.threadId}` },
          });
        resumedThreads.add(p.threadId);
        return reply(j.id, {
          thread: { id: p.threadId },
          model: 'mock-pro',
          reasoningEffort: 'medium',
        });
      case 'turn/start': {
        const turnId = `turn-${seq++}`;
        reply(j.id, { turn: { id: turnId, items: [], status: 'inProgress', error: null } });
        notify('turn/started', {
          threadId: p.threadId,
          turn: { id: turnId, status: 'inProgress' },
        });
        void runTurn(p.threadId, turnId, p);
        return;
      }
      case 'turn/interrupt':
        interrupted.add(p.turnId);
        wake(p.turnId);
        reply(j.id, {});
        return notify('turn/completed', {
          threadId: p.threadId,
          turn: { id: p.turnId, items: [], status: 'interrupted', error: null },
        });
      default:
        if (j.id !== undefined)
          send({ id: j.id, error: { code: -32601, message: `Method not found: ${j.method}` } });
    }
  });
  await new Promise(() => {});
}

/** 官方登录（NOMI_MOCK_LOGIN_EMAIL / NOMI_MOCK_LOGIN_MS / NOMI_MOCK_LOGIN_FAIL）：输出与真实 CLI 一致，凭据写进配置目录 */
function mockJwt(claims) {
  return `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;
}
if (args[0] === 'login' && args.includes('--device-auth')) {
  const fs = await import('node:fs');
  const path = await import('node:path');
  process.stdout.write(
    '\nFollow these steps to sign in with ChatGPT using device code authorization:\n\n' +
      '1. Open this link in your browser and sign in to your account\n   \x1b[94mhttps://auth.openai.com/codex/device\x1b[0m\n\n' +
      '2. Enter this one-time code \x1b[90m(expires in 15 minutes)\x1b[0m\n   \x1b[94mMOCK-CODE1\x1b[0m\n\n',
  );
  setTimeout(
    () => {
      if (process.env.NOMI_MOCK_LOGIN_FAIL === '1') {
        process.stderr.write('Error: device code expired\n');
        process.exit(1);
      }
      const email = process.env.NOMI_MOCK_LOGIN_EMAIL || 'mock@x.com';
      const dir = process.env.CODEX_HOME;
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'auth.json'),
        JSON.stringify({
          tokens: {
            id_token: mockJwt({ email, sub: `sub-${email}` }),
            access_token: 'at',
            refresh_token: `rt-${email}`,
            account_id: `acct-${email}`,
          },
          last_refresh: new Date().toISOString(),
        }),
      );
      process.stdout.write('Successfully logged in\n');
      process.exit(0);
    },
    Number(process.env.NOMI_MOCK_LOGIN_MS || 200),
  );
} else {
  /** 测试用：记下这一轮实际收到的消息（验证换目录时带入的前文） */
  function logPrompt(text) {
    const f = process.env.NOMI_MOCK_PROMPT_LOG;
    if (f) appendFileSync(f, `${JSON.stringify(text)}\n`);
    const argvLog = process.env.NOMI_MOCK_ARGV_LOG;
    if (argvLog) appendFileSync(argvLog, `${JSON.stringify(args)}\n`);
  }
  // exec resume [...flags] <id> <prompt>：续接历史会话。带值的参数（-c key=value、--cd dir 等）
  // 的值不是位置参数，跳过它们才拿得到会话 id
  const VALUE_FLAGS = new Set(['-c', '--config', '-m', '--model', '--cd', '-C', '-s', '--sandbox']);
  const positional = args.filter(
    (a, i) => !a.startsWith('-') && !(i > 0 && VALUE_FLAGS.has(args[i - 1])),
  );
  const resumeAt = args.indexOf('resume');
  const resumed = resumeAt >= 0 ? positional.slice(2)[0] : '';
  const ownThread = process.env.NOMI_MOCK_SESSION || 'mock-codex-thread-1';
  // 只有续接「别的」会话（历史会话）才改回复，普通多轮对话的回复保持不变
  const foreign = resumed && resumed !== ownThread;
  const reply =
    process.env.NOMI_MOCK_CODEX_REPLY ||
    (foreign ? `【Mock Codex】已续接会话 ${resumed}` : '【Mock Codex】任务完成。');
  const threadId = resumed || ownThread;
  logPrompt(args[args.length - 1]);

  if (delayMs > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
  function emit(obj) {
    process.stdout.write(`${JSON.stringify(obj)}\n`);
  }

  const isExec = args[0] === 'exec' || args[0] === 'e';
  if (!isExec) {
    process.stderr.write('mock-codex: only exec/--version/update supported\n');
    process.exit(2);
  }

  emit({ type: 'thread.started', thread_id: threadId });
  emit({ type: 'turn.started' });
  emit({
    type: 'item.completed',
    item: { id: 'item_1', type: 'agent_message', text: reply, status: 'completed' },
  });
  emit({
    type: 'turn.completed',
    usage: { input_tokens: 10, output_tokens: 8 },
  });
  process.exit(0);
}
