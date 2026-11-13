/**
 * Nomi 派给编程助手的子任务卡片（docs/development/coding-agents.md）：
 * - 标题：编程助手、目标、状态、耗时、「停止」「查看」；
 * - 当前一行：所有代理里最近的一个动作（「explorer · 运行 npm test」）；
 * - 审批：子任务的权限请求直接在卡片里答复（标签里也同时显示）；
 * - 子代理：每个一行，Claude 可以单独停止；
 * - 结束后：编程助手的汇报（做了什么、改动的文件、没做完的、需要用户决定的）；
 *   改动的文件 = 汇报 / git 核对的 + 子任务对话里编辑 / 写入工具改过的，点开共用右侧资源预览（.md 先渲染）。
 * 数据：工具调用 id → 标签（delegation.callId）→ 标签的实时状态；历史消息只有工具输出。
 */
import { Button, Icon, Modal, ModalHostContext, t } from '@nomi-ai/ui';
import { ChevronDown, ChevronRight, ExternalLink, Square } from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useState } from 'react';

import { useHarnessLive, useHarnessTabs } from '../../contexts/HarnessTabsContext';
import {
  ResourceContext,
  useResourceContext,
  type ResourceContextValue,
} from '../../contexts/ResourceContext';
import { useSubagentPane } from '../../contexts/SubagentPaneContext';
import { api } from '../../services/api';
import { delegateClient, type DelegateResult } from '../../services/delegateClient';
import {
  harnessClient,
  MAIN_TAB_ID,
  type HarnessBackend,
  type HarnessTabMessage,
  type HarnessTabMeta,
} from '../../services/harnessClient';
import { replyPermissionRequest } from '../../services/permissionReply';
import type { ConvMessage } from '../../types/conversation';
import { canStopSubagent } from '../../utils/cliCaps';
import { fromHarnessMessage, tabLiveToConv } from '../../utils/convAdapters';
import { ENDPOINT_NAME } from '../../utils/endpointBadge';
import type { LiveAgent, TabLive } from '../../utils/liveState';
import { resourceTarget, resolveDocumentHref, workspaceFileHref } from '../../utils/resourceLinks';
import { aggregateSessionChanges } from '../../utils/sessionChanges';
import { parseInput, type FileDiff, type ToolCall } from '../../utils/toolTrace';
import { workspaceRelPath } from '../../utils/workspacePath';
import { AgentHoverCard } from '../AgentHoverCard';
import { EndpointIcon } from '../EndpointIcon';

import { ApprovePlanCard } from './ApprovePlanCard';
import { buildCliSlots } from './cliSlots';
import styles from './DelegateCard.module.css';
import { Markdown } from './Markdown';
import { PermissionCard } from './PermissionCard';
import { TabSandboxRequests } from './SandboxRequests';

import { ConversationView } from './index';

type Phase = 'confirming' | 'running' | 'waiting' | 'done' | 'error' | 'cancelled';

/** 工具输出：`{ ok, data }` / `{ ok: false, error }`（主进程 DelegateService） */
export function parseOutput(output: string | undefined): {
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
    /* 输出被截断等：退回工具调用本身的状态 */
  }
  return {};
}

export interface DelegateView {
  call: ToolCall;
  tab: HarnessTabMeta | null;
  live: TabLive | undefined;
  result?: DelegateResult;
  error?: { code: string; message: string };
  phase: Phase;
  backend: HarnessBackend | null;
  goal: string;
}

/**
 * 异步委派结束后的工具调用：工具输出是 running 占位，主进程广播 / 查到的最终结果替换进去（卡片与会话详情共用）。
 * 子任务里后续轮次的结果（followUp）不算委派本身的结果。
 */
export function withDelegateResult(call: ToolCall, r: DelegateResult | undefined): ToolCall {
  if (!r || r.status === 'running' || r.followUp) return call;
  return { ...call, status: 'done', output: JSON.stringify({ ok: true, data: r }) };
}

/** 由工具调用 + 标签状态推出卡片要显示的东西（纯函数，任务组头部也用它汇总） */
export function delegateTab(
  call: ToolCall,
  tabs: readonly HarnessTabMeta[] | undefined,
): HarnessTabMeta | null {
  return tabs?.find((x) => x.delegation?.callId === call.id) ?? null;
}

export function delegateView(
  call: ToolCall,
  tab: HarnessTabMeta | null,
  tl: TabLive | undefined,
): DelegateView {
  const { result, error } = parseOutput(call.output);
  const input = parseInput(call.input);
  const goal = tab?.delegation?.goal ?? (typeof input?.goal === 'string' ? input.goal : '') ?? '';
  const backend = (tab?.backend ?? result?.cli ?? null) as HarnessBackend | null;
  let phase: Phase;
  if (call.status === 'running' || result?.status === 'running') {
    // 工具已返回但后台仍在跑（P2 异步默认）：跟标签实时状态
    if (!tab) phase = call.status === 'running' ? 'confirming' : 'running';
    // 标签已经出错停下（最终结果还没到）：按出错显示，不再一直「运行中」
    else if (tab.status === 'error') phase = 'error';
    else phase = tl?.permissions?.length || tab.sandboxPending?.length ? 'waiting' : 'running';
  } else if (result) phase = result.status === 'done' ? 'done' : result.status;
  else phase = error || call.status === 'error' ? 'error' : 'done';
  return { call, tab, live: tl, result, error, phase, backend, goal };
}

function phaseLabel(p: Phase): string {
  switch (p) {
    case 'confirming':
      return t('ui.session-workspace.waiting-for-you-to-approve-the-handoff');
    case 'running':
      return t('ui.knowledge-local.running');
    case 'waiting':
      return t('ui.session-workspace.needs-your-approval');
    case 'done':
      return t('ui.foundation.done');
    case 'error':
      return t('ui.chat-settings.error');
    case 'cancelled':
      return t('ui.chat-settings.stopped');
  }
}

function useElapsed(since: number | undefined, until: number | undefined): string | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (since === undefined || until !== undefined) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [since, until]);
  if (since === undefined) return null;
  const s = Math.max(0, Math.floor(((until ?? now) - since) / 1000));
  return s >= 60
    ? t('ui.chat-settings.m-s', String(Math.floor(s / 60)), String(s % 60))
    : t('ui.mascot-theme.s', String(s));
}

/** 「当前」一行：运行中子代理里最近开始的一个的进度，否则主代理当前的工具 */
function currentStep(live: TabLive | undefined): string | null {
  if (!live) return null;
  const running = Object.values(live.agents ?? {})
    .filter((a) => a.status === 'running')
    .sort((a, b) => b.startedAt - a.startedAt)[0];
  if (running) {
    const who = running.label || running.agentType || t('ui.usage-tools.subagent');
    return running.progress ? `${who} · ${running.progress}` : who;
  }
  return live.tool ?? null;
}

const AGENT_STATUS: Record<LiveAgent['status'], string> = {
  running: 'ui.knowledge-local.running',
  completed: 'ui.foundation.done',
  failed: 'ui.chat-settings.error',
  stopped: 'ui.chat-settings.stopped',
};

const AgentRow: React.FC<{ agent: LiveAgent; onStop?: () => void }> = ({ agent, onStop }) => {
  const [stopping, setStopping] = useState(false);
  const usage = agent.usage?.toolUses
    ? t('ui.session-workspace.tool-calls', String(agent.usage.toolUses))
    : '';
  return (
    <li className={styles.agent} data-testid="delegate-agent" data-status={agent.status}>
      <span className={styles.agentName} title={agent.label}>
        {agent.label || agent.agentType || t('ui.usage-tools.subagent')}
      </span>
      <span className={styles.agentStatus}>{t(AGENT_STATUS[agent.status])}</span>
      <span className={styles.agentProgress} title={agent.progress}>
        {[agent.status === 'running' ? agent.progress : '', usage].filter(Boolean).join(' · ')}
      </span>
      {onStop && agent.status === 'running' && (
        <button
          type="button"
          className={styles.linkBtn}
          disabled={stopping}
          aria-label={t(
            'ui.chat-settings.stop-subagent',
            agent.label || t('ui.usage-tools.subagent'),
          )}
          data-testid="delegate-agent-stop"
          onClick={() => {
            setStopping(true);
            onStop();
          }}
        >
          {stopping ? t('ui.chat-settings.stopping') : t('ui.foundation.stop')}
        </button>
      )}
    </li>
  );
};

/** 子代理列表：只列运行中的，已结束的折叠成一行 */
const Agents: React.FC<{ v: DelegateView }> = ({ v }) => {
  const [showDone, setShowDone] = useState(false);
  const agents = Object.values(v.live?.agents ?? {}).sort((a, b) => a.startedAt - b.startedAt);
  if (!agents.length || !v.tab) return null;
  const tabId = v.tab.id;
  const running = agents.filter((a) => a.status === 'running');
  const ended = agents.filter((a) => a.status !== 'running');
  // Claude 可以单独停止子代理；Codex 等只能停整个任务
  const stoppable = canStopSubagent(v.backend);
  const shown = showDone ? agents : running;
  return (
    <div className={styles.agents}>
      <div className={styles.agentsHead}>
        {t('ui.session-workspace.subagents-running', String(agents.length), String(running.length))}
        {!stoppable && (
          <span className={styles.muted}>
            {' '}
            · {t('ui.session-workspace.this-coding-assistant-doesn-t-report-subagent-steps')}
          </span>
        )}
      </div>
      <ul className={styles.agentList}>
        {shown.map((a) => (
          <AgentRow
            key={a.id}
            agent={a}
            onStop={
              stoppable
                ? () => void harnessClient.stopAgent(tabId, a.id).catch(() => undefined)
                : undefined
            }
          />
        ))}
      </ul>
      {!showDone && ended.length > 0 && (
        <button type="button" className={styles.linkBtn} onClick={() => setShowDone(true)}>
          {t('ui.session-workspace.more-finished', String(ended.length))}
        </button>
      )}
    </div>
  );
};

/** 交给模型时包的 <cli-output> 边界与说明行去掉，只留编程助手的原话 */
export function plainSummary(s: string): string {
  const m = /^<cli-output>\n[^\n]*\n([\s\S]*)\n<\/cli-output>$/.exec(s.trim());
  return balanceCutFence((m ? m[1]! : s).trim());
}

/**
 * 内核只保留回复的结尾（开头换成「…」）：截断点落在代码块中间时，剩下的第一个 ``` 其实是收尾，
 * 原样渲染会把后面的正文全当成代码。在开头补回一个围栏。
 */
export function balanceCutFence(s: string): string {
  if (!s.startsWith('…')) return s;
  const fences = s.split('\n').filter((l) => /^\s*(```|~~~)/.test(l)).length;
  if (fences % 2 === 0) return s;
  return `…\n\n\`\`\`\n${s.slice(1)}`;
}

/**
 * 编程助手改过的文件。path 只是显示用的短路径（在某个目录里就收成相对路径），
 * 文件身份是 key = 所在目录 + 相对路径：两个目录里的同名文件是两个文件（#246）。
 */
export interface DelegateFile {
  key: string;
  path: string;
  /**
   * 依次从这些目录读写：绝对路径落在第 i 个目录里时从第 i 个开始（子任务 worktree 清理后
   * 还能回到主目录读回填的结果，主目录里的文件却不会被换成 worktree 里的同名文件）；
   * 相对路径按子任务目录（roots[0]）算。
   */
  cwds: string[];
  diff?: FileDiff;
}

/**
 * 汇报 / git 核对的文件 + 子任务对话里编辑 / 写入工具改过的文件，按文件身份去重。
 * 后者补上 git 看不到的：非 git 目录且没按格式汇报、被忽略的目录、用绝对路径写到 worktree 外。
 */
export function delegateFiles(
  reported: readonly string[],
  messages: readonly ConvMessage[],
  roots: readonly string[],
): DelegateFile[] {
  const ident = (f: string): Omit<DelegateFile, 'diff'> => {
    for (let i = 0; i < roots.length; i++) {
      const x = workspaceRelPath(roots[i]!, f);
      if (x !== f) return { key: `${roots[i]}\0${x}`, path: x, cwds: roots.slice(i) };
    }
    // 相对路径：按子任务目录；目录外的绝对路径：原样（预览会提示不在工作区里）
    const isAbs = /^(?:[a-zA-Z]:)?[\\/]/.test(f);
    return { key: isAbs || !roots[0] ? f : `${roots[0]}\0${f}`, path: f, cwds: [...roots] };
  };
  const out = new Map<string, DelegateFile>();
  for (const f of reported) {
    if (!f) continue;
    const id = ident(f);
    out.set(id.key, id);
  }
  for (const e of aggregateSessionChanges(messages)) {
    if (!e.file || e.file === '(unnamed)' || e.status === 'deleted') continue;
    const id = ident(e.file);
    const diff = e.diff && !e.diff.summaryOnly ? e.diff : undefined;
    out.set(id.key, diff ? { ...id, diff } : (out.get(id.key) ?? id));
  }
  return [...out.values()];
}

/** 子任务标签的完整消息（抽屉与汇报共用）；enabled 为 false 时不拉 */
function useTabMessages(
  tabId: string | undefined,
  updatedAt: number | undefined,
  running: boolean,
  enabled = true,
): HarnessTabMessage[] | null {
  const [messages, setMessages] = useState<HarnessTabMessage[] | null>(null);
  useEffect(() => {
    if (!tabId || !enabled) return;
    let alive = true;
    void harnessClient
      .tabMessages(tabId)
      .then((m) => alive && setMessages(m))
      .catch(() => alive && setMessages([]));
    return () => {
      alive = false;
    };
  }, [tabId, updatedAt, running, enabled]);
  return messages;
}

/** 结束后的汇报 */
const Report: React.FC<{
  v: DelegateView;
  files: DelegateFile[];
  onOpenFile?: (key: string) => void;
}> = ({ v, files, onOpenFile }) => {
  const r = v.result;
  if (v.error && !r)
    return (
      <div className={styles.errorText} data-testid="delegate-error">
        {v.error.message}
      </div>
    );
  if (!r) return null;
  return (
    <div className={styles.report} data-testid="delegate-report">
      {r.status === 'cancelled' && (
        <div className={styles.muted}>
          {r.cancelledBy === 'nomi'
            ? t('ui.session-workspace.nomi-s-turn-was-stopped-so-the-subtask')
            : t('ui.session-workspace.you-stopped-this-subtask')}
        </div>
      )}
      {r.error && <div className={styles.errorText}>{r.error}</div>}
      {r.report ? (
        <>
          <div className={styles.reportBody}>
            <Markdown text={plainSummary(r.report.done)} settled />
          </div>
          {r.report.unfinished && (
            <div className={styles.reportRow}>
              <span className={styles.reportLabel}>{t('ui.session-workspace.not-finished')}</span>
              <span>{plainSummary(r.report.unfinished)}</span>
            </div>
          )}
          {r.report.needsUser && (
            <div className={styles.reportRow}>
              <span className={styles.reportLabel}>
                {t('ui.session-workspace.needs-your-decision')}
              </span>
              <span>{plainSummary(r.report.needsUser)}</span>
            </div>
          )}
        </>
      ) : r.summary ? (
        // 编程助手没按格式汇报：显示它最后的回复（去掉交给模型时加的边界说明）
        <div className={styles.reportBody} data-testid="delegate-summary">
          <Markdown text={plainSummary(r.summary)} settled />
        </div>
      ) : null}
      {files.length > 0 && (
        <div className={styles.reportRow}>
          <span className={styles.reportLabel}>
            {r.filesVerified
              ? t('ui.session-workspace.changed-files')
              : t('ui.session-workspace.changed-files-not-checked-against-git')}
          </span>
          <ul className={styles.files} data-testid="delegate-files">
            {files.slice(0, 8).map((f) => (
              <li key={f.key}>
                {onOpenFile ? (
                  <button
                    type="button"
                    className={styles.fileBtn}
                    data-testid="delegate-file"
                    onClick={() => onOpenFile(f.key)}
                  >
                    <code>{f.path}</code>
                  </button>
                ) : (
                  <code>{f.path}</code>
                )}
              </li>
            ))}
            {files.length > 8 && (
              <li className={styles.muted}>
                {t('ui.session-workspace.in-total', String(files.length))}
              </li>
            )}
          </ul>
        </div>
      )}
      {r.conflictedFiles?.length ? (
        <div className={styles.reportRow} data-testid="delegate-conflicts">
          <span className={styles.reportLabel}>
            {t('ui.session-workspace.files-not-applied-automatically')}
          </span>
          <ul className={styles.files}>
            {r.conflictedFiles.slice(0, 8).map((f) => (
              <li key={f}>
                <code>{f}</code>
              </li>
            ))}
            {r.conflictedFiles.length > 8 && (
              <li className={styles.muted}>
                {t('ui.session-workspace.in-total', String(r.conflictedFiles.length))}
              </li>
            )}
          </ul>
        </div>
      ) : null}
      {r.approvals.asked > 0 && (
        <div className={styles.muted}>
          {t(
            'ui.session-workspace.approval-requests-denied-timed-out',
            String(r.approvals.asked),
            String(r.approvals.denied),
            String(r.approvals.timedOut),
          )}
        </div>
      )}
    </div>
  );
};

/**
 * 「查看」：在右侧抽屉里看子任务的完整对话（与工作台标签同一套渲染：思考、工具轨迹、改动），
 * 不切换模式；工作台模式下头部可一键切到这个标签接手。权限请求在抽屉里也能直接答复。
 */
const DelegateDrawer: React.FC<{
  v: DelegateView;
  elapsed: string | null;
  running: boolean;
  stopping: boolean;
  onStop: () => void;
  onClose: () => void;
}> = ({ v, elapsed, running, stopping, onStop, onClose }) => {
  const tabId = v.tab?.id;
  const messages = useTabMessages(tabId, v.tab?.updatedAt, running);
  const backend = v.backend ?? 'claude';
  const conv = useMemo(
    () => (messages ?? []).map((m) => fromHarnessMessage(m, backend)),
    [messages, backend],
  );
  const live = useMemo(() => tabLiveToConv(v.live), [v.live]);
  const cwd = v.tab?.cwd ?? null;
  const slots = useMemo(() => buildCliSlots({ cwd }), [cwd]);
  const drawerTaskId = v.tab?.delegation?.taskId;
  const onPermission = useCallback(
    (id: string, allow: boolean, opts?: { approvePlan?: 'acceptEdits' | 'manual' | 'deny' }) => {
      if (!tabId) return;
      // 后台委派是持续任务：先经任务回应；任务已结束 / 请求已失效时退回直接回标签
      void replyPermissionRequest(tabId, id, allow, {
        ...(opts?.approvePlan ? { approvePlan: opts.approvePlan } : {}),
        ...(drawerTaskId ? { taskId: drawerTaskId } : {}),
      }).catch(() => false);
    },
    [tabId, drawerTaskId],
  );
  const name = v.backend ? t(ENDPOINT_NAME[v.backend]) : t('ui.providers-schedule.coding-agents');
  const host = useMemo(
    () => ({
      mode: 'drawer' as const,
      actions: (
        <>
          {running && (
            <Button
              variant="ghost"
              size="sm"
              disabled={stopping}
              onClick={onStop}
              data-testid="delegate-drawer-stop"
            >
              {t('ui.session-workspace.stop-this-subtask')}
            </Button>
          )}
        </>
      ),
    }),
    [running, stopping, onStop],
  );
  const empty = messages !== null && !conv.length && !live;
  return (
    <ModalHostContext.Provider value={host}>
      <Modal
        open
        onClose={onClose}
        size="lg"
        title={name}
        bodyClassName={styles.drawerBody}
        data-testid="delegate-drawer"
      >
        <div className={styles.drawerMeta}>
          <div className={styles.drawerStatus}>
            {v.backend && <EndpointIcon backend={v.backend} size={16} decorative />}
            <span className={styles.phase} data-phase={v.phase} aria-live="polite">
              {phaseLabel(v.phase)}
            </span>
            {elapsed && <span className={styles.muted}>{elapsed}</span>}
          </div>
          <p className={styles.drawerGoal} title={v.goal}>
            {v.goal}
          </p>
          {v.error && <p className={styles.drawerError}>{v.error.message}</p>}
        </div>
        <div className={styles.drawerConv}>
          {empty ? (
            <div className={styles.drawerEmpty}>{t('ui.session-workspace.no-output-yet')}</div>
          ) : (
            <ConversationView
              scopeId={`delegate:${tabId ?? v.call.id}`}
              messages={conv}
              live={live ?? null}
              phase={running ? 'running' : 'idle'}
              onPermission={onPermission}
              slots={slots}
            />
          )}
        </div>
      </Modal>
    </ModalHostContext.Provider>
  );
};

const DelegateCardImpl: React.FC<{ call: ToolCall }> = ({ call }) => {
  const tabs = useHarnessTabs();
  const resource = useResourceContext();
  const tabMeta = delegateTab(call, tabs.state?.tabs);
  // 只订阅自己这个标签的实时进度（别的标签每帧的输出不让这张卡片重渲染）
  const tl = useHarnessLive((l) => (tabMeta ? l[tabMeta.id] : undefined));
  const parsed = parseOutput(call.output);
  const taskId = parsed.result?.taskId ?? tabMeta?.id;
  const [liveResult, setLiveResult] = useState<DelegateResult | undefined>();
  // 异步委派：工具输出是 running 占位，完成后主进程广播 / 可查 status
  useEffect(() => {
    if (!taskId) return;
    if (parsed.result?.status !== 'running' && liveResult?.status !== 'running') return;
    let alive = true;
    const apply = (r: DelegateResult) => {
      // 子任务里后续轮次的结果写进对话，不覆盖卡片上委派本身的汇报
      if (alive && r.taskId === taskId && !r.followUp) setLiveResult(r);
    };
    const off = delegateClient.onCompleted(apply);
    void delegateClient
      .status(taskId)
      .then((r) => {
        if (r) apply(r);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
      off();
    };
    // liveResult 故意不进依赖：只在工具输出仍为 running 时挂订阅
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId, parsed.result?.status]);
  const callForView = withDelegateResult(call, liveResult);
  const v = delegateView(callForView, tabMeta, tl);
  const [open, setOpen] = useState(true);
  const [drawer, setDrawer] = useState(false);
  /** 已失效（任务结束 / 请求不在等待里）的审批：不再显示卡片，否则按钮点了永远没反应 */
  const [dead, setDead] = useState<string[]>([]);
  const [replyError, setReplyError] = useState(false);
  // 有子任务面板（主窗口）就在对话旁打开、可以接着对话；没有时退回抽屉
  const subagentPane = useSubagentPane();
  const [stopping, setStopping] = useState(false);
  const running = v.phase === 'running' || v.phase === 'waiting';
  const elapsed = useElapsed(
    call.startedAt,
    running
      ? undefined
      : liveResult?.durationMs != null && call.startedAt != null
        ? call.startedAt + liveResult.durationMs
        : (call.endedAt ?? call.startedAt),
  );
  const step = running ? currentStep(v.live) : null;
  const name = v.backend ? t(ENDPOINT_NAME[v.backend]) : t('ui.providers-schedule.coding-agents');
  const tab = v.tab;
  // 后台委派是持续任务（标签带 taskId）：停止 = 取消任务；直接停标签会让任务以为执行者崩了
  const tabTaskId = tab?.delegation?.taskId;
  // 结束后：从子任务对话里补齐改过的文件；读文件时按目录依次找
  // （子任务标签目录，可能是 worktree → 主标签目录，跟着当前对话的工作区走）
  const mainCwd = tabs.state?.tabs.find((x) => x.id === MAIN_TAB_ID)?.cwd;
  // 不手写 useMemo：交给 React Compiler（卡片里的 v / tab 每次渲染新建，手写依赖保不住）
  // A vanished child tab provides no proven cwd: never reinterpret historical
  // relative files in whichever main workspace happens to be active now.
  const roots = tab?.cwd ? [...new Set([tab.cwd, mainCwd].filter((x): x is string => !!x))] : [];
  const childMessages = useTabMessages(tab?.id, tab?.updatedAt, running, !running && open);
  const backend = v.backend ?? 'claude';
  const childConv = (childMessages ?? []).map((m) => fromHarnessMessage(m, backend));
  const reported =
    (v.result?.report?.changedFiles?.length
      ? v.result.report.changedFiles
      : v.result?.changedFiles) ?? [];
  const files = delegateFiles(reported, childConv, roots);
  // Report Markdown, the fallback drawer and explicit file buttons share the
  // child's identity. Only reuse the controller, not parent document metadata.
  const childResource: ResourceContextValue | null = resource
    ? {
        scope: {
          id: tab ? `cli:${tab.id}` : `delegate:${taskId ?? call.id}`,
          cwd: tab?.cwd ?? null,
          source: backend,
          ...(roots.length > 1 ? { fallbackCwds: roots.slice(1) } : {}),
        },
        open: (href, scope, image) => {
          const target = resourceTarget(href);
          // Absolute identity also lets the existing preview safely relocate a
          // known worktree file after cleanup. Preserve URL encoding and #L….
          const resolved =
            scope.cwd && target?.path && !target.web ? resolveDocumentHref(scope.cwd, href) : href;
          resource.open(resolved, scope, image);
        },
      }
    : null;
  const openFile = (key: string) => {
    const file = files.find((f) => f.key === key);
    const cwd = file?.cwds[0] ?? roots[0];
    if (!file || !cwd || !childResource) return;
    childResource.open(workspaceFileHref(cwd, file.path), {
      ...childResource.scope,
      cwd,
      fallbackCwds: file.cwds.slice(1),
    });
  };
  const stop = () => {
    if (!tab) return;
    setStopping(true);
    const done = tabTaskId ? api.tasks.cancel({ id: tabTaskId }) : harnessClient.cancelTab(tab.id);
    void Promise.resolve(done).catch(() => setStopping(false));
  };
  /**
   * 审批：任务标签先经任务回应（内核的任务收件箱要对上请求），失败退回直接回标签；
   * 内核明确返回失效才收起卡片；通信失败保留入口，允许重试。
   */
  const reply = async (
    requestId: string,
    allow: boolean,
    approvePlan?: 'acceptEdits' | 'manual' | 'deny',
  ) => {
    if (!tab) return false;
    setReplyError(false);
    try {
      const ok = await replyPermissionRequest(tab.id, requestId, allow, {
        ...(approvePlan ? { approvePlan } : {}),
        ...(tabTaskId ? { taskId: tabTaskId } : {}),
      });
      if (!ok) setDead((d) => (d.includes(requestId) ? d : [...d, requestId]));
      return ok;
    } catch {
      setReplyError(true);
      return false;
    }
  };
  return (
    <ResourceContext.Provider value={childResource}>
      <section
        className={styles.card}
        data-testid="delegate-card"
        data-phase={v.phase}
        aria-label={t('ui.session-workspace.subtask-for', name, v.goal)}
      >
        <div className={styles.head}>
          <button
            type="button"
            className={styles.toggle}
            aria-expanded={open}
            onClick={() => setOpen((o) => !o)}
          >
            <Icon icon={open ? ChevronDown : ChevronRight} size={14} />
          </button>
          {v.backend && <EndpointIcon backend={v.backend} size={16} decorative />}
          <AgentHoverCard
            target={tab ? { kind: 'harness', tabId: tab.id } : null}
            onOpen={tab && subagentPane ? () => subagentPane.openSubagent(tab.id) : undefined}
            fallback={{ lastUser: v.goal }}
            className={styles.title}
          >
            <span className={styles.name}>{name}</span>
            <span className={styles.goal}>{v.goal}</span>
          </AgentHoverCard>
          <span className={styles.phase} data-phase={v.phase} aria-live="polite">
            {phaseLabel(v.phase)}
          </span>
          {elapsed && <span className={styles.muted}>{elapsed}</span>}
          {running && tab && (
            <button
              type="button"
              className={styles.iconBtn}
              disabled={stopping}
              aria-label={t('ui.session-workspace.stop-this-subtask')}
              data-testid="delegate-stop"
              onClick={stop}
            >
              <Icon icon={Square} size={12} />
            </button>
          )}
          {tab && (
            <button
              type="button"
              className={styles.iconBtn}
              aria-label={t('ui.session-workspace.view-subtask')}
              data-testid="delegate-view"
              onClick={() => (subagentPane ? subagentPane.openSubagent(tab.id) : setDrawer(true))}
            >
              <Icon icon={ExternalLink} size={13} />
            </button>
          )}
        </div>
        {step && (
          <div className={styles.step} data-testid="delegate-step" title={step}>
            {t('ui.session-workspace.now', step)}
          </div>
        )}
        {open && (
          <div className={styles.body}>
            {tab && <TabSandboxRequests tabId={tab.id} />}
            {tab &&
              // 计划轮次完成后仍可能有执行计划审批；取消的委派不再接受审批。
              v.phase !== 'cancelled' &&
              (v.live?.permissions ?? [])
                .filter((p) => !dead.includes(p.id))
                .map((p) =>
                  p.kind === 'approve-plan' ? (
                    <ApprovePlanCard
                      key={p.id}
                      summary={p.summary}
                      agent={p.agent}
                      expiresAt={p.expiresAt}
                      executePlan={p.toolName === 'execute_plan'}
                      onChoice={(choice) => void reply(p.id, choice !== 'deny', choice)}
                    />
                  ) : (
                    <PermissionCard
                      key={p.id}
                      summary={p.summary}
                      agent={p.agent}
                      expiresAt={p.expiresAt}
                      onReply={(allow) => void reply(p.id, allow)}
                    />
                  ),
                )}
            {replyError && (
              <div className={styles.errorText} role="alert">
                {t('ui.session-workspace.permission-reply-failed')}
              </div>
            )}
            <Agents v={v} />
            {!running && (
              <Report
                v={v}
                files={files}
                onOpenFile={childResource && roots.length ? openFile : undefined}
              />
            )}
          </div>
        )}
        {drawer && (
          <DelegateDrawer
            v={v}
            elapsed={elapsed}
            running={running}
            stopping={stopping}
            onStop={stop}
            onClose={() => setDrawer(false)}
          />
        )}
      </section>
    </ResourceContext.Provider>
  );
};

export const DelegateCard = React.memo(DelegateCardImpl);

/** 组头只看「在等你批准」：用占位的实时状态算阶段（delegateView 只看 permissions 有没有） */
const WAITING_LIVE = { permissions: [{}] } as unknown as TabLive;

/** 同一轮派出多个子任务：组头汇总状态，「全部停止」 */
const DelegateGroupImpl: React.FC<{ calls: ToolCall[] }> = ({ calls }) => {
  const tabs = useHarnessTabs();
  const groupTabs = calls.map((c) => delegateTab(c, tabs.state?.tabs));
  // 只订阅这组标签「有没有待批准」（一位一个标签的字符串）：别的标签 / 本组标签的流式输出不让组头重渲染
  const waitingKey = useHarnessLive((l) =>
    groupTabs.map((tab) => (tab && l[tab.id]?.permissions?.length ? '1' : '0')).join(''),
  );
  const views = calls.map((c, i) => {
    const tab = groupTabs[i] ?? null;
    return delegateView(c, tab, tab && waitingKey[i] === '1' ? WAITING_LIVE : undefined);
  });
  const running = views.filter((x) => x.phase === 'running' || x.phase === 'waiting');
  const waiting = views.filter((x) => x.phase === 'waiting').length;
  return (
    <div className={styles.group} data-testid="delegate-group">
      <div className={styles.groupHead} aria-live="polite">
        <span>
          {[
            t('ui.session-workspace.nomi-handed-off-tasks', String(calls.length)),
            running.length ? t('ui.session-workspace.running', String(running.length)) : '',
            waiting ? t('ui.session-workspace.need-your-approval', String(waiting)) : '',
          ]
            .filter(Boolean)
            .join(' · ')}
        </span>
        {running.length > 0 && (
          <button
            type="button"
            className={styles.linkBtn}
            data-testid="delegate-stop-all"
            onClick={() => {
              for (const x of running) {
                if (!x.tab) continue;
                const taskId = x.tab.delegation?.taskId;
                const done = taskId
                  ? api.tasks.cancel({ id: taskId })
                  : harnessClient.cancelTab(x.tab.id);
                void Promise.resolve(done).catch(() => undefined);
              }
            }}
          >
            {t('ui.session-workspace.stop-all')}
          </button>
        )}
      </div>
      {calls.map((c) => (
        <DelegateCard key={c.id} call={c} />
      ))}
    </div>
  );
};

/** calls 每次是新数组（ToolTimeline 现取），按元素比较 */
export const DelegateGroup = React.memo(
  DelegateGroupImpl,
  (a, b) => a.calls.length === b.calls.length && a.calls.every((c, i) => c === b.calls[i]),
);
