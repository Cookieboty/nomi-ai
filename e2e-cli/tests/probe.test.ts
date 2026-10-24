/**
 * 必填字段探测（设计 §9.3）：直接对着严格客户端（Grok）逐个删除 Responses 流里的字段、注入未知事件，
 * 得到「这个版本要求什么」的表，与 snapshots/ 下的快照比对。CLI 升级导致要求变化时测试失败并给出差异。
 * 很慢（每个字段起一次 CLI），只在 NOMI_E2E_PROBE=1 时运行；NOMI_E2E_PROBE_UPDATE=1 时写入新快照。
 */
import fs from 'node:fs';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { cliVersion, hasCli, runGrok } from '../helpers/cli';
import { sseEvent, startUpstream, type FakeUpstream } from '../helpers/upstream';

const enabled = process.env.NOMI_E2E_PROBE === '1' && hasCli('grok');

type Obj = Record<string, unknown>;

/** 一份完整、合规的流；drop 指定要删除的字段：['response', 'model'] / ['message', 'role'] / ['delta', 'item_id'] … */
function fullStream(drop?: [string, string], extra?: Obj): string[] {
  const strip = (kind: string, o: Obj) => {
    if (drop && drop[0] === kind) {
      const c = { ...o };
      delete c[drop[1]];
      return c;
    }
    return o;
  };
  const part = strip('part', { type: 'output_text', text: 'PROBE', annotations: [] });
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
  );
  out.push(
    ev(
      strip('delta', {
        type: 'response.output_text.delta',
        item_id: 'msg_1',
        output_index: 0,
        content_index: 0,
        delta: 'PROBE',
      }),
    ),
  );
  out.push(ev({ type: 'response.output_item.done', output_index: 0, item: msg }));
  out.push(
    ev({
      type: 'response.completed',
      response: resp('completed', {
        output: [msg],
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens_details: { reasoning_tokens: 0 },
        },
      }),
    }),
  );
  return out;
}

const FIELDS: Array<[string, string]> = [
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

describe.skipIf(!enabled)('Grok 必填字段探测', () => {
  let up: FakeUpstream;
  beforeAll(async () => {
    up = await startUpstream(() => ({ sse: fullStream() }));
  });
  afterAll(async () => up?.close());

  it('与快照一致', async () => {
    // 直接连假上游（不经过网关）：探测的是 CLI 自己的要求
    const base = up.base;
    const required: string[] = [];
    for (const f of FIELDS) {
      up.setScenario(() => ({ sse: fullStream(f) }));
      const r = await runGrok(base, 'm', 'probe');
      if (/missing field/.test(r.stdout + r.stderr)) required.push(f.join('.'));
    }
    up.setScenario(() => ({ sse: fullStream(undefined, { type: 'response.nomi_probe_unknown' }) }));
    const r = await runGrok(base, 'm', 'probe');
    const m = /expected one of (.*?) at line/.exec(r.stdout + r.stderr);
    const acceptedEvents = m ? [...m[1]!.matchAll(/`([^`]+)`/g)].map((x) => x[1]!).sort() : [];

    const version = cliVersion('grok').split(/\s+/)[1] ?? 'unknown';
    const result = { cli: 'grok', version, required: required.sort(), acceptedEvents };
    const file = path.join(__dirname, '..', 'snapshots', `grok-${version}.json`);
    if (process.env.NOMI_E2E_PROBE_UPDATE === '1' || !fs.existsSync(file)) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`);
    }
    expect(result).toEqual(JSON.parse(fs.readFileSync(file, 'utf8')));
  });
});
