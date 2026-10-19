/**
 * 运行中一轮的子代理实时状态（按派生它的工具调用 id 索引）：时间线里的子代理卡片据此显示
 * 后台标记、进度、状态（docs/design/cli-subagents.md §5）。历史消息没有它，卡片退回工具调用本身的状态。
 */
import { createContext, useContext } from 'react';

import type { LiveAgent } from '../../utils/liveState';

export const AgentsByCallContext = createContext<ReadonlyMap<string, LiveAgent> | undefined>(
  undefined,
);

export function useAgentForCall(callId: string): LiveAgent | undefined {
  return useContext(AgentsByCallContext)?.get(callId);
}

/** 按 callId 建索引；同一调用派生多个子代理（Codex spawn_agent）时取最近开始的那个 */
export function agentsByCall(
  agents: Record<string, LiveAgent> | undefined,
): ReadonlyMap<string, LiveAgent> | undefined {
  if (!agents) return undefined;
  const m = new Map<string, LiveAgent>();
  for (const a of Object.values(agents)) {
    if (!a.callId) continue;
    const prev = m.get(a.callId);
    if (!prev || prev.startedAt <= a.startedAt) m.set(a.callId, a);
  }
  return m.size ? m : undefined;
}
