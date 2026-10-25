/**
 * Responses 上游的保活事件与「没有 response.completed 就断开」（amux，Claude Code 经 Messages 入口时一直计时、没有回复）。
 */
import { describe, expect, it } from 'vitest';

import { createStreamConverter, SseParser } from '../src/stream';

const ev = (o: Record<string, unknown>) =>
  `event: ${String(o.type)}\ndata: ${JSON.stringify(o)}\n\n`;
const keepAlive = ev({
  type: 'response.output_text.delta',
  item_id: 'SSE-Keep-Alive',
  output_index: 0,
  content_index: 0,
  delta: '',
  'SSE-Keep-Alive': true,
});
const created = ev({ type: 'response.created', response: { id: 'r1', model: 'm' } });

function events(raw: string) {
  const p = new SseParser();
  return [...p.push(raw), ...p.end()].map((e) => e.event);
}

describe('Responses upstream keep-alive', () => {
  it('a stream of only created + keep-alives that ends early becomes an error, not an empty reply', () => {
    const c = createStreamConverter('responses', 'messages', { model: 'm' });
    const out = c.push(created + keepAlive + keepAlive) + c.end();
    const names = events(out);
    expect(names).toContain('error');
    expect(names).not.toContain('content_block_start');
  });

  it('keep-alives between real deltas are ignored', () => {
    const c = createStreamConverter('responses', 'messages', { model: 'm' });
    const out =
      c.push(
        created +
          keepAlive +
          ev({ type: 'response.output_text.delta', item_id: 'msg', delta: 'hi' }) +
          keepAlive +
          ev({ type: 'response.completed', response: { id: 'r1', usage: {} } }),
      ) + c.end();
    const names = events(out);
    expect(names).not.toContain('error');
    expect(out.match(/text_delta/g)?.length).toBe(1);
  });
});
