/**
 * 会话详情里的「智能体」：本会话用到的其他智能体与状态（纯函数，便于单测）。
 * - 子任务：Nomi 派给编程助手的（delegate_to_cli → 标签 delegation.callId），点开在子任务面板里看；
 * - 子代理：编程助手 / Nomi 自己派生的（Task / Agent / delegate_to_nomi 等），状态以实时状态为准。
 */
import type { HarnessBackend, HarnessTabMeta } from '../../services/harnessClient';
import type { ConvMessage } from '../../types/conversation';
import type { LiveAgent, TabLive } from '../../utils/liveState';
import {
  baseToolName,
  classifyTool,
  describeCall,
  parseInput,
  reduceTraceCached,
  type ToolCall,
} from '../../utils/toolTrace';
import { delegateTab, delegateView } from '../Conversation/DelegateCard';

export type SessionAgentStatus = 'running' | 'waiting' | 'done' | 'error' | 'stopped';

export interface SessionAgent {
  id: string;
  kind: 'delegate' | 'subagent';
  /** 子任务：编程助手；子代理：类型 / 名字（空 = 界面写「子代理」） */
  backend?: HarnessBackend | null;
  label?: string;
  /** 目标 / 描述 */
  detail?: string;
  status: SessionAgentStatus;
  /** 子任务的标签 id（标签还在时才有，可以打开） */
  tabId?: string;
}

const PHASE_STATUS = {
  confirming: 'waiting',
  running: 'running',
  waiting: 'waiting',
  done: 'done',
  error: 'error',
  cancelled: 'stopped',
} as const satisfies Record<string, SessionAgentStatus>;

const LIVE_STATUS: Record<LiveAgent['status'], SessionAgentStatus> = {
  running: 'running',
  completed: 'done',
  failed: 'error',
  stopped: 'stopped',
};

function callStatus(c: ToolCall): SessionAgentStatus {
  if (c.status === 'running') return 'running';
  return c.status === 'error' ? 'error' : 'done';
}

function toolCalls(messages: readonly ConvMessage[]): ToolCall[] {
  const out: ToolCall[] = [];
  for (const m of messages) {
    if (!m.trace?.length) continue;
    for (const e of reduceTraceCached(m.trace)) if (e.type === 'tool') out.push(e.call);
  }
  return out;
}

/**
 * messages：当前会话（含进行中的一轮）；tabs：编程助手标签；live：标签实时状态；
 * liveAgents：当前标签这一轮的子代理（还没出现在消息里的也算）
 */
export function collectSessionAgents(
  messages: readonly ConvMessage[],
  tabs: readonly HarnessTabMeta[] | undefined,
  live: Record<string, TabLive>,
  liveAgents?: Record<string, LiveAgent>,
): SessionAgent[] {
  const agents: SessionAgent[] = [];
  const seen = new Set<string>();
  const byCall = new Map<string, LiveAgent>();
  for (const a of Object.values(liveAgents ?? {})) if (a.callId) byCall.set(a.callId, a);
  for (const call of toolCalls(messages)) {
    if (seen.has(call.id)) continue;
    const name = baseToolName(call.name);
    if (name === 'delegate_to_cli') {
      seen.add(call.id);
      const tab = delegateTab(call, tabs);
      const v = delegateView(call, tab, tab ? live[tab.id] : undefined);
      agents.push({
        id: call.id,
        kind: 'delegate',
        backend: v.backend,
        detail: v.goal || undefined,
        status: PHASE_STATUS[v.phase],
        tabId: tab?.id,
      });
      continue;
    }
    if (classifyTool(call.name) !== 'subagent') continue;
    seen.add(call.id);
    const la = byCall.get(call.id);
    const input = parseInput(call.input);
    const type = typeof input?.subagent_type === 'string' ? input.subagent_type : undefined;
    agents.push({
      id: call.id,
      kind: 'subagent',
      label: la?.label || la?.agentType || type || (name === 'delegate_to_nomi' ? 'Nomi' : ''),
      detail: describeCall(call).target,
      status: la ? LIVE_STATUS[la.status] : callStatus(call),
    });
  }
  // 实时子代理里没关联到工具调用的（如 Codex 的协作代理）
  for (const a of Object.values(liveAgents ?? {})) {
    if (a.callId && seen.has(a.callId)) continue;
    agents.push({
      id: `live-${a.id}`,
      kind: 'subagent',
      label: a.label || a.agentType || '',
      detail: a.progress || a.summary,
      status: LIVE_STATUS[a.status],
    });
  }
  return agents;
}

export function countRunning(agents: readonly SessionAgent[]): number {
  return agents.filter((a) => a.status === 'running' || a.status === 'waiting').length;
}
