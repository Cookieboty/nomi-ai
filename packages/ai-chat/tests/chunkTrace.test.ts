import { describe, expect, it } from 'vitest';

import { chunkToTrace, chunkToUsage } from '../src/utils/chunkTrace';
import { buildTimeline, reduceTrace } from '../src/utils/toolTrace';

describe('chunkToTrace (Nomi tool calls use the same trace model)', () => {
  it('maps tool_call.delta / tool_call.result / reasoning to trace events', () => {
    const start = chunkToTrace(
      {
        type: 'tool_call.delta',
        index: 0,
        name: 'kb_search',
        argumentsJson: '{"q":"x"}',
        id: 'c1',
      },
      100,
    );
    const done = chunkToTrace(
      { type: 'tool_call.result', id: 'c1', name: 'kb_search', output: '3 hits' },
      900,
    );
    const failed = chunkToTrace(
      { type: 'tool_call.result', id: 'c2', name: 'web_fetch', error: 'timeout' },
      950,
    );
    const think = chunkToTrace({ type: 'reasoning', content: '想一想' }, 50);
    expect(start).toEqual({
      type: 'tool',
      name: 'kb_search',
      status: 'start',
      id: 'c1',
      input: '{"q":"x"}',
      at: 100,
    });
    expect(done).toMatchObject({ status: 'done', id: 'c1', output: '3 hits', at: 900 });
    expect(failed).toMatchObject({ status: 'error', output: 'timeout' });
    expect(think).toEqual({ type: 'thinking', text: '想一想', at: 50 });
    expect(chunkToTrace({ type: 'delta', content: 'x' })).toBeNull();
    expect(chunkToTrace({ type: 'tool_call.delta', index: 0 })).toBeNull();
  });

  it('events from a Nomi turn reduce into the same timeline items as CLI traces', () => {
    const events = [
      chunkToTrace({ type: 'reasoning', content: '先搜索' }, 0)!,
      chunkToTrace(
        {
          type: 'tool_call.delta',
          index: 0,
          name: 'kb_search',
          argumentsJson: '{"query":"nomi"}',
          id: 'a',
        },
        10,
      )!,
      chunkToTrace({ type: 'tool_call.result', id: 'a', name: 'kb_search', output: 'hit' }, 410)!,
    ];
    const items = buildTimeline(reduceTrace(events));
    expect(items.map((i) => i.type)).toEqual(['thinking', 'call']);
    const call = items[1] as {
      type: 'call';
      call: { status: string; startedAt?: number; endedAt?: number };
    };
    expect(call.call).toMatchObject({ status: 'done', startedAt: 10, endedAt: 410 });
  });

  it('chunkToUsage reads prompt / completion tokens', () => {
    expect(
      chunkToUsage({
        type: 'usage',
        usage: { promptTokens: 12, completionTokens: 5, totalTokens: 17, cacheReadTokens: 2 },
      }),
    ).toEqual({ inputTokens: 12, outputTokens: 5, cacheReadTokens: 2 });
    expect(chunkToUsage({ type: 'delta' })).toBeNull();
  });
});
