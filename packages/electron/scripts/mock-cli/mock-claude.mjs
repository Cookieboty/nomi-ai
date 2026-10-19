#!/usr/bin/env node
/**
 * Mock Claude Code CLI for CI / headed e2e.
 * Supports:
 *   --version | update
 *   单轮：-p <prompt> --output-format stream-json
 *   长驻：-p --input-format stream-json --output-format stream-json
 *     （stdin 逐行 NDJSON user / control_response；每轮 result 后进程不退出）
 * Env: NOMI_MOCK_CLAUDE_REPLY, NOMI_MOCK_SESSION, NOMI_MOCK_ASK_PERMISSION,
 *      NOMI_MOCK_PERMISSION_ID, NOMI_MOCK_TOOLS（1 = 单个 Bash；rich = 多种工具调用演示）,
 *      NOMI_MOCK_STEP_MS（rich 场景下每个事件之间的停顿）, NOMI_MOCK_DELAY_MS,
 *      NOMI_MOCK_CLAUDE_BOOT_LOG（可选：每次进程启动 append「pid 参数」一行，测复用）,
 *      NOMI_MOCK_CLAUDE_CONTROL_LOG（可选：收到 set_permission_mode 时 append「pid 模式」）
 */
import fs, { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const args = process.argv.slice(2);
const delayMs = Number(process.env.NOMI_MOCK_DELAY_MS || 0);
if (args.includes('--version') || args.includes('-v')) {
  process.stdout.write('2.0.0-mock (Claude Code Mock)\n');
  process.exit(0);
}
if (args.includes('update')) {
  process.stdout.write('Already up to date: 2.0.0-mock\n');
  process.exit(0);
}

const bootLog = process.env.NOMI_MOCK_CLAUDE_BOOT_LOG;
const controlLog = process.env.NOMI_MOCK_CLAUDE_CONTROL_LOG;
if (bootLog) {
  try {
    fs.appendFileSync(bootLog, `${process.pid} ${args.join(' ')}\n`);
  } catch {
    /* */
  }
}

if (args[0] === 'auth' && args[1] === 'login') {
  const url = 'https://claude.com/cai/oauth/authorize?code=true&client_id=mock&state=mock';
  process.stdout.write(
    `Opening browser to sign in…\nIf the browser didn't open, visit: \x1b]8;;${url}\x07${url}\x1b]8;;\x07\nPaste code here if prompted > `,
  );
  const rl = createInterface({ input: process.stdin });
  rl.once('line', (line) => {
    if (line.trim() !== 'CODE-OK') {
      process.stdout.write('\nInvalid code\n');
      process.exit(1);
    }
    const email = process.env.NOMI_MOCK_LOGIN_EMAIL || 'mock@claude.ai';
    const dir = process.env.CLAUDE_CONFIG_DIR;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      `${dir}/.credentials.json`,
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'at',
          refreshToken: `rt-${email}`,
          expiresAt: Date.now() + 3_600_000,
          subscriptionType: 'max',
        },
      }),
    );
    fs.writeFileSync(
      `${dir}/.claude.json`,
      JSON.stringify({ oauthAccount: { accountUuid: `u-${email}`, emailAddress: email } }),
    );
    process.stdout.write('\nLogin successful.\n');
    process.exit(0);
  });
  await new Promise(() => {});
}

const resumeIdx = args.indexOf('--resume');
const ownSession = process.env.NOMI_MOCK_SESSION || 'mock-claude-session-1';
const resumed = resumeIdx >= 0 ? args[resumeIdx + 1] : '';
const foreign = resumed && resumed !== ownSession;
const sessionId = resumed || ownSession;

function sleep() {
  if (delayMs > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
}

function emit(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

/** 测试用：记下这一轮实际收到的消息（验证换目录时带入的前文） */
function logPrompt(text) {
  const f = process.env.NOMI_MOCK_PROMPT_LOG;
  if (f) appendFileSync(f, `${JSON.stringify(text)}\n`);
}

function extractUserText(line) {
  try {
    const j = JSON.parse(line);
    if (j?.type === 'control_response') return { kind: 'control', j };
    if (j?.type === 'control_request') return { kind: 'control_request', j };
    if (typeof j.prompt === 'string') return { kind: 'user', text: j.prompt };
    if (j?.message?.content != null) {
      const c = j.message.content;
      logPrompt(typeof c === 'string' ? c : JSON.stringify(c));
      return {
        kind: 'user',
        text: typeof c === 'string' ? c : JSON.stringify(c),
        uuid: typeof j.uuid === 'string' ? j.uuid : undefined,
      };
    }
    if (typeof j.content === 'string') return { kind: 'user', text: j.content };
  } catch {
    /* */
  }
  return { kind: 'user', text: line };
}

/**
 * 后台子代理（NOMI_MOCK_BG_AGENT=1，对齐 Claude 2.1.303 实测）：本轮启动一个后台子代理并立刻以 STARTED 结束；
 * NOMI_MOCK_BG_MS（默认 300）后子代理在 result 之后继续输出（带 parent_tool_use_id），完成通知后
 * 主代理在没有用户消息的情况下自发跟进一轮（FOLLOWUP + 第二个 result）。
 */
function bgAgentTurn() {
  const toolUseId = 'toolu_bg_1';
  emit({
    type: 'assistant',
    session_id: sessionId,
    message: {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: toolUseId,
          name: 'Agent',
          input: {
            description: 'bg task',
            subagent_type: 'general-purpose',
            run_in_background: true,
          },
        },
      ],
    },
  });
  emit({
    type: 'system',
    subtype: 'task_started',
    session_id: sessionId,
    task_id: 'task_bg_1',
    tool_use_id: toolUseId,
    description: 'bg task',
    subagent_type: 'general-purpose',
    task_type: 'local_agent',
    is_backgrounded: true,
  });
  emit({
    type: 'user',
    session_id: sessionId,
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'Async agent launched' }],
    },
  });
  emit({
    type: 'assistant',
    session_id: sessionId,
    message: { role: 'assistant', content: [{ type: 'text', text: 'STARTED' }] },
  });
  emit({ type: 'result', session_id: sessionId, result: 'STARTED', subtype: 'success' });
  setTimeout(
    () => {
      queue.unshift({ auto: true });
      pump();
    },
    Number(process.env.NOMI_MOCK_BG_MS || 300),
  );
}

function bgFollowup() {
  const toolUseId = 'toolu_bg_1';
  emit({
    type: 'assistant',
    session_id: sessionId,
    parent_tool_use_id: toolUseId,
    message: {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'toolu_bg_read', name: 'Read', input: { file_path: 'a.txt' } },
      ],
    },
  });
  emit({
    type: 'user',
    session_id: sessionId,
    parent_tool_use_id: toolUseId,
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_bg_read', content: 'hello' }],
    },
  });
  emit({
    type: 'system',
    subtype: 'task_notification',
    session_id: sessionId,
    task_id: 'task_bg_1',
    tool_use_id: toolUseId,
    status: 'completed',
    summary: 'bg done',
  });
  emit({
    type: 'assistant',
    session_id: sessionId,
    message: { role: 'assistant', content: [{ type: 'text', text: 'FOLLOWUP' }] },
  });
  emit({
    type: 'result',
    session_id: sessionId,
    result: 'FOLLOWUP',
    subtype: 'success',
    usage: { input_tokens: 10, output_tokens: 2 },
  });
}

/**
 * 两个子代理并行请求权限（NOMI_MOCK_PARALLEL_PERMS=1）：各自的 can_use_tool 带 tool_use_id，
 * 两个都答复后才结束本轮；最终文本写明各自的答复（allow / deny）。
 */
async function parallelPermsTurn() {
  const content = (id, name, input) => [{ type: 'tool_use', id, name, input }];
  for (const [id, d] of [
    ['toolu_a', 'agent A'],
    ['toolu_b', 'agent B'],
  ])
    emit({
      type: 'assistant',
      session_id: sessionId,
      message: { role: 'assistant', content: content(id, 'Agent', { description: d }) },
    });
  for (const [parent, id, cmd] of [
    ['toolu_a', 'toolu_a_bash', 'rm a.tmp'],
    ['toolu_b', 'toolu_b_bash', 'rm b.tmp'],
  ])
    emit({
      type: 'assistant',
      session_id: sessionId,
      parent_tool_use_id: parent,
      message: { role: 'assistant', content: content(id, 'Bash', { command: cmd }) },
    });
  const answers = await new Promise((resolve) => {
    const got = {};
    multiWaiter = (reqId, allowed) => {
      got[reqId] = allowed ? 'allow' : 'deny';
      if (Object.keys(got).length === 2) {
        multiWaiter = null;
        resolve(got);
      }
    };
    for (const [reqId, toolUseId, cmd] of [
      ['perm-a', 'toolu_a_bash', 'rm a.tmp'],
      ['perm-b', 'toolu_b_bash', 'rm b.tmp'],
    ])
      emit({
        type: 'control_request',
        request_id: reqId,
        request: {
          subtype: 'can_use_tool',
          tool_name: 'Bash',
          input: { command: cmd },
          tool_use_id: toolUseId,
        },
      });
  });
  const text = `A=${answers['perm-a']} B=${answers['perm-b']}`;
  emit({
    type: 'assistant',
    session_id: sessionId,
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  });
  emit({ type: 'result', session_id: sessionId, result: text, subtype: 'success' });
}

async function runOnce(_prompt) {
  if (process.env.NOMI_MOCK_PARALLEL_PERMS === '1') return parallelPermsTurn();
  if (process.env.NOMI_MOCK_BG_AGENT === '1' && !bgStarted) {
    bgStarted = true;
    bgAgentTurn();
    return;
  }
  sleep();
  // 固定回复，便于既有单测断言；续接「外会话」时带 session id
  let text =
    process.env.NOMI_MOCK_CLAUDE_REPLY ||
    (foreign ? `【Mock Claude】已续接会话 ${resumed}` : '【Mock Claude】已收到，并完成演示回复。');

  emit({
    type: 'system',
    subtype: 'init',
    session_id: sessionId,
    model: 'mock-claude',
    pid: process.pid,
  });

  if (process.env.NOMI_MOCK_ASK_PERMISSION === '1') {
    const reqId = process.env.NOMI_MOCK_PERMISSION_ID || 'mock-perm-1';
    emit({
      type: 'control_request',
      request_id: reqId,
      request: {
        subtype: 'can_use_tool',
        tool_name: 'Bash',
        input: { command: 'echo mock-permission' },
      },
    });
    // 长驻模式下由外层 line 循环把 control_response 投递进来；单轮模式在下面等
    if (!streamIn) {
      const line = await readStdinLine();
      let allowed = false;
      try {
        const j = JSON.parse(line);
        allowed = j?.response?.response?.behavior === 'allow';
      } catch {
        /* deny */
      }
      if (!allowed) {
        emit({
          type: 'result',
          session_id: sessionId,
          result: '【Mock Claude】权限被拒绝',
          subtype: 'success',
        });
        return;
      }
    } else {
      const decision = await waitPermission();
      if (!decision) {
        emit({
          type: 'result',
          session_id: sessionId,
          result: '【Mock Claude】权限被拒绝',
          subtype: 'success',
        });
        return;
      }
    }
  }

  if (process.env.NOMI_MOCK_TOOLS === '1') {
    emit({
      type: 'assistant',
      session_id: sessionId,
      message: {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'mock-tu-1', name: 'Bash', input: { command: 'echo hi' } },
        ],
      },
    });
    emit({
      type: 'user',
      session_id: sessionId,
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'mock-tu-1', content: 'hi', is_error: false },
        ],
      },
    });
  }

  const firstToken = Number(process.env.NOMI_MOCK_FIRST_TOKEN_MS || 0);
  if (firstToken > 0) await new Promise((r) => setTimeout(r, firstToken));
  if (process.env.NOMI_MOCK_FAIL === '1') {
    emit({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      session_id: sessionId,
      result: 'Mock: 429 rate limit exceeded',
    });
    return;
  }
  if (process.env.NOMI_MOCK_TOOLS === 'rich') await richScenario();
  if (process.env.NOMI_MOCK_TOOLS === 'stress') await stressScenario();

  // 流式渲染压测：NOMI_MOCK_CODEBLOCK_CHARS 把回复换成一个这么长的 TS 围栏代码块（末尾闭合并带一句结论），
  // NOMI_MOCK_STREAM_CPS 按「字符 / 秒」匀速吐字（模拟真实模型的吐字速率，而不是尽快发完）
  const codeChars = Number(process.env.NOMI_MOCK_CODEBLOCK_CHARS || 0);
  if (codeChars > 0) {
    const fn = (k) =>
      `export async function handler${k}(input: Request, ctx: Context): Promise<Result> {\n  const value = ctx.cache.get('key-${k}') ?? (await compute(input.body, ${k}));\n  return ctx.store.save({ id: 'item-${k}', value }).then((r) => r.ok);\n}\n\n`;
    let code = '';
    for (let k = 0; code.length < codeChars; k++) code += fn(k);
    text = `下面是实现：\n\n\`\`\`ts\n${code.slice(0, codeChars)}\n\`\`\`\n\n以上就是完整代码。`;
  }
  const cps = Number(process.env.NOMI_MOCK_STREAM_CPS || 0);
  const chunks =
    cps > 0
      ? text.match(new RegExp(`.{1,${Math.max(1, Math.round(cps / 20))}}`, 'gs')) || [text]
      : text.match(/.{1,8}/gs) || [text];
  for (const c of chunks) {
    if (cps > 0) await new Promise((r) => setTimeout(r, 50));
    emit({
      type: 'stream_event',
      session_id: sessionId,
      event: { delta: { type: 'text_delta', text: c } },
    });
  }
  emit({
    type: 'assistant',
    session_id: sessionId,
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  });
  emit({
    type: 'result',
    session_id: sessionId,
    result: text,
    subtype: 'success',
    usage: { input_tokens: 1200, output_tokens: 340, cache_read_input_tokens: 800 },
    total_cost_usd: 0.0123,
    duration_ms: 1500,
  });
}

/**
 * 压测场景：持续输出 NOMI_MOCK_STRESS_N（默认 2000）个工具调用（读 / 搜 / 命令 / 编辑循环，输出 1–3KB），
 * 夹杂思考与 NOMI_MOCK_STRESS_TEXT_KB（默认 200）KB 的 Markdown 流式文本；每 20 条事件让出一次事件循环。
 */
async function stressScenario() {
  const n = Number(process.env.NOMI_MOCK_STRESS_N || 2000);
  const textKb = Number(process.env.NOMI_MOCK_STRESS_TEXT_KB || 200);
  const pad = (k) => `line ${k} `.repeat(40).slice(0, 1500 + (k % 3) * 700);
  let sent = 0;
  const tick = async () => {
    if (++sent % 20 === 0) await new Promise((r) => setImmediate(r));
  };
  for (let i = 0; i < n; i++) {
    const id = `stress-${i}`;
    const kind = i % 4;
    const [name, input, output] =
      kind === 0
        ? ['Read', { file_path: `/repo/src/mod${i % 97}/file${i}.ts` }, pad(i)]
        : kind === 1
          ? ['Grep', { pattern: `symbol${i % 31}`, path: 'src' }, pad(i)]
          : kind === 2
            ? ['Bash', { command: `pnpm test -- case${i}` }, pad(i)]
            : [
                'Edit',
                {
                  file_path: `/repo/src/edit${i % 13}.ts`,
                  old_string: `const a${i} = 1;\nconst b = 2;`,
                  new_string: `const a${i} = 2;\nconst b = 2;\nconst c = 3;`,
                },
                'ok',
              ];
    if (i % 50 === 0)
      emit({
        type: 'assistant',
        session_id: sessionId,
        message: {
          role: 'assistant',
          content: [{ type: 'thinking', thinking: `第 ${i} 步思考：`.repeat(20) }],
        },
      });
    emit({
      type: 'assistant',
      session_id: sessionId,
      message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
    });
    await tick();
    emit({
      type: 'user',
      session_id: sessionId,
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: id, content: output }],
      },
    });
    await tick();
  }
  const para =
    '## 小结\n\n这是一段 **Markdown** 文本，包含 `inline code`、[链接](https://example.com) 和列表：\n\n- 条目一\n- 条目二\n\n```ts\nconst x = 1;\nconsole.log(x);\n```\n\n';
  let total = 0;
  while (total < textKb * 1024) {
    for (let k = 0; k < para.length; k += 40) {
      const chunk = para.slice(k, k + 40);
      emit({
        type: 'stream_event',
        session_id: sessionId,
        event: { delta: { type: 'text_delta', text: chunk } },
      });
      total += chunk.length;
      await tick();
    }
  }
}

/** 多种工具调用演示：思考 / 目录 / 搜索 / 读文件 / 子代理 / 编辑 / 命令（成功与失败） */
async function richScenario() {
  const step = Number(process.env.NOMI_MOCK_STEP_MS || 0);
  const pause = () => step > 0 && new Promise((r) => setTimeout(r, step));
  let n = 0;
  const call = async (name, input, output, opts = {}) => {
    const id = `rich-${++n}`;
    emit({
      type: 'assistant',
      session_id: sessionId,
      ...(opts.parent ? { parent_tool_use_id: opts.parent } : {}),
      message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
    });
    await pause();
    emit({
      type: 'user',
      session_id: sessionId,
      ...(opts.parent ? { parent_tool_use_id: opts.parent } : {}),
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: id, content: output, is_error: !!opts.error },
        ],
      },
    });
    await pause();
    return id;
  };
  // 等待 / 恢复状态：API 重试、上下文压缩（各停一会儿，便于界面截图）
  emit({ type: 'system', subtype: 'api_retry', session_id: sessionId, attempt: 1, max_retries: 3 });
  await pause();
  emit({ type: 'system', subtype: 'status', status: 'compacting', session_id: sessionId });
  await pause();
  emit({ type: 'system', subtype: 'status', status: null, session_id: sessionId });
  emit({
    type: 'assistant',
    session_id: sessionId,
    message: {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: '先浏览目录结构，再搜索关键字，最后修改实现并跑测试。' },
      ],
    },
  });
  await pause();
  await call('LS', { path: '/repo/src' }, 'cli/\nutils/\nindex.ts');
  await call(
    'Grep',
    { pattern: 'registerHandler', path: 'src' },
    'src/cli/a.ts:12: registerHandler(x)\nsrc/cli/b.ts:40: registerHandler(y)',
  );
  await call('Grep', { pattern: 'TODO', path: 'src' }, 'No matches found');
  await call(
    'Read',
    { file_path: '/repo/src/cli/a.ts' },
    'export function registerHandler() {\n  return 1;\n}\n',
  );
  await call('Read', { file_path: '/repo/src/cli/b.ts' }, 'export const b = 2;\n');
  await call('Glob', { pattern: 'src/**/*.test.ts' }, 'src/cli/a.test.ts');
  const task = 'rich-task';
  emit({
    type: 'assistant',
    session_id: sessionId,
    message: {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: task,
          name: 'Task',
          input: {
            description: '检查内存泄漏风险',
            subagent_type: 'explore',
            prompt: '检查事件监听是否在卸载时移除。',
          },
        },
      ],
    },
  });
  await pause();
  await call('Grep', { pattern: 'addEventListener' }, 'src/ui/a.tsx:8', { parent: task });
  await call('Read', { file_path: '/repo/src/ui/a.tsx' }, 'useEffect(() => {})', { parent: task });
  emit({
    type: 'user',
    session_id: sessionId,
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: task,
          content: [{ type: 'text', text: '未发现泄漏：所有监听都在 cleanup 中移除。' }],
          is_error: false,
        },
      ],
    },
  });
  await pause();
  await call(
    'Edit',
    {
      file_path: '/repo/src/cli/a.ts',
      old_string: 'export function registerHandler() {\n  return 1;\n}',
      new_string:
        'export function registerHandler(opts = {}) {\n  const id = opts.id ?? 1;\n  return id;\n}',
    },
    'The file /repo/src/cli/a.ts has been updated.',
  );
  await call(
    'Write',
    { file_path: '/repo/src/cli/new.ts', content: 'export const x = 1;\nexport const y = 2;\n' },
    'File created',
  );
  await call(
    'Bash',
    { command: 'pnpm test -- a.test.ts', description: '运行单测' },
    ' PASS  src/cli/a.test.ts\n  ✓ registers handler (3 ms)\n\nTests: 1 passed, 1 total',
  );
  await call(
    'Bash',
    { command: 'pnpm lint' },
    'src/cli/a.ts\n  3:5  error  Unexpected any  no-explicit-any',
    { error: true },
  );
}

function readStdinLine() {
  return new Promise((resolve) => {
    const onData = (chunk) => {
      const s = String(chunk);
      const nl = s.indexOf('\n');
      if (nl >= 0) {
        process.stdin.off('data', onData);
        resolve(s.slice(0, nl));
      }
    };
    process.stdin.on('data', onData);
  });
}

/** 长驻：permission 等待队列 */
let permissionWaiter = null;
/** 并行权限场景：按 request_id 收答复 */
let multiWaiter = null;
function waitPermission() {
  return new Promise((resolve) => {
    permissionWaiter = resolve;
  });
}

const promptIdx = args.findIndex((a) => a === '-p' || a === '--print');
const inlineCandidate = promptIdx >= 0 ? args[promptIdx + 1] : '';
const inline = inlineCandidate && !String(inlineCandidate).startsWith('-') ? inlineCandidate : '';
const streamIn = args.includes('--input-format') && args.includes('stream-json');

let bgStarted = false;
const replay = args.includes('--replay-user-messages');
let busy = false;
const queue = [];
// 与真实 CLI 一致：开始处理某条用户消息时才回显它（带原 uuid、isReplay），自发轮次不回显
const pump = () => {
  if (busy) return;
  const next = queue.shift();
  if (!next) return;
  busy = true;
  if (next.auto) {
    bgFollowup();
    busy = false;
    pump();
    return;
  }
  if (replay && next.uuid)
    emit({
      type: 'user',
      session_id: sessionId,
      uuid: next.uuid,
      isReplay: true,
      message: { role: 'user', content: next.text },
    });
  void runOnce(next.text)
    .catch(() => {})
    .finally(() => {
      busy = false;
      pump();
    });
};

if (streamIn) {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

  rl.on('line', (line) => {
    const parsed = extractUserText(line);
    if (parsed.kind === 'control') {
      if (multiWaiter) {
        const r = parsed.j?.response;
        multiWaiter(r?.request_id, r?.response?.behavior === 'allow');
        return;
      }
      if (permissionWaiter) {
        const allowed = parsed.j?.response?.response?.behavior === 'allow';
        const w = permissionWaiter;
        permissionWaiter = null;
        w(Boolean(allowed));
      }
      return;
    }
    if (parsed.kind === 'control_request') {
      // interrupt 等：直接退出，模拟被中止
      if (parsed.j?.request?.subtype === 'interrupt') {
        process.exit(0);
      }
      if (parsed.j?.request?.subtype === 'stop_task') {
        const taskId = parsed.j.request.task_id;
        if (controlLog) fs.appendFileSync(controlLog, `${process.pid} stop_task ${taskId}\n`);
        emit({
          type: 'control_response',
          response: { subtype: 'success', request_id: parsed.j.request_id, response: {} },
        });
        emit({
          type: 'system',
          subtype: 'task_notification',
          session_id: sessionId,
          task_id: taskId,
          status: 'stopped',
          summary: 'stopped by user',
        });
      }
      if (parsed.j?.request?.subtype === 'set_permission_mode') {
        const mode = parsed.j.request.mode;
        if (controlLog) fs.appendFileSync(controlLog, `${process.pid} ${mode}\n`);
        emit({
          type: 'control_response',
          response: { subtype: 'success', request_id: parsed.j.request_id, response: { mode } },
        });
      }
      return;
    }
    if (parsed.text.trim()) {
      queue.push({ text: parsed.text, uuid: parsed.uuid });
      pump();
    }
  });
  rl.on('close', () => {
    // stdin EOF：结束长驻
    process.exit(0);
  });
} else {
  void runOnce(inline || '').then(() => process.exit(0));
}
