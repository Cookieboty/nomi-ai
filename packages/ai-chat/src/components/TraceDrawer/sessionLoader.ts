/**
 * 多入口轨迹数据加载器：
 * - 单轮（turn）：单条助手消息 + 可选上文用户提问 + 关联委派子代理；
 * - 会话（session）：整次会话所有消息 + 实时轨迹 + 进程内/委派子代理 + 关联持续任务；
 * - 任务（task）：Nomi 任务（attempts + trace + thinking + live）或 CLI 任务（存活 tab / attempts + journal）。
 */
import { t } from '@nomi-ai/ui';
import { useEffect, useMemo, useState } from 'react';

import { useHarnessTabs } from '../../contexts/HarnessTabsContext';
import { delegateClient, type DelegateResult } from '../../services/delegateClient';
import { diagnosticsClient, type CliRecordsResult } from '../../services/diagnosticsClient';
import {
  harnessClient,
  type HarnessTabMeta,
  type HarnessTraceEvent,
} from '../../services/harnessClient';
import { qualityClient, type QualityRequestItem } from '../../services/qualityClient';
import {
  tasksApi,
  tasksAvailable,
  type Attempt,
  type JournalEntry,
  type Task,
} from '../../services/tasksClient';
import type { ConvMessage } from '../../types/conversation';
import { fromHarnessMessage } from '../../utils/convAdapters';
import { ENDPOINT_NAME, type EndpointKey } from '../../utils/endpointBadge';
import type { LiveAgent } from '../../utils/liveState';
import { baseToolName, reduceTrace } from '../../utils/toolTrace';
import { liveFromView, nomiTaskMessages } from '../SubagentPane/project';

import {
  buildTraceDocument,
  inferMessageBackend,
  turnWindow,
  type SubTabPayload,
  type SubTaskPayload,
  type TraceDocument,
} from './model';

/** 会话来源：agent 标签（按标签 id 关联）或 Nomi 对话（按客户端 nomi 关联） */
export type TraceSource = { kind: 'cli'; tabId: string } | { kind: 'nomi' };

export type TraceTarget =
  | {
      kind: 'turn';
      message: ConvMessage;
      source: TraceSource;
      userPrompt?: string;
      allMessages?: readonly ConvMessage[];
    }
  | {
      kind: 'session';
      title: string;
      messages: readonly ConvMessage[];
      source: TraceSource;
      liveTrace?: readonly HarnessTraceEvent[];
      liveText?: string;
      liveStartedAt?: number;
      liveAgents?: Record<string, LiveAgent>;
      conversationId?: string;
      relatedTasks?: readonly Task[];
    }
  | {
      kind: 'task';
      task: Task;
      attempts?: readonly Attempt[];
    };

export interface LoadedTraceState {
  doc: TraceDocument;
  source: TraceSource;
  requests: QualityRequestItem[] | null;
  reqError: string | null;
  proc: CliRecordsResult | null;
  procError: string | null;
  loadingDetails: boolean;
  rawJson: string;
}

const REQUEST_LIMIT = 400;

function parseDelegateCallOutput(output: string | undefined): DelegateResult | undefined {
  if (!output) return undefined;
  try {
    const o = JSON.parse(output) as { ok?: boolean; data?: DelegateResult };
    return o.ok && o.data ? o.data : undefined;
  } catch {
    return undefined;
  }
}

function scanDelegateIds(messages: readonly ConvMessage[]): {
  pendingDelegateTaskIds: string[];
  nomiTaskIds: string[];
  directTabIds: string[];
} {
  const pendingDelegateTaskIds: string[] = [];
  const nomiTaskIds: string[] = [];
  const directTabIds: string[] = [];
  const seenPending = new Set<string>();
  const seenNomi = new Set<string>();
  const seenTabs = new Set<string>();

  for (const m of messages) {
    if (!m.trace?.length) continue;
    for (const e of reduceTrace(m.trace)) {
      if (e.type !== 'tool') continue;
      const base = baseToolName(e.call.name);
      if (base === 'delegate_to_cli') {
        const res = parseDelegateCallOutput(e.call.output);
        if (res?.taskId && res.status === 'running' && !seenPending.has(res.taskId)) {
          seenPending.add(res.taskId);
          pendingDelegateTaskIds.push(res.taskId);
        }
        if (res?.tabId && !seenTabs.has(res.tabId)) {
          seenTabs.add(res.tabId);
          directTabIds.push(res.tabId);
        }
      } else if (base === 'delegate_to_nomi') {
        const res = parseDelegateCallOutput(e.call.output);
        if (res?.taskId && !seenNomi.has(res.taskId)) {
          seenNomi.add(res.taskId);
          nomiTaskIds.push(res.taskId);
        }
      }
    }
  }
  return { pendingDelegateTaskIds, nomiTaskIds, directTabIds };
}

function resolveTabLookups(tabs: readonly HarnessTabMeta[] | undefined): {
  byCallId: Record<string, string>;
  byTaskId: Record<string, string>;
  metaById: Record<string, HarnessTabMeta>;
} {
  const byCallId: Record<string, string> = {};
  const byTaskId: Record<string, string> = {};
  const metaById: Record<string, HarnessTabMeta> = {};
  for (const tab of tabs ?? []) {
    metaById[tab.id] = tab;
    const d = tab.delegation;
    if (!d) continue;
    if (d.callId) byCallId[d.callId] = tab.id;
    for (const cid of d.prevCallIds ?? []) byCallId[cid] = tab.id;
    if (d.taskId) byTaskId[d.taskId] = tab.id;
    for (const tid of d.prevTaskIds ?? []) byTaskId[tid] = tab.id;
  }
  return { byCallId, byTaskId, metaById };
}

function inferMainEndpoint(
  source: TraceSource,
  tabs: readonly HarnessTabMeta[] | undefined,
  task?: Task,
): { name: string; backend: EndpointKey | null } {
  if (source.kind === 'cli') {
    const tab = tabs?.find((x) => x.id === source.tabId);
    const b = tab?.backend;
    if (b && b in ENDPOINT_NAME) return { name: ENDPOINT_NAME[b as EndpointKey], backend: b };
    if (task?.executor.kind === 'cli') {
      const cli = task.executor.cli ?? task.executor.presetId;
      if (cli && cli in ENDPOINT_NAME)
        return { name: ENDPOINT_NAME[cli as EndpointKey], backend: cli as EndpointKey };
    }
    return { name: ENDPOINT_NAME.other, backend: 'other' };
  }
  return { name: ENDPOINT_NAME.nomi, backend: 'nomi' };
}

export function useTraceData(target: TraceTarget): LoadedTraceState {
  const harnessTabs = useHarnessTabs();
  const allTabs = harnessTabs.state?.tabs;
  const lookups = useMemo(() => resolveTabLookups(allTabs), [allTabs]);

  // 针对 task 入口的异步状态
  const [taskAttempts, setTaskAttempts] = useState<Attempt[] | null>(
    target.kind === 'task' ? [...(target.attempts ?? [])] : null,
  );
  const [taskJournal, setTaskJournal] = useState<JournalEntry[]>([]);
  const [taskMessages, setTaskMessages] = useState<ConvMessage[]>([]);
  const [taskLive, setTaskLive] = useState<{
    trace: HarnessTraceEvent[];
    text: string;
    startedAt: number;
  } | null>(null);
  const [taskCliTabId, setTaskCliTabId] = useState<string | null>(null);

  // 共享的子代理 / 网关 / 子进程状态
  const [subTabs, setSubTabs] = useState<Record<string, SubTabPayload>>({});
  const [subTasks, setSubTasks] = useState<Record<string, SubTaskPayload>>({});
  const [delegateResults, setDelegateResults] = useState<Record<string, DelegateResult>>({});
  const [requests, setRequests] = useState<QualityRequestItem[] | null>(null);
  const [reqError, setReqError] = useState<string | null>(null);
  const [proc, setProc] = useState<CliRecordsResult | null>(null);
  const [procError, setProcError] = useState<string | null>(null);
  const [loadingDetails, setLoadingDetails] = useState<boolean>(false);

  // 确定当前主体消息列与来源
  const targetKind = target.kind;
  const turnMessage = target.kind === 'turn' ? target.message : null;
  const turnUserPrompt = target.kind === 'turn' ? target.userPrompt : undefined;
  const sessionMessages = target.kind === 'session' ? target.messages : null;
  const sessionTitle = target.kind === 'session' ? target.title : '';
  const sessionLiveTrace = target.kind === 'session' ? target.liveTrace : undefined;
  const sessionLiveText = target.kind === 'session' ? target.liveText : undefined;
  const sessionLiveStartedAt = target.kind === 'session' ? target.liveStartedAt : undefined;
  const sessionLiveAgents = target.kind === 'session' ? target.liveAgents : undefined;
  const sessionRelatedTasks = target.kind === 'session' ? target.relatedTasks : undefined;
  const taskObj = target.kind === 'task' ? target.task : null;
  const taskInitialAttempts = target.kind === 'task' ? target.attempts : undefined;

  const baseMessages = useMemo<ConvMessage[]>(() => {
    if (targetKind === 'turn' && turnMessage) {
      const list: ConvMessage[] = [];
      if (turnUserPrompt) {
        list.push({
          id: `${turnMessage.id}-prompt`,
          role: 'user',
          text: turnUserPrompt,
          at: turnWindow(turnMessage).from,
        });
      }
      list.push(turnMessage);
      return list;
    }
    if (targetKind === 'session' && sessionMessages) {
      return [...sessionMessages];
    }
    return taskMessages;
  }, [targetKind, turnMessage, turnUserPrompt, sessionMessages, taskMessages]);

  const rawSourceKind = target.kind === 'task' ? null : target.source.kind;
  const rawSourceTabId =
    target.kind !== 'task' && target.source.kind === 'cli' ? target.source.tabId : null;
  const targetExecutorKind = target.kind === 'task' ? target.task.executor.kind : null;

  const effectiveSource = useMemo<TraceSource>(() => {
    if (rawSourceKind === 'cli' && rawSourceTabId) {
      return { kind: 'cli', tabId: rawSourceTabId };
    }
    if (rawSourceKind === 'nomi') {
      return { kind: 'nomi' };
    }
    if (targetExecutorKind === 'cli' && taskCliTabId) {
      return { kind: 'cli', tabId: taskCliTabId };
    }
    return { kind: 'nomi' };
  }, [rawSourceKind, rawSourceTabId, targetExecutorKind, taskCliTabId]);

  const taskId = taskObj?.id;
  const taskUpdatedAt = taskObj?.updatedAt;
  const taskKind = taskObj?.executor.kind;
  const taskGoal = taskObj?.goal ?? '';

  // 阶段 1：如果是 task 入口，先加载任务执行记录（Nomi 含 trace+live，CLI 优先取存活 tab 消息）
  useEffect(() => {
    if (targetKind !== 'task' || !taskId || !taskKind) return;
    let alive = true;
    const loadTask = async () => {
      setLoadingDetails(true);
      try {
        const [got, j] = await Promise.all([
          tasksAvailable() ? tasksApi.get(taskId).catch(() => null) : Promise.resolve(null),
          tasksAvailable() ? tasksApi.journal(taskId).catch(() => []) : Promise.resolve([]),
        ]);
        if (!alive) return;
        const atts = got?.attempts ?? [...(taskInitialAttempts ?? [])];
        setTaskAttempts(atts);
        setTaskJournal(j ?? []);

        if (taskKind === 'nomi') {
          setTaskCliTabId(null);
          if (tasksAvailable()) {
            const tv = await tasksApi.trace(taskId).catch(() => null);
            if (!alive) return;
            if (tv) {
              const lv = liveFromView(tv);
              setTaskMessages(nomiTaskMessages(taskGoal, tv, lv?.attemptId));
              setTaskLive(lv ? { trace: lv.trace, text: lv.text, startedAt: lv.startedAt } : null);
            }
          }
        } else if (taskKind === 'cli') {
          const rev = [...atts].reverse();
          const latestTab = rev.find((a) => a.carrier?.tabId)?.carrier?.tabId ?? null;
          setTaskCliTabId(latestTab);
          if (latestTab && harnessClient.available() && lookups.metaById[latestTab]) {
            const raw = await harnessClient.tabMessages(latestTab).catch(() => []);
            if (!alive) return;
            const backend = lookups.metaById[latestTab]!.backend;
            setTaskMessages(raw.map((m) => fromHarnessMessage(m, backend)));
            setTaskLive(null);
          } else {
            setTaskMessages([]);
            setTaskLive(null);
          }
        }
      } finally {
        if (alive) setLoadingDetails(false);
      }
    };
    void loadTask();
    return () => {
      alive = false;
    };
  }, [
    targetKind,
    taskId,
    taskUpdatedAt,
    taskKind,
    taskGoal,
    taskInitialAttempts,
    lookups.metaById,
  ]);

  // 阶段 2：加载子代理标签、子任务与网关请求 / 子进程收发
  const scan = useMemo(() => scanDelegateIds(baseMessages), [baseMessages]);
  const mainSpan = useMemo(() => {
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (const m of baseMessages) {
      const w = m.role === 'assistant' ? turnWindow(m) : { from: m.at, to: m.at };
      min = Math.min(min, w.from, m.at);
      max = Math.max(max, w.to, m.at);
    }
    if (sessionLiveStartedAt !== undefined) min = Math.min(min, sessionLiveStartedAt);
    if (!Number.isFinite(min)) {
      return { from: 0, to: 0 };
    }
    return { from: min, to: Math.max(max, min) };
  }, [baseMessages, sessionLiveStartedAt]);

  // 注意：relatedTasks 会随 useTasks 更新，稳定 key 以避免无谓重复请求
  const relatedTaskIdsKey = useMemo(
    () => (sessionRelatedTasks ?? []).map((tk) => `${tk.id}:${tk.updatedAt}`).join(','),
    [sessionRelatedTasks],
  );
  const relatedTasksRef = sessionRelatedTasks;

  const targetTitle =
    target.kind === 'turn' ? '' : target.kind === 'session' ? target.title : target.task.title;
  const targetGoal = target.kind === 'task' ? target.task.goal : '';
  const targetModel = target.kind === 'turn' ? target.message.model : undefined;
  const targetTask = target.kind === 'task' ? target.task : null;
  const targetMessage = target.kind === 'turn' ? target.message : null;

  useEffect(() => {
    let alive = true;

    const loadDetails = async () => {
      setLoadingDetails(true);
      setReqError(null);
      setProcError(null);
      try {
        // 1) 解析未完结委派的最终结果
        const nextDelegateResults: Record<string, DelegateResult> = {};
        if (scan.pendingDelegateTaskIds.length > 0 && delegateClient.available()) {
          const settled = await Promise.allSettled(
            scan.pendingDelegateTaskIds.map(
              async (id) => [id, await delegateClient.status(id)] as const,
            ),
          );
          if (!alive) return;
          for (const s of settled) {
            if (s.status === 'fulfilled' && s.value[1]) {
              nextDelegateResults[s.value[0]] = s.value[1];
            }
          }
          setDelegateResults(nextDelegateResults);
        }

        // 2) 收集所有关联的 CLI 子代理 tabId
        const tabIds = new Set<string>(scan.directTabIds);
        for (const tab of allTabs ?? []) {
          const d = tab.delegation;
          if (
            d?.callId &&
            baseMessages.some((m) =>
              m.trace?.some(
                (ev) =>
                  ('id' in ev && ev.id === d.callId) || ('detail' in ev && ev.detail === d.callId),
              ),
            )
          ) {
            tabIds.add(tab.id);
          }
          if (effectiveSource.kind === 'cli' && tab.subagentOf?.tabId === effectiveSource.tabId) {
            tabIds.add(tab.id);
          }
        }
        for (const res of Object.values(nextDelegateResults)) {
          if (res.tabId) tabIds.add(res.tabId);
        }
        if (targetKind === 'session') {
          for (const tk of relatedTasksRef ?? []) {
            if (tk.executor.kind === 'cli' && tasksAvailable()) {
              const got = await tasksApi.get(tk.id).catch(() => null);
              for (const a of got?.attempts ?? []) {
                if (a.carrier?.tabId) tabIds.add(a.carrier.tabId);
              }
            }
          }
        }

        if (tabIds.size > 0 && harnessClient.available()) {
          const nextSubTabs: Record<string, SubTabPayload> = {};
          await Promise.allSettled(
            [...tabIds].map(async (tid) => {
              const meta = lookups.metaById[tid];
              if (!meta) return;
              const raw = await harnessClient.tabMessages(tid).catch(() => null);
              if (!raw) return;
              nextSubTabs[tid] = {
                tabId: tid,
                title: meta.title,
                backend: meta.backend,
                messages: raw.map((m) => fromHarnessMessage(m, meta.backend)),
                running: meta.status === 'running' || meta.status === 'queued',
              };
            }),
          );
          if (!alive) return;
          setSubTabs(nextSubTabs);
        }

        // 3) 收集所有关联 Nomi 任务轨迹
        const taskIdsToLoad = new Set<string>(scan.nomiTaskIds);
        if (targetKind === 'session') {
          for (const tk of relatedTasksRef ?? []) {
            if (tk.executor.kind === 'nomi') taskIdsToLoad.add(tk.id);
          }
        }
        let nextSubTasksCount = 0;
        if (taskIdsToLoad.size > 0 && tasksAvailable()) {
          const nextSubTasks: Record<string, SubTaskPayload> = {};
          await Promise.allSettled(
            [...taskIdsToLoad].map(async (tid) => {
              const [got, tv] = await Promise.all([
                tasksApi.get(tid).catch(() => null),
                tasksApi.trace(tid).catch(() => null),
              ]);
              if (!got || !tv) return;
              const lv = liveFromView(tv);
              nextSubTasks[tid] = {
                taskId: tid,
                title: got.task.title,
                executorKind: got.task.executor.kind,
                messages: nomiTaskMessages(got.task.goal, tv, lv?.attemptId),
                liveTrace: lv?.trace,
                liveText: lv?.text,
                liveStartedAt: lv?.startedAt,
                running: got.task.status === 'running',
              };
            }),
          );
          if (!alive) return;
          nextSubTasksCount = Object.keys(nextSubTasks).length;
          setSubTasks(nextSubTasks);
        }

        // 4) 拉取网关请求与子进程收发
        const now = Date.now();
        const spanFrom = mainSpan.to > 0 ? mainSpan.from : now - 60_000;
        const spanTo = mainSpan.to > 0 ? mainSpan.to : now;
        if (qualityClient.available()) {
          const from = spanFrom - 2000;
          const to = spanTo + 2000;
          const queries: Array<Promise<{ items: QualityRequestItem[] }>> = [];
          const assistantMsgs = baseMessages.filter((m) => m.role === 'assistant');
          const assistantTurnCount = assistantMsgs.length;
          if (
            effectiveSource.kind === 'nomi' &&
            sessionLiveStartedAt === undefined &&
            !taskLive &&
            nextSubTasksCount === 0 &&
            assistantMsgs.length > 0
          ) {
            const nomiTurns = assistantMsgs.filter(
              (m) => inferMessageBackend(m, 'nomi') === 'nomi',
            );
            if (nomiTurns.length > 0) {
              const rawWins = nomiTurns
                .map((m) => {
                  const w = turnWindow(m);
                  return { from: w.from - 2000, to: w.to + 2000 };
                })
                .sort((a, b) => a.from - b.from);
              const mergedWins: Array<{ from: number; to: number }> = [];
              for (const w of rawWins) {
                const last = mergedWins[mergedWins.length - 1];
                if (last && w.from - last.to <= 60_000) {
                  last.to = Math.max(last.to, w.to);
                } else {
                  mergedWins.push({ ...w });
                }
              }
              const targetWins =
                mergedWins.length <= 12
                  ? mergedWins
                  : [{ from: mergedWins[0]!.from, to: mergedWins[mergedWins.length - 1]!.to }];
              for (const w of targetWins) {
                queries.push(
                  qualityClient.requests({
                    from: w.from,
                    to: w.to,
                    layer: 'gateway',
                    limit: REQUEST_LIMIT,
                    filters: { client: ['nomi'] },
                  }),
                );
              }
            }
          } else {
            queries.push(
              qualityClient.requests({
                from,
                to,
                layer: 'gateway',
                limit: REQUEST_LIMIT,
                ...(effectiveSource.kind === 'cli'
                  ? { tabId: effectiveSource.tabId }
                  : { filters: { client: ['nomi'] } }),
              }),
            );
          }
          if (targetKind !== 'turn') {
            for (const tid of tabIds) {
              queries.push(
                qualityClient.requests({
                  from,
                  to,
                  layer: 'gateway',
                  limit: 150,
                  tabId: tid,
                }),
              );
            }
          }
          const settledReqs = await Promise.allSettled(queries);
          if (!alive) return;
          const byReqId = new Map<string, QualityRequestItem>();
          let firstErr: string | null = null;
          for (const sr of settledReqs) {
            if (sr.status === 'fulfilled') {
              for (const item of sr.value.items) byReqId.set(item.id, item);
            } else if (!firstErr) {
              firstErr = (sr.reason as Error)?.message ?? String(sr.reason);
            }
          }
          // 若是 CLI 会话且网关层记录少于助手轮次数（例如官方账号直连），补拉 CLI 层统计作补充
          if (effectiveSource.kind === 'cli' && byReqId.size < assistantTurnCount) {
            const cliRes = await qualityClient
              .requests({
                from,
                to,
                layer: 'cli',
                limit: 150,
                tabId: effectiveSource.tabId,
              })
              .catch(() => null);
            if (!alive) return;
            if (cliRes?.items?.length) {
              const gwTimestamps = [...byReqId.values()].map((item) => item.ts);
              for (const item of cliRes.items) {
                const coveredByGw = gwTimestamps.some((ts) => Math.abs(ts - item.ts) <= 2000);
                if (!coveredByGw) byReqId.set(item.id, item);
              }
            }
          }
          if (byReqId.size === 0 && firstErr) setReqError(firstErr);
          else setRequests([...byReqId.values()].sort((a, b) => a.ts - b.ts));
        }

        if (effectiveSource.kind === 'cli' && diagnosticsClient.available()) {
          diagnosticsClient
            .cliRecords({
              tabId: effectiveSource.tabId,
              from: spanFrom,
              to: spanTo + 2000,
            })
            .then((r) => alive && setProc(r))
            .catch((e: unknown) => alive && setProcError((e as Error).message));
        } else {
          setProc(null);
        }
      } finally {
        if (alive) setLoadingDetails(false);
      }
    };

    void loadDetails();
    return () => {
      alive = false;
    };
    // relatedTasksRef 内容由 relatedTaskIdsKey 精确覆盖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    targetKind,
    baseMessages,
    scan,
    allTabs,
    lookups.metaById,
    effectiveSource,
    mainSpan.from,
    mainSpan.to,
    relatedTaskIdsKey,
  ]);

  const doc = useMemo(() => {
    const ep = inferMainEndpoint(effectiveSource, allTabs, taskObj ?? undefined);
    const title =
      targetKind === 'turn'
        ? t('ui.devtools.execution-trace')
        : targetKind === 'session'
          ? sessionTitle || t('ui.devtools.scope-session')
          : targetTitle;
    const subtitle =
      targetKind === 'turn' ? targetModel : targetKind === 'session' ? ep.name : targetGoal;

    return buildTraceDocument({
      scope: targetKind,
      title,
      subtitle,
      mainLaneName: ep.name,
      mainBackend: ep.backend,
      ...(effectiveSource.kind === 'cli' ? { mainTabId: effectiveSource.tabId } : {}),
      messages: baseMessages,
      liveTrace: targetKind === 'session' ? sessionLiveTrace : taskLive?.trace,
      liveText: targetKind === 'session' ? sessionLiveText : taskLive?.text,
      liveStartedAt: targetKind === 'session' ? sessionLiveStartedAt : taskLive?.startedAt,
      liveAgents: targetKind === 'session' ? sessionLiveAgents : undefined,
      requests: requests ?? [],
      subTabs,
      subTasks,
      delegateResults,
      tabLookupByCallId: lookups.byCallId,
      tabLookupByTaskId: lookups.byTaskId,
      attempts: taskAttempts ?? undefined,
      journal: taskJournal,
    });
  }, [
    effectiveSource,
    allTabs,
    taskObj,
    targetKind,
    targetTitle,
    targetModel,
    targetGoal,
    sessionTitle,
    baseMessages,
    sessionLiveTrace,
    sessionLiveText,
    sessionLiveStartedAt,
    sessionLiveAgents,
    taskLive,
    requests,
    subTabs,
    subTasks,
    delegateResults,
    lookups.byCallId,
    lookups.byTaskId,
    taskAttempts,
    taskJournal,
  ]);

  const rawJson = useMemo(() => {
    if (targetKind === 'turn' && targetMessage) {
      const m = targetMessage;
      return JSON.stringify(
        {
          id: m.id,
          at: new Date(m.at).toISOString(),
          durationMs: m.durationMs,
          model: m.model,
          usage: m.usage,
          error: m.error,
          stopped: m.stopped,
          trace: m.trace ?? [],
        },
        null,
        2,
      );
    }
    if (targetKind === 'session') {
      return JSON.stringify(
        {
          scope: 'session',
          title: targetTitle,
          turns: doc.stats.turns,
          tools: doc.stats.toolCount,
          subagents: doc.stats.subagentCount,
          messages: baseMessages,
          subTabs: Object.keys(subTabs),
          subTasks: Object.keys(subTasks),
        },
        null,
        2,
      );
    }
    return JSON.stringify(
      {
        scope: 'task',
        task: targetTask,
        attempts: taskAttempts ?? [],
        journal: taskJournal,
        messages: baseMessages,
      },
      null,
      2,
    );
  }, [
    targetKind,
    targetMessage,
    targetTitle,
    targetTask,
    doc.stats,
    baseMessages,
    subTabs,
    subTasks,
    taskAttempts,
    taskJournal,
  ]);

  const matchedRequests = useMemo(() => {
    if (requests === null) return null;
    if (doc.turns.length === 0) return requests;
    const seen = new Set<string>();
    const out: QualityRequestItem[] = [];
    for (const id of doc.orderedNodeIds) {
      const node = doc.nodesById[id];
      if (node?.kind !== 'request' || !node.req || seen.has(node.req.id)) continue;
      seen.add(node.req.id);
      out.push(node.req);
    }
    return out;
  }, [requests, doc.turns.length, doc.orderedNodeIds, doc.nodesById]);

  return {
    doc,
    source: effectiveSource,
    requests: matchedRequests,
    reqError,
    proc,
    procError,
    loadingDetails,
    rawJson,
  };
}
