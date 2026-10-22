#!/usr/bin/env node
/**
 * 统一网关验收矩阵的协议部分（docs/design/unified-gateway.md §17）：
 * 在本进程里起网关，对真实上游按 Claude Code（Messages 入口）和 Codex（Responses 入口）的请求形状
 * 跑一组场景，转换目标分别强制为 Chat 和 Anthropic，用结果决定各厂商的 preferWire。
 *
 *   pnpm --filter @nomi-ai/gateway build
 *   MATRIX_KEY=sk-... MATRIX_CHAT=https://x/v1 MATRIX_MESSAGES=https://x \
 *     MATRIX_MODELS=z-ai/glm-5.3,moonshotai/kimi-k3 [MATRIX_NO_VISION=deepseek/deepseek-v4-pro] \
 *     node scripts/gateway-matrix.mjs [out.json]
 *
 * Key 只从环境变量读，不写进输出。不需要 Electron。
 */
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

import { createGateway } from '../packages/gateway/dist/index.js';

const KEY = process.env.MATRIX_KEY;
const CHAT = process.env.MATRIX_CHAT;
const MESSAGES = process.env.MATRIX_MESSAGES;
const MODELS = (process.env.MATRIX_MODELS ?? '').split(',').filter(Boolean);
const ONLY = process.env.MATRIX_ONLY; // 只跑名字里含这个串的场景
// 不支持图片的模型（逗号分隔）：网关按 vision:false 把图片换成一行说明（§12.7.3）
const NO_VISION = new Set((process.env.MATRIX_NO_VISION ?? '').split(',').filter(Boolean));
if (!KEY || !MODELS.length || (!CHAT && !MESSAGES)) {
  process.stderr.write(
    '需要 MATRIX_KEY、MATRIX_MODELS，以及 MATRIX_CHAT / MATRIX_MESSAGES 至少一个\n',
  );
  process.exit(2);
}

/* ------------------------------ 素材 ------------------------------ */

/** 16×16 纯红 PNG（不依赖图片库） */
function redPng() {
  const crc = (buf) => {
    let c = ~0;
    for (const b of buf) {
      c ^= b;
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return ~c >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const w = 16;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(w, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3, Buffer.from([255, 0, 0]))]);
  const raw = Buffer.concat(Array.from({ length: w }, () => row));
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]).toString('base64');
}
const PNG = redPng();

const TOOLS = [
  {
    name: 'read_file',
    description: 'Read a file from the workspace and return its contents.',
    schema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Relative file path' } },
      required: ['path'],
    },
  },
  {
    name: 'run_command',
    description: 'Run a shell command in the workspace and return stdout.',
    schema: {
      type: 'object',
      properties: { command: { type: 'string' } },
      required: ['command'],
    },
  },
];

/** MCP 工具里常见的复杂 schema：嵌套对象、数组、anyOf、enum、additionalProperties、$defs */
const COMPLEX_TOOL = {
  name: 'create_issue',
  description: 'Create an issue in the tracker.',
  schema: {
    type: 'object',
    $defs: { label: { type: 'string', enum: ['bug', 'feature', 'docs'] } },
    properties: {
      title: { type: 'string', minLength: 1, maxLength: 200 },
      labels: { type: 'array', items: { $ref: '#/$defs/label' }, uniqueItems: true },
      assignee: { anyOf: [{ type: 'string', format: 'email' }, { type: 'null' }] },
      priority: { type: 'integer', minimum: 1, maximum: 5, default: 3 },
      fields: {
        type: 'object',
        additionalProperties: { oneOf: [{ type: 'string' }, { type: 'number' }] },
      },
      steps: {
        type: 'array',
        items: {
          type: 'object',
          properties: { order: { type: 'integer' }, text: { type: 'string' } },
          required: ['order', 'text'],
          additionalProperties: false,
        },
      },
    },
    required: ['title', 'labels'],
    additionalProperties: false,
  },
};

const PARALLEL_PROMPT =
  'Do both of these at the same time, in a single turn, using the tools: read the file package.json, and run the command `ls`. Call both tools now.';

/* ------------------------------ SSE ------------------------------ */

async function sse(res) {
  const text = await res.text();
  return text
    .split('\n\n')
    .filter(Boolean)
    .map((block) => {
      const ev = /^event: (.+)$/m.exec(block)?.[1];
      const data = block
        .split('\n')
        .filter((l) => l.startsWith('data: '))
        .map((l) => l.slice(6))
        .join('\n');
      try {
        return { ev, data: JSON.parse(data) };
      } catch {
        return { ev, data };
      }
    });
}

/** Messages 流 → assistant content（含 thinking 签名、tool_use） */
async function readMessages(res) {
  const evs = await sse(res);
  const blocks = [];
  let stop;
  let error;
  for (const { ev, data } of evs) {
    if (ev === 'error' || data?.type === 'error')
      error = data?.error?.message ?? JSON.stringify(data);
    if (data?.type === 'content_block_start')
      blocks[data.index] = { ...data.content_block, _json: '' };
    if (data?.type === 'content_block_delta') {
      const b = blocks[data.index];
      const d = data.delta;
      if (d.type === 'text_delta') b.text = (b.text ?? '') + d.text;
      if (d.type === 'thinking_delta') b.thinking = (b.thinking ?? '') + d.thinking;
      if (d.type === 'signature_delta') b.signature = (b.signature ?? '') + d.signature;
      if (d.type === 'input_json_delta') b._json += d.partial_json;
    }
    if (data?.type === 'message_delta') stop = data.delta?.stop_reason;
  }
  const content = blocks.filter(Boolean).map(({ _json, ...b }) => {
    if (b.type === 'tool_use') b.input = _json ? JSON.parse(_json) : (b.input ?? {});
    return b;
  });
  return { content, stop, error };
}

/** Responses 流 → response.completed 里的 output */
async function readResponses(res) {
  const evs = await sse(res);
  const done = evs.find(
    (e) => e.data?.type === 'response.completed' || e.ev === 'response.completed',
  );
  const failed = evs.find((e) => /failed|error/.test(e.data?.type ?? e.ev ?? ''));
  return {
    output: done?.data?.response?.output ?? [],
    status: done?.data?.response?.status,
    error: done
      ? undefined
      : (failed?.data?.response?.error?.message ??
        failed?.data?.message ??
        JSON.stringify(failed?.data ?? evs.at(-1)?.data)),
  };
}

/* ------------------------------ 场景 ------------------------------ */

const anthTools = (list) =>
  list.map((t) => ({ name: t.name, description: t.description, input_schema: t.schema }));
const respTools = (list) =>
  list.map((t) => ({
    type: 'function',
    name: t.name,
    description: t.description,
    parameters: t.schema,
  }));

function fakeResult(name) {
  return name === 'read_file'
    ? '{"name":"demo","version":"1.0.0"}'
    : 'package.json\nsrc\nREADME.md';
}

function messagesScenarios(post) {
  const call = (body) =>
    post('/v1/messages', { max_tokens: 2048, stream: true, ...body }, 'claude');
  const toolTurn = async (extra) => {
    const messages = [{ role: 'user', content: PARALLEL_PROMPT }];
    const r1 = await readMessages(await call({ ...extra, tools: anthTools(TOOLS), messages }));
    if (r1.error) return { ok: false, note: r1.error };
    const uses = r1.content.filter((b) => b.type === 'tool_use');
    if (!uses.length) return { ok: false, note: `没有工具调用（stop=${r1.stop}）` };
    const thinking = r1.content.filter((b) => b.type === 'thinking');
    messages.push({ role: 'assistant', content: r1.content });
    messages.push({
      role: 'user',
      content: uses.map((u) => ({
        type: 'tool_result',
        tool_use_id: u.id,
        content: fakeResult(u.name),
      })),
    });
    const r2 = await readMessages(await call({ ...extra, tools: anthTools(TOOLS), messages }));
    if (r2.error) return { ok: false, note: `第二轮：${r2.error}` };
    const text = r2.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('');
    return {
      ok: Boolean(text || r2.content.some((b) => b.type === 'tool_use')),
      note: `${uses.length} 个并行工具${thinking.length ? `，thinking ${thinking.length} 块${thinking.some((t) => t.signature) ? '（带签名）' : ''}` : ''}`,
    };
  };
  return {
    'messages/parallel-tools': () => toolTurn({}),
    'messages/thinking-tools': () =>
      toolTurn({ max_tokens: 4096, thinking: { type: 'enabled', budget_tokens: 2048 } }),
    'messages/image': async () => {
      const r = await readMessages(
        await call({
          messages: [
            {
              role: 'user',
              content: [
                { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } },
                { type: 'text', text: 'What color is this image? Answer in one word.' },
              ],
            },
          ],
        }),
      );
      const text = r.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('');
      return { ok: !r.error && Boolean(text), note: r.error ?? text.slice(0, 40) };
    },
    'messages/complex-schema': async () => {
      const r = await readMessages(
        await call({
          tools: anthTools([COMPLEX_TOOL]),
          messages: [
            {
              role: 'user',
              content:
                'File a bug titled "Crash on start" with label bug, priority 2. Use the tool.',
            },
          ],
        }),
      );
      const use = r.content.find((b) => b.type === 'tool_use');
      return {
        ok: !r.error,
        note: r.error ?? (use ? `调用了 ${use.name}` : '没调用工具（请求本身成功）'),
      };
    },
  };
}

function responsesScenarios(post) {
  const call = (body) => post('/v1/responses', { stream: true, ...body }, 'codex');
  const toolTurn = async (extra) => {
    const input = [{ role: 'user', content: [{ type: 'input_text', text: PARALLEL_PROMPT }] }];
    const r1 = await readResponses(await call({ ...extra, tools: respTools(TOOLS), input }));
    if (r1.error) return { ok: false, note: r1.error };
    const calls = r1.output.filter((o) => o.type === 'function_call');
    if (!calls.length) return { ok: false, note: '没有工具调用' };
    const reasoning = r1.output.filter((o) => o.type === 'reasoning');
    input.push(...r1.output);
    for (const c of calls)
      input.push({ type: 'function_call_output', call_id: c.call_id, output: fakeResult(c.name) });
    const r2 = await readResponses(await call({ ...extra, tools: respTools(TOOLS), input }));
    if (r2.error) return { ok: false, note: `第二轮：${r2.error}` };
    return {
      ok: r2.output.length > 0,
      note: `${calls.length} 个并行工具${reasoning.length ? `，reasoning ${reasoning.length} 项` : ''}`,
    };
  };
  return {
    'responses/parallel-tools': () => toolTurn({}),
    'responses/reasoning-tools': () =>
      toolTurn({ reasoning: { effort: 'medium' }, include: ['reasoning.encrypted_content'] }),
    'responses/apply-patch': async () => {
      const tools = [
        {
          type: 'custom',
          name: 'apply_patch',
          description:
            'Apply a patch. The input is a patch in this format:\n*** Begin Patch\n*** Add File: <path>\n+<line>\n*** End Patch',
        },
      ];
      const input = [
        {
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: 'Create hello.txt containing the single line "hi" using apply_patch.',
            },
          ],
        },
      ];
      const r1 = await readResponses(await call({ tools, input }));
      if (r1.error) return { ok: false, note: r1.error };
      const c = r1.output.find((o) => o.type === 'custom_tool_call');
      if (!c)
        return {
          ok: false,
          note: `没有 custom_tool_call（${r1.output.map((o) => o.type).join(',')}）`,
        };
      input.push(...r1.output, {
        type: 'custom_tool_call_output',
        call_id: c.call_id,
        output: 'Done!',
      });
      const r2 = await readResponses(await call({ tools, input }));
      return {
        ok: !r2.error,
        note: r2.error ?? `patch ${/\*\*\* Begin Patch/.test(c.input) ? '格式正确' : '格式不对'}`,
      };
    },
    'responses/image': async () => {
      const r = await readResponses(
        await call({
          input: [
            {
              role: 'user',
              content: [
                { type: 'input_image', image_url: `data:image/png;base64,${PNG}` },
                { type: 'input_text', text: 'What color is this image? Answer in one word.' },
              ],
            },
          ],
        }),
      );
      const text = r.output
        .filter((o) => o.type === 'message')
        .flatMap((o) => o.content)
        .map((c) => c.text ?? '')
        .join('');
      return { ok: !r.error && Boolean(text), note: r.error ?? text.slice(0, 40) };
    },
  };
}

/* ------------------------------ 运行 ------------------------------ */

const targets = [
  ...(CHAT ? [{ id: 'up-chat', wire: 'chat', urls: { chat: CHAT } }] : []),
  ...(MESSAGES ? [{ id: 'up-messages', wire: 'messages', urls: { messages: MESSAGES } }] : []),
];
const providers = targets.map((t) => ({
  id: t.id,
  name: t.id,
  enabled: true,
  urls: t.urls,
  keys: [{ id: 'k', value: KEY, enabled: true }],
  models: MODELS.map((id) => ({
    id,
    enabled: true,
    ...(NO_VISION.has(id) ? { vision: false } : {}),
  })),
}));
const gw = createGateway({
  host: '127.0.0.1',
  port: 0,
  providers,
  clients: {
    claude: { token: 'tok-claude', models: {} },
    codex: { token: 'tok-codex', models: {} },
  },
});
await gw.start();
const base = gw.listenUrl();

const results = [];
for (const model of MODELS) {
  for (const t of targets) {
    const ref = `${t.id}/${model}`;
    const post = (path, body, client) =>
      fetch(`${base}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(client === 'claude'
            ? { 'x-api-key': 'tok-claude', 'anthropic-version': '2023-06-01' }
            : { authorization: 'Bearer tok-codex' }),
        },
        body: JSON.stringify({ ...body, model: ref }),
        signal: AbortSignal.timeout(180_000),
      });
    const scenarios = { ...messagesScenarios(post), ...responsesScenarios(post) };
    for (const [name, run] of Object.entries(scenarios)) {
      if (ONLY && !name.includes(ONLY)) continue;
      const started = Date.now();
      let r;
      try {
        r = await run();
      } catch (e) {
        r = { ok: false, note: `异常：${e.message}` };
      }
      const row = {
        model,
        target: t.wire,
        scenario: name,
        ok: r.ok,
        note: String(r.note ?? '').slice(0, 200),
        ms: Date.now() - started,
      };
      results.push(row);
      process.stdout.write(
        `${r.ok ? '✓' : '✗'} ${model} → ${t.wire} · ${name} · ${row.note} (${row.ms}ms)\n`,
      );
    }
  }
}
gw.stop();
const out = process.argv[2];
if (out) writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
process.exit(results.every((r) => r.ok) ? 0 : 1);
