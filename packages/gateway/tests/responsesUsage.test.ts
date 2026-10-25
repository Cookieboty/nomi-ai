/**
 * Responses 入口的流式补全层（canonical/responses 的 ResponsesCanonicalizer，原 ResponsesUsagePatcher）：按事件输出，LF / CRLF 空行都认（#94）。
 */
import { describe, expect, it } from 'vitest';

import {
  completeResponsesBody,
  ResponsesCanonicalizer as ResponsesUsagePatcher,
} from '../src/canonical/responses';
import { RESPONSES_EVENTS } from '../src/spec/responses';

const ev = (o: unknown, nl = '\n') => `event: x${nl}data: ${JSON.stringify(o)}${nl}${nl}`;
const delta = {
  type: 'response.output_text.delta',
  item_id: 'msg_1',
  output_index: 0,
  content_index: 0,
  delta: 'hi',
  sequence_number: 0,
};
const completed = {
  type: 'response.completed',
  sequence_number: 1,
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

describe('ResponsesUsagePatcher: strict-client fixes (amux → Grok 1.0.67)', () => {
  const keepAlive = {
    type: 'response.output_text.delta',
    item_id: 'SSE-Keep-Alive',
    output_index: 0,
    content_index: 0,
    delta: '',
    'SSE-Keep-Alive': true,
  };
  const data = (s: string) =>
    s
      .split('\n\n')
      .filter(Boolean)
      .map((b) => JSON.parse(b.split('data: ')[1]!) as Record<string, any>);

  it('drops keep-alive events', () => {
    const p = new ResponsesUsagePatcher();
    expect(p.push(ev(keepAlive))).toBe('');
  });

  it('fills a missing sequence_number after the last seen one', () => {
    const p = new ResponsesUsagePatcher();
    const first = { ...delta, sequence_number: 4 };
    expect(p.push(ev(first))).toBe(ev(first));
    const { sequence_number: _, ...bare } = delta;
    expect(data(p.push(ev(bare)))[0]!.sequence_number).toBe(5);
  });

  it('adds summary: [] to reasoning items in item events and completed output', () => {
    const p = new ResponsesUsagePatcher();
    const reasoning = { type: 'reasoning', id: 'r1', status: 'completed' };
    const done = { type: 'response.output_item.done', output_index: 0, item: reasoning };
    expect(data(p.push(ev(done)))[0]!.item.summary).toEqual([]);
    const fin = {
      type: 'response.completed',
      response: { id: 'r', output: [reasoning], usage: { input_tokens: 1, output_tokens: 1 } },
    };
    expect(data(p.push(ev(fin)))[0]!.response.output[0].summary).toEqual([]);
  });
});

describe('ResponsesUsagePatcher: required fields (each one verified against Grok 1.0.67)', () => {
  const one = (p: ResponsesUsagePatcher, o: unknown) =>
    JSON.parse(p.push(ev(o)).split('data: ')[1]!) as Record<string, any>;

  it('response.created without model / output (real upstream event)', () => {
    const p = new ResponsesUsagePatcher('amux/openai/gpt-6-sol');
    const out = one(p, {
      response: { id: 'resp_0', object: 'response', status: 'in_progress', created_at: 1792770018 },
      sequence_number: 0,
      type: 'response.created',
    });
    expect(out.response).toEqual({
      id: 'resp_0',
      object: 'response',
      status: 'in_progress',
      created_at: 1792770018,
      model: 'amux/openai/gpt-6-sol',
      output: [],
    });
  });

  it('later response events reuse the first id / created_at; status follows the event type', () => {
    const p = new ResponsesUsagePatcher('m');
    one(p, { type: 'response.created', response: { id: 'r9', created_at: 5 } });
    const done = one(p, { type: 'response.completed', response: {} });
    expect(done.response).toMatchObject({
      id: 'r9',
      created_at: 5,
      status: 'completed',
      model: 'm',
    });
  });

  it('message items get id / role / status / content / annotations', () => {
    const p = new ResponsesUsagePatcher();
    const added = one(p, {
      type: 'response.output_item.added',
      output_index: 0,
      item: { type: 'message' },
    });
    expect(added.item).toEqual({
      type: 'message',
      id: 'item_nomi_0',
      role: 'assistant',
      status: 'in_progress',
      content: [],
    });
    const done = one(p, {
      type: 'response.output_item.done',
      output_index: 0,
      item: { type: 'message', id: 'm1', content: [{ type: 'output_text', text: 'x' }] },
    });
    expect(done.item.content[0].annotations).toEqual([]);
    expect(done.item.status).toBe('completed');
  });

  it('deltas missing item_id / output_index / content_index are filled from the item', () => {
    const p = new ResponsesUsagePatcher();
    one(p, {
      type: 'response.output_item.added',
      output_index: 2,
      item: { type: 'message', id: 'm2', role: 'assistant', status: 'in_progress', content: [] },
    });
    expect(one(p, { type: 'response.output_text.delta', delta: 'a' })).toMatchObject({
      item_id: 'm2',
      output_index: 2,
      content_index: 0,
    });
    expect(
      one(p, { type: 'response.function_call_arguments.delta', item_id: 'm2', delta: '{' }),
    ).not.toHaveProperty('content_index');
  });

  it('function_call items get call_id / arguments', () => {
    const p = new ResponsesUsagePatcher();
    const out = one(p, {
      type: 'response.output_item.done',
      output_index: 0,
      item: { type: 'function_call', id: 'fc1', name: 'ls' },
    });
    expect(out.item).toMatchObject({ call_id: 'fc1', arguments: '' });
  });
});

describe('completeResponsesBody', () => {
  it('leaves error bodies alone', () => {
    const body = { error: { message: 'bad' } };
    expect(completeResponsesBody(body, 'm')).toBe(body);
  });
});

describe('ResponsesUsagePatcher: non-standard event types', () => {
  it('drops events outside the official list (amux response.metadata)', () => {
    const p = new ResponsesUsagePatcher();
    expect(p.push(ev({ type: 'response.metadata', sequence_number: 3, metadata: {} }))).toBe('');
  });

  it('keeps official events Codex relies on', () => {
    const p = new ResponsesUsagePatcher();
    const e = {
      type: 'response.custom_tool_call_input.delta',
      sequence_number: 1,
      item_id: 'c1',
      output_index: 0,
      delta: 'x',
    };
    expect(p.push(ev(e))).toBe(ev(e));
  });
});

describe('official Responses event list', () => {
  it('matches the event types the strictest client accepts (e2e-cli probe snapshot)', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const dir = path.join(__dirname, '..', '..', '..', 'e2e-cli', 'snapshots');
    const snaps = fs.existsSync(dir)
      ? fs.readdirSync(dir).filter((f) => f.startsWith('grok-'))
      : [];
    for (const f of snaps) {
      const snap = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as {
        acceptedEvents: string[];
      };
      expect([...RESPONSES_EVENTS].sort(), f).toEqual([...snap.acceptedEvents].sort());
    }
  });
});
