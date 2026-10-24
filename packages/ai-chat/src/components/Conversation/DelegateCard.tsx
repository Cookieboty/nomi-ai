/**
 * Nomi 派给编程助手的子任务卡片（docs/design/nomi-delegate-cli.md §7）：
 * - 标题：编程助手、目标、状态、耗时、「停止」「查看」；
 * - 当前一行：所有代理里最近的一个动作（「explorer · 运行 npm test」）；
 * - 审批：子任务的权限请求直接在卡片里答复（标签里也同时显示）；
 * - 子代理：每个一行，Claude 可以单独停止；
 * - 结束后：编程助手的汇报（做了什么、改动的文件、没做完的、需要用户决定的）。
 * 数据：工具调用 id → 标签（delegation.callId）→ 标签的实时状态；历史消息只有工具输出。
 */
import { Icon, Modal, ModalHostContext, t } from '@nomi-ai/ui';
import { ChevronDown, ChevronRight, ExternalLink, Square } from 'lucide-react';
import React, { useEffect, useMemo, useState } from 'react';

import { useHarnessLive, useHarnessTabs } from '../../contexts/HarnessTabsContext';
import { useChatMode } from '../../hooks/useChatMode';
import { delegateClient, type DelegateResult } from '../../services/delegateClient';
import {
  harnessClient,
  type HarnessBackend,
  type HarnessTabMessage,
  type HarnessTabMeta,
} from '../../services/harnessClient';
import { canStopSubagent } from '../../utils/cliCaps';
import { ENDPOINT_NAME } from '../../utils/endpointBadge';
import type { LiveAgent, TabLive } from '../../utils/liveState';
import { parseInput, type ToolCall } from '../../utils/toolTrace';
import { EndpointIcon } from '../EndpointIcon';

import { ApprovePlanCard } from './ApprovePlanCard';
import styles from './DelegateCard.module.css';
import { Markdown } from './Markdown';
import { PermissionCard } from './PermissionCard';

type Phase = 'confirming' | 'running' | 'waiting' | 'done' | 'error' | 'cancelled';

/** 工具输出：`{ ok, data }` / `{ ok: false, error }`（主进程 DelegateService） */
function parseOutput(output: string | undefined): {
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
    else phase = tl?.permissions?.length ? 'waiting' : 'running';
  } else if (result) phase = result.status === 'done' ? 'done' : result.status;
  else phase = error || call.status === 'error' ? 'error' : 'done';
  return { call, tab, live: tl, result, error, phase, backend, goal };
}

function phaseLabel(p: Phase): string {
  switch (p) {
    case 'confirming':
      return t('等待确认委派');
    case 'running':
      return t('运行中');
    case 'waiting':
      return t('等你确认');
    case 'done':
      return t('已完成');
    case 'error':
      return t('出错');
    case 'cancelled':
      return t('已停止');
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
    ? t('{0} 分 {1} 秒', String(Math.floor(s / 60)), String(s % 60))
    : t('{0} 秒', String(s));
}

/** 「当前」一行：运行中子代理里最近开始的一个的进度，否则主代理当前的工具 */
function currentStep(live: TabLive | undefined): string | null {
  if (!live) return null;
  const running = Object.values(live.agents ?? {})
    .filter((a) => a.status === 'running')
    .sort((a, b) => b.startedAt - a.startedAt)[0];
  if (running) {
    const who = running.label || running.agentType || t('子代理');
    return running.progress ? `${who} · ${running.progress}` : who;
  }
  return live.tool ?? null;
}

const AGENT_STATUS: Record<LiveAgent['status'], string> = {
  running: '运行中',
  completed: '已完成',
  failed: '出错',
  stopped: '已停止',
};

const AgentRow: React.FC<{ agent: LiveAgent; onStop?: () => void }> = ({ agent, onStop }) => {
  const [stopping, setStopping] = useState(false);
  const usage = agent.usage?.toolUses ? t('{0} 次工具', String(agent.usage.toolUses)) : '';
  return (
    <li className={styles.agent} data-testid="delegate-agent" data-status={agent.status}>
      <span className={styles.agentName} title={agent.label}>
        {agent.label || agent.agentType || t('子代理')}
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
          aria-label={t('停止子代理「{0}」', agent.label || t('子代理'))}
          data-testid="delegate-agent-stop"
          onClick={() => {
            setStopping(true);
            onStop();
          }}
        >
          {stopping ? t('正在停止…') : t('停止')}
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
        {t('子代理 {0} 个（{1} 运行中）', String(agents.length), String(running.length))}
        {!stoppable && (
          <span className={styles.muted}> · {t('该编程助手不提供子代理的内部步骤')}</span>
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
          {t('另有 {0} 个已结束', String(ended.length))}
        </button>
      )}
    </div>
  );
};

/** 交给模型时包的 <cli-output> 边界与说明行去掉，只留编程助手的原话 */
export function plainSummary(s: string): string {
  const m = /^<cli-output>\n[^\n]*\n([\s\S]*)\n<\/cli-output>$/.exec(s.trim());
  return (m ? m[1]! : s).trim();
}

/** 结束后的汇报 */
const Report: React.FC<{ v: DelegateView }> = ({ v }) => {
  const r = v.result;
  if (v.error && !r)
    return (
      <div className={styles.errorText} data-testid="delegate-error">
        {v.error.message}
      </div>
    );
  if (!r) return null;
  const files = (r.report?.changedFiles?.length ? r.report.changedFiles : r.changedFiles) ?? [];
  return (
    <div className={styles.report} data-testid="delegate-report">
      {r.status === 'cancelled' && (
        <div className={styles.muted}>
          {r.cancelledBy === 'nomi'
            ? t('Nomi 这一轮被停止，子任务一起停下了。')
            : t('你停止了这个子任务。')}
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
              <span className={styles.reportLabel}>{t('没做完的')}</span>
              <span>{plainSummary(r.report.unfinished)}</span>
            </div>
          )}
          {r.report.needsUser && (
            <div className={styles.reportRow}>
              <span className={styles.reportLabel}>{t('需要你决定的')}</span>
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
            {r.filesVerified ? t('改动的文件') : t('改动的文件（未经 git 核对）')}
          </span>
          <ul className={styles.files} data-testid="delegate-files">
            {files.slice(0, 8).map((f) => (
              <li key={f}>
                <code>{f}</code>
              </li>
            ))}
            {files.length > 8 && (
              <li className={styles.muted}>{t('等 {0} 个', String(files.length))}</li>
            )}
          </ul>
        </div>
      )}
      {r.approvals.asked > 0 && (
        <div className={styles.muted}>
          {t(
            '审批 {0} 次，拒绝 {1} 次，超时 {2} 次',
            String(r.approvals.asked),
            String(r.approvals.denied),
            String(r.approvals.timedOut),
          )}
        </div>
      )}
    </div>
  );
};

/** 助手模式下「查看」：在右侧抽屉里看子任务的对话记录（不切换模式；要接手就去工作台） */
const DelegateDrawer: React.FC<{ v: DelegateView; onClose: () => void }> = ({ v, onClose }) => {
  const [messages, setMessages] = useState<HarnessTabMessage[] | null>(null);
  const tabId = v.tab?.id;
  const updatedAt = v.tab?.updatedAt;
  useEffect(() => {
    if (!tabId) return;
    let alive = true;
    void harnessClient
      .tabMessages(tabId)
      .then((m) => alive && setMessages(m))
      .catch(() => alive && setMessages([]));
    return () => {
      alive = false;
    };
  }, [tabId, updatedAt]);
  const host = useMemo(() => ({ mode: 'drawer' as const }), []);
  const name = v.backend ? t(ENDPOINT_NAME[v.backend]) : '';
  return (
    <ModalHostContext.Provider value={host}>
      <Modal open onClose={onClose} title={`${name} · ${v.goal}`} data-testid="delegate-drawer">
        <div className={styles.drawer}>
          {(messages ?? []).map((m) => (
            // 用户消息（任务说明）按原样换行显示；Markdown 会把单个换行合并成空格
            <div
              key={m.id}
              className={m.role === 'user' ? styles.drawerUser : styles.drawerAssistant}
            >
              {m.role === 'user' ? m.content : <Markdown text={m.content} settled />}
            </div>
          ))}
          {v.live?.text && (
            <div className={styles.drawerAssistant}>
              <Markdown text={v.live.text} />
            </div>
          )}
          {messages !== null && !messages.length && !v.live?.text && (
            <div className={styles.muted}>{t('还没有输出')}</div>
          )}
        </div>
      </Modal>
    </ModalHostContext.Provider>
  );
};

export const DelegateCard: React.FC<{ call: ToolCall }> = ({ call }) => {
  const tabs = useHarnessTabs();
  const tabMeta = delegateTab(call, tabs.state?.tabs);
  // 只订阅自己这个标签的实时进度（别的标签每帧的输出不让这张卡片重渲染）
  const tl = useHarnessLive((l) => (tabMeta ? l[tabMeta.id] : undefined));
  const { isDev } = useChatMode();
  const parsed = parseOutput(call.output);
  const taskId = parsed.result?.taskId ?? tabMeta?.id;
  const [liveResult, setLiveResult] = useState<DelegateResult | undefined>();
  // 异步委派：工具输出是 running 占位，完成后主进程广播 / 可查 status
  useEffect(() => {
    if (!taskId) return;
    if (parsed.result?.status !== 'running' && liveResult?.status !== 'running') return;
    let alive = true;
    const apply = (r: DelegateResult) => {
      if (alive && r.taskId === taskId) setLiveResult(r);
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
  const callForView =
    liveResult && liveResult.status !== 'running'
      ? {
          ...call,
          status: 'done' as const,
          output: JSON.stringify({ ok: true, data: liveResult }),
        }
      : call;
  const v = delegateView(callForView, tabMeta, tl);
  const [open, setOpen] = useState(true);
  const [drawer, setDrawer] = useState(false);
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
  const name = v.backend ? t(ENDPOINT_NAME[v.backend]) : t('编程助手');
  const tab = v.tab;
  const view = () => {
    if (!tab) return;
    if (isDev) void tabs.activate(tab.id);
    else setDrawer(true);
  };
  return (
    <section
      className={styles.card}
      data-testid="delegate-card"
      data-phase={v.phase}
      aria-label={t('交给 {0} 的子任务：{1}', name, v.goal)}
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
        <span className={styles.title} title={v.goal}>
          <span className={styles.name}>{name}</span>
          <span className={styles.goal}>{v.goal}</span>
        </span>
        <span className={styles.phase} data-phase={v.phase} aria-live="polite">
          {phaseLabel(v.phase)}
        </span>
        {elapsed && <span className={styles.muted}>{elapsed}</span>}
        {running && tab && (
          <button
            type="button"
            className={styles.iconBtn}
            disabled={stopping}
            aria-label={t('停止这个子任务')}
            title={t('停止这个子任务（Nomi 会继续）')}
            data-testid="delegate-stop"
            onClick={() => {
              setStopping(true);
              void harnessClient.cancelTab(tab.id).catch(() => setStopping(false));
            }}
          >
            <Icon icon={Square} size={12} />
          </button>
        )}
        {tab && (
          <button
            type="button"
            className={styles.iconBtn}
            aria-label={t('查看子任务')}
            title={isDev ? t('切到这个编程助手标签') : t('查看子任务的对话记录')}
            data-testid="delegate-view"
            onClick={view}
          >
            <Icon icon={ExternalLink} size={13} />
          </button>
        )}
      </div>
      {step && (
        <div className={styles.step} data-testid="delegate-step" title={step}>
          {t('当前：{0}', step)}
        </div>
      )}
      {open && (
        <div className={styles.body}>
          {tab &&
            (v.live?.permissions ?? []).map((p) =>
              p.kind === 'approve-plan' ? (
                <ApprovePlanCard
                  key={p.id}
                  summary={p.summary}
                  agent={p.agent}
                  expiresAt={p.expiresAt}
                  executePlan={p.toolName === 'execute_plan'}
                  onChoice={(choice) =>
                    void harnessClient.replyApprovePlan(tab.id, p.id, choice).catch(() => undefined)
                  }
                />
              ) : (
                <PermissionCard
                  key={p.id}
                  summary={p.summary}
                  agent={p.agent}
                  expiresAt={p.expiresAt}
                  onReply={(allow) =>
                    void harnessClient.replyPermission(tab.id, p.id, allow).catch(() => undefined)
                  }
                />
              ),
            )}
          <Agents v={v} />
          {!running && <Report v={v} />}
        </div>
      )}
      {drawer && <DelegateDrawer v={v} onClose={() => setDrawer(false)} />}
    </section>
  );
};

/** 同一轮派出多个子任务：组头汇总状态，「全部停止」 */
export const DelegateGroup: React.FC<{ calls: ToolCall[] }> = ({ calls }) => {
  const tabs = useHarnessTabs();
  const live = useHarnessLive((l) => l);
  const views = calls.map((c) => {
    const tab = delegateTab(c, tabs.state?.tabs);
    return delegateView(c, tab, tab ? live[tab.id] : undefined);
  });
  const running = views.filter((x) => x.phase === 'running' || x.phase === 'waiting');
  const waiting = views.filter((x) => x.phase === 'waiting').length;
  return (
    <div className={styles.group} data-testid="delegate-group">
      <div className={styles.groupHead} aria-live="polite">
        <span>
          {[
            t('Nomi 派出 {0} 个任务', String(calls.length)),
            running.length ? t('{0} 运行中', String(running.length)) : '',
            waiting ? t('{0} 等你确认', String(waiting)) : '',
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
              for (const x of running)
                if (x.tab) void harnessClient.cancelTab(x.tab.id).catch(() => undefined);
            }}
          >
            {t('全部停止')}
          </button>
        )}
      </div>
      {calls.map((c) => (
        <DelegateCard key={c.id} call={c} />
      ))}
    </div>
  );
};
