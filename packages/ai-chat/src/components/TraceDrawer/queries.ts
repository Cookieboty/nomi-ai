/**
 * 轨迹查询、过滤、进程内子代理提取、思考脉络组装与耗时洞察计算（纯函数，无 React）。
 */
import { t } from '@nomi-ai/ui';

import type { HarnessTraceEvent } from '../../services/harnessClient';
import type { ConvMessage } from '../../types/conversation';
import { thoughtTitle } from '../../utils/timelineShape';
import { baseToolName, formatDuration, parseInput, type ToolCall } from '../../utils/toolTrace';

import type { TraceAgentLane, TraceDocument, TraceNode, TraceTurn } from './model';
import { canonicalModelName } from './modelAudit';
import { offsetLabel } from './waterfall';

/** 慢步骤阈值（毫秒）：超过 2s 在界面标为慢步骤 */
export const SLOW_STEP_MS = 2_000;

function firstText(v: unknown): string {
  return typeof v === 'string' && v.trim() ? v.trim() : '';
}

export function extractAgentIds(call: ToolCall): string[] {
  const out: string[] = [];
  const add = (id: unknown) => {
    if (typeof id === 'string' && id && !out.includes(id)) out.push(id);
  };
  const input = parseInput(call.input);
  if (Array.isArray(input?.agents)) input.agents.forEach(add);
  const m = call.output ? /\bagentId:\s*([\w-]+)/.exec(call.output) : null;
  if (m) add(m[1]);
  return out;
}

/**
 * 绕过 reduceTrace 对 parentId 思考与正文的过滤，提取进程内子代理的完整消息轮次。
 * 保留其内部嵌套的子孙事件（改写直接 parentId 为 undefined），支持多层子代理递归展开。
 */
export function extractNestedAgentMessages(
  events: readonly HarnessTraceEvent[],
  callId: string,
  extraIds: readonly string[] = [],
  callInput?: string,
  callOutput?: string,
  callAt = 0,
): ConvMessage[] {
  const directIds = new Set([callId, ...extraIds]);
  const subtreeIds = new Set<string>(directIds);
  let grew = true;
  while (grew) {
    grew = false;
    for (const ev of events) {
      if (ev.type === 'tool' && ev.parentId && subtreeIds.has(ev.parentId)) {
        const id = ev.id ?? ev.detail;
        if (id && !subtreeIds.has(id)) {
          subtreeIds.add(id);
          grew = true;
        }
      }
    }
  }

  let prompt = '';
  const parsedIn = parseInput(callInput);
  if (parsedIn) {
    for (const key of ['prompt', 'description', 'goal', 'task']) {
      const s = firstText(parsedIn[key]);
      if (s) {
        prompt = s;
        break;
      }
    }
  }

  interface TurnBuf {
    user?: string;
    userAt?: number;
    text: string;
    trace: HarnessTraceEvent[];
    at: number;
  }
  const turns: TurnBuf[] = [{ text: '', trace: [], at: callAt }];
  const cur = () => turns[turns.length - 1]!;

  for (const ev of events) {
    const parentId = 'parentId' in ev ? ev.parentId : undefined;
    if (!parentId || !subtreeIds.has(parentId)) continue;
    const isDirect = directIds.has(parentId);
    if (ev.type === 'agent-input') {
      if (isDirect && ev.text.trim()) {
        turns.push({ user: ev.text, userAt: ev.at, text: '', trace: [], at: ev.at ?? callAt });
      }
      continue;
    }
    if (ev.type === 'agent-text') {
      if (isDirect && ev.text.trim()) {
        const tBuf = cur();
        tBuf.text = tBuf.text ? `${tBuf.text}\n\n${ev.text}` : ev.text;
        if (ev.at) tBuf.at = ev.at;
      } else if (!isDirect) {
        cur().trace.push(ev);
      }
      continue;
    }
    if (ev.type === 'thinking') {
      if (!ev.text.trim()) continue;
      cur().trace.push({
        type: 'thinking',
        text: ev.text,
        at: ev.at,
        textAt: cur().text.length,
        ...(isDirect ? {} : { parentId: ev.parentId }),
      });
      continue;
    }
    if (ev.type === 'tool') {
      cur().trace.push({
        ...ev,
        textAt: cur().text.length,
        ...(isDirect ? { parentId: undefined } : {}),
      });
    }
  }

  const out: ConvMessage[] = [];
  const first = turns[0]!;
  const firstTextVal = first.text || (callOutput ?? '');
  if (prompt) {
    out.push({ id: `nested-${callId}-u0`, role: 'user', text: prompt, at: callAt || 1 });
  }
  if (firstTextVal || first.trace.length) {
    out.push({
      id: `nested-${callId}-a0`,
      role: 'assistant',
      text: firstTextVal,
      at: first.at || callAt || 1,
      ...(first.trace.length ? { trace: first.trace } : {}),
    });
  }
  turns.slice(1).forEach((tb, idx) => {
    const when = tb.userAt ?? tb.at ?? callAt ?? 1;
    out.push({ id: `nested-${callId}-u${idx + 1}`, role: 'user', text: tb.user ?? '', at: when });
    if (tb.text || tb.trace.length) {
      out.push({
        id: `nested-${callId}-a${idx + 1}`,
        role: 'assistant',
        text: tb.text,
        at: tb.at || when,
        ...(tb.trace.length ? { trace: tb.trace } : {}),
      });
    }
  });
  return out;
}

export type TraceKindFilter =
  | 'all'
  | 'thinking'
  | 'tool'
  | 'subagent'
  | 'request'
  | 'error'
  | 'slow'
  | 'mismatch';

export interface TraceFilter {
  query: string;
  kind: TraceKindFilter;
  laneId: string;
  model?: string;
}

export interface TraceFilterResult {
  active: boolean;
  matchedIds: Set<string>;
  orderedMatches: string[];
  visibleTurnIds: Set<string>;
}

export function filterTraceDocument(doc: TraceDocument, filter: TraceFilter): TraceFilterResult {
  const terms = filter.query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  const modelKey = filter.model && filter.model !== 'all' ? filter.model : undefined;
  const active =
    terms.length > 0 || filter.kind !== 'all' || filter.laneId !== 'all' || modelKey !== undefined;
  const matchedIds = new Set<string>();
  const orderedMatches: string[] = [];
  const visibleTurnIds = new Set<string>();

  const nodeHasModelAnomaly = (n: TraceNode): boolean => {
    if (n.kind === 'request' && n.req) {
      const a = doc.modelAnalysis?.requestAuditsByReqId[n.req.id];
      return a?.verdict === 'mismatch' || a?.verdict === 'suspect';
    }
    if (n.kind === 'reply' || n.kind === 'error') {
      const ta = doc.turnsById[n.turnId]?.modelAudit;
      return ta?.verdict === 'mismatch' || ta?.verdict === 'suspect';
    }
    return false;
  };

  for (const id of doc.orderedNodeIds) {
    const n = doc.nodesById[id]!;
    if (filter.laneId !== 'all' && n.laneId !== filter.laneId) continue;
    if (modelKey) {
      const turnModel = doc.turnsById[n.turnId]?.model;
      const reqModel = n.req?.upstreamModel || n.req?.model;
      const turnMatch = turnModel ? canonicalModelName(turnModel) === modelKey : false;
      const reqMatch = reqModel ? canonicalModelName(reqModel) === modelKey : false;
      if (!turnMatch && !reqMatch) continue;
    }
    if (filter.kind === 'thinking' && n.kind !== 'thinking') continue;
    if (filter.kind === 'tool' && n.kind !== 'tool') continue;
    if (filter.kind === 'subagent' && n.kind !== 'subagent') continue;
    if (filter.kind === 'request' && n.kind !== 'request') continue;
    if (filter.kind === 'error' && n.status !== 'error') continue;
    if (filter.kind === 'slow' && !(n.durationMs !== undefined && n.durationMs >= SLOW_STEP_MS))
      continue;
    if (filter.kind === 'mismatch' && !nodeHasModelAnomaly(n)) continue;
    if (terms.length > 0) {
      const laneName = doc.lanesById[n.laneId]?.name.toLowerCase() ?? '';
      const haystack = `${n.searchText} ${laneName}`;
      if (!terms.every((term) => haystack.includes(term))) continue;
    }
    matchedIds.add(id);
    orderedMatches.push(id);
    if (n.turnId && n.turnId !== 'unassigned') visibleTurnIds.add(n.turnId);
  }

  return { active, matchedIds, orderedMatches, visibleTurnIds };
}

export interface ThinkingChainItem {
  node: TraceNode;
  lane: TraceAgentLane;
  turn: TraceTurn;
  stepIndex: number;
  summary: string;
  triggeredActions: TraceNode[];
}

/**
 * 提取按发生顺序排列的思考脉络，每段思考关联其后触发的工具/子代理操作。
 */
export function extractThinkingChain(
  doc: TraceDocument,
  filter?: TraceFilterResult,
): ThinkingChainItem[] {
  const items: ThinkingChainItem[] = [];
  const visitedTurns = new Set<string>();
  let stepIndex = 0;

  const visitTurn = (turnId: string) => {
    if (visitedTurns.has(turnId)) return;
    visitedTurns.add(turnId);
    const turn = doc.turnsById[turnId];
    if (!turn) return;
    const lane = doc.lanesById[turn.laneId]!;
    const nodes = turn.nodeIds.map((id) => doc.nodesById[id]!).filter(Boolean);

    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i]!;
      if (n.kind === 'subagent' && n.childTurnIds?.length) {
        for (const cid of n.childTurnIds) visitTurn(cid);
        continue;
      }
      if (n.kind !== 'thinking') continue;
      if (filter?.active && !filter.matchedIds.has(n.id)) continue;

      const triggered: TraceNode[] = [];
      for (let j = i + 1; j < nodes.length; j++) {
        const next = nodes[j]!;
        if (next.kind === 'thinking' || next.kind === 'reply' || next.kind === 'user') break;
        if (next.kind === 'tool' || next.kind === 'subagent' || next.kind === 'error') {
          triggered.push(next);
        }
      }

      stepIndex += 1;
      items.push({
        node: n,
        lane,
        turn,
        stepIndex,
        summary: thoughtTitle(n.text ?? '', 'first', 120) || n.title,
        triggeredActions: triggered,
      });

      for (const act of triggered) {
        if (act.kind === 'subagent' && act.childTurnIds?.length) {
          for (const cid of act.childTurnIds) visitTurn(cid);
        }
      }
    }
  };

  for (const tid of doc.rootTurnIds) visitTurn(tid);
  return items;
}

export function formatThinkingMarkdown(items: readonly ThinkingChainItem[], docFrom: number): string {
  return items
    .map((item) => {
      const offset = item.node.start !== undefined ? offsetLabel(item.node.start, docFrom) : '';
      const dur = formatDuration(item.node.durationMs);
      const header = [`### #${item.stepIndex} ${item.lane.name} · ${item.turn.label}`, offset, dur]
        .filter(Boolean)
        .join(' · ');
      const actions = item.triggeredActions.length
        ? `\n\n**${t('ui.devtools.triggered-actions')}:**\n${item.triggeredActions
            .map((a) => `- [${a.status}] ${a.title}${a.durationMs ? ` (${formatDuration(a.durationMs)})` : ''}`)
            .join('\n')}`
        : '';
      return `${header}\n\n${item.node.text ?? ''}${actions}`;
    })
    .join('\n\n---\n\n');
}

export interface TraceInsights {
  totalMs: number;
  thinkingMs: number;
  toolMs: number;
  subagentMs: number;
  requestMs: number;
  otherMs: number;
  slowest: TraceNode[];
  failed: TraceNode[];
  toolDistribution: Array<{ name: string; count: number; errors: number; totalMs: number }>;
}

export function computeTraceInsights(doc: TraceDocument): TraceInsights {
  let thinkingMs = 0;
  let toolMs = 0;
  let subagentMs = 0;
  let requestMs = 0;
  const timedSteps: TraceNode[] = [];
  const failed: TraceNode[] = [];
  const toolCounts = new Map<string, { name: string; count: number; errors: number; totalMs: number }>();

  for (const id of doc.orderedNodeIds) {
    const n = doc.nodesById[id]!;
    if (n.status === 'error') failed.push(n);
    const dur = n.durationMs ?? 0;
    if (n.kind === 'thinking') thinkingMs += dur;
    else if (n.kind === 'tool') toolMs += dur;
    else if (n.kind === 'subagent') subagentMs += dur;
    else if (n.kind === 'request') requestMs += dur;

    if (n.kind !== 'request' && n.kind !== 'user' && n.kind !== 'reply' && n.durationMs !== undefined) {
      timedSteps.push(n);
    }
    if (n.kind === 'tool' && n.call) {
      const key = baseToolName(n.call.name);
      const cur = toolCounts.get(key) ?? { name: n.call.name, count: 0, errors: 0, totalMs: 0 };
      cur.count += 1;
      if (n.status === 'error') cur.errors += 1;
      cur.totalMs += dur;
      toolCounts.set(key, cur);
    }
  }

  const totalMs = Math.max(1, doc.to - doc.from);
  const tracked = thinkingMs + toolMs + subagentMs;
  const otherMs = Math.max(0, totalMs - tracked);

  const slowest = [...timedSteps]
    .sort((a, b) => (b.durationMs ?? 0) - (a.durationMs ?? 0))
    .slice(0, 5);

  const toolDistribution = [...toolCounts.values()]
    .sort((a, b) => b.count - a.count || b.totalMs - a.totalMs)
    .slice(0, 8);

  return {
    totalMs,
    thinkingMs,
    toolMs,
    subagentMs,
    requestMs,
    otherMs,
    slowest,
    failed,
    toolDistribution,
  };
}
