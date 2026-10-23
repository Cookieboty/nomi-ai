/**
 * 运行中标签的实时状态：把一批 harness 事件折叠进 TabLive（纯函数，便于单测）。
 * 渲染层按帧（rAF）合批调用：一帧里到达上千个事件也只产生一次新状态、一次数组复制。
 */
import type { HarnessLiveEvent, HarnessTraceEvent } from '../services/harnessClient';

import { mergeAssistantText } from './textCursor';

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
  /** 正文分段起点（后一段模型消息从这里开始） */
  textBreaks?: number[];
  /** 本轮开始时间（ms），用于「已处理 N 秒」 */
  startedAt?: number;
  /** 收到本轮第一个输出事件（文本 / 工具 / 思考）的时间；未收到时为「等待首字」 */
  firstEventAt?: number;
  /**
   * 待确认的权限请求（按到达顺序排队）：并行子代理会同时请求，不能互相覆盖
   * （docs/design/cli-subagents.md §5）
   */
  permissions?: PendingPermission[];
  /** 最近一次超时自动拒绝（界面短暂提示） */
  permissionExpired?: { summary: string; agent?: string; at: number };
  /** 本轮出现过的子代理（按 id）；卡片按 callId 关联到派生它的工具调用 */
  agents?: Record<string, LiveAgent>;
  status?: LiveStatus;
  /**
   * 本轮最近一次主线程请求的上下文占用（或压缩后的新占用）。轮末 usage 落盘前，上下文环以它为准；
   * tokens 为 null：刚压缩、大小未知。model：CLI 实际使用的模型（标签没设模型时用来查窗口）；
   * window：CLI 上报的模型窗口（Codex / Gemini）。
   */
  context?: { tokens: number | null; model?: string; window?: number };
}

/** 一个子代理的实时状态（start / progress / end 折叠而来） */
export interface LiveAgent {
  id: string;
  callId?: string;
  label?: string;
  agentType?: string;
  background?: boolean;
  status: 'running' | 'completed' | 'failed' | 'stopped';
  progress?: string;
  summary?: string;
  usage?: { toolUses?: number; tokens?: number; durationMs?: number };
  startedAt: number;
  endedAt?: number;
}

export interface PendingPermission {
  id: string;
  summary: string;
  agent?: string;
  /** 超时自动拒绝的时间点（ms）；老版本主进程不给时为空 */
  expiresAt?: number;
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
      case 'text': {
        const folded = mergeAssistantText(next.text, e.text, next.textBreaks ?? [], 'segment');
        next.text = folded.text;
        if (folded.breaks.length) next.textBreaks = folded.breaks;
        else delete next.textBreaks;
        touch();
        break;
      }
      case 'tool':
      case 'thinking': {
        const { tabId: _id, ...rest } = e;
        const stamped = rest.textAt === undefined ? { ...rest, textAt: next.text.length } : rest;
        const ev = stamped.at === undefined ? { ...stamped, at: now } : stamped;
        (added ??= []).push(ev);
        if (e.type === 'tool') {
          next.tool = e.name;
          next.toolStatus = e.status;
        }
        touch();
        break;
      }
      case 'permission': {
        const list = next.permissions ?? [];
        if (!list.some((p) => p.id === e.id))
          next.permissions = [
            ...list,
            {
              id: e.id,
              summary: e.summary,
              ...(e.agent ? { agent: e.agent } : {}),
              ...(e.expiresAt !== undefined ? { expiresAt: e.expiresAt } : {}),
            },
          ];
        break;
      }
      case 'permission-resolved': {
        const gone = next.permissions?.find((p) => p.id === e.id);
        const rest = (next.permissions ?? []).filter((p) => p.id !== e.id);
        if (rest.length) next.permissions = rest;
        else delete next.permissions;
        if (gone && e.reason === 'timeout')
          next.permissionExpired = {
            summary: gone.summary,
            ...(gone.agent ? { agent: gone.agent } : {}),
            at: now,
          };
        break;
      }
      case 'agent': {
        const prevAgent = next.agents?.[e.id];
        const base: LiveAgent = prevAgent ?? { id: e.id, status: 'running', startedAt: now };
        // 结束后迟到的 progress 不把状态改回运行中
        const ended = base.status !== 'running';
        const merged: LiveAgent = {
          ...base,
          ...(e.callId ? { callId: e.callId } : {}),
          ...(e.label ? { label: e.label } : {}),
          ...(e.agentType ? { agentType: e.agentType } : {}),
          ...(e.background !== undefined ? { background: e.background } : {}),
          ...(e.progress && !ended ? { progress: e.progress } : {}),
          ...(e.summary ? { summary: e.summary } : {}),
          ...(e.usage ? { usage: { ...base.usage, ...e.usage } } : {}),
          ...(e.op === 'end'
            ? { status: e.status ?? 'completed', endedAt: base.endedAt ?? now }
            : {}),
        };
        next.agents = { ...next.agents, [e.id]: merged };
        touch();
        break;
      }
      case 'context':
        next.context = {
          tokens: e.tokens,
          model: e.model ?? next.context?.model,
          window: e.window ?? next.context?.window,
        };
        break;
      case 'status':
        if (e.kind === 'clear') delete next.status;
        else next.status = { kind: e.kind, text: e.text, attempt: e.attempt, max: e.max };
        break;
      case 'done':
      case 'error':
        delete next.permissions;
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
