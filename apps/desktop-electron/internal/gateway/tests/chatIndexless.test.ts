/**
 * Chat 上游的工具调用不带 index（Kimi 等）：不同 id 的调用不能并成一个；没有 id 的分片续写当前调用。
 * 回放夹具 chat-tool-calls-without-index 发现的回归（解码器去掉兼容分支后，规范化层按块内位置补 index）。
 */
import { describe, expect, it } from 'vitest';

import { ChatChunkNormalizer } from '../src/canonical/chat';
import { createStreamConverter, SseParser } from '../src/stream';

const chunk = (tool: Record<string, unknown>) =>
  `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [tool] } }] })}\n\n`;
const fn = (name: string | undefined, args: unknown) => ({
  ...(name ? { name } : {}),
  arguments: args,
});

function toolUses(out: string) {
  const p = new SseParser();
  const evs = [...p.push(out), ...p.end()].map((e) => JSON.parse(e.data) as Record<string, any>);
  const starts = evs.filter(
    (e) => e.type === 'content_block_start' && e.content_block?.type === 'tool_use',
  );
  return starts.map((s) => ({
    name: s.content_block.name as string,
    args: evs
      .filter((e) => e.type === 'content_block_delta' && e.index === s.index)
      .map((e) => e.delta.partial_json as string)
      .join(''),
  }));
}

describe('Chat tool calls without index', () => {
  it('two calls with different ids (same tool name) stay two calls', () => {
    const c = createStreamConverter('chat', 'messages', { model: 'm' });
    const out =
      c.push(
        chunk({ id: 'call_a', type: 'function', function: fn('read_file', '{"path":"a.ts"}') }) +
          chunk({ id: 'call_b', type: 'function', function: fn('read_file', { path: 'b.ts' }) }) +
          `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\n` +
          'data: [DONE]\n\n',
      ) + c.end();
    expect(toolUses(out)).toEqual([
      { name: 'read_file', args: '{"path":"a.ts"}' },
      { name: 'read_file', args: '{"path":"b.ts"}' },
    ]);
  });

  it('fragments without id continue the current call; a repeated id maps back to its call', () => {
    const n = new ChatChunkNormalizer();
    const idx = (tc: Record<string, unknown>) => {
      const j = { choices: [{ delta: { tool_calls: [tc] } }] };
      n.normalize(j);
      return (j.choices[0]!.delta.tool_calls[0] as { index: number }).index;
    };
    expect(idx({ id: 'x', function: fn('a', '{"p":') })).toBe(0);
    expect(idx({ function: fn(undefined, '1}') })).toBe(0);
    expect(idx({ id: 'y', function: fn('b', '{}') })).toBe(1);
    expect(idx({ id: 'x', function: fn(undefined, '') })).toBe(0);
    // 显式 index 照旧
    expect(idx({ index: 5, id: 'z', function: fn('c', '{}') })).toBe(5);
    expect(idx({ id: 'w', function: fn('d', '{}') })).toBe(6);
  });
});
