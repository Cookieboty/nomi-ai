/**
 * 透传热路径的基准（docs/design/cli-plugin-architecture.md §6.4「性能」）：不在 CI 里跑。
 *   pnpm -F @nomi-ai/gateway exec vitest run --config bench/vitest.config.ts
 * 对比「直接转发」与协议桥透传（含 / 不含复读检测）处理同一条长流的耗时，输出单事件额外开销。
 * 目标：单事件额外开销 < 50µs。
 */
import { performance } from 'node:perf_hooks';

import { describe, expect, it } from 'vitest';

import { createBridge } from '../src/bridge';
import type { Wire } from '../src/ir';

const N = 2_000;
const ROUNDS = 20;

function stream(wire: Wire): string {
  const parts: string[] = [];
  for (let i = 0; i < N; i++) {
    const text = `token ${i} `;
    const ev =
      wire === 'chat'
        ? { id: 'c', choices: [{ index: 0, delta: { content: text } }] }
        : wire === 'messages'
          ? { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }
          : wire === 'responses'
            ? {
                type: 'response.output_text.delta',
                sequence_number: i + 2,
                item_id: 'm',
                output_index: 0,
                content_index: 0,
                delta: text,
              }
            : { candidates: [{ content: { parts: [{ text }] } }] };
    parts.push(`data: ${JSON.stringify(ev)}\n\n`);
  }
  return parts.join('');
}

/** 按 ~1KB 切块模拟网络分片 */
function chunks(s: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length; i += 1024) out.push(s.slice(i, i + 1024));
  return out;
}

/** 多轮取中位数（ms） */
function time(fn: () => void): number {
  const t: number[] = [];
  for (let r = 0; r < ROUNDS; r++) {
    const a = performance.now();
    fn();
    t.push(performance.now() - a);
  }
  return t.sort((x, y) => x - y)[Math.floor(ROUNDS / 2)]!;
}

describe('passthrough benchmark', () => {
  for (const wire of ['messages', 'responses', 'chat', 'gemini'] as const)
    it(`${wire}: ${N} events`, () => {
      const parts = chunks(stream(wire));
      const base = time(() => {
        let n = 0;
        for (const p of parts) n += p.length;
        expect(n).toBeGreaterThan(0);
      });
      const run = (repetition: boolean) => () => {
        const b = createBridge({
          from: wire,
          to: wire,
          mode: 'passthrough',
          model: 'm',
          fixes: { repetition },
        });
        for (const p of parts) b.push(p);
        b.end();
      };
      const plain = time(run(false));
      const guarded = time(run(true));
      const us = (ms: number) => (((ms - base) * 1000) / N).toFixed(2);
      process.stdout.write(
        `${wire.padEnd(9)} bridge ${plain.toFixed(2)}ms (${us(plain)}µs/event)  ` +
          `+repetition ${guarded.toFixed(2)}ms (${us(guarded)}µs/event)\n`,
      );
      expect(((plain - base) * 1000) / N).toBeLessThan(50);
    });
});
