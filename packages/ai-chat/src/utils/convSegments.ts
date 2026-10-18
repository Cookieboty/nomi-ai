/**
 * 助手一轮的展示顺序：文字段和工具按发生位置穿插。
 * 没有位置信息的旧消息仍是「工具在前、正文在后」。
 */
import { buildTimeline, classifyTool, type TimelineItem, type TraceEntry } from './toolTrace';

export type BodySegment =
  { type: 'text'; text: string } | { type: 'activity'; items: TimelineItem[] };

function tidy(slice: string): string {
  return slice.replace(/^\n+/, '').replace(/\n+$/, '');
}

/** 顶层条目按 textAt 分组；子代理内部调用留在父块里，不单独占一段 */
function topLevel(entries: readonly TraceEntry[]): {
  tops: TraceEntry[];
  children: TraceEntry[];
} {
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
  return { tops, children };
}

export function segmentBody(
  text: string,
  entries: readonly TraceEntry[],
  live = false,
  endAt?: number,
  breaks?: readonly number[],
): BodySegment[] {
  const { tops, children } = topLevel(entries);
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
