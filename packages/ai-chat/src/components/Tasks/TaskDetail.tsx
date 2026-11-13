/**
 * 任务详情（右侧）：目标、触发、执行者、授权、预算、执行历史；按状态给出唯一明确的动作（批准、补充、验收、核对），
 * 以及立即运行、暂停 / 恢复、取消、撤销授权、删除。撤销、取消、删除先用应用内确认框确认。
 */
import { Button, Disclosure, Icon, IconButton, Select, t, Textarea } from '@nomi-ai/ui';
import { X } from 'lucide-react';
import React, { useEffect, useState } from 'react';

import { api } from '../../services/api';
import {
  attemptStatusLabel,
  CATEGORIES,
  CATEGORY_LABEL,
  categoryOf,
  executorLabel,
  fmtDateTime,
  fmtTime,
  LEVEL_LABEL,
  pendingExternal,
  PRIORITIES,
  PRIORITY_LABEL,
  statusLabel,
  tasksApi,
  TOOL_LABEL,
  triggerLabel,
  type Attempt,
  type JournalEntry,
  type Task,
  type TaskCategory,
  type TaskPriority,
} from '../../services/tasksClient';
import { confirmDialog } from '../ConfirmDialog';
import { TaskSandboxRequests } from '../Conversation/SandboxRequests';

import styles from './index.module.css';

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export const TaskDetail: React.FC<{ task: Task; onClose: () => void }> = ({ task, onClose }) => {
  const [attempts, setAttempts] = useState<Attempt[]>([]);
  const [journal, setJournal] = useState<JournalEntry[]>([]);
  const [pending, setPending] = useState<JournalEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
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
    void load.then(([r, j]) => {
      if (!live) return;
      setAttempts([...(r?.attempts ?? [])].reverse());
      setJournal([...j].reverse().slice(0, 50));
      const list = r?.attempts ?? [];
      const last = list[list.length - 1];
      setPending(last ? pendingExternal(j, last.id) : []);
    });
    if (isEvent)
      void api.tasks
        .events({ id: task.id })
        .then((r) => live && setEvents(r as never))
        .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [task.id, task.updatedAt, isEvent]);

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

  const id = task.id;
  const last = attempts[0];
  const ended = ['done', 'failed', 'cancelled', 'expired'].includes(task.status);

  return (
    <aside className={styles.detail} aria-label={task.title} data-testid="task-detail">
      <header className={styles.detailHead}>
        <h3 className={styles.detailTitle}>{task.title}</h3>
        <IconButton
          size="sm"
          label={t('ui.providers-schedule.close')}
          icon={<Icon icon={X} size={14} />}
          onClick={onClose}
          data-testid="task-detail-close"
        />
      </header>
      <p className={styles.status} data-testid="task-status">
        {statusLabel(task)}
      </p>
      <div className={styles.picks}>
        <Select
          size="sm"
          variant="ghost"
          className={styles.pick}
          value={task.priority ?? 'none'}
          onChange={(e) => {
            const v = e.target.value;
            run(() =>
              api.tasks.update({ id, priority: v === 'none' ? null : (v as TaskPriority) }),
            );
          }}
          aria-label={t('ui.providers-schedule.task-priority')}
          options={[...PRIORITIES, 'none' as const].map((p) => ({
            value: p,
            label: t(PRIORITY_LABEL[p]),
          }))}
          data-testid="task-priority"
        />
        <Select
          size="sm"
          variant="ghost"
          className={styles.pick}
          value={categoryOf(task)}
          onChange={(e) =>
            run(() => api.tasks.update({ id, category: e.target.value as TaskCategory }))
          }
          aria-label={t('ui.providers-schedule.task-category')}
          options={CATEGORIES.map((c) => ({ value: c, label: t(CATEGORY_LABEL[c]) }))}
          data-testid="task-category"
        />
      </div>

      {/* 编程助手被沙箱挡下：在这里直接授权（本会话 / 这个项目始终 / 不允许） */}
      <TaskSandboxRequests taskId={task.id} />

      {/* 需要你：每种情况只给一个明确的动作 */}
      {task.status === 'waiting_user' && task.wait && (
        <div className={styles.action} data-testid="task-needs-you">
          {task.wait.detail && <p className={styles.waitDetail}>{task.wait.detail}</p>}
          {task.wait.kind === 'input' && (
            <Textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              aria-label={t('ui.providers-schedule.task-input-label')}
              rows={3}
            />
          )}
          {task.wait.kind === 'grant' ? (
            <Button
              variant="primary"
              size="sm"
              disabled={busy}
              onClick={() =>
                void confirmThen(
                  t('ui.providers-schedule.task-regrant-confirm', t(LEVEL_LABEL[task.grant.level])),
                  () =>
                    api.tasks.grant({
                      id,
                      grant: {
                        level: task.grant.level,
                        paths: task.grant.paths,
                        connections: task.grant.connections,
                        ...(task.grant.clis ? { clis: task.grant.clis } : {}),
                        ...(task.grant.autoJudge ? { autoJudge: true } : {}),
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
                            r.branch && t('ui.providers-schedule.task-applied-branch', r.branch),
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
      {(task.status === 'failed' || task.status === 'expired') && task.lastError && (
        <p className={styles.error}>{task.lastError.message}</p>
      )}
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}

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
            <p className={styles.waitDetail}>{t('ui.providers-schedule.task-observed-empty')}</p>
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
          {task.grant.autoJudge ? ` · ${t('ui.providers-schedule.task-auto-judge')}` : ''}
          {task.grant.expiresAt
            ? ` · ${t('ui.providers-schedule.task-grant-until', fmtTime(task.grant.expiresAt))}`
            : ''}
          {task.grant.revokedAt ? ` · ${t('ui.providers-schedule.task-grant-revoked')}` : ''}
        </dd>
      </dl>

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
                {a.usage.inputTokens + a.usage.outputTokens > 0
                  ? ` · ${t(
                      'ui.providers-schedule.task-usage',
                      a.usage.inputTokens + a.usage.outputTokens,
                      a.usage.costKnown && a.usage.costUsd !== undefined
                        ? `$${a.usage.costUsd.toFixed(4)}`
                        : t('ui.providers-schedule.task-cost-unknown'),
                    )}`
                  : ''}
              </span>
              {a.result?.summary && <span className={styles.attemptBody}>{a.result.summary}</span>}
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
    </aside>
  );
};
