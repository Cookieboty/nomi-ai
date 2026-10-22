/**
 * Responses 入口的流式补全层（ResponsesUsagePatcher）：按事件输出，LF / CRLF 空行都认（#94）。
 */
import { describe, expect, it } from 'vitest';

import { ResponsesUsagePatcher } from '../src/responsesUsage';

const ev = (o: unknown, nl = '\n') => `event: x${nl}data: ${JSON.stringify(o)}${nl}${nl}`;
const delta = { type: 'response.output_text.delta', delta: 'hi' };
const completed = {
  type: 'response.completed',
  response: {
    id: 'r',
    output: [{ type: 'message' }],
    usage: { input_tokens: 3, output_tokens: 2 },
  },
};

describe('ResponsesUsagePatcher', () => {
  it('emits each LF event as soon as it is complete', () => {
    const p = new ResponsesUsagePatcher();
    expect(p.push(ev(delta))).toBe(ev(delta));
  });

  it('emits CRLF events immediately and keeps their bytes', () => {
    const p = new ResponsesUsagePatcher();
    const text = ev(delta, '\r\n');
    expect(p.push(text)).toBe(text);
    expect(p.end()).toBe('');
  });

  it('handles a CRLF separator split across chunks and mixed line endings', () => {
    const p = new ResponsesUsagePatcher();
    const text = ev(delta, '\r\n');
    const cut = text.length - 1; // 切在最后的 \r 与 \n 之间
    expect(p.push(text.slice(0, cut))).toBe('');
    expect(p.push(text.slice(cut))).toBe(text);
    const mixed = `data: ${JSON.stringify(delta)}\n\r\n`;
    expect(p.push(mixed)).toBe(mixed);
  });

  it('patches usage inside a CRLF completed event without losing CRLF', () => {
    const p = new ResponsesUsagePatcher();
    const out = p.push(ev(completed, '\r\n'));
    expect(out).toContain('"input_tokens_details":{"cached_tokens":0}');
    expect(out.endsWith('\r\n\r\n')).toBe(true);
    expect(out).not.toMatch(/[^\r]\n/);
  });
});
