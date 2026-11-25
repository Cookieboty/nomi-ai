/**
 * 任务详情（右侧双 Tab 抽屉）：
 * - Sticky 顶栏（展开/收起、上下文跳转、快捷归档/还原）与行动横幅（批准、补充、验收、核对、知道了）；
 * - Tab 1「进度与对话」：实时/回放执行流与状态自适应交互输入栏（插话/排队补充/退回/追问）；
 * - Tab 2「规则与设置」：内联编辑标题、目标、完成标准、验收方式、重要程度、分类，及授权/事件/执行历史/日志。
 */
import {
  Button,
  Disclosure,
  Icon,
  IconButton,
  Input,
  Select,
  t,
  Tabs,
  Textarea,
} from '@nomi-ai/ui';
import {
  IconArchive as Archive,
  IconArchiveOff as ArchiveRestore,
  IconExternalLink as ExternalLink,
  IconArrowsMaximize as Maximize2,
  IconArrowsMinimize as Minimize2,
  IconRoute as RouteIcon,
  IconX as X,
} from '@tabler/icons-react';
import React, { useEffect, useMemo, useState } from 'react';

import { useHarnessTabs } from '../../contexts/HarnessTabsContext';
import { SubagentOutboxProvider } from '../../contexts/SubagentOutboxContext';
import { SubagentPaneProvider, useSubagentPane } from '../../contexts/SubagentPaneContext';
import { api } from '../../services/api';
import { requestOpenConversation } from '../../services/conversationStore';
import { registerSideTrace } from '../../services/sideTrace';
import {
  attemptStatusLabel,
  CATEGORIES,
  CATEGORY_LABEL,
  executorLabel,
  fmtDateTime,
  fmtTime,
  LEVEL_LABEL,
  pendingExternal,
  PRIORITIES,
  PRIORITY_LABEL,
  stageOf,
  statusLabel,
  tasksApi,
  TOOL_LABEL,
  triggerLabel,
  type Attempt,
  type JournalEntry,
  type Task,
  type TaskCategory,
  type TaskPriority,
  type TaskQueueInfo,
} from '../../services/tasksClient';
import { requestOpenFleet } from '../../services/workbenchNav';
import type { ConvMessage } from '../../types/conversation';
import { sideTabItems } from '../../utils/sideTabs';
import { confirmDialog } from '../ConfirmDialog';
import { TaskSandboxRequests } from '../Conversation/SandboxRequests';
import { SessionDetailsProvider } from '../SessionDetails';
import { ChangesUiProvider } from '../SessionWorkspace';
import type { SubagentPaneActions } from '../SubagentPane';

import { canAckFailure, canArchiveTask, LastRunBadge, OriginBadge } from './Board';
import styles from './index.module.css';
import { TaskConversation } from './TaskConversation';
import { TaskModelSwitch } from './TaskModelSwitch';
import { TaskSideDrawer } from './TaskSideDrawer';

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

type DetailTab = 'conversation' | 'settings';

function statusToneOf(task: Task): 'running' | 'attention' | 'done' | 'failed' | 'neutral' {
  switch (stageOf(task)) {
    case 'in_progress':
      return 'running';
    case 'needs_you':
      return task.status === 'failed' || task.status === 'expired' ? 'failed' : 'attention';
    case 'done':
      return task.status === 'done' ? 'done' : 'neutral';
    default:
      return 'neutral';
  }
}

/** 内联规则与设置编辑表单：通过外部传 key 随任务版本自动同步，避免在 effect 里同步 setState */
const TaskRulesEditor: React.FC<{
  task: Task;
  busy: boolean;
  savedNotice: boolean;
  onSave: (patch: {
    title: string;
    goal: string;
    doneWhen?: string;
    acceptance?: 'auto' | 'user';
  }) => void;
}> = ({ task, busy, savedNotice, onSave }) => {
  const [title, setTitle] = useState(task.title);
  const [goal, setGoal] = useState(task.goal);
  const [doneWhen, setDoneWhen] = useState(
    task.executor.kind === 'notify' ? '' : (task.executor.brief?.doneWhen ?? ''),
  );
  const [acceptance, setAcceptance] = useState<'auto' | 'user'>(task.acceptance);

  const handleSave = () => {
    const cleanTitle = title.trim();
    const cleanGoal = goal.trim();
    if (!cleanTitle || !cleanGoal) return;
    onSave({
      title: cleanTitle,
      goal: cleanGoal,
      ...(task.executor.kind !== 'notify' ? { doneWhen: doneWhen.trim(), acceptance } : {}),
    });
  };

  return (
    <section className={styles.editBlock} data-testid="task-edit-rules">
      <label className={styles.field}>
        <span>{t('ui.providers-schedule.task-title')}</span>
        <Input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          disabled={busy}
          data-testid="task-edit-title"
        />
      </label>
      <label className={styles.field}>
        <span>{t('ui.providers-schedule.task-goal')}</span>
        <textarea
          className={styles.textarea}
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          disabled={busy}
          data-testid="task-edit-goal"
        />
      </label>
      {task.executor.kind !== 'notify' && (
        <>
          <label className={styles.field}>
            <span>{t('ui.providers-schedule.task-edit-done-when-label')}</span>
            <Input
              value={doneWhen}
              onChange={(e) => setDoneWhen(e.target.value)}
              placeholder={t('ui.providers-schedule.task-edit-done-when-placeholder')}
              disabled={busy}
              data-testid="task-edit-done-when"
            />
          </label>
          <label className={styles.field}>
            <span>{t('ui.providers-schedule.task-acceptance')}</span>
            <Select
              size="sm"
              value={acceptance}
              onChange={(e) => setAcceptance(e.target.value as 'auto' | 'user')}
              disabled={busy}
              options={[
                { value: 'auto', label: t('ui.providers-schedule.task-acceptance-auto') },
                { value: 'user', label: t('ui.providers-schedule.task-acceptance-user') },
              ]}
              data-testid="task-edit-acceptance"
            />
          </label>
        </>
      )}
      <div className={styles.actionRow}>
        {savedNotice && (
          <span className={styles.savedTip} role="status">
            {t('ui.providers-schedule.task-saved-feedback')}
          </span>
        )}
        <Button
          size="sm"
          variant="secondary"
          disabled={busy || !title.trim() || !goal.trim()}
          onClick={handleSave}
          data-testid="task-save-rules"
        >
          {t('ui.providers-schedule.task-save-changes')}
        </Button>
      </div>
    </section>
  );
};

export interface TaskDetailProps {
  task: Task;
  queueInfo?: TaskQueueInfo;
  onClose: () => void;
  paneActions?: SubagentPaneActions;
  onSideExpandedChange?: (expanded: boolean) => void;
}

const TaskDetailInner: React.FC<TaskDetailProps> = ({
  task,
  queueInfo,
  onClose,
  paneActions,
  onSideExpandedChange,
}) => {
  const pane = useSubagentPane();
  const [attempts, setAttempts] = useState<Attempt[]>([]);
  const [journal, setJournal] = useState<JournalEntry[]>([]);
  const [pending, setPending] = useState<JournalEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [tab, setTab] = useState<DetailTab>('conversation');
  const [wide, setWide] = useState(false);
  const [sideWide, setSideWide] = useState(false);
  const [columnMessages, setColumnMessages] = useState<readonly ConvMessage[]>([]);
  const [goalExpanded, setGoalExpanded] = useState(false);
  const [savedNotice, setSavedNotice] = useState(false);
  const [seenTaskId, setSeenTaskId] = useState(task.id);
  if (seenTaskId !== task.id) {
    setSeenTaskId(task.id);
    setSavedNotice(false);
    setGoalExpanded(false);
    setSideWide(false);
  }

  const sideItems = useMemo(() => (pane ? sideTabItems(pane.tabs) : []), [pane]);
  const hasSide = sideItems.length > 0;
  const activeSideKind = pane?.active?.startsWith('trace:') ? 'trace' : 'agent';
  const effectiveSideWide = hasSide && sideWide;

  if (!hasSide && sideWide) {
    setSideWide(false);
  }

  useEffect(() => {
    onSideExpandedChange?.(effectiveSideWide);
    return () => onSideExpandedChange?.(false);
  }, [effectiveSideWide, onSideExpandedChange]);

  useEffect(() => {
    if (!pane) return;
    const dedupeKey = `task:${task.id}`;
    const tracePage = pane.pages.find((p) => p.kind === 'trace' && p.dedupeKey === dedupeKey);
    if (!tracePage || tracePage.kind !== 'trace') return;
    registerSideTrace(
      pane.scope,
      { kind: 'task', task, attempts, title: task.title || t('ui.devtools.session-trace') },
      tracePage.id,
    );
  }, [pane, task, attempts]);

  const isEvent = task.trigger.kind === 'event';
  const mode = task.trigger.kind === 'event' ? task.trigger.mode : null;
  const [events, setEvents] = useState<{
    observed: { key: string; summary: string; occurredAt: number }[];
    lastPollAt?: number;
    lastError?: string;
  } | null>(null);

  useEffect(() => {
    let live = true;
    const load = Promise.all([tasksApi.get(task.id), tasksApi.journal(task.id)]);
    void load
      .then(([r, j]) => {
        if (!live) return;
        setAttempts([...(r?.attempts ?? [])].reverse());
        setJournal([...j].reverse().slice(0, 50));
        const list = r?.attempts ?? [];
        const lastAttempt = list[list.length - 1];
        setPending(lastAttempt ? pendingExternal(j, lastAttempt.id) : []);
      })
      .catch(() => undefined);
    if (isEvent)
      void api.tasks
        .events({ id: task.id })
        .then((r) => live && setEvents(r as never))
        .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [task.id, task.updatedAt, isEvent]);

  const harnessTabs = useHarnessTabs();
  const last = attempts[0];
  const liveCliTab = (() => {
    const tid = attempts.find((a) => a.carrier?.tabId)?.carrier?.tabId;
    if (!tid) return null;
    return harnessTabs.state?.tabs?.find((x) => x.id === tid) ?? null;
  })();
  const liveCliTabId = liveCliTab?.id ?? null;

  const run = (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    void fn()
      .then((r) => {
        const res = r as { ok?: boolean; reason?: string } | undefined;
        if (res && res.ok === false)
          setError(t('ui.providers-schedule.task-action-rejected', res.reason ?? ''));
        setText('');
      })
      .catch((e) => setError(errText(e)))
      .finally(() => setBusy(false));
  };
  const confirmThen = async (message: string, fn: () => Promise<unknown>, danger = true) => {
    if (await confirmDialog({ message, danger })) run(fn);
  };

  const handleSaveRules = (patch: {
    title: string;
    goal: string;
    doneWhen?: string;
    acceptance?: 'auto' | 'user';
  }) => {
    setSavedNotice(false);
    run(async () => {
      await tasksApi.update({
        id: task.id,
        ...patch,
      });
      setSavedNotice(true);
    });
  };

  const id = task.id;
  const ended = ['done', 'failed', 'cancelled', 'expired'].includes(task.status);
  const ackable = canAckFailure(task);
  const archivable = canArchiveTask(task);
  const tone = statusToneOf(task);
  const doneWhen = task.executor.kind === 'notify' ? '' : (task.executor.brief?.doneWhen ?? '');
  const hasLongGoal = task.goal.length > 110 || task.goal.includes('\n') || Boolean(doneWhen);
  const hasLinks = Boolean(
    task.origin.conversationId ||
    liveCliTabId ||
    task.executor.kind !== 'notify' ||
    task.archivedAt != null ||
    archivable,
  );

  return (
    <div
      className={styles.detailGroup}
      data-wide={wide ? 'true' : undefined}
      data-has-side={hasSide ? 'true' : undefined}
      data-side-wide={effectiveSideWide ? 'true' : undefined}
      data-side-kind={hasSide ? activeSideKind : undefined}
    >
      <aside
        className={styles.detail}
        data-wide={wide ? 'true' : undefined}
        aria-label={task.title}
        data-testid="task-detail"
      >
        <div className={styles.detailTop}>
          <header className={styles.detailHead}>
            <h3 className={styles.detailTitle} title={task.title}>
              {task.title}
            </h3>
            <IconButton
              icon={<Icon icon={wide ? Minimize2 : Maximize2} size={14} />}
              label={t(
                wide
                  ? 'ui.providers-schedule.task-drawer-collapse'
                  : 'ui.providers-schedule.task-drawer-expand',
              )}
              size="sm"
              variant="ghost"
              onClick={() => setWide((w) => !w)}
              data-testid="task-detail-expand"
            />
            <IconButton
              icon={<Icon icon={X} size={14} />}
              label={t('ui.providers-schedule.close')}
              size="sm"
              variant="ghost"
              onClick={onClose}
              data-testid="task-detail-close"
            />
          </header>
          <div className={styles.detailMeta}>
            <span className={styles.statusBadge} data-tone={tone}>
              <span className={styles.statusDot} aria-hidden />
              {statusLabel(task)}
            </span>
            <OriginBadge task={task} />
            <LastRunBadge task={task} />
            <span className={styles.metaSep} aria-hidden>
              ·
            </span>
            <span className={styles.metaChip}>{executorLabel(task.executor)}</span>
            <span className={styles.metaSep} aria-hidden>
              ·
            </span>
            <span className={styles.metaChip}>{triggerLabel(task.trigger)}</span>
          </div>
          {hasLinks && (
            <div className={styles.detailLinks}>
              {task.origin.conversationId && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => requestOpenConversation(task.origin.conversationId!)}
                  data-testid="task-open-source-chat"
                >
                  <Icon icon={ExternalLink} size={12} />
                  {t('ui.providers-schedule.task-open-source-chat')}
                </Button>
              )}
              {liveCliTabId && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => pane?.openSubagent(liveCliTabId)}
                  data-testid="task-open-cli-tab"
                >
                  <Icon icon={ExternalLink} size={12} />
                  {t('ui.providers-schedule.task-open-cli-tab')}
                </Button>
              )}
              {task.executor.kind !== 'notify' && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => requestOpenFleet()}
                  data-testid="task-open-fleet"
                >
                  <Icon icon={ExternalLink} size={12} />
                  {t('ui.cli-monitor.fleet-board')}
                </Button>
              )}
              {task.executor.kind !== 'notify' &&
                (attempts.length > 0 || task.status === 'running') && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      const title = task.title || t('ui.devtools.session-trace');
                      pane?.openTrace(
                        { kind: 'task', task, attempts, title },
                        { dedupeKey: `task:${task.id}`, title },
                      );
                    }}
                    data-testid="task-open-trace"
                  >
                    <Icon icon={RouteIcon} size={12} />
                    {t('ui.devtools.session-trace')}
                  </Button>
                )}
              <div className={styles.detailLinksEnd}>
                {task.archivedAt != null && (
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={busy}
                    onClick={() => run(() => tasksApi.unarchive(id))}
                    data-testid="task-unarchive"
                  >
                    <Icon icon={ArchiveRestore} size={12} />
                    {t('ui.providers-schedule.task-unarchive')}
                  </Button>
                )}
                {archivable && (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => run(() => tasksApi.archive(id))}
                    data-testid="task-archive"
                  >
                    <Icon icon={Archive} size={12} />
                    {t('ui.cli-monitor.archive-chat')}
                  </Button>
                )}
              </div>
            </div>
          )}
        </div>

        {task.goal && (
          <section className={styles.goalCard} data-testid="task-detail-goal">
            <div className={styles.goalHead}>
              <span className={styles.goalLabel}>{t('ui.providers-schedule.task-goal')}</span>
              {hasLongGoal && (
                <button
                  type="button"
                  className={styles.goalToggle}
                  onClick={() => setGoalExpanded((v) => !v)}
                  data-testid="task-goal-toggle"
                >
                  {t(
                    goalExpanded
                      ? 'ui.knowledge-local.collapse'
                      : 'ui.knowledge-local.view-full-text',
                  )}
                </button>
              )}
            </div>
            <p className={styles.goalText} data-expanded={goalExpanded ? 'true' : undefined}>
              {task.goal}
            </p>
            {doneWhen && goalExpanded && (
              <p className={styles.goalDoneWhen}>
                {t('ui.providers-schedule.task-edit-done-when-label')}：{doneWhen}
              </p>
            )}
          </section>
        )}

        {/* Sticky 行动区：不放进滚动区内，有操作待处理时一眼看到；无待处理时靠 CSS :empty 自动隐藏 */}
        <div className={styles.detailAlerts}>
          <TaskSandboxRequests taskId={id} />
          {task.status === 'waiting_user' && task.wait && (
            <div className={styles.action} data-testid="task-needs-you">
              {task.wait.detail && <p className={styles.waitDetail}>{task.wait.detail}</p>}
              {task.wait.kind === 'input' && (
                <Textarea
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  aria-label={t('ui.providers-schedule.task-input-label')}
                  rows={2}
                />
              )}
              {task.wait.kind === 'grant' ? (
                <Button
                  variant="primary"
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    void confirmThen(
                      t(
                        'ui.providers-schedule.task-regrant-confirm',
                        t(LEVEL_LABEL[task.grant.level]),
                      ),
                      () =>
                        api.tasks.grant({
                          id,
                          grant: {
                            level: task.grant.level,
                            paths: task.grant.paths,
                            connections: task.grant.connections,
                            ...(task.grant.clis ? { clis: task.grant.clis } : {}),
                            ...(task.grant.autoJudge === false ? { autoJudge: false } : {}),
                          },
                        }),
                      false,
                    )
                  }
                  data-testid="task-regrant"
                >
                  {t('ui.providers-schedule.task-regrant')}
                </Button>
              ) : (
                <div className={styles.actionRow}>
                  <Button
                    variant="primary"
                    size="sm"
                    disabled={busy || (task.wait.kind === 'input' && !text.trim())}
                    onClick={() =>
                      run(() =>
                        api.tasks.decide({
                          id,
                          gen: task.gen,
                          ...(task.wait?.requestId ? { requestId: task.wait.requestId } : {}),
                          approve: true,
                          ...(text.trim() ? { input: text.trim() } : {}),
                        }),
                      )
                    }
                    data-testid="task-approve"
                  >
                    {task.wait.kind === 'taken_over'
                      ? t('ui.providers-schedule.task-mark-done')
                      : task.wait.kind === 'config'
                        ? t('ui.providers-schedule.task-config-retry')
                        : task.wait.kind === 'input'
                          ? t('ui.knowledge-local.send')
                          : t('ui.providers-schedule.task-approve')}
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={busy}
                    onClick={() =>
                      run(() =>
                        api.tasks.decide({
                          id,
                          gen: task.gen,
                          ...(task.wait?.requestId ? { requestId: task.wait.requestId } : {}),
                          approve: false,
                        }),
                      )
                    }
                    data-testid="task-deny"
                  >
                    {task.wait.kind === 'taken_over'
                      ? t('ui.providers-schedule.task-hand-back')
                      : task.wait.kind === 'config'
                        ? t('ui.providers-schedule.task-config-give-up')
                        : t('ui.chat-settings.deny')}
                  </Button>
                </div>
              )}
            </div>
          )}
          {task.status === 'awaiting_accept' && (
            <div className={styles.action} data-testid="task-accept-card">
              {last?.result?.summary && <p className={styles.result}>{last.result.summary}</p>}
              <Textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                aria-label={t('ui.providers-schedule.task-feedback-label')}
                placeholder={t('ui.providers-schedule.task-feedback-placeholder')}
                rows={2}
              />
              <div className={styles.actionRow}>
                <Button
                  size="sm"
                  variant="primary"
                  disabled={busy}
                  onClick={() => run(() => api.tasks.accept({ id }))}
                  data-testid="task-accept"
                >
                  {t('ui.providers-schedule.task-accept')}
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={busy || !text.trim()}
                  onClick={() => run(() => api.tasks.reject({ id, feedback: text.trim() }))}
                  data-testid="task-reject"
                >
                  {t('ui.providers-schedule.task-reject')}
                </Button>
                {last?.carrier?.worktree && last.carrier.sourceCwd && (
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={busy}
                    onClick={() =>
                      void (async () => {
                        if (
                          !(await confirmDialog({
                            message: t(
                              'ui.providers-schedule.task-apply-worktree-confirm',
                              last.carrier!.sourceCwd!,
                            ),
                          }))
                        )
                          return;
                        run(async () => {
                          const r = await api.tasks.applyWorktree({ id });
                          if (r)
                            setNotice(
                              [
                                t(
                                  'ui.providers-schedule.task-applied',
                                  r.applied.length,
                                  r.conflicted.length,
                                  r.denied.length,
                                ),
                                r.branch &&
                                  t('ui.providers-schedule.task-applied-branch', r.branch),
                              ]
                                .filter(Boolean)
                                .join(' · '),
                            );
                        });
                      })()
                    }
                    data-testid="task-apply-worktree"
                  >
                    {t('ui.providers-schedule.task-apply-worktree')}
                  </Button>
                )}
              </div>
              {notice && (
                <p className={styles.waitDetail} role="status">
                  {notice}
                </p>
              )}
            </div>
          )}
          {task.status === 'needs_reconcile' && (
            <div className={styles.action} data-testid="task-reconcile-card">
              <p className={styles.waitDetail}>{t('ui.providers-schedule.task-reconcile-hint')}</p>
              {pending.length > 0 && (
                <ul className={styles.journal} data-testid="task-reconcile-pending">
                  {pending.map((e) => (
                    <li key={e.seq}>
                      <time>{fmtDateTime(e.at)}</time> {e.summary ?? e.action}
                    </li>
                  ))}
                </ul>
              )}
              <div className={styles.actionRow}>
                <Button
                  size="sm"
                  variant="primary"
                  disabled={busy}
                  onClick={() => run(() => api.tasks.reconcile({ id, outcome: 'applied' }))}
                >
                  {t('ui.providers-schedule.task-reconcile-applied')}
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={busy}
                  onClick={() => run(() => api.tasks.reconcile({ id, outcome: 'not_applied' }))}
                >
                  {t('ui.providers-schedule.task-reconcile-not-applied')}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => run(() => api.tasks.reconcile({ id, outcome: 'abandon' }))}
                >
                  {t('ui.providers-schedule.task-reconcile-abandon')}
                </Button>
              </div>
            </div>
          )}
          {(task.status === 'failed' || task.status === 'expired') &&
            (ackable || Boolean(task.lastError)) && (
              <div className={styles.action} data-tone="danger" data-testid="task-failed-card">
                {task.lastError && <p className={styles.error}>{task.lastError.message}</p>}
                {ackable && (
                  <div className={styles.actionRow}>
                    <span className={styles.waitDetail}>
                      {t('ui.providers-schedule.task-ack-hint')}
                    </span>
                    <Button
                      size="sm"
                      variant="primary"
                      disabled={busy}
                      onClick={() => run(() => tasksApi.ack(id))}
                      data-testid="task-ack"
                    >
                      {t('ui.models.got-it')}
                    </Button>
                  </div>
                )}
              </div>
            )}
          {error && (
            <p className={styles.error} role="alert">
              {error}
            </p>
          )}
        </div>

        <div className={styles.detailTabsWrap}>
          <Tabs
            variant="underline"
            className={styles.detailTabs}
            items={[
              {
                value: 'conversation',
                label: t('ui.providers-schedule.task-tab-conversation'),
                testId: 'task-tab-conversation',
              },
              {
                value: 'settings',
                label: t('ui.providers-schedule.task-tab-settings'),
                testId: 'task-tab-settings',
              },
            ]}
            value={tab}
            onChange={(v) => setTab(v as DetailTab)}
            aria-label={t('ui.providers-schedule.tasks')}
          />
        </div>

        <div className={styles.detailConvHost} hidden={tab !== 'conversation'}>
          {tab === 'conversation' && (
            <TaskConversation
              task={task}
              attempts={attempts}
              queueInfo={queueInfo}
              onMessagesChange={setColumnMessages}
              onOpenProviders={paneActions?.openProviders}
            />
          )}
        </div>

        <div className={styles.detailBody} hidden={tab !== 'settings'}>
          <div className={styles.picks}>
            <Select
              size="sm"
              variant="ghost"
              className={styles.pick}
              value={task.priority ?? 'none'}
              disabled={busy}
              aria-label={t('ui.providers-schedule.task-priority')}
              onChange={(e) => {
                const v = e.target.value;
                run(() =>
                  api.tasks.update({ id, priority: v === 'none' ? null : (v as TaskPriority) }),
                );
              }}
              options={[
                { value: 'none', label: t('ui.providers-schedule.task-priority') },
                ...PRIORITIES.map((p) => ({ value: p, label: t(PRIORITY_LABEL[p]) })),
              ]}
              data-testid="task-priority"
            />
            <Select
              size="sm"
              variant="ghost"
              className={styles.pick}
              value={task.category ?? 'auto'}
              disabled={busy}
              aria-label={t('ui.providers-schedule.task-category')}
              onChange={(e) => {
                const v = e.target.value;
                run(() =>
                  api.tasks.update({ id, category: v === 'auto' ? null : (v as TaskCategory) }),
                );
              }}
              options={[
                { value: 'auto', label: t('ui.providers-schedule.task-category-auto') },
                ...CATEGORIES.map((c) => ({ value: c, label: t(CATEGORY_LABEL[c]) })),
              ]}
              data-testid="task-category"
            />
          </div>

          {task.executor.kind !== 'notify' && (
            <div className={styles.modelRow} data-testid="task-settings-model-row">
              <span className={styles.modelRowLabel}>{t('ui.foundation.model')}</span>
              <TaskModelSwitch
                task={task}
                liveTab={liveCliTab}
                placement="settings"
                onOpenProviders={paneActions?.openProviders}
              />
            </div>
          )}

          <TaskRulesEditor
            key={`${task.id}:${task.updatedAt}`}
            task={task}
            busy={busy}
            savedNotice={savedNotice}
            onSave={handleSaveRules}
          />

          {isEvent && events && (
            <section
              className={styles.action}
              aria-label={t('ui.providers-schedule.task-observed-title', events.observed.length)}
              data-testid="task-observed"
            >
              <h4 className={styles.detailTitle}>
                {t('ui.providers-schedule.task-observed-title', events.observed.length)}
              </h4>
              {!events.observed.length && (
                <p className={styles.waitDetail}>
                  {t('ui.providers-schedule.task-observed-empty')}
                </p>
              )}
              <ul className={styles.journal}>
                {events.observed.slice(-20).map((e) => (
                  <li key={e.key}>{e.summary}</li>
                ))}
              </ul>
              {events.lastPollAt && (
                <p className={styles.waitDetail}>
                  {t('ui.providers-schedule.task-last-poll', fmtDateTime(events.lastPollAt))}
                </p>
              )}
              {events.lastError && (
                <p className={styles.error}>
                  {t('ui.providers-schedule.task-poll-error', events.lastError)}
                </p>
              )}
              <div className={styles.actionRow}>
                {events.observed.length > 0 && (
                  <>
                    <Button
                      size="sm"
                      variant="primary"
                      disabled={busy}
                      onClick={() => run(() => api.tasks.processObserved({ id }))}
                      data-testid="task-process-observed"
                    >
                      {t('ui.providers-schedule.task-process-observed')}
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={busy}
                      onClick={() => run(() => api.tasks.clearObserved({ id }))}
                      data-testid="task-clear-observed"
                    >
                      {t('ui.providers-schedule.task-clear-observed')}
                    </Button>
                  </>
                )}
                {mode === 'observe' ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={busy}
                    onClick={() =>
                      void confirmThen(
                        t('ui.providers-schedule.task-mode-act-confirm'),
                        () => api.tasks.setMode({ id, mode: 'act' }),
                        false,
                      )
                    }
                    data-testid="task-mode-act"
                  >
                    {t('ui.providers-schedule.task-mode-act')}
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={busy}
                    onClick={() => run(() => api.tasks.setMode({ id, mode: 'observe' }))}
                    data-testid="task-mode-observe"
                  >
                    {t('ui.providers-schedule.task-mode-observe')}
                  </Button>
                )}
              </div>
            </section>
          )}

          <div className={styles.factsCard}>
            <dl className={styles.facts}>
              <dt>{t('ui.providers-schedule.task-goal')}</dt>
              <dd className={styles.goal}>{task.goal}</dd>
              <dt>{t('ui.providers-schedule.task-trigger')}</dt>
              <dd>
                {triggerLabel(task.trigger)}
                {task.nextRunAt && task.enabled && !ended
                  ? ` · ${t('ui.providers-schedule.task-next-run', fmtTime(task.nextRunAt))}`
                  : ''}
              </dd>
              <dt>{t('ui.providers-schedule.task-executor')}</dt>
              <dd>
                {executorLabel(task.executor)}
                {task.executor.kind === 'nomi' && task.executor.tools.length > 0
                  ? ` · ${task.executor.tools.map((x) => t(TOOL_LABEL[x])).join('、')}`
                  : ''}
              </dd>
              <dt>{t('ui.providers-schedule.task-grant')}</dt>
              <dd>
                {t(LEVEL_LABEL[task.grant.level])}
                {task.grant.clis?.length ? ` · ${task.grant.clis.join('、')}` : ''}
                {task.grant.level >= 3 && task.grant.autoJudge !== false
                  ? ` · ${t('ui.providers-schedule.task-auto-judge')}`
                  : ''}
                {task.grant.expiresAt
                  ? ` · ${t('ui.providers-schedule.task-grant-until', fmtTime(task.grant.expiresAt))}`
                  : ''}
                {task.grant.revokedAt ? ` · ${t('ui.providers-schedule.task-grant-revoked')}` : ''}
              </dd>
            </dl>
          </div>

          <div className={styles.actionRow}>
            {!ended &&
              task.status !== 'running' &&
              task.status !== 'queued' &&
              task.status !== 'waiting_user' && (
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={busy || !task.enabled}
                  onClick={() => run(() => api.tasks.runNow({ id }))}
                  data-testid="task-run-now"
                >
                  {t('ui.providers-schedule.run-now')}
                </Button>
              )}
            {ended && task.status !== 'expired' && (
              <Button
                size="sm"
                variant="secondary"
                disabled={busy}
                onClick={() => run(() => api.tasks.runNow({ id }))}
                data-testid="task-run-again"
              >
                {t('ui.providers-schedule.task-run-again')}
              </Button>
            )}
            {!ended &&
              (task.enabled ? (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => run(() => api.tasks.pause({ id }))}
                  data-testid="task-pause"
                >
                  {t('ui.providers-schedule.task-pause')}
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => run(() => api.tasks.resume({ id }))}
                  data-testid="task-resume"
                >
                  {t('ui.providers-schedule.task-resume')}
                </Button>
              ))}
            {!ended && !task.grant.revokedAt && (
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() =>
                  void confirmThen(t('ui.providers-schedule.task-revoke-confirm'), () =>
                    api.tasks.revoke({ id }),
                  )
                }
                data-testid="task-revoke"
              >
                {t('ui.foundation.revoke')}
              </Button>
            )}
            {!ended ? (
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() =>
                  void confirmThen(t('ui.providers-schedule.task-cancel-confirm'), () =>
                    api.tasks.cancel({ id }),
                  )
                }
                data-testid="task-cancel"
              >
                {t('ui.providers-schedule.task-cancel')}
              </Button>
            ) : (
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() =>
                  void confirmThen(t('ui.providers-schedule.task-remove-confirm'), async () => {
                    await api.tasks.remove({ id });
                    onClose();
                  })
                }
                data-testid="task-remove"
              >
                {t('ui.foundation.delete')}
              </Button>
            )}
          </div>

          <Disclosure
            summary={t('ui.providers-schedule.task-history', attempts.length)}
            defaultOpen={attempts.length > 0}
          >
            <ul className={styles.attempts} data-testid="task-attempts">
              {attempts.map((a) => (
                <li key={a.id} className={styles.attempt}>
                  <span className={styles.attemptHead}>
                    {fmtTime(a.startedAt)} · {attemptStatusLabel(a.status)}
                    {(a.usage?.inputTokens ?? 0) + (a.usage?.outputTokens ?? 0) > 0
                      ? ` · ${t(
                          'ui.providers-schedule.task-usage',
                          (a.usage?.inputTokens ?? 0) + (a.usage?.outputTokens ?? 0),
                          a.usage?.costKnown && a.usage?.costUsd !== undefined
                            ? `$${a.usage.costUsd.toFixed(4)}`
                            : t('ui.providers-schedule.task-cost-unknown'),
                        )}`
                      : ''}
                  </span>
                  {a.result?.summary && (
                    <span className={styles.attemptBody}>{a.result.summary}</span>
                  )}
                  {a.error && <span className={styles.attemptError}>{a.error.message}</span>}
                </li>
              ))}
            </ul>
          </Disclosure>
          <Disclosure summary={t('ui.providers-schedule.task-journal')}>
            <ul className={styles.journal} data-testid="task-journal">
              {journal.map((e, i) => (
                <li key={`${e.at}-${i}`}>
                  <time>{fmtTime(e.at)}</time>{' '}
                  {e.t === 'state' ? `${e.event}: ${e.from} → ${e.to}` : (e.msg ?? e.action ?? e.t)}
                </li>
              ))}
            </ul>
          </Disclosure>
        </div>
      </aside>
      <TaskSideDrawer
        columnMessages={columnMessages}
        paneActions={paneActions}
        wide={effectiveSideWide}
        onToggleWide={() => setSideWide((v) => !v)}
      />
    </div>
  );
};

export const TaskDetail: React.FC<TaskDetailProps> = (props) => (
  <ChangesUiProvider>
    <SubagentPaneProvider isolated scope={`task-detail:${props.task.id}`}>
      <SubagentOutboxProvider>
        <SessionDetailsProvider>
          <TaskDetailInner {...props} />
        </SessionDetailsProvider>
      </SubagentOutboxProvider>
    </SubagentPaneProvider>
  </ChangesUiProvider>
);
