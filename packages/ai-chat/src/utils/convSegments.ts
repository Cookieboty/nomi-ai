/**
 * 助手一轮的展示顺序：文字段和工具按发生位置穿插。
 * 没有位置信息的旧消息仍是「工具在前、正文在后」。
 *
 * 拆成两步：`planBody` 只依赖轨迹（分组 + 各组时间线），`sliceBody` 只按位置切文字。
 * 流式时文字每帧都变、轨迹多数帧不变，组件里分别 memo，纯文字帧不必重建时间线，
 * 各组 items 数组也保持同一引用（ToolTimeline 据此跳过重渲染）。
 */
import { buildTimeline, classifyTool, type TimelineItem, type TraceEntry } from './toolTrace';

export type BodySegment =
  { type: 'text'; text: string } | { type: 'activity'; items: TimelineItem[] };

function tidy(slice: string): string {
  return slice.replace(/^\n+/, '').replace(/\n+$/, '');
}

type ToolEntry = Extract<TraceEntry, { type: 'tool' }>;

/** 顶层条目与子代理内部调用（按父 id 分桶，记下原始顺序） */
export interface BodyLayout {
  entries: readonly TraceEntry[];
  tops: TraceEntry[];
  childrenOf: Map<string, { idx: number; entry: TraceEntry }[]>;
  /** 顶层条目里有没有位置信息 */
  positioned: boolean;
  /** 顶层条目 textAt 的最大值（无则 0）：文字长度超过它之后，分组结果与文字长度无关 */
  maxAt: number;
}

/** 顶层条目按 textAt 分组；子代理内部调用留在父块里，不单独占一段 */
export function layoutBody(entries: readonly TraceEntry[]): BodyLayout {
  const subIds = new Set<string>();
  for (const e of entries)
    if (e.type === 'tool' && classifyTool(e.call.name) === 'subagent') subIds.add(e.call.id);
  const tops: TraceEntry[] = [];
  const childrenOf = new Map<string, { idx: number; entry: TraceEntry }[]>();
  let positioned = false;
  let maxAt = 0;
  entries.forEach((e, idx) => {
    const pid = e.type === 'tool' ? e.call.parentId : undefined;
    if (pid && subIds.has(pid) && !(e.type === 'tool' && e.call.id === pid)) {
      const list = childrenOf.get(pid);
      if (list) list.push({ idx, entry: e });
      else childrenOf.set(pid, [{ idx, entry: e }]);
      return;
    }
    tops.push(e);
    if (typeof e.textAt === 'number') {
      positioned = true;
      if (e.textAt > maxAt) maxAt = e.textAt;
    }
  });
  return { entries, tops, childrenOf, positioned, maxAt };
}

export type BodyPlan =
  | { flat: true; items: TimelineItem[] }
  | { flat: false; groups: { at: number; items: TimelineItem[] | null }[] };

/**
 * 分组位置会被夹到文字长度以内：传给 planBody 的长度用这个值，
 * 文字长度超过所有位置之后它就不再变化，plan 的 memo 也就不会因文字增长失效。
 */
export function planLength(
  layout: BodyLayout,
  textLength: number,
  breaks?: readonly number[],
): number {
  if (!layout.positioned && !breaks?.length) return 0;
  let max = layout.maxAt;
  for (const b of breaks ?? []) if (b > max) max = b;
  return Math.min(textLength, max);
}

export function planBody(
  layout: BodyLayout,
  textLength: number,
  live = false,
  endAt?: number,
  breaks?: readonly number[],
): BodyPlan {
  const { tops, childrenOf } = layout;
  const cuts = breaks?.length ? breaks : [];
  if (!layout.positioned && !cuts.length)
    return { flat: true, items: buildTimeline(layout.entries, live, endAt) };

  const groups: { at: number; entries: TraceEntry[] }[] = [];
  let floor = 0;
  for (const e of tops) {
    const at = Math.max(floor, Math.min(textLength, e.textAt ?? floor));
    const last = groups[groups.length - 1];
    if (last && last.at === at) last.entries.push(e);
    else groups.push({ at, entries: [e] });
    floor = at;
  }
  for (const b of cuts) {
    const at = Math.max(0, Math.min(textLength, b));
    if (!groups.some((g) => g.at === at)) groups.push({ at, entries: [] });
  }
  groups.sort((a, b) => a.at - b.at);

  return {
    flat: false,
    groups: groups.map((g, i) => {
      if (!g.entries.length) return { at: g.at, items: null };
      const kids: { idx: number; entry: TraceEntry }[] = [];
      let buckets = 0;
      const seen = new Set<string>();
      for (const e of g.entries) {
        if (e.type !== 'tool') continue;
        const id = (e as ToolEntry).call.id;
        if (seen.has(id)) continue;
        seen.add(id);
        const list = childrenOf.get(id);
        if (!list) continue;
        kids.push(...list);
        buckets++;
      }
      // 多个子代理的内部调用合并时恢复原始顺序
      if (buckets > 1) kids.sort((a, b) => a.idx - b.idx);
      const withChildren = kids.length ? [...g.entries, ...kids.map((k) => k.entry)] : g.entries;
      const last = i === groups.length - 1;
      return {
        at: g.at,
        items: buildTimeline(withChildren, live && last, live && last ? undefined : endAt),
      };
    }),
  };
}

/** 按 plan 切文字；位置夹到当前文字长度以内 */
export function sliceBody(text: string, plan: BodyPlan): BodySegment[] {
  const out: BodySegment[] = [];
  if (plan.flat) {
    if (plan.items.length) out.push({ type: 'activity', items: plan.items });
    const body = tidy(text);
    if (body.trim()) out.push({ type: 'text', text: body });
    return out;
  }
  let cursor = 0;
  for (const g of plan.groups) {
    const at = Math.min(text.length, g.at);
    const slice = tidy(text.slice(cursor, at));
    if (slice.trim()) out.push({ type: 'text', text: slice });
    cursor = Math.max(cursor, at);
    if (g.items?.length) out.push({ type: 'activity', items: g.items });
  }
  const rest = tidy(text.slice(cursor));
  if (rest.trim()) out.push({ type: 'text', text: rest });
  return out;
}

export function segmentBody(
  text: string,
  entries: readonly TraceEntry[],
  live = false,
  endAt?: number,
  breaks?: readonly number[],
): BodySegment[] {
  const layout = layoutBody(entries);
  return sliceBody(text, planBody(layout, text.length, live, endAt, breaks));
}
