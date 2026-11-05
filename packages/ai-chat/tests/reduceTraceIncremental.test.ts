import { describe, expect, it } from 'vitest';

import type { HarnessTraceEvent } from '../src/services/harnessClient';
import { reduceTrace, reduceTraceCached } from '../src/utils/toolTrace';

/** 覆盖归并的各种分支：思考合并、重复 start、按名配对、没有 start 的结果、插话、子代理 */
function sampleTrace(): HarnessTraceEvent[] {
  const ev: HarnessTraceEvent[] = [];
  let at = 1000;
  const tool = (
    name: string,
    status: 'start' | 'done' | 'error',
    extra: Partial<Extract<HarnessTraceEvent, { type: 'tool' }>> = {},
  ) => ev.push({ type: 'tool', name, status, at: at++, ...extra });
  ev.push({ type: 'thinking', text: 'Let me ', at: at++, textAt: 0 });
  ev.push({ type: 'thinking', text: 'look.', at: at++, textAt: 0 });
  tool('Read', 'start', { id: 'r1', input: '{"path":"a"}', textAt: 3 });
  tool('Read', 'start', { id: 'r1', input: '{"path":"a","limit":5}' });
  tool('Grep', 'start', { textAt: 3 });
  tool('Read', 'done', { id: 'r1', output: 'file a' });
  tool('Grep', 'done', { output: 'hits' });
  ev.push({ type: 'interject', text: 'also check b', at: at++, textAt: 5 });
  tool('Task', 'start', { id: 't1', input: '{"goal":"x"}' });
  tool('Bash', 'start', { id: 'b1', parentId: 't1', input: 'ls' });
  ev.push({ type: 'thinking', text: 'hmm', at: at++, textAt: 9 });
  ev.push({ type: 'thinking', text: ' ok', textAt: 9 });
  tool('tool', 'done', { id: 'b1', output: 'x' });
  tool('Edit', 'error', { id: 'e1', output: 'denied' });
  tool('tool', 'start', { id: 'w1' });
  tool('Write', 'done', { id: 'w1', input: '{"path":"c"}', output: 'ok' });
  tool('Task', 'done', { id: 't1', output: 'report' });
  ev.push({ type: 'thinking', text: 'done', at: at++, textAt: 20 });
  tool('Read', 'done', { output: 'orphan' });
  return ev;
}

describe('reduceTraceCached incremental fold', () => {
  it('matches a full reduce at every prefix and never mutates earlier results', () => {
    const events = sampleTrace();
    const results: Array<{ k: number; out: unknown; snap: string }> = [];
    // 每帧一份新数组（同一批事件对象），像 traceSnap / liveState 的 concat 那样
    for (let k = 1; k <= events.length; k++) {
      const frame = events.slice(0, k);
      const out = reduceTraceCached(frame);
      expect(out).toEqual(reduceTrace(frame));
      results.push({ k, out, snap: JSON.stringify(out) });
    }
    for (const r of results) expect(JSON.stringify(r.out)).toBe(r.snap);
  });

  it('keeps unchanged entries by identity and replaces changed ones', () => {
    const events = sampleTrace();
    const a = reduceTraceCached(events.slice(0, 5)); // Read r1 (running), Grep (running)
    const b = reduceTraceCached(events.slice(0, 6)); // Read r1 done
    expect(b).not.toBe(a);
    expect(b[0]).toBe(a[0]); // thinking untouched
    expect(b[1]).not.toBe(a[1]); // Read finished → new entry / call
    expect(a[1]!.type === 'tool' && a[1]!.call.status).toBe('running');
    expect(b[2]).toBe(a[2]); // Grep still running
  });

  it('falls back to a full reduce when the array is not an extension (trimmed front, branch)', () => {
    const events = sampleTrace();
    reduceTraceCached(events.slice(0, 10));
    const shorter = events.slice(0, 8);
    expect(reduceTraceCached(shorter)).toEqual(reduceTrace(shorter));
    const trimmed = events.slice(3);
    expect(reduceTraceCached(trimmed)).toEqual(reduceTrace(trimmed));
    const branched = [...events.slice(0, 6), { type: 'thinking' as const, text: 'other' }];
    expect(reduceTraceCached(branched)).toEqual(reduceTrace(branched));
    expect(reduceTraceCached(events)).toEqual(reduceTrace(events));
  });
});
