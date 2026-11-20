/**
 * 执行轨迹数据模型（纯函数，无 React，便于单测）：
 * - 向后兼容原有单轮瀑布图工具函数（turnWindow / waterfallRows / barOf 等）；
 * - 统一建模单轮（turn）、整次会话（session）与后台任务（task）的多层级轨迹文档；
 * - 完整还原主代理与子代理（进程内 parentId / delegate_to_cli / delegate_to_nomi）的思考与工具调用；
 * - 提供全文检索、多维筛选、思考脉络提取与耗时洞察计算。
 */
import { t } from '@nomi-ai/ui';

import type { DelegateResult } from '../../services/delegateClient';
import type {
  HarnessBackend,
  HarnessTraceEvent,
  HarnessUsage,
} from '../../services/harnessClient';
import type { QualityRequestItem } from '../../services/qualityClient';
import { attemptStatusLabel, type Attempt, type JournalEntry } from '../../services/tasksClient';
import type { ConvMessage } from '../../types/conversation';
import { cacheHitRate } from '../../utils/cacheHit';
import { ENDPOINT_NAME, type EndpointKey } from '../../utils/endpointBadge';
import type { LiveAgent } from '../../utils/liveState';
import { thoughtTitle } from '../../utils/timelineShape';
import {
  baseToolName,
  bucketOf,
  callDuration,
  classifyTool,
  describeCall,
  diffStats,
  parseInput,
  reduceTrace,
  type Bucket,
  type ToolCall,
  type ToolKind,
} from '../../utils/toolTrace';

import {
  analyzeTraceModels,
  canonicalModelName,
  stripProviderPrefix,
  type TraceModelAnalysis,
  type TurnModelAudit,
} from './modelAudit';
import { extractAgentIds, extractNestedAgentMessages, SLOW_STEP_MS } from './queries';
import { FALLBACK_WINDOW_MS, turnWindow } from './waterfall';

export * from './waterfall';
export * from './queries';
export * from './modelAudit';

/** 子代理最大递归展开层级，防止循环引用 */
const MAX_SUBAGENT_DEPTH = 3;

// ───────────────────────── 统一轨迹图文档模型 ─────────────────────────

export type TraceScope = 'turn' | 'session' | 'task';

export type TraceNodeKind =
  | 'user'
  | 'thinking'
  | 'tool'
  | 'subagent'
  | 'reply'
  | 'request'
  | 'interject'
  | 'error'
  | 'status';

export type TraceNodeStatus = 'done' | 'running' | 'error' | 'stopped';

export interface TraceAgentLane {
  id: string;
  name: string;
  backend?: EndpointKey | null;
  kind: 'main' | 'nested' | 'delegate' | 'nomi-task' | 'task';
  parentLaneId?: string;
  tabId?: string;
  status: TraceNodeStatus;
  closed?: boolean;
  stepCount: number;
  durationMs?: number;
}

export interface TraceNode {
  id: string;
  kind: TraceNodeKind;
  laneId: string;
  turnId: string;
  depth: number;
  title: string;
  subtitle?: string;
  toolKind?: ToolKind;
  bucket?: Bucket;
  status: TraceNodeStatus;
  start?: number;
  end?: number;
  durationMs?: number;
  searchText: string;
  parentNodeId?: string;
  subagentLaneId?: string;
  childTurnIds?: string[];
  call?: ToolCall;
  req?: QualityRequestItem;
  text?: string;
  message?: ConvMessage;
  delegateResult?: DelegateResult;
  attempt?: Attempt;
  firstAt?: number;
}

export interface TraceWave {
  id: string;
  kind: 'single' | 'parallel';
  nodeIds: string[];
}

export interface TraceTurn {
  id: string;
  laneId: string;
  index: number;
  label: string;
  startedAt?: number;
  endedAt?: number;
  durationMs?: number;
  status: TraceNodeStatus;
  model?: string;
  responseModel?: string;
  switchedFromModel?: string;
  modelAudit?: TurnModelAudit;
  usage?: HarnessUsage;
  nodeIds: string[];
  requestNodeIds: string[];
  waves: TraceWave[];
  triggerNote?: string;
}

export interface TraceStats {
  turns: number;
  thinkingCount: number;
  toolCount: number;
  subagentCount: number;
  failedCount: number;
  slowCount: number;
  requestCount: number;
  modelAnomalyCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  hitRate?: number;
  costUsd?: number;
}

export interface TraceDocument {
  scope: TraceScope;
  title: string;
  subtitle?: string;
  from: number;
  to: number;
  lanes: TraceAgentLane[];
  lanesById: Record<string, TraceAgentLane>;
  turns: TraceTurn[];
  turnsById: Record<string, TraceTurn>;
  nodesById: Record<string, TraceNode>;
  orderedNodeIds: string[];
  rootTurnIds: string[];
  unassignedRequestIds: string[];
  stats: TraceStats;
  modelAnalysis: TraceModelAnalysis;
}

export interface SubTabPayload {
  tabId: string;
  title: string;
  backend: HarnessBackend;
  messages: readonly ConvMessage[];
  liveTrace?: readonly HarnessTraceEvent[];
  liveText?: string;
  running?: boolean;
  closed?: boolean;
}

export interface SubTaskPayload {
  taskId: string;
  title: string;
  executorKind: 'nomi' | 'cli' | 'notify';
  messages: readonly ConvMessage[];
  liveTrace?: readonly HarnessTraceEvent[];
  liveText?: string;
  liveStartedAt?: number;
  running?: boolean;
}

export interface BuildTraceDocumentInput {
  scope: TraceScope;
  title: string;
  subtitle?: string;
  mainLaneName: string;
  mainBackend?: EndpointKey | null;
  mainTabId?: string;
  messages: readonly ConvMessage[];
  liveTrace?: readonly HarnessTraceEvent[];
  liveText?: string;
  liveStartedAt?: number;
  liveAgents?: Record<string, LiveAgent>;
  requests?: readonly QualityRequestItem[];
  subTabs?: Readonly<Record<string, SubTabPayload>>;
  subTasks?: Readonly<Record<string, SubTaskPayload>>;
  delegateResults?: Readonly<Record<string, DelegateResult>>;
  tabLookupByCallId?: Readonly<Record<string, string>>;
  tabLookupByTaskId?: Readonly<Record<string, string>>;
  attempts?: readonly Attempt[];
  journal?: readonly JournalEntry[];
}

function parseDelegateOutput(output: string | undefined): {
  result?: DelegateResult;
  error?: { code: string; message: string };
} {
  if (!output) return {};
  try {
    const o = JSON.parse(output) as {
      ok?: boolean;
      data?: DelegateResult;
      error?: { code: string; message: string };
    };
    if (o.ok && o.data) return { result: o.data };
    if (o.ok === false && o.error) return { error: o.error };
  } catch {
    /* 截断输出按纯文本处理 */
  }
  return {};
}

function firstText(v: unknown): string {
  return typeof v === 'string' && v.trim() ? v.trim() : '';
}

function buildSearchText(parts: Array<string | number | undefined | null>): string {
  return parts
    .filter((p): p is string | number => p !== undefined && p !== null && p !== '')
    .join(' ')
    .toLowerCase();
}

function inferEndpoint(backend?: string | null): EndpointKey | null {
  if (!backend) return null;
  if (backend in ENDPOINT_NAME) return backend as EndpointKey;
  return 'other';
}

interface PairedTurnInput {
  user?: ConvMessage;
  assistant?: ConvMessage;
  liveTrace?: readonly HarnessTraceEvent[];
  liveText?: string;
  liveStartedAt?: number;
  label?: string;
  triggerNote?: string;
  attempt?: Attempt;
}

function pairMessagesIntoTurns(
  messages: readonly ConvMessage[],
  liveTrace?: readonly HarnessTraceEvent[],
  liveText?: string,
  liveStartedAt?: number,
): PairedTurnInput[] {
  const turns: PairedTurnInput[] = [];
  let pendingUser: ConvMessage | undefined;

  for (const m of messages) {
    if (m.role === 'user') {
      if (pendingUser) turns.push({ user: pendingUser });
      pendingUser = m;
      continue;
    }
    turns.push({
      ...(pendingUser ? { user: pendingUser } : {}),
      assistant: m,
    });
    pendingUser = undefined;
  }
  if (pendingUser || liveTrace?.length || liveText) {
    turns.push({
      ...(pendingUser ? { user: pendingUser } : {}),
      ...(liveTrace?.length ? { liveTrace } : {}),
      ...(liveText ? { liveText } : {}),
      ...(liveStartedAt !== undefined ? { liveStartedAt } : {}),
    });
  }
  return turns;
}

function sliceTabMessagesForCall(
  tabMsgs: readonly ConvMessage[],
  call: ToolCall,
  siblings: readonly ToolCall[],
): ConvMessage[] {
  if (siblings.length <= 1 || call.startedAt === undefined) return [...tabMsgs];
  const idx = siblings.findIndex((s) => s.id === call.id);
  const prevEnd = idx > 0 ? siblings[idx - 1]!.endedAt : undefined;
  const nextStart = idx >= 0 && idx + 1 < siblings.length ? siblings[idx + 1]!.startedAt : undefined;
  const from = Math.max(call.startedAt - 2500, prevEnd !== undefined ? prevEnd : -Infinity);
  const to =
    call.endedAt !== undefined
      ? Math.min(call.endedAt + 2500, nextStart !== undefined ? nextStart : Infinity)
      : nextStart !== undefined
        ? nextStart
        : Infinity;
  const sliced = tabMsgs.filter((m) => m.at >= from && m.at <= to);
  return sliced.length > 0 ? sliced : [...tabMsgs];
}

function buildWavesFromNodes(nodes: readonly TraceNode[]): TraceWave[] {
  const waves: TraceWave[] = [];
  let i = 0;
  let seq = 0;
  while (i < nodes.length) {
    const cur = nodes[i]!;
    if (cur.kind !== 'tool') {
      waves.push({ id: `w-${cur.turnId}-${seq++}`, kind: 'single', nodeIds: [cur.id] });
      i += 1;
      continue;
    }
    // 连续有时间重叠（或同毫秒发起）的 tool 节点组成一个并行扇出波次
    const group = [cur];
    let maxEnd = cur.end ?? cur.start;
    let j = i + 1;
    while (j < nodes.length) {
      const nxt = nodes[j]!;
      if (nxt.kind !== 'tool') break;
      const overlapping =
        cur.start !== undefined &&
        nxt.start !== undefined &&
        maxEnd !== undefined &&
        (nxt.start < maxEnd || nxt.start === cur.start);
      if (!overlapping) break;
      group.push(nxt);
      if (nxt.end !== undefined) maxEnd = Math.max(maxEnd ?? nxt.end, nxt.end);
      j += 1;
    }
    waves.push({
      id: `w-${cur.turnId}-${seq++}`,
      kind: group.length > 1 ? 'parallel' : 'single',
      nodeIds: group.map((n) => n.id),
    });
    i = j;
  }
  return waves;
}

/**
 * 构建统一 TraceDocument（同时服务轨迹图、时间线、思考脉络、搜索、检查器）。
 */
export function buildTraceDocument(input: BuildTraceDocumentInput): TraceDocument {
  const lanes: TraceAgentLane[] = [];
  const lanesById: Record<string, TraceAgentLane> = {};
  const turns: TraceTurn[] = [];
  const turnsById: Record<string, TraceTurn> = {};
  const nodesById: Record<string, TraceNode> = {};
  const orderedNodeIds: string[] = [];
  const rootTurnIds: string[] = [];
  const visitedTabs = new Set<string>();
  const visitedTasks = new Set<string>();
  const referencedTasks = new Set<string>();

  const mainLane: TraceAgentLane = {
    id: 'main',
    name: input.mainLaneName,
    backend: input.mainBackend ?? null,
    kind: input.scope === 'task' ? 'task' : 'main',
    ...(input.mainTabId ? { tabId: input.mainTabId } : {}),
    status: 'done',
    stepCount: 0,
  };
  lanes.push(mainLane);
  lanesById[mainLane.id] = mainLane;

  let seq = 0;
  const nextId = (prefix: string) => `${prefix}-${++seq}`;

  const addNode = (node: TraceNode) => {
    nodesById[node.id] = node;
    orderedNodeIds.push(node.id);
    const lane = lanesById[node.laneId];
    if (lane && node.kind !== 'request') lane.stepCount += 1;
  };

  // 统计所有委派 tab 的调用列表，用于同一 tab 复用时的时间窗切片
  const callsByTab = new Map<string, ToolCall[]>();
  const registerDelegateCalls = (msgs: readonly ConvMessage[]) => {
    for (const m of msgs) {
      if (!m.trace?.length) continue;
      for (const e of reduceTrace(m.trace)) {
        if (e.type !== 'tool' || baseToolName(e.call.name) !== 'delegate_to_cli') continue;
        const parsed = parseDelegateOutput(e.call.output);
        const tabId =
          input.tabLookupByCallId?.[e.call.id] ??
          (parsed.result?.taskId ? input.tabLookupByTaskId?.[parsed.result.taskId] : undefined) ??
          parsed.result?.tabId;
        if (tabId) {
          const arr = callsByTab.get(tabId) ?? [];
          arr.push(e.call);
          callsByTab.set(tabId, arr);
        }
      }
    }
  };
  registerDelegateCalls(input.messages);

  const processTurnsForLane = (
    laneId: string,
    turnInputs: readonly PairedTurnInput[],
    depth: number,
    isRoot: boolean,
  ): string[] => {
    const laneTurnIds: string[] = [];
    turnInputs.forEach((ti, idx) => {
      const turnId = nextId(`turn-${laneId}`);
      const msg = ti.assistant;
      const isLive = !msg && !!(ti.liveTrace?.length || ti.liveText);
      const rawEvents = msg?.trace ?? ti.liveTrace ?? [];
      const entries = reduceTrace(rawEvents);
      const turnEnd = msg?.at;
      const turnStart =
        ti.liveStartedAt ??
        ti.user?.at ??
        (msg ? turnWindow(msg).from : undefined);

      let status: TraceNodeStatus = 'done';
      if (isLive) status = 'running';
      else if (msg?.stopped) status = 'stopped';
      else if (msg?.error) status = 'error';

      const turnLabel =
        input.scope === 'task' && ti.attempt
          ? t('ui.devtools.attempt-n', String(idx + 1))
          : msg?.origin === 'background'
            ? t('ui.devtools.background-follow-up')
            : t('ui.devtools.turn-n', String(idx + 1));

      const turnNodes: TraceNode[] = [];
      const pushTurnNode = (node: TraceNode) => {
        turnNodes.push(node);
        addNode(node);
      };

      // 1. 用户输入节点
      if (ti.user?.text) {
        pushTurnNode({
          id: nextId('n-user'),
          kind: 'user',
          laneId,
          turnId,
          depth,
          title: t('ui.devtools.user-input'),
          subtitle: ti.user.text.replace(/\s+/g, ' ').trim().slice(0, 72),
          status: 'done',
          start: ti.user.at,
          end: ti.user.at,
          text: ti.user.text,
          message: ti.user,
          searchText: buildSearchText([t('ui.devtools.user-input'), ti.user.text]),
        });
      }

      // 2. 轨迹条目（思考 / 插话 / 工具 / 子代理）
      for (let ei = 0; ei < entries.length; ei++) {
        const entry = entries[ei]!;
        if (entry.type === 'thinking') {
          if (!entry.text.trim()) continue;
          const nextEntry = entries[ei + 1];
          const nextAt = nextEntry
            ? nextEntry.type === 'tool'
              ? nextEntry.call.startedAt
              : nextEntry.at
            : undefined;
          const running = isLive && ei === entries.length - 1;
          const end = running ? undefined : (nextAt ?? (nextEntry ? entry.lastAt : (turnEnd ?? entry.lastAt)));
          const dur =
            entry.at !== undefined && end !== undefined && end >= entry.at
              ? end - entry.at
              : undefined;
          const summary = thoughtTitle(entry.text, 'first', 72) || t('ui.devtools.thinking');
          pushTurnNode({
            id: nextId('n-think'),
            kind: 'thinking',
            laneId,
            turnId,
            depth,
            title: summary,
            subtitle: t('ui.devtools.thinking'),
            status: running ? 'running' : 'done',
            start: entry.at,
            end,
            durationMs: dur,
            text: entry.text,
            searchText: buildSearchText([t('ui.devtools.thinking'), summary, entry.text]),
          });
          continue;
        }

        if (entry.type === 'interject') {
          pushTurnNode({
            id: nextId('n-ij'),
            kind: 'interject',
            laneId,
            turnId,
            depth,
            title: t('ui.session-workspace.inserted'),
            subtitle: entry.text.replace(/\s+/g, ' ').trim().slice(0, 72),
            status: 'done',
            start: entry.at,
            end: entry.at,
            text: entry.text,
            searchText: buildSearchText([t('ui.session-workspace.inserted'), entry.text]),
          });
          continue;
        }

        const c = entry.call;
        const toolKind = classifyTool(c.name);
        const desc = describeCall(c);
        const baseName = baseToolName(c.name);
        const dur = callDuration(c);
        const stats = diffStats(c);
        const callStatus: TraceNodeStatus =
          c.status === 'error' ? 'error' : c.status === 'running' ? 'running' : 'done';

        if (toolKind === 'subagent') {
          const nodeId = nextId('n-sub');
          let delegateRes: DelegateResult | undefined;
          let subLaneId: string | undefined;
          let childTurnIds: string[] = [];
          let subName = desc.verb;
          let subClosed = false;

          if (baseName === 'delegate_to_cli') {
            const parsed = parseDelegateOutput(c.output);
            const taskId = parsed.result?.taskId;
            const res = (taskId ? input.delegateResults?.[taskId] : undefined) ?? parsed.result;
            delegateRes = res;
            const tabId =
              input.tabLookupByCallId?.[c.id] ??
              (taskId ? input.tabLookupByTaskId?.[taskId] : undefined) ??
              res?.tabId;
            const parsedIn = parseInput(c.input);
            const cliId = (res?.cli ?? firstText(parsedIn?.cli)) || undefined;
            let subBackend = inferEndpoint(cliId);
            if (subBackend && ENDPOINT_NAME[subBackend]) subName = ENDPOINT_NAME[subBackend];

            const tabPayload = tabId ? input.subTabs?.[tabId] : undefined;
            if (tabPayload && depth < MAX_SUBAGENT_DEPTH && !visitedTabs.has(tabPayload.tabId)) {
              visitedTabs.add(tabPayload.tabId);
              subName = tabPayload.title || subName;
              subBackend = inferEndpoint(tabPayload.backend) ?? subBackend;
              subLaneId = nextId('lane-del');
              const sLane: TraceAgentLane = {
                id: subLaneId,
                name: subName,
                backend: subBackend,
                kind: 'delegate',
                parentLaneId: laneId,
                tabId: tabPayload.tabId,
                status: tabPayload.running ? 'running' : callStatus,
                closed: tabPayload.closed,
                stepCount: 0,
                durationMs: dur ?? res?.durationMs,
              };
              lanes.push(sLane);
              lanesById[subLaneId] = sLane;
              const scopedMsgs = sliceTabMessagesForCall(
                tabPayload.messages,
                c,
                callsByTab.get(tabPayload.tabId) ?? [c],
              );
              const subTurns = pairMessagesIntoTurns(
                scopedMsgs,
                tabPayload.liveTrace,
                tabPayload.liveText,
              );
              childTurnIds = processTurnsForLane(subLaneId, subTurns, depth + 1, false);
            } else {
              subClosed = true;
              subLaneId = nextId('lane-del');
              const sLane: TraceAgentLane = {
                id: subLaneId,
                name: subName,
                backend: subBackend,
                kind: 'delegate',
                parentLaneId: laneId,
                status: callStatus,
                closed: true,
                stepCount: 0,
                durationMs: dur ?? res?.durationMs,
              };
              lanes.push(sLane);
              lanesById[subLaneId] = sLane;
            }
          } else if (baseName === 'delegate_to_nomi') {
            const parsed = parseDelegateOutput(c.output);
            const taskId = parsed.result?.taskId;
            if (taskId) referencedTasks.add(taskId);
            delegateRes = (taskId ? input.delegateResults?.[taskId] : undefined) ?? parsed.result;
            subName = ENDPOINT_NAME.nomi;
            const taskPayload = taskId ? input.subTasks?.[taskId] : undefined;
            if (taskPayload && depth < MAX_SUBAGENT_DEPTH && !visitedTasks.has(taskId!)) {
              visitedTasks.add(taskId!);
              subName = taskPayload.title || subName;
              subLaneId = nextId('lane-nomi');
              const sLane: TraceAgentLane = {
                id: subLaneId,
                name: subName,
                backend: 'nomi',
                kind: 'nomi-task',
                parentLaneId: laneId,
                status: taskPayload.running ? 'running' : callStatus,
                stepCount: 0,
                durationMs: dur ?? delegateRes?.durationMs,
              };
              lanes.push(sLane);
              lanesById[subLaneId] = sLane;
              const subTurns = pairMessagesIntoTurns(
                taskPayload.messages,
                taskPayload.liveTrace,
                taskPayload.liveText,
                taskPayload.liveStartedAt,
              );
              childTurnIds = processTurnsForLane(subLaneId, subTurns, depth + 1, false);
            }
          } else {
            // 进程内子代理（Task / Agent / spawn_agent / subagent 等）
            const parsedIn = parseInput(c.input);
            const liveAg = Object.values(input.liveAgents ?? {}).find((a) => a.callId === c.id);
            const agentType = firstText(parsedIn?.subagent_type);
            subName = liveAg?.label || liveAg?.agentType || agentType || t('ui.usage-tools.subagent');
            const nestedMsgs = extractNestedAgentMessages(
              rawEvents,
              c.id,
              extractAgentIds(c),
              c.input,
              c.output,
              c.startedAt ?? turnStart ?? 0,
            );
            if (nestedMsgs.length > 0 && depth < MAX_SUBAGENT_DEPTH) {
              subLaneId = nextId('lane-nest');
              const sLane: TraceAgentLane = {
                id: subLaneId,
                name: subName,
                backend: lanesById[laneId]?.backend ?? null,
                kind: 'nested',
                parentLaneId: laneId,
                status: callStatus,
                stepCount: 0,
                durationMs: dur,
              };
              lanes.push(sLane);
              lanesById[subLaneId] = sLane;
              childTurnIds = processTurnsForLane(
                subLaneId,
                pairMessagesIntoTurns(nestedMsgs),
                depth + 1,
                false,
              );
            }
          }

          const title = desc.target ? `${subName} · ${desc.target}` : subName;
          const subStart = c.startedAt ?? delegateRes?.startedAt;
          const subEnd =
            c.endedAt ??
            (delegateRes?.startedAt !== undefined && delegateRes?.durationMs !== undefined
              ? delegateRes.startedAt + delegateRes.durationMs
              : undefined);
          pushTurnNode({
            id: nodeId,
            kind: 'subagent',
            laneId,
            turnId,
            depth,
            title,
            subtitle: subClosed ? t('ui.devtools.subagent-closed-hint') : c.name,
            toolKind: 'subagent',
            bucket: 'other',
            status: callStatus,
            start: subStart,
            end: subEnd,
            durationMs: dur ?? delegateRes?.durationMs,
            call: c,
            delegateResult: delegateRes,
            subagentLaneId: subLaneId,
            childTurnIds,
            searchText: buildSearchText([
              subName,
              c.name,
              desc.target,
              c.input,
              c.output,
              delegateRes?.summary,
              delegateRes?.error,
            ]),
          });
          continue;
        }

        const title = desc.target ? `${desc.verb} · ${desc.target}` : `${desc.verb} ${c.name}`;
        const diffSubtitle = stats ? `+${stats.added} −${stats.removed}` : undefined;
        pushTurnNode({
          id: nextId('n-tool'),
          kind: 'tool',
          laneId,
          turnId,
          depth,
          title,
          subtitle: diffSubtitle ? `${c.name} · ${diffSubtitle}` : c.name,
          toolKind,
          bucket: bucketOf(toolKind),
          status: callStatus,
          start: c.startedAt,
          end: c.endedAt,
          durationMs: dur,
          call: c,
          searchText: buildSearchText([title, c.name, desc.verb, desc.target, c.input, c.output]),
        });
      }

      // 3. 错误或助手正文节点
      const replyText = msg?.text ?? ti.liveText ?? '';
      if (msg?.error) {
        pushTurnNode({
          id: nextId('n-err'),
          kind: 'error',
          laneId,
          turnId,
          depth,
          title: t('ui.foundation.failed'),
          subtitle: msg.error.replace(/\s+/g, ' ').trim().slice(0, 80),
          status: 'error',
          start: turnEnd,
          end: turnEnd,
          text: msg.error,
          message: msg,
          searchText: buildSearchText([t('ui.foundation.failed'), msg.error]),
        });
      } else if (replyText.trim() || msg) {
        const preview = replyText.replace(/\s+/g, ' ').trim().slice(0, 72);
        pushTurnNode({
          id: nextId('n-reply'),
          kind: 'reply',
          laneId,
          turnId,
          depth,
          title: t('ui.slash-commands.assistant-replies'),
          subtitle: preview || (msg?.stopped ? t('ui.chat-settings.stopped') : undefined),
          status: isLive ? 'running' : msg?.stopped ? 'stopped' : 'done',
          start: turnEnd,
          end: turnEnd,
          durationMs: msg?.durationMs,
          text: replyText,
          message: msg,
          attempt: ti.attempt,
          searchText: buildSearchText([t('ui.slash-commands.assistant-replies'), replyText, msg?.model]),
        });
      }

      const timedStarts = turnNodes
        .map((n) => n.start)
        .filter((x): x is number => x !== undefined && Number.isFinite(x));
      const timedEnds = turnNodes
        .map((n) => n.end ?? n.start)
        .filter((x): x is number => x !== undefined && Number.isFinite(x));
      const tStart =
        turnStart ?? (timedStarts.length ? Math.min(...timedStarts) : undefined);
      const tEnd =
        turnEnd ?? (timedEnds.length ? Math.max(...timedEnds) : undefined);
      const tDur =
        msg?.durationMs ??
        (tStart !== undefined && tEnd !== undefined && tEnd >= tStart ? tEnd - tStart : undefined);

      const turnObj: TraceTurn = {
        id: turnId,
        laneId,
        index: idx + 1,
        label: turnLabel,
        startedAt: tStart,
        endedAt: tEnd,
        durationMs: tDur,
        status,
        model: msg?.model,
        usage: msg?.usage,
        nodeIds: turnNodes.map((n) => n.id),
        requestNodeIds: [],
        waves: buildWavesFromNodes(turnNodes),
        ...(ti.triggerNote ? { triggerNote: ti.triggerNote } : {}),
      };
      turns.push(turnObj);
      turnsById[turnId] = turnObj;
      laneTurnIds.push(turnId);
      if (isRoot) rootTurnIds.push(turnId);
    });
    return laneTurnIds;
  };

  // 构建主泳道 Turn
  let mainTurnInputs: PairedTurnInput[];
  if (input.messages.length === 0 && input.attempts?.length) {
    // 已关闭标签的 CLI 任务，由 attempts + journal 回放
    const asc = [...input.attempts].reverse();
    mainTurnInputs = asc.map((a, idx) => {
      const files = (a.result?.artifacts ?? [])
        .filter((x) => x.kind === 'file' && x.ref)
        .map((x) => x.ref);
      const summary = [
        a.result?.summary ?? '',
        files.length ? `${t('ui.devtools.changed-files-list')}:\n${files.map((f) => `- ${f}`).join('\n')}` : '',
      ]
        .filter(Boolean)
        .join('\n\n');
      const jEvents = (input.journal ?? [])
        .filter((j) => j.attemptId === a.id)
        .map((j) => ({
          type: 'tool' as const,
          name: j.action ?? j.event ?? j.t,
          status: j.t === 'failed' ? ('error' as const) : ('done' as const),
          id: `j-${a.id}-${j.at}-${j.seq ?? 0}`,
          output: j.summary ?? j.msg ?? (j.from && j.to ? `${j.from} → ${j.to}` : undefined),
          at: j.at,
        }));
      return {
        user: {
          id: `att-u-${a.id}`,
          role: 'user' as const,
          text: a.cause.note ?? input.title,
          at: a.startedAt,
        },
        assistant: {
          id: `att-a-${a.id}`,
          role: 'assistant' as const,
          text: summary || attemptStatusLabel(a.status),
          at: a.endedAt ?? a.startedAt,
          durationMs: a.endedAt ? Math.max(0, a.endedAt - a.startedAt) : undefined,
          ...(jEvents.length ? { trace: jEvents } : {}),
          ...(a.error ? { error: a.error.message } : {}),
          ...(a.status === 'cancelled' ? { stopped: true } : {}),
        },
        attempt: a,
        triggerNote: idx > 0 ? a.cause.kind : undefined,
      };
    });
  } else {
    mainTurnInputs = pairMessagesIntoTurns(
      input.messages,
      input.liveTrace,
      input.liveText,
      input.liveStartedAt,
    );
  }

  processTurnsForLane('main', mainTurnInputs, 0, true);

  // 会话级未直接挂在工具调用下的关联任务（例如 handoffFromChat）
  if (input.scope === 'session' && input.subTasks) {
    for (const [taskId, tp] of Object.entries(input.subTasks)) {
      if (referencedTasks.has(taskId) || visitedTasks.has(taskId)) continue;
      visitedTasks.add(taskId);
      const tLaneId = nextId('lane-task');
      const tLane: TraceAgentLane = {
        id: tLaneId,
        name: tp.title,
        backend: tp.executorKind === 'nomi' ? 'nomi' : 'other',
        kind: 'task',
        parentLaneId: 'main',
        status: tp.running ? 'running' : 'done',
        stepCount: 0,
      };
      lanes.push(tLane);
      lanesById[tLaneId] = tLane;
      processTurnsForLane(
        tLaneId,
        pairMessagesIntoTurns(tp.messages, tp.liveTrace, tp.liveText, tp.liveStartedAt),
        1,
        true,
      );
    }
  }

  // 关联网关请求到最近匹配的 Turn（优先同 tabId → 严格落入区间 → 距离与模型匹配度最优）
  const unassignedRequestIds: string[] = [];
  const sortedReqs = [...(input.requests ?? [])].sort((a, b) => a.ts - b.ts);
  const pickTurnForRequest = (r: QualityRequestItem): TraceTurn | undefined => {
    const laneMatches = r.tabId ? turns.filter((tr) => lanesById[tr.laneId]?.tabId === r.tabId) : [];
    const pool = laneMatches.length ? laneMatches : turns;
    const reqCanon = canonicalModelName(r.upstreamModel || r.model || '');

    let best: TraceTurn | undefined;
    let bestScore = -Infinity;
    for (const tr of pool) {
      if (tr.startedAt === undefined || tr.endedAt === undefined) continue;
      if (r.ts < tr.startedAt - 2000 || r.ts > tr.endedAt + 2000) continue;
      const inside = r.ts >= tr.startedAt && r.ts <= tr.endedAt;
      const modelOk =
        reqCanon !== '' && tr.model !== undefined && canonicalModelName(tr.model) === reqCanon;
      const mid = (tr.startedAt + tr.endedAt) / 2;
      const distPenalty = Math.abs(r.ts - mid) / 100_000;
      const score = (inside ? 10 : 0) + (modelOk ? 5 : 0) - distPenalty;
      if (score > bestScore) {
        bestScore = score;
        best = tr;
      }
    }
    return best ?? pool[0];
  };

  for (const r of sortedReqs) {
    const reqEnd = r.ts + r.timing.endMs;
    const matchedTurn = pickTurnForRequest(r);
    const reqId = nextId('n-req');
    const observedResp = r.fingerprint?.responseModel || r.responseModel;
    const baseReqTitle = r.display ?? r.model ?? t('ui.devtools.model-request');
    const isRespDiff =
      !!observedResp &&
      canonicalModelName(observedResp) !==
        canonicalModelName(r.upstreamModel || r.model || baseReqTitle);
    const reqTitle = isRespDiff
      ? `${stripProviderPrefix(baseReqTitle) || baseReqTitle} → ${stripProviderPrefix(observedResp!) || observedResp}`
      : baseReqTitle;
    const reqSub = [
      r.providerName ?? r.provider,
      r.timing.firstContentMs !== undefined ? `TTFT ${Math.round(r.timing.firstContentMs)}ms` : '',
    ]
      .filter(Boolean)
      .join(' · ');
    const reqNode: TraceNode = {
      id: reqId,
      kind: 'request',
      laneId: matchedTurn?.laneId ?? 'main',
      turnId: matchedTurn?.id ?? 'unassigned',
      depth: 0,
      title: reqTitle,
      subtitle: reqSub || undefined,
      status: r.outcome === 'ok' ? 'done' : 'error',
      start: r.ts,
      end: reqEnd,
      durationMs: r.timing.endMs,
      firstAt: r.timing.firstContentMs !== undefined ? r.ts + r.timing.firstContentMs : undefined,
      req: r,
      searchText: buildSearchText([
        reqTitle,
        r.model,
        r.upstreamModel,
        r.responseModel,
        r.fingerprint?.responseModel,
        r.fingerprint?.responseId,
        r.fingerprint?.systemFingerprint,
        r.providerName,
        r.provider,
        r.traceId,
        r.errorKind,
      ]),
    };
    addNode(reqNode);
    if (matchedTurn) matchedTurn.requestNodeIds.push(reqId);
    else unassignedRequestIds.push(reqId);
  }

  // 模型切换追踪与指纹/质量核验分析，并将结论回填至各个 Turn
  const modelAnalysis = analyzeTraceModels(turns, nodesById, lanesById);
  for (const tr of turns) {
    const audit = modelAnalysis.turnAuditsByTurnId[tr.id];
    if (!audit) continue;
    tr.modelAudit = audit;
    if (audit.observedModel) tr.responseModel = audit.observedModel;
    if (audit.switchedFromModel) tr.switchedFromModel = audit.switchedFromModel;
    if (audit.verdict === 'mismatch') {
      for (const reqNid of tr.requestNodeIds) {
        const rn = nodesById[reqNid];
        if (rn) rn.searchText = `${rn.searchText} mismatch fingerprint`;
      }
    }
  }

  // 统计全文档时间窗与 KPI
  let minAt = Number.POSITIVE_INFINITY;
  let maxAt = Number.NEGATIVE_INFINITY;
  for (const id of orderedNodeIds) {
    const n = nodesById[id]!;
    if (n.start !== undefined && Number.isFinite(n.start)) {
      minAt = Math.min(minAt, n.start);
      maxAt = Math.max(maxAt, n.end ?? n.start);
    }
  }
  if (!Number.isFinite(minAt)) {
    const lastMsg = input.messages[input.messages.length - 1];
    if (lastMsg) {
      const w = turnWindow(lastMsg);
      minAt = w.from;
      maxAt = w.to;
    } else {
      maxAt = Date.now();
      minAt = maxAt - FALLBACK_WINDOW_MS;
    }
  }
  const from = minAt;
  const to = Math.max(maxAt, minAt + 1);

  let thinkingCount = 0;
  let toolCount = 0;
  let subagentCount = 0;
  let failedCount = 0;
  let slowCount = 0;
  let requestCount = 0;
  for (const id of orderedNodeIds) {
    const n = nodesById[id]!;
    if (n.kind === 'thinking') thinkingCount += 1;
    else if (n.kind === 'tool') toolCount += 1;
    else if (n.kind === 'subagent') subagentCount += 1;
    else if (n.kind === 'request') requestCount += 1;
    if (n.status === 'error') failedCount += 1;
    if (n.durationMs !== undefined && n.durationMs >= SLOW_STEP_MS) slowCount += 1;
  }

  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let costUsd = 0;
  let hasCost = false;
  for (const m of input.messages) {
    if (m.role !== 'assistant' || !m.usage) continue;
    inputTokens += m.usage.inputTokens ?? 0;
    outputTokens += m.usage.outputTokens ?? 0;
    cacheReadTokens += m.usage.cacheReadTokens ?? 0;
    if (m.usage.costUsd !== undefined) {
      costUsd += m.usage.costUsd;
      hasCost = true;
    }
  }
  const hitRate =
    input.mainBackend === 'nomi' && inputTokens > 0
      ? cacheHitRate(inputTokens, cacheReadTokens)
      : undefined;

  if (turns.some((tr) => tr.status === 'running')) mainLane.status = 'running';
  else if (turns.some((tr) => tr.status === 'error')) mainLane.status = 'error';

  const modelAnomalyCount =
    modelAnalysis.summary.mismatchCount + modelAnalysis.summary.suspectCount;

  return {
    scope: input.scope,
    title: input.title,
    subtitle: input.subtitle,
    from,
    to,
    lanes,
    lanesById,
    turns,
    turnsById,
    nodesById,
    orderedNodeIds,
    rootTurnIds,
    unassignedRequestIds,
    stats: {
      turns: rootTurnIds.length,
      thinkingCount,
      toolCount,
      subagentCount,
      failedCount,
      slowCount,
      requestCount,
      modelAnomalyCount,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      ...(hitRate !== undefined ? { hitRate } : {}),
      ...(hasCost ? { costUsd } : {}),
    },
    modelAnalysis,
  };
}
