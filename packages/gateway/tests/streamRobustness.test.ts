/**
 * 上游流的非标准情况（与具体中转站无关）：没有结束标记、只给完整条目、Chat 工具调用的各种写法、
 * Gemini 生成了非法工具调用。
 */
import { describe, expect, it } from 'vitest';

import { createStreamConverter, SseParser, type UpstreamStreamFormat } from '../src/stream';
import { TerminalWatch } from '../src/stream/passthrough';
import { SseSplitter } from '../src/stream/sse';

const data = (o: unknown) => `data: ${typeof o === 'string' ? o : JSON.stringify(o)}\n\n`;
const ev = (o: Record<string, unknown>) =>
  `event: ${String(o.type)}\ndata: ${JSON.stringify(o)}\n\n`;

function toMessages(from: UpstreamStreamFormat, raw: string) {
  const c = createStreamConverter(from, 'messages', { model: 'm' });
  const p = new SseParser();
  return [...p.push(c.push(raw) + c.end()), ...p.end()].map((e) => ({
    event: e.event,
    data: JSON.parse(e.data) as Record<string, any>,
  }));
}
const text = (evs: ReturnType<typeof toMessages>) =>
  evs
    .filter((e) => e.data.delta?.type === 'text_delta')
    .map((e) => e.data.delta.text as string)
    .join('');
const tools = (evs: ReturnType<typeof toMessages>) =>
  evs.filter((e) => e.data.content_block?.type === 'tool_use').map((e) => e.data.content_block);
const args = (evs: ReturnType<typeof toMessages>) =>
  evs
    .filter((e) => e.data.delta?.type === 'input_json_delta')
    .map((e) => e.data.delta.partial_json as string)
    .join('');

describe('TerminalWatch (same-wire passthrough)', () => {
  const cases: Array<[UpstreamStreamFormat, string, string]> = [
    [
      'chat',
      data({ choices: [{ index: 0, delta: { content: 'a' } }] }),
      data({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
    ],
    ['messages', ev({ type: 'message_start', message: { id: 'm' } }), ev({ type: 'message_stop' })],
    [
      'responses',
      ev({ type: 'response.created', response: { id: 'r' } }),
      ev({ type: 'response.completed', response: { id: 'r' } }),
    ],
    [
      'gemini',
      data({ candidates: [{ content: { parts: [{ text: 'a' }] } }] }),
      data({ candidates: [{ content: { parts: [] }, finishReason: 'STOP' }] }),
    ],
  ];
  for (const [wire, body, end] of cases) {
    it(`${wire}: cut-off stream is not terminated, a finished one is`, () => {
      const cut = new TerminalWatch(wire);
      cut.push(body);
      expect(cut.terminated).toBe(false);
      const ok = new TerminalWatch(wire);
      ok.push(body + end.trimEnd()); // 最后一个事件不带结尾空行也算
      expect(ok.terminated).toBe(true);
    });
  }
});

describe('Responses upstream that only sends whole items', () => {
  it('text only in output_item.done', () => {
    const evs = toMessages(
      'responses',
      ev({ type: 'response.created', response: { id: 'r' } }) +
        ev({
          type: 'response.output_item.done',
          output_index: 0,
          item: { type: 'message', id: 'msg1', content: [{ type: 'output_text', text: '你好' }] },
        }) +
        ev({ type: 'response.completed', response: { id: 'r', output: [] } }),
    );
    expect(text(evs)).toBe('你好');
  });

  it('text and tool call only in response.completed', () => {
    const evs = toMessages(
      'responses',
      ev({
        type: 'response.completed',
        response: {
          id: 'r',
          output: [
            { type: 'message', id: 'msg1', content: [{ type: 'output_text', text: 'ok' }] },
            { type: 'function_call', id: 'fc1', call_id: 'call_1', name: 'ls', arguments: '{}' },
          ],
        },
      }),
    );
    expect(text(evs)).toBe('ok');
    expect(tools(evs)).toMatchObject([{ id: 'call_1', name: 'ls' }]);
    expect(evs.at(-1)!.event).toBe('message_stop');
  });

  it('streamed deltas are not repeated from the completed output', () => {
    const evs = toMessages(
      'responses',
      ev({ type: 'response.output_text.delta', delta: 'ok' }) +
        ev({
          type: 'response.output_item.done',
          item: { type: 'message', id: 'msg1', content: [{ type: 'output_text', text: 'ok' }] },
        }) +
        ev({
          type: 'response.completed',
          response: {
            output: [
              { type: 'message', id: 'msg1', content: [{ type: 'output_text', text: 'ok' }] },
            ],
          },
        }),
    );
    expect(text(evs)).toBe('ok');
  });
});

describe('Chat tool call variants', () => {
  const stop = data({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });

  it('tool_calls without index, two calls in two chunks', () => {
    const call = (id: string, name: string) =>
      data({
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ id, type: 'function', function: { name, arguments: '{}' } }] },
          },
        ],
      });
    const evs = toMessages('chat', call('c1', 'ls') + call('c2', 'pwd') + stop);
    expect(tools(evs).map((t) => t.name)).toEqual(['ls', 'pwd']);
  });

  it('a new id on every chunk without a name does not split the call', () => {
    const part = (id: string, fn: Record<string, unknown>) =>
      data({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id, function: fn }] } }] });
    const evs = toMessages(
      'chat',
      part('a', { name: 'ls', arguments: '{"p":' }) + part('b', { arguments: '1}' }) + stop,
    );
    expect(tools(evs)).toHaveLength(1);
    expect(args(evs)).toBe('{"p":1}');
  });

  it('arguments given as an object', () => {
    const evs = toMessages(
      'chat',
      data({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [{ index: 0, id: 'c1', function: { name: 'ls', arguments: { p: 1 } } }],
            },
          },
        ],
      }) + stop,
    );
    expect(args(evs)).toBe('{"p":1}');
  });

  it('content as an array of text / thinking parts', () => {
    const evs = toMessages(
      'chat',
      data({
        choices: [
          {
            index: 0,
            delta: {
              content: [
                { type: 'thinking', thinking: [{ type: 'text', text: '想' }] },
                { type: 'text', text: '答' },
              ],
            },
          },
        ],
      }) + data({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
    );
    expect(text(evs)).toBe('答');
  });
});

describe('Gemini invalid tool call', () => {
  it('MALFORMED_FUNCTION_CALL → error, not an empty reply', () => {
    const evs = toMessages(
      'gemini',
      data({ candidates: [{ content: { parts: [] }, finishReason: 'MALFORMED_FUNCTION_CALL' }] }),
    );
    expect(evs.at(-1)!.event).toBe('error');
    expect(evs.at(-1)!.data.error.message).toMatch(/MALFORMED_FUNCTION_CALL/);
  });
});

describe('SseSplitter', () => {
  it('splits at every boundary regardless of chunking (LF / CRLF across chunks)', () => {
    const text = 'data: a\n\nevent: x\r\ndata: b\r\n\r\ndata: c\n\r\ndata: tail';
    for (let size = 1; size <= text.length; size++) {
      const s = new SseSplitter();
      const blocks: string[] = [];
      for (let i = 0; i < text.length; i += size)
        for (const b of s.push(text.slice(i, i + size))) blocks.push(b.body + b.sep);
      expect(blocks).toEqual(['data: a\n\n', 'event: x\r\ndata: b\r\n\r\n', 'data: c\n\r\n']);
      expect(s.take()).toBe('data: tail');
    }
  });

  it('one large event in many chunks stays linear', () => {
    const s = new SseSplitter();
    const big = `data: ${'A'.repeat(4 * 1024 * 1024)}\n\n`;
    const t0 = performance.now();
    let n = 0;
    for (let i = 0; i < big.length; i += 16 * 1024) n += s.push(big.slice(i, i + 16 * 1024)).length;
    expect(n).toBe(1);
    // 原来逐片从头扫描 + 拼整串是 O(n²)，这里约 100ms；线性实现只要几毫秒
    expect(performance.now() - t0).toBeLessThan(60);
  });
});
