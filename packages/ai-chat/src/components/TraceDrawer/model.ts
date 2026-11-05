/**
 * 执行轨迹抽屉的数据整理（纯函数，便于测试）：
 * 一轮的时间窗、瀑布图的行（思考 / 工具调用 / 网关请求）、子进程收发的相对时间。
 */
import type { QualityRequestItem } from '../../services/qualityClient';
import type { ConvMessage } from '../../types/conversation';
import { reduceTrace, type ToolCall } from '../../utils/toolTrace';

/** 既没有耗时也没有带时间的事件时，往前看多久 */
export const FALLBACK_WINDOW_MS = 60_000;

export interface TurnWindow {
  from: number;
  to: number;
}

/** 一轮的时间窗：结束 = 消息时间；开始 = 结束 − 耗时，与最早一个带时间的事件取较早者 */
export function turnWindow(m: Pick<ConvMessage, 'at' | 'durationMs' | 'trace'>): TurnWindow {
  const to = m.at;
  let from = m.durationMs && m.durationMs > 0 ? to - m.durationMs : Number.POSITIVE_INFINITY;
  for (const ev of m.trace ?? []) if (ev.at !== undefined && ev.at < from) from = ev.at;
  if (!Number.isFinite(from)) from = to - FALLBACK_WINDOW_MS;
  return { from, to: Math.max(to, from) };
}

export type WaterfallRow =
  | { kind: 'thinking'; id: string; start: number; end?: number; text: string }
  | { kind: 'interject'; id: string; start: number; end?: number; text: string }
  | { kind: 'tool'; id: string; start: number; end?: number; call: ToolCall; depth: number }
  | {
      kind: 'request';
      id: string;
      start: number;
      end: number;
      firstAt?: number;
      req: QualityRequestItem;
    };

/** 瀑布图的行：按开始时间排序；没有时间的工具调用放在最后（start = NaN） */
export function waterfallRows(
  m: Pick<ConvMessage, 'trace' | 'showThinkingDetails'>,
  requests: readonly QualityRequestItem[],
): WaterfallRow[] {
  const rows: WaterfallRow[] = [];
  const trace =
    m.showThinkingDetails === false
      ? m.trace?.map((event) => (event.type === 'thinking' ? { ...event, text: '' } : event))
      : m.trace;
  const entries = reduceTrace(trace ?? []);
  const depthOf = new Map<string, number>();
  for (const e of entries) {
    if (e.type === 'thinking') {
      if (e.at === undefined) continue;
      rows.push({ kind: 'thinking', id: e.id, start: e.at, end: e.lastAt, text: e.text });
      continue;
    }
    if (e.type === 'interject') {
      if (e.at === undefined) continue;
      rows.push({ kind: 'interject', id: e.id, start: e.at, end: e.at, text: e.text });
      continue;
    }
    const c = e.call;
    const depth = c.parentId ? (depthOf.get(c.parentId) ?? 0) + 1 : 0;
    depthOf.set(c.id, depth);
    rows.push({
      kind: 'tool',
      id: c.id,
      start: c.startedAt ?? Number.NaN,
      end: c.endedAt,
      call: c,
      depth,
    });
  }
  for (const r of requests)
    rows.push({
      kind: 'request',
      id: `req:${r.id}`,
      start: r.ts,
      end: r.ts + r.timing.endMs,
      ...(r.timing.firstContentMs !== undefined ? { firstAt: r.ts + r.timing.firstContentMs } : {}),
      req: r,
    });
  return rows.sort((a, b) => {
    const an = Number.isNaN(a.start);
    const bn = Number.isNaN(b.start);
    if (an || bn) return an === bn ? 0 : an ? 1 : -1;
    return a.start - b.start;
  });
}

/** 瀑布图的刻度范围：时间窗与所有行的并集 */
export function waterfallSpan(win: TurnWindow, rows: readonly WaterfallRow[]): TurnWindow {
  let { from, to } = win;
  for (const r of rows) {
    if (Number.isNaN(r.start)) continue;
    from = Math.min(from, r.start);
    to = Math.max(to, r.end ?? r.start);
  }
  return { from, to: Math.max(to, from + 1) };
}

/** 一行在刻度上的位置（百分比）；没有结束时间的按运行到整轮结束画 */
export function barOf(row: WaterfallRow, span: TurnWindow): { left: number; width: number } | null {
  if (Number.isNaN(row.start)) return null;
  const total = span.to - span.from;
  const left = ((row.start - span.from) / total) * 100;
  const end = row.end ?? span.to;
  const width = Math.max(0.5, ((end - row.start) / total) * 100);
  return { left: Math.max(0, Math.min(100, left)), width: Math.min(100 - left, width) };
}

/** 相对开始的时间：+1.23s */
export function offsetLabel(at: number, from: number): string {
  const d = (at - from) / 1000;
  return `${d >= 0 ? '+' : '−'}${Math.abs(d).toFixed(2)}s`;
}

/** 美化 JSON 文本；不是 JSON 原样返回 */
export function prettyJson(text: string | undefined): string {
  if (!text) return '';
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}
