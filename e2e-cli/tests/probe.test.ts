/**
 * 必填字段探测（设计 §9.3）：直接对着各 CLI（不经过网关）逐个删除流里的字段、注入未知事件，
 * 得到「这个版本要求什么」的表，与 snapshots/<cli>-<版本>.json 比对。
 *
 * - Grok：按它报的 `missing field` / `expected one of` 读出必填字段与接受的事件全集；
 * - 其余 CLI：删掉一个字段后还能不能正常答出 PROBE（不能 = 必填），以及容不容忍未知事件。
 *
 * 很慢（每个字段起一次 CLI），只在 NOMI_E2E_PROBE=1 时运行；NOMI_E2E_PROBE_UPDATE=1 时写入快照。
 * 本机装的版本没有快照时跳过比对并说明（CLI 升级不让测试变红；要更新就带 UPDATE 跑一次）。
 */
import fs from 'node:fs';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  cliSemver,
  hasCli,
  runClaude,
  runCodex,
  runDsh,
  runGemini,
  runGrok,
  type CliName,
  type CliRun,
} from '../helpers/cli';
import { sseEvent, startUpstream, type FakeUpstream } from '../helpers/upstream';

const PROBE = process.env.NOMI_E2E_PROBE === '1';
const UPDATE = process.env.NOMI_E2E_PROBE_UPDATE === '1';
const SNAPSHOTS = path.join(__dirname, '..', 'snapshots');
const ANSWER = 'PROBE';
/** 每个字段起一次 CLI：一个 CLI 的探测要十几次运行 */
const PROBE_TIMEOUT = 60 * 60_000;

type Obj = Record<string, unknown>;
/** [对象种类, 字段]：['response', 'model'] / ['message', 'role'] / ['delta', 'item_id'] … */
type Drop = [string, string];

/** 按种类删字段的助手：stream 构造器里每个对象都过一遍 */
const stripper =
  (drop?: Drop) =>
  (kind: string, o: Obj): Obj => {
    if (!drop || drop[0] !== kind) return o;
    const c = { ...o };
    delete c[drop[1]];
    return c;
  };

/* ------------------------------- Responses ------------------------------- */

function responsesStream(drop?: Drop, extra?: Obj): string[] {
  const strip = stripper(drop);
  const part = strip('part', { type: 'output_text', text: ANSWER, annotations: [] });
  const msg = strip('message', {
    type: 'message',
    id: 'msg_1',
    role: 'assistant',
    status: 'completed',
    content: [part],
  });
  const resp = (status: string, more: Obj = {}) =>
    strip('response', {
      id: 'r',
      object: 'response',
      status,
      created_at: 1,
      model: 'm',
      output: [],
      ...more,
    });
  let seq = 0;
  const ev = (o: Obj) => sseEvent(strip('event', { ...o, sequence_number: seq++ }));
  const out = [ev({ type: 'response.created', response: resp('in_progress') })];
  if (extra) out.push(sseEvent(extra));
  out.push(
    ev({
      type: 'response.output_item.added',
      output_index: 0,
      item: { ...msg, status: 'in_progress', content: [] },
    }),
    ev(
      strip('delta', {
        type: 'response.output_text.delta',
        item_id: 'msg_1',
        output_index: 0,
        content_index: 0,
        delta: ANSWER,
      }),
    ),
    ev({ type: 'response.output_item.done', output_index: 0, item: msg }),
    ev({
      type: 'response.completed',
      response: resp('completed', {
        output: [msg],
        usage: strip('usage', {
          input_tokens: 1,
          output_tokens: 1,
          total_tokens: 2,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens_details: { reasoning_tokens: 0 },
        }),
      }),
    }),
  );
  return out;
}

const RESPONSES_FIELDS: Drop[] = [
  ['response', 'id'],
  ['response', 'object'],
  ['response', 'status'],
  ['response', 'created_at'],
  ['response', 'model'],
  ['response', 'output'],
  ['message', 'id'],
  ['message', 'role'],
  ['message', 'status'],
  ['message', 'content'],
  ['part', 'annotations'],
  ['delta', 'item_id'],
  ['delta', 'output_index'],
  ['delta', 'content_index'],
  ['event', 'sequence_number'],
];

/** 用量字段（Grok 的快照不含：沿用最初的字段表；Codex 实测要求 total_tokens） */
const RESPONSES_USAGE_FIELDS: Drop[] = [
  ['usage', 'input_tokens'],
  ['usage', 'output_tokens'],
  ['usage', 'total_tokens'],
  ['usage', 'input_tokens_details'],
  ['usage', 'output_tokens_details'],
];

/* -------------------------------- Messages -------------------------------- */

function messagesStream(drop?: Drop, extra?: Obj): string[] {
  const strip = stripper(drop);
  const out = [
    sseEvent({
      type: 'message_start',
      message: strip('message', {
        id: 'm1',
        type: 'message',
        role: 'assistant',
        content: [],
        model: 'm',
        usage: { input_tokens: 1, output_tokens: 0 },
      }),
    }),
  ];
  if (extra) out.push(sseEvent(extra));
  out.push(
    sseEvent(
      strip('block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: strip('block', { type: 'text', text: '' }),
      }),
    ),
    sseEvent(
      strip('block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: strip('delta', { type: 'text_delta', text: ANSWER }),
      }),
    ),
    sseEvent(strip('block_stop', { type: 'content_block_stop', index: 0 })),
    sseEvent(
      strip('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 1 },
      }),
    ),
    sseEvent({ type: 'message_stop' }),
  );
  return out;
}

const MESSAGES_FIELDS: Drop[] = [
  ['message', 'id'],
  ['message', 'type'],
  ['message', 'role'],
  ['message', 'content'],
  ['message', 'model'],
  ['message', 'usage'],
  ['block_start', 'index'],
  ['block', 'type'],
  ['block', 'text'],
  ['block_delta', 'index'],
  ['delta', 'type'],
  ['block_stop', 'index'],
  ['message_delta', 'delta'],
  ['message_delta', 'usage'],
];

/* --------------------------------- Gemini --------------------------------- */

const geminiChunk = (o: Obj) => `data: ${JSON.stringify(o)}\n\n`;

function geminiStream(drop?: Drop, extra?: Obj): string[] {
  const strip = stripper(drop);
  const part = strip('part', { text: ANSWER });
  const content = strip('content', { parts: [part], role: 'model' });
  const candidate = strip('candidate', { content, finishReason: 'STOP', index: 0 });
  return [
    geminiChunk(
      strip('response', {
        candidates: [candidate],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
        modelVersion: 'm',
        ...(extra ?? {}),
      }),
    ),
  ];
}

const GEMINI_FIELDS: Drop[] = [
  ['response', 'candidates'],
  ['response', 'usageMetadata'],
  ['response', 'modelVersion'],
  ['candidate', 'content'],
  ['candidate', 'finishReason'],
  ['candidate', 'index'],
  ['content', 'parts'],
  ['content', 'role'],
  ['part', 'text'],
];

/* ---------------------------------- 驱动 ---------------------------------- */

interface ProbeSpec {
  cli: CliName;
  wire: 'responses' | 'messages' | 'gemini';
  fields: Drop[];
  stream: (drop?: Drop, extra?: Obj) => string[];
  /** 未知事件 / 字段（Gemini 是顶层未知字段） */
  unknown: Obj;
  run: (base: string) => Promise<CliRun>;
}

const answered = (r: CliRun) => r.code === 0 && r.stdout.includes(ANSWER);

const SPECS: ProbeSpec[] = [
  {
    cli: 'codex',
    wire: 'responses',
    fields: [...RESPONSES_FIELDS, ...RESPONSES_USAGE_FIELDS],
    stream: responsesStream,
    unknown: { type: 'response.nomi_probe_unknown' },
    // 关掉重试：每个坏流只跑一次
    run: (base) => runCodex(base, 'm', 'probe', 'request_max_retries=0, stream_max_retries=0'),
  },
  {
    cli: 'dsh',
    wire: 'responses',
    fields: [...RESPONSES_FIELDS, ...RESPONSES_USAGE_FIELDS],
    stream: responsesStream,
    unknown: { type: 'response.nomi_probe_unknown' },
    run: (base) => runDsh(base, 'm', 'probe'),
  },
  {
    cli: 'claude',
    wire: 'messages',
    fields: MESSAGES_FIELDS,
    stream: messagesStream,
    unknown: { type: 'nomi_probe_unknown' },
    run: (base) => runClaude(base, 'm', 'probe'),
  },
  {
    cli: 'gemini',
    wire: 'gemini',
    fields: GEMINI_FIELDS,
    stream: geminiStream,
    unknown: { nomiProbeUnknown: true },
    run: (base) => runGemini(base, 'm', 'probe'),
  },
];

/**
 * 与快照比对：本机版本有快照就比；没有时 UPDATE=1 写入，否则跳过并说明（返回 false）。
 */
function compareSnapshot(
  cli: CliName,
  version: string,
  result: unknown,
  skip: (m: string) => void,
) {
  const file = path.join(SNAPSHOTS, `${cli}-${version}.json`);
  if (UPDATE) {
    fs.mkdirSync(SNAPSHOTS, { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`);
  }
  if (!fs.existsSync(file)) {
    const known = fs
      .readdirSync(SNAPSHOTS)
      .filter((n) => n.startsWith(`${cli}-`))
      .map((n) => n.slice(cli.length + 1, -'.json'.length));
    skip(
      `${cli} ${version} 没有探测快照（已有：${known.join('、') || '无'}）；` +
        '用 NOMI_E2E_PROBE_UPDATE=1 跑一次生成',
    );
    return;
  }
  expect(result).toEqual(JSON.parse(fs.readFileSync(file, 'utf8')));
}

describe.skipIf(!PROBE)('必填字段探测', () => {
  let up: FakeUpstream;
  beforeAll(async () => {
    up = await startUpstream(() => ({ sse: responsesStream() }));
  });
  afterAll(async () => up?.close());

  it.skipIf(!hasCli('grok'))('grok：与快照一致', { timeout: PROBE_TIMEOUT }, async (ctx) => {
    // 直接连假上游（不经过网关）：探测的是 CLI 自己的要求
    const required: string[] = [];
    for (const f of RESPONSES_FIELDS) {
      up.setScenario(() => ({ sse: responsesStream(f) }));
      const r = await runGrok(up.base, 'm', 'probe');
      if (/missing field/.test(r.stdout + r.stderr)) required.push(f.join('.'));
    }
    up.setScenario(() => ({
      sse: responsesStream(undefined, { type: 'response.nomi_probe_unknown' }),
    }));
    const r = await runGrok(up.base, 'm', 'probe');
    const m = /expected one of (.*?) at line/.exec(r.stdout + r.stderr);
    const acceptedEvents = m ? [...m[1]!.matchAll(/`([^`]+)`/g)].map((x) => x[1]!).sort() : [];
    const version = cliSemver('grok');
    const result = { cli: 'grok', version, required: required.sort(), acceptedEvents };
    compareSnapshot('grok', version, result, (msg) => ctx.skip(msg));
  });

  for (const spec of SPECS) {
    it.skipIf(!hasCli(spec.cli))(
      `${spec.cli}：与快照一致`,
      { timeout: PROBE_TIMEOUT },
      async (ctx) => {
        // 基线：完整的流必须能正常答出，否则探测结果没有意义
        up.setScenario(() => ({ sse: spec.stream() }));
        const base = await spec.run(up.base);
        expect(answered(base), `${spec.cli} 基线失败：\n${base.stdout}\n${base.stderr}`).toBe(true);
        const required: string[] = [];
        for (const f of spec.fields) {
          up.setScenario(() => ({ sse: spec.stream(f) }));
          if (!answered(await spec.run(up.base))) required.push(f.join('.'));
        }
        up.setScenario(() => ({ sse: spec.stream(undefined, spec.unknown) }));
        const toleratesUnknown = answered(await spec.run(up.base));
        const version = cliSemver(spec.cli);
        const result = {
          cli: spec.cli,
          version,
          wire: spec.wire,
          required: required.sort(),
          toleratesUnknown,
        };
        compareSnapshot(spec.cli, version, result, (msg) => ctx.skip(msg));
      },
    );
  }
});
