/** 把一轮的 HarnessEvent 整理成可持久化的轨迹（工具调用 + 思考），控制体积 */
import type { HarnessEvent, HarnessTraceEvent, HarnessUsage } from './types';

export const MAX_TRACE_EVENTS = 300;
export const MAX_TRACE_BYTES = 400_000;

export function isTraceEvent(ev: HarnessEvent): ev is HarnessTraceEvent {
  return ev.type === 'tool' || ev.type === 'thinking';
}

/** 给 tool / thinking 事件打上主进程时间戳（会话视图据此算耗时） */
export function stampEvent(ev: HarnessEvent, now = Date.now()): HarnessEvent {
  if (isTraceEvent(ev) && ev.at === undefined) ev.at = now;
  return ev;
}

export function buildTrace(events: HarnessEvent[]): HarnessTraceEvent[] {
  const out: HarnessTraceEvent[] = [];
  for (const ev of events) {
    if (!isTraceEvent(ev)) continue;
    const prev = out[out.length - 1];
    // 连续的思考片段合并
    if (ev.type === 'thinking' && prev?.type === 'thinking') {
      out[out.length - 1] = { ...prev, text: `${prev.text}${ev.text}`.slice(0, 8000) };
      continue;
    }
    out.push({ ...ev });
  }
  const trimmed = out.length > MAX_TRACE_EVENTS ? out.slice(-MAX_TRACE_EVENTS) : out;
  // 体积超限：从最早的事件起丢掉输出 / 参数
  let size = JSON.stringify(trimmed).length;
  for (let i = 0; i < trimmed.length && size > MAX_TRACE_BYTES; i++) {
    const ev = trimmed[i]!;
    if (ev.type !== 'tool') continue;
    if (ev.output) {
      size -= ev.output.length;
      delete ev.output;
    }
    if (size > MAX_TRACE_BYTES && ev.input) {
      size -= ev.input.length;
      delete ev.input;
    }
  }
  return trimmed;
}

/** 单个标签的消息文件体积上限；超出后较早消息的轨迹只保留骨架（名称 / 状态 / 时间），丢掉参数与输出 */
export const MAX_TAB_FILE_BYTES = 6_000_000;
/** 体积压缩时完整保留轨迹的最近消息数 */
export const KEEP_FULL_TRACE_MESSAGES = 20;

/** 把较早消息的轨迹压成骨架（原地修改）；返回是否有改动 */
export function compactOldTraces(
  list: Array<{ trace?: HarnessTraceEvent[] }>,
  keepRecent = KEEP_FULL_TRACE_MESSAGES,
): boolean {
  let changed = false;
  for (let i = 0; i < list.length - keepRecent; i++) {
    const trace = list[i]!.trace;
    if (!trace) continue;
    for (const ev of trace) {
      if (ev.type !== 'tool') continue;
      if (ev.output !== undefined) {
        delete ev.output;
        changed = true;
      }
      if (ev.input !== undefined) {
        delete ev.input;
        changed = true;
      }
    }
  }
  return changed;
}

/** 一轮里所有 done 事件携带的用量合并（后到的字段覆盖先到的）；没有数据返回 undefined */
export function mergeUsage(events: readonly HarnessEvent[]): HarnessUsage | undefined {
  let out: HarnessUsage | undefined;
  for (const ev of events) {
    if (ev.type === 'done' && ev.usage) out = { ...out, ...ev.usage };
  }
  return out;
}
