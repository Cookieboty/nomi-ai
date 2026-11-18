/**
 * 会话详情里的「Agents」：本会话用到的其他 Agents 与状态（纯函数，便于单测）。
 * - 子任务：Nomi 派给 agent 的（delegate_to_cli → 标签 delegation.callId），点开在子任务面板里看；
 * - 子代理：agents / Nomi 自己派生的（Task / Agent 等），状态以实时状态为准。
 * 派给后台 Nomi 的（delegate_to_nomi）是一个持续任务，列在「任务」里，不算 Agents。
 */
import type { DelegateResult } from '../../services/delegateClient';
import type { HarnessBackend, HarnessTabMeta } from '../../services/harnessClient';
import type { ConvMessage } from '../../types/conversation';
import { delegateOpenTab } from '../../utils/delegateTarget';
import type { LiveAgent, TabLive } from '../../utils/liveState';
import type { SubagentTarget } from '../../utils/sideTabs';
import {
  baseToolName,
  classifyTool,
  describeCall,
  parseInput,
  reduceTraceCached,
  type ToolCall,
} from '../../utils/toolTrace';
import {
  delegateTab,
  delegateView,
  parseOutput,
  withDelegateResult,
} from '../Conversation/DelegateCard';

export type SessionAgentStatus = 'running' | 'waiting' | 'done' | 'error' | 'stopped' | 'idle';

export interface SessionAgent {
  id: string;
  /** side-chat：侧边聊天（只问 Nomi 的临时聊天，和子任务在同一个标签区里） */
  kind: 'delegate' | 'subagent' | 'side-chat';
  /** 子任务：agents；子代理：类型 / 名字（空 = 界面写「子代理」） */
  backend?: HarnessBackend | null;
  label?: string;
  /** 目标 / 描述 */
  detail?: string;
  status: SessionAgentStatus;
  /** 子任务的标签 id（标签还在时才有，可以打开） */
  tabId?: string;
  /** 侧边聊天的 id */
  chatId?: string;
  /**
   * 排序用的时间：开始的时间（派出 / 侧边聊天最近一次提问）。不用「最近活动」：
   * 流式输出时它每帧都变，列表会跳。
   */
  at?: number;
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

/** 一条消息里和 Agents 有关的工具调用（委派子任务、子代理），连同预先解析好的字段 */
interface AgentCall {
  call: ToolCall;
  /** side-chat：侧边聊天（只问 Nomi 的临时聊天，和子任务在同一个标签区里） */
  kind: 'delegate' | 'subagent' | 'side-chat';
  /** 委派：最终结果还没到（输出是 running 占位）时的任务 id */
  pendingTaskId?: string;
  taskId?: string;
  /** 子代理：类型与描述 */
  type?: string;
  target?: string;
}

/**
 * 按消息缓存：流式输出时只有最新那条消息换了对象，前面的消息直接取缓存，
 * 不再每帧把全部历史的工具调用重新折叠、解析 JSON。
 */
const agentCallCache = new WeakMap<
  ConvMessage,
  { trace: ConvMessage['trace']; len: number; calls: AgentCall[] }
>();
function agentCallsOf(m: ConvMessage): AgentCall[] {
  // 同一条消息的 trace 可能被原地追加：数组和长度都没变才算命中（同 reduceTraceCached）
  const hit = agentCallCache.get(m);
  if (hit && hit.trace === m.trace && hit.len === (m.trace?.length ?? 0)) return hit.calls;
  const out: AgentCall[] = [];
  if (m.trace?.length) {
    for (const e of reduceTraceCached(m.trace)) {
      if (e.type !== 'tool') continue;
      const call = e.call;
      const name = baseToolName(call.name);
      if (name === 'delegate_to_cli') {
        const r = parseOutput(call.output).result;
        out.push({
          call,
          kind: 'delegate',
          taskId: r?.taskId,
          pendingTaskId: r?.status === 'running' ? r.taskId : undefined,
        });
      } else if (name !== 'delegate_to_nomi' && classifyTool(call.name) === 'subagent') {
        const input = parseInput(call.input);
        out.push({
          call,
          kind: 'subagent',
          type: typeof input?.subagent_type === 'string' ? input.subagent_type : undefined,
          target: describeCall(call).target,
        });
      }
    }
  }
  agentCallCache.set(m, { trace: m.trace, len: m.trace?.length ?? 0, calls: out });
  return out;
}

function agentCalls(messages: readonly ConvMessage[]): AgentCall[] {
  const out: AgentCall[] = [];
  for (const m of messages) out.push(...agentCallsOf(m));
  return out;
}

/** 工具输出还是 running 占位的异步委派：要去查 / 等最终结果的任务 id */
export function pendingDelegateTaskIds(messages: readonly ConvMessage[]): string[] {
  const out: string[] = [];
  for (const a of agentCalls(messages)) {
    if (a.pendingTaskId && !out.includes(a.pendingTaskId)) out.push(a.pendingTaskId);
  }
  return out;
}

/** 识别本次委派实际落到的 Agent 标签载体（复用同一个标签的多次委派会共享同一载体键） */
function delegateCarrierKey(
  call: ToolCall,
  openTab: HarnessTabMeta | null,
  result: DelegateResult | undefined,
): string | undefined {
  if (openTab?.id) return openTab.id;
  if (result?.tabId) return result.tabId;
  const parsed = parseOutput(call.output).result;
  if (parsed?.tabId) return parsed.tabId;
  if (parsed && !parsed.background && parsed.taskId) return parsed.taskId;
  return undefined;
}

/**
 * messages：当前会话（含进行中的一轮）；tabs：agent 标签；live：标签实时状态；
 * liveAgents：当前标签这一轮的子代理（还没出现在消息里的也算）；
 * results：异步委派的最终结果（taskId → 结果；工具输出只是 running 占位，与子任务卡片同一来源）；
 * followUps：委派结束后在子任务里接着跑的那一轮（出错后「继续」等）的最新结果
 */
export function collectSessionAgents(
  messages: readonly ConvMessage[],
  tabs: readonly HarnessTabMeta[] | undefined,
  live: Record<string, TabLive>,
  liveAgents?: Record<string, LiveAgent>,
  results?: Record<string, DelegateResult>,
  followUps?: Record<string, DelegateResult>,
): SessionAgent[] {
  const agents: SessionAgent[] = [];
  const seen = new Set<string>();
  const delegateIndexByCarrier = new Map<string, number>();
  const byCall = new Map<string, LiveAgent>();
  for (const a of Object.values(liveAgents ?? {})) if (a.callId) byCall.set(a.callId, a);
  for (const { call, kind, taskId, type, target } of agentCalls(messages)) {
    if (seen.has(call.id)) continue;
    if (kind === 'delegate') {
      seen.add(call.id);
      const tab = delegateTab(call, tabs);
      const result = taskId ? results?.[taskId] : undefined;
      const v = delegateView(withDelegateResult(call, result), tab, tab ? live[tab.id] : undefined);
      // 标签被后来的同类委派接着用了：仍按结果里的 taskId / tabId 打开它（状态还是看这一次自己的结果）
      const openTab = tab ?? delegateOpenTab(call, tabs, result);
      const entry: SessionAgent = {
        id: call.id,
        kind: 'delegate',
        backend: v.backend,
        detail: v.goal || undefined,
        status: delegateStatus(PHASE_STATUS[v.phase], tab, tab ? live[tab.id] : undefined, () =>
          taskId ? followUps?.[taskId] : undefined,
        ),
        tabId: openTab?.id,
        ...(call.startedAt != null ? { at: call.startedAt } : {}),
      };
      const carrier = delegateCarrierKey(call, openTab, result);
      if (carrier) {
        const prevIdx = delegateIndexByCarrier.get(carrier);
        if (prevIdx !== undefined) {
          const prev = agents[prevIdx]!;
          agents[prevIdx] = {
            ...entry,
            backend: entry.backend ?? prev.backend,
            detail: entry.detail ?? prev.detail,
            tabId: entry.tabId ?? prev.tabId,
            ...((entry.at ?? prev.at) != null ? { at: entry.at ?? prev.at } : {}),
          };
          continue;
        }
        delegateIndexByCarrier.set(carrier, agents.length);
      }
      agents.push(entry);
      continue;
    }
    seen.add(call.id);
    const la = byCall.get(call.id);
    agents.push({
      id: call.id,
      kind: 'subagent',
      label: la?.label || la?.agentType || type || '',
      detail: target,
      status: la ? LIVE_STATUS[la.status] : callStatus(call),
      ...((call.startedAt ?? la?.startedAt) != null ? { at: call.startedAt ?? la?.startedAt } : {}),
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
      at: a.startedAt,
    });
  }
  return agents;
}

/**
 * 委派的状态以子任务标签的现状为准：最终结果（出错 / 完成）到了以后，用户在子任务里「继续」，
 * 标签又跑起来——这时是进行中，而不是一直停在最终结果上；那一轮结束后按它的结果（followUp）显示。
 */
function delegateStatus(
  base: SessionAgentStatus,
  tab: HarnessTabMeta | null,
  tl: TabLive | undefined,
  followUp: () => DelegateResult | undefined,
): SessionAgentStatus {
  if (base === 'running' || base === 'waiting') return base;
  if (tab && (tab.status === 'running' || tab.status === 'queued'))
    return tl?.permissions?.length || tab.sandboxPending?.length ? 'waiting' : 'running';
  const f = followUp();
  if (f && f.status !== 'running') return PHASE_STATUS[f.status];
  return base;
}

export function countRunning(agents: readonly SessionAgent[]): number {
  return agents.filter((a) => a.status === 'running' || a.status === 'waiting').length;
}

/** 本会话开着的侧边聊天（会话详情的 Agents 列表里和子任务排在一起） */
export function sideChatAgents(
  chats: ReadonlyArray<{
    id: string;
    name: string;
    running: boolean;
    messages: ReadonlyArray<{ role: string; text: string; error?: string; at?: number }>;
  }>,
): SessionAgent[] {
  return chats.map((c) => {
    const last = c.messages[c.messages.length - 1];
    const lastUser = [...c.messages].reverse().find((m) => m.role === 'user');
    return {
      id: `side-chat:${c.id}`,
      kind: 'side-chat' as const,
      backend: 'nomi' as const,
      label: c.name,
      ...(lastUser?.text ? { detail: lastUser.text.replace(/\s+/g, ' ').slice(0, 160) } : {}),
      status: c.running ? 'running' : last?.error ? 'error' : last ? 'done' : 'idle',
      chatId: c.id,
      ...(lastUser?.at != null ? { at: lastUser.at } : {}),
    };
  });
}

/** 状态分组：进行中（含排队、等你批准）→ 出错 → 已完成 → 已停止 → 空闲 */
const STATUS_RANK: Record<SessionAgentStatus, number> = {
  running: 0,
  waiting: 0,
  error: 1,
  done: 2,
  stopped: 3,
  idle: 4,
};

/**
 * 会话详情 Agents 的顺序：先按状态分组，组内按开始时间新的在前；没有时间的排在组尾，
 * 同组同时间的保持原来的顺序（稳定排序）。只有状态变了才换组，流式输出不会让列表跳。
 */
export function sortSessionAgents(agents: readonly SessionAgent[]): SessionAgent[] {
  return agents
    .map((a, i) => ({ a, i }))
    .sort((x, y) => {
      const r = STATUS_RANK[x.a.status] - STATUS_RANK[y.a.status];
      if (r) return r;
      const xa = x.a.at ?? -Infinity;
      const ya = y.a.at ?? -Infinity;
      if (xa !== ya) return ya > xa ? 1 : -1;
      return x.i - y.i;
    })
    .map((x) => x.a);
}

/** 点开 / 悬停这一行看哪个：侧边聊天、标签还在的委派、进程内子代理；标签已经没了的委派没有（返回 null） */
export function sessionAgentTarget(
  a: SessionAgent,
  parentTabId: string | null,
): SubagentTarget | null {
  if (a.chatId) return { kind: 'side-chat', chatId: a.chatId };
  if (a.tabId) return { kind: 'harness', tabId: a.tabId };
  if (a.kind === 'delegate') return null;
  return { kind: 'nested', callId: a.id, parentTabId };
}
