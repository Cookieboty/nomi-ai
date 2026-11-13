/**
 * 子任务悬停卡片的内容（纯函数，便于单测）：最近发给它的一句、它最近的输出、状态。
 * 数据来自各子任务已有的实时来源（编程助手标签的消息 / 实时进度、后台 Nomi 的 trace、父转录里的子代理），
 * 见 ./index.tsx。
 */
import type { ConvMessage } from '../../types/conversation';

export type AgentCardState = 'running' | 'waiting' | 'done' | 'failed' | 'idle';

export interface AgentCardPreview {
  name: string;
  state: AgentCardState;
  /** 最近一条发给它的消息（任务说明 / 追问） */
  lastUser: string;
  /** 它最近的输出（运行中是正在写的这段） */
  lastOutput: string;
  /** 有等你确认的授权 */
  waitingHint?: string;
}

/** 卡片里的一段摘录：去掉代码块和常见 Markdown 记号，空白合并成一行，过长截断 */
export function excerpt(text: string | undefined, max = 280): string {
  if (!text) return '';
  const plain = text
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, '')
    .replace(/(\*\*|__|~~)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return plain.length > max ? `${plain.slice(0, max - 1).trimEnd()}…` : plain;
}

/** 从会话消息里取最近一条用户消息和最近的输出；liveText = 正在写的这段（优先） */
export function lastExchange(
  messages: readonly ConvMessage[],
  liveText?: string,
): { lastUser: string; lastOutput: string } {
  let lastUser = '';
  let lastOutput = '';
  for (let i = messages.length - 1; i >= 0 && (!lastUser || !lastOutput); i--) {
    const m = messages[i]!;
    if (m.role === 'user' && !lastUser) lastUser = m.text;
    if (m.role === 'assistant' && !lastOutput && !lastUser) lastOutput = m.text || m.error || '';
  }
  return {
    lastUser: excerpt(lastUser, 160),
    lastOutput: excerpt(liveText?.trim() ? liveText : lastOutput),
  };
}

/** 编程助手标签的状态 */
export function harnessCardState(status: string | undefined, waiting: boolean): AgentCardState {
  if (waiting) return 'waiting';
  if (status === 'running' || status === 'queued') return 'running';
  if (status === 'error') return 'failed';
  return 'done';
}

/** 后台 Nomi 任务的状态 */
export function taskCardState(status: string | undefined): AgentCardState {
  switch (status) {
    case 'running':
    case 'queued':
      return 'running';
    case 'waiting_user':
    case 'needs_reconcile':
    case 'awaiting_accept':
      return 'waiting';
    case 'failed':
    case 'cancelled':
    case 'expired':
      return 'failed';
    case 'done':
      return 'done';
    default:
      return 'idle';
  }
}

/** 进程内子代理（父转录里的 LiveAgent）的状态；没有实时信息时看调用是否还开着 */
export function nestedCardState(
  agentStatus: string | undefined,
  callOpen: boolean,
): AgentCardState {
  if (agentStatus === 'running') return 'running';
  if (agentStatus === 'failed') return 'failed';
  if (agentStatus === 'completed' || agentStatus === 'stopped') return 'done';
  return callOpen ? 'running' : 'done';
}

/** 父转录的实时轨迹里这次子代理调用是否还开着（还没收到结束） */
export function callStillOpen(
  trace: readonly { type: string; id?: string; detail?: string; status?: string }[] | undefined,
  callId: string,
): boolean {
  let open = false;
  for (const e of trace ?? []) {
    if (e.type !== 'tool' || (e.id ?? e.detail) !== callId) continue;
    open = e.status === 'start';
  }
  return open;
}
