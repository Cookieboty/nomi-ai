/**
 * 任务详情页里的「进度与对话」视图：
 * - Nomi 任务复用 tasks.trace + tasks.live（与 SubagentPane 同一套消息投影）；
 * - CLI 任务优先接入仍存活的 agent 标签流，标签退出后清晰回放历史执行回合、产出与改动文件；
 * - 底部输入区随任务当前状态自动切分：running → 插话（steer）；queued → 追加本次要求；
 *   awaiting_accept → 退回重做；终态 / 空闲 / 已归档 → 追问再跑（持续任务可选同步更新长期目标）。
 */
import { Button, Icon, t } from '@nomi-ai/ui';
import { IconClock as Clock, IconSend as Send } from '@tabler/icons-react';
import React, { useEffect, useMemo, useState } from 'react';

import { useHarnessTabMessages, useHarnessTabs } from '../../contexts/HarnessTabsContext';
import {
  attemptStatusLabel,
  formatQueueReason,
  isRecurringTask,
  tasksApi,
  type Attempt,
  type Task,
  type TaskLivePayload,
  type TaskQueueInfo,
  type TaskTraceView,
} from '../../services/tasksClient';
import type { ConvLive, ConvMessage } from '../../types/conversation';
import { fromHarnessMessage } from '../../utils/convAdapters';
import { ConversationView } from '../Conversation';
import { CliConversation } from '../Conversation/CliConversation';
import { nomiTraceSlots, traceActions } from '../Conversation/TraceAction';
import {
  applyTaskLiveEvent,
  liveFromView,
  nomiTaskMessages,
  type NomiTaskLive,
} from '../SubagentPane/project';

import styles from './TaskConversation.module.css';
import { TaskModelSwitch } from './TaskModelSwitch';

const EMPTY_MESSAGES: readonly ConvMessage[] = [];

type InputMode = 'steer' | 'append' | 'reject' | 'followup' | 'none';

function resolveInputMode(task: Task): InputMode {
  if (task.executor.kind === 'notify') return 'none';
  if (task.archivedAt != null) return 'followup';
  switch (task.status) {
    case 'running':
      return 'steer';
    case 'queued':
      return 'append';
    case 'awaiting_accept':
      return 'reject';
    case 'waiting_user':
    case 'needs_reconcile':
      return 'none';
    default:
      return 'followup';
  }
}

function cliAttemptsToMessages(attempts: readonly Attempt[]): ConvMessage[] {
  if (attempts.length === 0) return [];
  const asc = [...attempts].reverse();
  const out: ConvMessage[] = [];
  asc.forEach((a, idx) => {
    if ((a.cause.kind === 'followup' || a.cause.kind === 'rework') && a.cause.note) {
      out.push({
        id: `cli-attempt-user-${a.id}`,
        role: 'user',
        text: a.cause.note,
        at: a.startedAt,
      });
    }
    const files = (a.result?.artifacts ?? [])
      .filter((x) => x.kind === 'file' && x.ref)
      .map((x) => x.ref);
    const parts: string[] = [];
    if (a.result?.summary) parts.push(a.result.summary);
    if (files.length > 0) {
      parts.push(
        `${t('ui.providers-schedule.task-changed-files', files.length)}\n${files.map((f) => `- ${f}`).join('\n')}`,
      );
    }
    const statusText = t(
      'ui.providers-schedule.task-run-status-label',
      idx + 1,
      attemptStatusLabel(a.status),
    );
    out.push({
      id: `cli-attempt-ai-${a.id}`,
      role: 'assistant',
      text: parts.length > 0 ? parts.join('\n\n') : statusText,
      at: a.endedAt ?? a.startedAt,
      ...(a.error?.message ? { error: a.error.message } : {}),
      ...(a.status === 'cancelled' ? { stopped: true } : {}),
    });
  });
  return out;
}

export const TaskConversation: React.FC<{
  task: Task;
  attempts: Attempt[];
  queueInfo?: TaskQueueInfo;
  onMessagesChange?: (messages: readonly ConvMessage[]) => void;
  onOpenProviders?: () => void;
}> = ({ task, attempts, queueInfo, onMessagesChange, onOpenProviders }) => {
  const isNomi = task.executor.kind === 'nomi';
  const isCli = task.executor.kind === 'cli';

  // --- Nomi 实时轨迹状态 ---
  const [traceView, setTraceView] = useState<TaskTraceView | null>(null);
  const [nomiLive, setNomiLive] = useState<NomiTaskLive | null>(null);
  useEffect(() => {
    if (!isNomi) return;
    let alive = true;
    let timer: number | undefined;
    const load = () => {
      void tasksApi
        .trace(task.id)
        .then((v) => {
          if (!alive || !v) return;
          setTraceView(v);
          setNomiLive(liveFromView(v));
        })
        .catch(() => undefined);
    };
    const schedule = () => {
      if (timer !== undefined) return;
      timer = window.setTimeout(() => {
        timer = undefined;
        load();
      }, 120);
    };
    load();
    const offChange = tasksApi.onChange(schedule);
    const offLive = tasksApi.onLive((p: TaskLivePayload) => {
      if (p.id !== task.id) return;
      setNomiLive((prev) => applyTaskLiveEvent(prev, p.attemptId, p.event));
      if (p.event.type === 'done' || (p.event.type === 'tool' && p.event.status !== 'start')) {
        schedule();
      }
    });
    return () => {
      alive = false;
      offChange();
      offLive();
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [task.id, task.updatedAt, isNomi]);

  const nomiMessages = useMemo(() => {
    if (!isNomi) return [];
    const list = nomiTaskMessages(
      task.goal,
      traceView ?? { attemptId: null, lines: [] },
      nomiLive?.attemptId,
    );
    // 尚未运行任何尝试前只留目标与空提示
    if (!traceView?.attempts?.length && !nomiLive && !attempts.length) return [];
    return list;
  }, [isNomi, task.goal, traceView, nomiLive, attempts.length]);

  const convLive = useMemo<ConvLive | null>(
    () =>
      nomiLive
        ? {
            text: nomiLive.text,
            trace: nomiLive.trace,
            startedAt: nomiLive.startedAt,
            ...(nomiLive.text || nomiLive.trace.length ? { firstEventAt: nomiLive.startedAt } : {}),
          }
        : null,
    [nomiLive],
  );

  // --- CLI 标签实时视图 / 历史回放 ---
  const harnessTabs = useHarnessTabs();
  const latestTabId = useMemo(
    () => attempts.find((a) => a.carrier?.tabId)?.carrier?.tabId ?? null,
    [attempts],
  );
  const liveTab = useMemo(
    () =>
      isCli && latestTabId
        ? (harnessTabs.state?.tabs?.find((x) => x.id === latestTabId) ?? null)
        : null,
    [isCli, latestTabId, harnessTabs.state?.tabs],
  );
  const rawTabMsgs = useHarnessTabMessages(liveTab?.id ?? null);
  const cliLiveMessages = useMemo(() => {
    if (!liveTab) return [];
    const backend = liveTab.backend;
    return rawTabMsgs.map((m) => fromHarnessMessage(m, backend));
  }, [liveTab, rawTabMsgs]);
  const cliFallbackMessages = useMemo(
    () => (isCli ? cliAttemptsToMessages(attempts) : []),
    [isCli, attempts],
  );
  const cliTraceSlots = useMemo(
    () => (liveTab ? traceActions({ kind: 'cli', tabId: liveTab.id }) : undefined),
    [liveTab],
  );

  // --- 输入区与状态控制 ---
  const mode = resolveInputMode(task);
  const recurring = isRecurringTask(task);
  const [draft, setDraft] = useState('');
  const [syncGoal, setSyncGoal] = useState(false);
  const [sending, setSending] = useState(false);
  const [feedbackErr, setFeedbackErr] = useState<string | null>(null);

  const placeholder =
    mode === 'steer'
      ? t('ui.providers-schedule.task-conv-placeholder-running')
      : mode === 'append'
        ? t('ui.providers-schedule.task-conv-placeholder-queued')
        : mode === 'reject'
          ? t('ui.providers-schedule.task-conv-placeholder-accept')
          : t('ui.providers-schedule.task-conv-placeholder-followup');

  const sendLabel =
    mode === 'steer'
      ? t('ui.providers-schedule.task-conv-send-steer')
      : mode === 'append'
        ? t('ui.providers-schedule.task-conv-send-append')
        : mode === 'reject'
          ? t('ui.providers-schedule.task-conv-send-reject')
          : t('ui.providers-schedule.task-conv-send-followup');

  const handleSend = async () => {
    const body = draft.trim();
    if (!body || sending || mode === 'none') return;
    setSending(true);
    setFeedbackErr(null);
    try {
      if (mode === 'steer') {
        const ok = await tasksApi.steer(task.id, body);
        if (!ok) {
          setFeedbackErr(t('ui.providers-schedule.task-conv-steer-failed'));
          return;
        }
        setDraft('');
      } else if (mode === 'append') {
        const res = await tasksApi.appendQueued(task.id, body);
        if (!res.ok) {
          setFeedbackErr(t('ui.providers-schedule.task-action-rejected', res.reason ?? ''));
          return;
        }
        setDraft('');
      } else if (mode === 'reject') {
        const res = (await tasksApi.reject(task.id, body)) as { ok?: boolean; reason?: string };
        if (res?.ok === false) {
          setFeedbackErr(t('ui.providers-schedule.task-action-rejected', res.reason ?? ''));
          return;
        }
        setDraft('');
      } else {
        const res = await tasksApi.followUp(task.id, body, undefined, recurring && syncGoal);
        if (!res.ok) {
          setFeedbackErr(t('ui.providers-schedule.task-action-rejected', res.reason ?? ''));
          return;
        }
        setDraft('');
      }
    } catch (e) {
      setFeedbackErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  };

  const hasLiveCliStream = !!(liveTab && cliLiveMessages.length > 0);
  const currentMessages = isNomi
    ? nomiMessages
    : isCli
      ? hasLiveCliStream
        ? cliLiveMessages
        : cliFallbackMessages
      : EMPTY_MESSAGES;
  useEffect(() => {
    onMessagesChange?.(currentMessages);
  }, [onMessagesChange, currentMessages]);
  const showEmpty = isNomi
    ? nomiMessages.length === 0 && !convLive
    : isCli
      ? !hasLiveCliStream && cliFallbackMessages.length === 0
      : true;

  return (
    <div className={styles.root} data-testid="task-conversation">
      <div className={styles.streamHost}>
        {isNomi && !showEmpty && (
          <ConversationView
            scopeId={`task-detail:${task.id}`}
            messages={nomiMessages}
            live={convLive}
            phase={task.status === 'running' ? 'running' : 'idle'}
            slots={nomiTraceSlots}
          />
        )}
        {isCli && hasLiveCliStream && liveTab && (
          <CliConversation
            scopeId={liveTab.id}
            messages={cliLiveMessages}
            phase={liveTab.status === 'running' ? 'running' : 'idle'}
            slots={cliTraceSlots}
          />
        )}
        {isCli && !hasLiveCliStream && cliFallbackMessages.length > 0 && (
          <ConversationView
            scopeId={`task-detail-cli:${task.id}`}
            messages={cliFallbackMessages}
            phase="idle"
          />
        )}
        {showEmpty && (
          <p className={styles.empty} data-testid="task-conv-empty">
            {task.executor.kind === 'notify'
              ? t('ui.providers-schedule.task-conv-notify-hint')
              : t('ui.providers-schedule.task-conv-empty')}
          </p>
        )}
      </div>

      {task.status === 'queued' && (
        <div className={styles.queueCard} data-testid="task-detail-queue">
          <div className={styles.queueTitle}>
            <Icon icon={Clock} size={13} />
            {queueInfo ? (
              <span>
                {t('ui.providers-schedule.task-queue-pos', queueInfo.position)} ·{' '}
                {formatQueueReason(queueInfo)}
              </span>
            ) : (
              <span>{t('ui.mascot-theme.queued')}</span>
            )}
          </div>
          {task.pending?.note && (
            <div className={styles.queueNote}>
              {t('ui.providers-schedule.task-pending-note-prefix', task.pending.note)}
            </div>
          )}
        </div>
      )}

      {mode !== 'none' && (
        <div className={styles.composer} data-testid="task-conv-composer" data-mode={mode}>
          {recurring && mode === 'followup' && (
            <div className={styles.modeRow} data-testid="task-conv-goal-mode">
              <button
                type="button"
                className={styles.modeBtn}
                aria-pressed={!syncGoal}
                onClick={() => setSyncGoal(false)}
                data-testid="task-goal-mode-once"
              >
                {t('ui.providers-schedule.task-conv-goal-mode-once')}
              </button>
              <button
                type="button"
                className={styles.modeBtn}
                aria-pressed={syncGoal}
                onClick={() => setSyncGoal(true)}
                data-testid="task-goal-mode-sync"
              >
                {t('ui.providers-schedule.task-conv-goal-mode-sync')}
              </button>
            </div>
          )}
          <textarea
            className={styles.input}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void handleSend();
              }
            }}
            placeholder={placeholder}
            aria-label={placeholder}
            disabled={sending}
            data-testid="task-conv-input"
          />
          <div className={styles.composerBar}>
            <div className={styles.composerModel}>
              <TaskModelSwitch
                task={task}
                liveTab={liveTab}
                placement="composer"
                onOpenProviders={onOpenProviders}
              />
            </div>
            <Button
              size="ms"
              variant="primary"
              disabled={sending || !draft.trim()}
              onClick={() => {
                void handleSend();
              }}
              data-testid="task-conv-send"
            >
              <Icon icon={Send} size={13} />
              {sendLabel}
            </Button>
          </div>
          {feedbackErr && (
            <p className={styles.error} role="alert" data-testid="task-conv-error">
              {feedbackErr}
            </p>
          )}
        </div>
      )}
    </div>
  );
};
