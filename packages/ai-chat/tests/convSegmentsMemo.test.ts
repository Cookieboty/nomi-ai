import { describe, expect, it } from 'vitest';

import type { HarnessTraceEvent } from '../src/services/harnessClient';
import {
  type BodySegment,
  layoutBody,
  planBody,
  planLength,
  segmentBody,
  sliceBody,
} from '../src/utils/convSegments';
import {
  buildTimeline,
  classifyTool,
  reduceTrace,
  reduceTraceCached,
  type TraceEntry,
} from '../src/utils/toolTrace';

/** 改造前的 segmentBody（逐字照搬）：新实现的输出必须与它完全一致 */
function legacySegmentBody(
  text: string,
  entries: readonly TraceEntry[],
  live = false,
  endAt?: number,
  breaks?: readonly number[],
): BodySegment[] {
  const tidy = (s: string) => s.replace(/^\n+/, '').replace(/\n+$/, '');
  const subIds = new Set<string>();
  for (const e of entries)
    if (e.type === 'tool' && classifyTool(e.call.name) === 'subagent') subIds.add(e.call.id);
  const tops: TraceEntry[] = [];
  const children: TraceEntry[] = [];
  for (const e of entries) {
    const pid = e.type === 'tool' ? e.call.parentId : undefined;
    if (pid && subIds.has(pid) && !(e.type === 'tool' && e.call.id === pid)) children.push(e);
    else tops.push(e);
  }
  const positioned = tops.some((e) => typeof e.textAt === 'number');
  const cuts = breaks?.length ? breaks : [];
  if (!positioned && !cuts.length) {
    const items = buildTimeline(entries, live, endAt);
    const out: BodySegment[] = [];
    if (items.length) out.push({ type: 'activity', items });
    const body = tidy(text);
    if (body.trim()) out.push({ type: 'text', text: body });
    return out;
  }
  const groups: { at: number; entries: TraceEntry[] }[] = [];
  let floor = 0;
  for (const e of tops) {
    const at = Math.max(floor, Math.min(text.length, e.textAt ?? floor));
    const last = groups[groups.length - 1];
    if (last && last.at === at) last.entries.push(e);
    else groups.push({ at, entries: [e] });
    floor = at;
  }
  for (const b of cuts) {
    const at = Math.max(0, Math.min(text.length, b));
    if (!groups.some((g) => g.at === at)) groups.push({ at, entries: [] });
  }
  groups.sort((a, b) => a.at - b.at);
  const out: BodySegment[] = [];
  let cursor = 0;
  groups.forEach((g, i) => {
    const slice = tidy(text.slice(cursor, g.at));
    if (slice.trim()) out.push({ type: 'text', text: slice });
    cursor = Math.max(cursor, g.at);
    if (!g.entries.length) return;
    const ids = new Set(
      g.entries
        .filter((e): e is Extract<TraceEntry, { type: 'tool' }> => e.type === 'tool')
        .map((e) => e.call.id),
    );
    const withChildren = [
      ...g.entries,
      ...children.filter((c) => c.type === 'tool' && !!c.call.parentId && ids.has(c.call.parentId)),
    ];
    const last = i === groups.length - 1;
    const items = buildTimeline(withChildren, live && last, live && last ? undefined : endAt);
    if (items.length) out.push({ type: 'activity', items });
  });
  const rest = tidy(text.slice(cursor));
  if (rest.trim()) out.push({ type: 'text', text: rest });
  return out;
}

/** 组件里的三段 memo 流程 */
function staged(
  text: string,
  entries: readonly TraceEntry[],
  live?: boolean,
  endAt?: number,
  breaks?: readonly number[],
): BodySegment[] {
  const layout = layoutBody(entries);
  return sliceBody(
    text,
    planBody(layout, planLength(layout, text.length, breaks), live, endAt, breaks),
  );
}

const full = '先看一下。\n\n两个子代理并行跑。\n\n读完了，开始改。\n\n改好了。';
const p1 = full.indexOf('两个');
const p2 = full.indexOf('读完');
const p3 = full.indexOf('改好');

/** 两个子代理交错产生内部调用，外加普通调用、思考、超出文字长度的位置 */
const trace: HarnessTraceEvent[] = [
  { type: 'thinking', text: '想', textAt: 0, at: 1 },
  { type: 'tool', name: 'read_file', status: 'start', id: 'r0', textAt: p1, at: 2 },
  { type: 'tool', name: 'read_file', status: 'done', id: 'r0', output: 'x', at: 3 },
  { type: 'tool', name: 'Task', status: 'start', id: 'sa', textAt: p2, at: 4 },
  { type: 'tool', name: 'Task', status: 'start', id: 'sb', textAt: p2, at: 5 },
  { type: 'tool', name: 'Read', status: 'start', id: 'a1', parentId: 'sa', at: 6 },
  { type: 'tool', name: 'Bash', status: 'start', id: 'b1', parentId: 'sb', at: 7 },
  { type: 'tool', name: 'Read', status: 'done', id: 'a1', parentId: 'sa', at: 8 },
  { type: 'tool', name: 'Grep', status: 'start', id: 'a2', parentId: 'sa', at: 9 },
  { type: 'tool', name: 'Bash', status: 'done', id: 'b1', parentId: 'sb', at: 10 },
  { type: 'tool', name: 'Task', status: 'done', id: 'sb', at: 11 },
  { type: 'tool', name: 'edit_file', status: 'start', id: 'e1', textAt: p3, at: 12 },
  { type: 'tool', name: 'edit_file', status: 'start', id: 'e2', textAt: full.length + 50, at: 13 },
  { type: 'thinking', text: '再想', at: 14 },
];

describe('segmentBody 拆分后与原实现一致', () => {
  it('每个文字前缀、每种 live / breaks 组合都完全相同', () => {
    expect(classifyTool('Task')).toBe('subagent');
    const entries = reduceTrace(trace);
    for (const breaks of [undefined, [p1 - 2, full.length + 5]]) {
      for (const live of [false, true]) {
        for (let n = 0; n <= full.length; n++) {
          const text = full.slice(0, n);
          const want = legacySegmentBody(text, entries, live, 99, breaks);
          expect(segmentBody(text, entries, live, 99, breaks)).toEqual(want);
          expect(staged(text, entries, live, 99, breaks)).toEqual(want);
        }
      }
    }
  });

  it('没有位置信息时仍是工具在前', () => {
    const entries = reduceTrace(trace.map(({ textAt: _t, ...e }) => e as HarnessTraceEvent));
    expect(staged(full, entries, true)).toEqual(legacySegmentBody(full, entries, true));
  });

  it('多个子代理的内部调用按原始顺序归入各自父块', () => {
    const segs = segmentBody(full, reduceTrace(trace));
    const act = segs.filter((s) => s.type === 'activity');
    const subs = act.flatMap((s) => (s.type === 'activity' ? s.items : []));
    const sa = subs.find((i) => i.type === 'subagent' && i.call.id === 'sa');
    const sb = subs.find((i) => i.type === 'subagent' && i.call.id === 'sb');
    expect(sa?.type === 'subagent' && sa.children.length).toBeTruthy();
    expect(sb?.type === 'subagent' && sb.children.length).toBeTruthy();
  });
});

describe('纯文字变化时时间线保持同一引用', () => {
  it('文字增长不重建 plan，activity items 是同一个数组', () => {
    const entries = reduceTrace(trace.slice(0, -2));
    const layout = layoutBody(entries);
    const lenA = planLength(layout, full.length, undefined);
    const lenB = planLength(layout, full.length + 200, undefined);
    // 文字已越过所有位置：plan 的 memo 键不变
    expect(lenA).toBe(lenB);
    const plan = planBody(layout, lenA, true);
    const a = sliceBody(full, plan);
    const b = sliceBody(`${full}\n\n继续写更多内容。`, plan);
    const itemsOf = (s: BodySegment[]) =>
      s.flatMap((x) => (x.type === 'activity' ? [x.items] : []));
    expect(itemsOf(a).length).toBeGreaterThan(0);
    itemsOf(a).forEach((items, i) => expect(itemsOf(b)[i]).toBe(items));
    expect(b[b.length - 1]).toEqual({ type: 'text', text: '改好了。\n\n继续写更多内容。' });
  });

  it('文字还没追上位置时，长度键随文字变化', () => {
    const layout = layoutBody(reduceTrace(trace));
    expect(planLength(layout, 3, undefined)).toBe(3);
    expect(planLength(layout, 4, undefined)).toBe(4);
    // 没有位置信息也没有分段：与文字长度无关
    expect(planLength(layoutBody([]), 100, undefined)).toBe(0);
  });
});

describe('reduceTraceCached', () => {
  it('同一数组只归并一次，结果与 reduceTrace 相同', () => {
    const events = trace.slice();
    const a = reduceTraceCached(events);
    expect(reduceTraceCached(events)).toBe(a);
    expect(a).toEqual(reduceTrace(events));
  });

  it('追加事件得到的新数组（concat / 展开）重新归并', () => {
    const base = trace.slice(0, 5);
    const a = reduceTraceCached(base);
    const appended = base.concat(trace.slice(5));
    const b = reduceTraceCached(appended);
    expect(b).not.toBe(a);
    expect(b).toEqual(reduceTrace(appended));
    // 旧数组的缓存不受影响
    expect(reduceTraceCached(base)).toBe(a);
  });

  it('就地追加同一个数组也不会拿到旧结果', () => {
    const events = trace.slice(0, 3);
    const a = reduceTraceCached(events);
    events.push(...trace.slice(3));
    const b = reduceTraceCached(events);
    expect(b).not.toBe(a);
    expect(b).toEqual(reduceTrace(events));
  });
});
