/**
 * 运行中标签的实时状态：把一批 harness 事件折叠进 TabLive（纯函数，便于单测）。
 * 渲染层按帧（rAF）合批调用：一帧里到达上千个事件也只产生一次新状态、一次数组复制。
 */
import type { HarnessLiveEvent, HarnessTraceEvent } from '../services/harnessClient';

/** 等待 / 恢复状态（来自 CLI 的重试、重连、上下文压缩提示） */
export interface LiveStatus {
  kind: 'retry' | 'reconnect' | 'compact';
  text?: string;
  attempt?: number;
  max?: number;
}

export interface TabLive {
  text: string;
  tool?: string;
  /** start | done | error */
  toolStatus?: 'start' | 'done' | 'error';
  /** 本轮的工具调用 / 思考事件（按到达顺序；会话视图据此归并成时间线） */
  trace?: HarnessTraceEvent[];
  /** 本轮开始时间（ms），用于「已处理 N 秒」 */
  startedAt?: number;
  /** 收到本轮第一个输出事件（文本 / 工具 / 思考）的时间；未收到时为「等待首字」 */
  firstEventAt?: number;
  /** Claude can_use_tool 待确认 */
  permission?: { id: string; summary: string };
  status?: LiveStatus;
}

/** 实时轨迹最多保留的事件数：超出后丢弃最早的（落盘轨迹另有 300 条 / 400KB 上限） */
export const MAX_LIVE_TRACE = 3000;

export function applyLiveEvents(
  prev: TabLive | undefined,
  events: readonly HarnessLiveEvent[],
  now = Date.now(),
): TabLive {
  const next: TabLive = { ...(prev ?? { text: '', startedAt: now }) };
  let added: HarnessTraceEvent[] | null = null;
  const touch = () => {
    next.firstEventAt ??= now;
    delete next.status;
  };

  for (const e of events) {
    switch (e.type) {
      case 'text-delta':
        next.text += e.text;
        touch();
        break;
      case 'text':
        next.text = e.text;
        touch();
        break;
      case 'tool':
      case 'thinking': {
        const { tabId: _id, ...ev } = e;
        (added ??= []).push(ev.at === undefined ? { ...ev, at: now } : ev);
        if (e.type === 'tool') {
          next.tool = e.name;
          next.toolStatus = e.status;
        }
        touch();
        break;
      }
      case 'permission':
        next.permission = { id: e.id, summary: e.summary };
        break;
      case 'status':
        if (e.kind === 'clear') delete next.status;
        else next.status = { kind: e.kind, text: e.text, attempt: e.attempt, max: e.max };
        break;
      case 'done':
      case 'error':
        delete next.permission;
        delete next.status;
        break;
      default:
        break;
    }
  }

  if (added) {
    let trace = next.trace ? next.trace.concat(added) : added;
    if (trace.length > MAX_LIVE_TRACE) trace = trace.slice(trace.length - MAX_LIVE_TRACE);
    next.trace = trace;
  }
  return next;
}
