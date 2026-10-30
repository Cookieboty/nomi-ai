/**
 * 规范化层的故障注入（docs/design/cli-plugin-architecture.md §9.2、P4.8）：
 * - 编码器自检：所有编码器产出必须通过目标协议的规范校验；
 * - 随机删必填字段、插未知事件、伪装保活：规范化后的 Responses 流通过规范校验；补出的序号不倒序；
 * - 任意位置截断（透传与转换）：一定变成失败事件，不会被当成正常完成。
 */
import { describe, expect, it } from 'vitest';

import { createBridge, bridgeMode } from '../src/bridge';
import { ResponsesCanonicalizer } from '../src/canonical/responses';
import type { Wire } from '../src/ir';
import { parseSpecEvents, specOf, validateSse } from '../src/spec/index';
import {
  ChatCompletionsEncoder,
  GeminiEncoder,
  MessagesEncoder,
  ResponsesEncoder,
} from '../src/stream/encoders';
import type { NormEvent, StreamEncoder } from '../src/stream/events';

const WIRES: Wire[] = ['responses', 'chat', 'messages', 'gemini'];

/** 确定的伪随机数（mulberry32） */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function encoder(w: Wire): StreamEncoder {
  switch (w) {
    case 'messages':
      return new MessagesEncoder('m');
    case 'responses':
      return new ResponsesEncoder('m');
    case 'chat':
      return new ChatCompletionsEncoder('m');
    case 'gemini':
      return new GeminiEncoder('m');
  }
}

const textTurn: NormEvent[] = [
  { type: 'start', id: 'msg_1', model: 'm', usage: { inputTokens: 5 } },
  { type: 'think_start' },
  { type: 'think', text: 'Let me think.' },
  { type: 'text', text: 'Hello' },
  { type: 'text', text: ', world' },
  { type: 'finish', reason: 'end_turn', usage: { inputTokens: 5, outputTokens: 3 } },
];
const toolTurn: NormEvent[] = [
  { type: 'start', id: 'msg_2', model: 'm' },
  { type: 'text', text: 'Calling.' },
  { type: 'tool_start', key: '0', id: 'call_1', name: 'read_file' },
  { type: 'tool_args', key: '0', delta: '{"path":' },
  { type: 'tool_args', key: '0', delta: '"a.ts"}' },
  { type: 'tool_end', key: '0' },
  { type: 'finish', reason: 'tool_use', usage: { inputTokens: 9, outputTokens: 4 } },
];

function encode(w: Wire, evs: NormEvent[]): string {
  const enc = encoder(w);
  return evs.map((e) => enc.encode(e)).join('') + enc.end();
}

/** 协议桥输出（透传或转换）：上游 SSE 全文一次性推入 */
function bridged(from: Wire, to: Wire, upstream: string, cut?: number): string {
  const b = createBridge({
    from,
    to,
    mode: bridgeMode(from, to),
    model: 'm',
    fixes: {},
  });
  const text = cut === undefined ? upstream : upstream.slice(0, cut);
  return b.push(text) + b.end();
}

describe('encoder self-check (§6.5)', () => {
  for (const w of WIRES)
    for (const [name, turn] of [
      ['text', textTurn],
      ['tool', toolTurn],
    ] as const)
      it(`${w} encoder output passes the ${w} spec (${name} turn)`, () => {
        const out = w === 'responses' ? bridged(w, w, encode(w, turn)) : encode(w, turn);
        expect(validateSse(w, out)).toEqual([]);
      });

  for (const from of WIRES)
    for (const to of WIRES)
      it(`bridge ${from} → ${to} output passes the ${to} spec`, () => {
        for (const turn of [textTurn, toolTurn])
          expect(validateSse(to, bridged(from, to, encode(from, turn)))).toEqual([]);
      });
});

/** Responses 事件里规范化能补的字段（按事件类型） */
const DELETABLE: Array<(o: Record<string, unknown>) => boolean> = [
  (o) => delete o.sequence_number,
  (o) => delete o.item_id,
  (o) => delete o.output_index,
  (o) => delete o.content_index,
  (o) => (o.response ? delete (o.response as Record<string, unknown>).id : false),
  (o) => (o.response ? delete (o.response as Record<string, unknown>).model : false),
  (o) => (o.response ? delete (o.response as Record<string, unknown>).created_at : false),
  (o) => (o.response ? delete (o.response as Record<string, unknown>).status : false),
  (o) => (o.response ? delete (o.response as Record<string, unknown>).object : false),
  (o) => (o.item ? delete (o.item as Record<string, unknown>).status : false),
  (o) => (o.item ? delete (o.item as Record<string, unknown>).role : false),
  (o) => (o.item ? delete (o.item as Record<string, unknown>).call_id : false),
  (o) => (o.item ? delete (o.item as Record<string, unknown>).summary : false),
];

function inject(stream: string, seed: number): string {
  const r = rng(seed);
  const out: string[] = [];
  for (const ev of parseSpecEvents(stream)) {
    // 伪装成正文增量的保活、未知的私有事件
    if (r() < 0.2)
      out.push(
        `data: ${JSON.stringify({ type: 'response.output_text.delta', item_id: 'SSE-Keep-Alive', delta: '' })}\n\n`,
      );
    if (r() < 0.15) out.push(`data: ${JSON.stringify({ type: 'response.metadata', x: 1 })}\n\n`);
    const d = structuredClone(ev.data ?? {});
    for (const del of DELETABLE) if (r() < 0.25) del(d);
    out.push(`event: ${String(d.type)}\ndata: ${JSON.stringify(d)}\n\n`);
  }
  return out.join('');
}

describe('fault injection: Responses canonicalizer (§6.4)', () => {
  const clean = bridged('responses', 'responses', encode('responses', toolTurn));

  it('random missing fields / unknown events / fake keepalives → output passes the spec', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const faulty = inject(clean, seed);
      const c = new ResponsesCanonicalizer('m');
      const out = c.push(faulty) + c.end();
      expect(validateSse('responses', out), `seed ${seed}`).toEqual([]);
    }
  });

  it('filled sequence numbers never go backwards', () => {
    for (let seed = 1; seed <= 100; seed++) {
      const c = new ResponsesCanonicalizer('m');
      const out = c.push(inject(clean, seed)) + c.end();
      const seq = parseSpecEvents(out).map((e) => e.data?.sequence_number as number);
      for (let i = 1; i < seq.length; i++)
        expect(seq[i]!, `seed ${seed}`).toBeGreaterThan(seq[i - 1]!);
    }
  });

  it('chunk boundaries do not matter (same output for any split)', () => {
    const faulty = inject(clean, 7);
    const whole = new ResponsesCanonicalizer('m');
    const want = whole.push(faulty) + whole.end();
    const r = rng(99);
    for (let n = 0; n < 50; n++) {
      const c = new ResponsesCanonicalizer('m');
      let out = '';
      let i = 0;
      while (i < faulty.length) {
        const step = 1 + Math.floor(r() * 40);
        out += c.push(faulty.slice(i, i + step));
        i += step;
      }
      out += c.end();
      // response 的 id / created_at 在补全时用了当前时间：只比较事件结构
      const norm = (s: string) =>
        s.replace(/resp_nomi_[a-z0-9]+/g, 'R').replace(/"created_at":\d+/g, 'T');
      expect(norm(out)).toBe(norm(want));
    }
  });
});

describe('fault injection: truncation anywhere becomes a failure', () => {
  for (const from of WIRES)
    for (const to of WIRES)
      it(`${from} → ${to}`, () => {
        const up = encode(from, toolTurn);
        const spec = specOf(from);
        // 第一个结束事件开始的位置：在它之前任意位置截断都必须失败
        let terminalAt = -1;
        for (let at = 0, m: RegExpExecArray | null; (m = /\r?\n\r?\n/.exec(up.slice(at)));) {
          const end = at + m.index + m[0].length;
          const ev = parseSpecEvents(up.slice(at, end))[0];
          if (ev && spec.isTerminal(ev)) {
            terminalAt = at;
            break;
          }
          at = end;
        }
        expect(terminalAt).toBeGreaterThan(0);
        const r = rng(from.length * 31 + to.length);
        const cuts = new Set<number>([0, 1, terminalAt - 1]);
        for (let k = 0; k < 40; k++) cuts.add(Math.floor(r() * terminalAt));
        for (const cut of cuts) {
          const out = bridged(from, to, up, cut);
          const evs = parseSpecEvents(out);
          const toSpec = specOf(to);
          const terminal = evs.filter((e) => toSpec.isTerminal(e));
          expect(terminal.length, `cut ${cut}: ${out.slice(-300)}`).toBeGreaterThan(0);
          expect(toSpec.isError(terminal[0]!), `cut ${cut}: ${out.slice(-300)}`).toBe(true);
        }
      });
});
