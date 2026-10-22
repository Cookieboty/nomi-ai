import { describe, it, expect } from 'vitest';

import { jsonToSse, SseParser } from '../src/stream';

function parse(raw: string) {
  const p = new SseParser();
  return [...p.push(raw), ...p.end()].map((e) => ({
    event: e.event,
    data: e.data === '[DONE]' ? '[DONE]' : (JSON.parse(e.data) as any),
  }));
}

describe('jsonToSse fallback', () => {
  it('gemini functionCall JSON → Messages tool_use', () => {
    const evs = parse(
      jsonToSse('gemini', 'messages', {
        candidates: [
          {
            content: { parts: [{ functionCall: { name: 'grep', args: { q: 1 } } }] },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 3 },
      }),
    );
    expect(evs.find((e) => e.event === 'content_block_start')!.data.content_block).toMatchObject({
      type: 'tool_use',
      name: 'grep',
    });
    expect(evs.find((e) => e.event === 'message_delta')!.data.delta.stop_reason).toBe('tool_use');
  });

  it('responses function_call JSON → Messages tool_use', () => {
    const evs = parse(
      jsonToSse('responses', 'messages', {
        id: 'resp_1',
        output: [
          {
            type: 'function_call',
            id: 'fc_1',
            call_id: 'call_1',
            name: 'shell',
            arguments: '{"c":"ls"}',
          },
        ],
      }),
    );
    const delta = evs.find((e) => e.event === 'content_block_delta')!;
    expect(delta.data.delta).toEqual({ type: 'input_json_delta', partial_json: '{"c":"ls"}' });
  });

  it('chat JSON → Responses with function_call item and usage', () => {
    const evs = parse(
      jsonToSse('chat', 'responses', {
        id: 'c',
        choices: [
          {
            message: { tool_calls: [{ id: 'call_x', function: { name: 'f', arguments: '{}' } }] },
            finish_reason: 'tool_calls',
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
    );
    const done = evs[evs.length - 1].data.response;
    expect(done.output[0]).toMatchObject({
      type: 'function_call',
      call_id: 'call_x',
      name: 'f',
      arguments: '{}',
    });
    expect(done.usage.total_tokens).toBe(2);
  });

  it('messages JSON → Chat chunks ending in [DONE]', () => {
    const evs = parse(
      jsonToSse('messages', 'chat', {
        id: 'msg',
        content: [{ type: 'text', text: 'hi' }],
        stop_reason: 'end_turn',
      }),
    );
    expect(evs[evs.length - 1].data).toBe('[DONE]');
    expect(
      evs.map((e) => (e.data === '[DONE]' ? '' : (e.data.choices[0].delta.content ?? ''))).join(''),
    ).toBe('hi');
  });

  it('error JSON → target error event', () => {
    expect(
      parse(
        jsonToSse('gemini', 'messages', {
          error: { message: 'quota', status: 'RESOURCE_EXHAUSTED' },
        }),
      ),
    ).toEqual([
      { event: 'error', data: { type: 'error', error: { type: 'api_error', message: 'quota' } } },
    ]);
    const r = parse(
      jsonToSse('messages', 'responses', {
        type: 'error',
        error: { type: 'overloaded_error', message: 'busy' },
      }),
    );
    expect(r[r.length - 1].data.response.error).toEqual({
      code: 'overloaded_error',
      message: 'busy',
    });
  });
});
