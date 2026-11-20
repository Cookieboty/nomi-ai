/**
 * 任务的列表视图：与 Agent 看板共用卡片质感，补齐排队原因、来源徽章、自动归档倒计时与归档列表动作。
 * 整张卡片点开右侧详情（卡片里铺一个透明按钮，快捷操作按钮叠在上面，不嵌套）。
 */
import { Button, createLogger, Icon, IconButton, t } from '@nomi-ai/ui';
import {
  IconArchive as Archive,
  IconArchiveOff as ArchiveRestore,
  IconBell as Bell,
  IconCalendarClock as CalendarClock,
  IconClock as Clock,
  IconPlayerPlay as Play,
  IconTrash as Trash2,
} from '@tabler/icons-react';
import React from 'react';

import { describeRepeat } from '../../services/desktopClient';
import {
  CATEGORY_LABEL,
  categoryOf,
  executorLabel,
  fmtTime,
  formatQueueReason,
  stageOf,
  statusLabel,
  tasksApi,
  triggerLabel,
  type LegacyItem,
  type Task,
  type TaskQueueInfo,
} from '../../services/tasksClient';
import { fmtAgo } from '../../utils/relativeTime';
import { confirmDialog } from '../ConfirmDialog';

import {
  autoArchiveLabel,
  canAckFailure,
  canArchiveTask,
  CATEGORY_ICON,
  ExecutorIcon,
  LastRunBadge,
  OriginBadge,
  PriorityBadge,
  quickAction,
} from './Board';
import boardStyles from './Board.module.css';
import styles from './TaskList.module.css';

const log = createLogger('tasks-list');

/** 状态色：与 Agent 看板同一套（进行中主题色、要你处理 / 暂停 warning、完成 success、出错 danger、其余中性） */
function toneOf(task: Task): string {
  switch (stageOf(task)) {
    case 'in_progress':
      return 'running';
    case 'needs_you':
      return task.status === 'failed' || task.status === 'expired' ? 'failed' : 'attention';
    case 'done':
      return task.status === 'done' ? 'done' : 'todo';
    default:
      return task.enabled ? 'todo' : 'paused';
  }
}

/** 状态条 */
function trackOf(task: Task): string {
  const tone = toneOf(task);
  return tone === 'done'
    ? 'done'
    : tone === 'paused'
      ? 'paused'
      : tone === 'running'
        ? 'running'
        : '';
}

const TaskCard: React.FC<{
  task: Task;
  queueInfo?: TaskQueueInfo;
  archivedMode?: boolean;
  selected: boolean;
  onSelect: () => void;
}> = ({ task, queueInfo, archivedMode, selected, onSelect }) => {
  const category = categoryOf(task);
  const tone = toneOf(task);
  const action = archivedMode ? null : quickAction(task);
  const ackable = !archivedMode && canAckFailure(task);
  const archivable = !archivedMode && canArchiveTask(task);
  const archiveHint = archivedMode ? null : autoArchiveLabel(task);
  const next =
    !archivedMode && task.nextRunAt && task.status === 'idle' && task.enabled
      ? t('ui.providers-schedule.task-next-run', fmtTime(task.nextRunAt))
      : '';

  const handleDeleteArchived = async () => {
    const ok = await confirmDialog({
      title: t('ui.providers-schedule.task-remove-confirm'),
      danger: true,
    });
    if (ok) {
      await tasksApi.remove(task.id).catch((e: unknown) => log.warn('remove failed', e));
    }
  };

  return (
    <li
      className={styles.card}
      data-tone={tone}
      data-column={stageOf(task) === 'done' ? 'done' : undefined}
      aria-current={selected ? 'true' : undefined}
    >
      <button
        type="button"
        className={styles.open}
        aria-label={task.title}
        aria-current={selected ? 'true' : undefined}
        onClick={onSelect}
        data-testid={`task-${task.id}`}
      />
      <div className={styles.cardHead}>
        <span className={styles.tile} aria-hidden>
          <Icon icon={CATEGORY_ICON[category]} size={18} />
        </span>
        <span className={styles.name}>{t(CATEGORY_LABEL[category])}</span>
        <span className={styles.status} data-tone={tone}>
          <span className={styles.dot} aria-hidden />
          {statusLabel(task)}
        </span>
        <span className={styles.headSpacer} />
        {archivedMode ? (
          <span className={`${styles.above} ${styles.actionsInline}`}>
            <IconButton
              size="sm"
              variant="ghost"
              icon={<Icon icon={ArchiveRestore} size={14} />}
              label={`${t('ui.providers-schedule.task-unarchive')} · ${task.title}`}
              onClick={() => {
                void tasksApi
                  .unarchive(task.id)
                  .catch((e: unknown) => log.warn('unarchive failed', e));
              }}
              data-testid={`list-unarchive-${task.id}`}
            />
            <IconButton
              size="sm"
              variant="ghost"
              icon={<Icon icon={Play} size={14} />}
              label={`${t('ui.providers-schedule.task-run-again')} · ${task.title}`}
              onClick={() => {
                void tasksApi.runNow(task.id).catch((e: unknown) => log.warn('runNow failed', e));
              }}
              data-testid={`list-rerun-${task.id}`}
            />
            <IconButton
              size="sm"
              variant="ghost"
              icon={<Icon icon={Trash2} size={14} />}
              label={`${t('ui.foundation.delete')} · ${task.title}`}
              onClick={() => {
                void handleDeleteArchived();
              }}
              data-testid={`list-delete-${task.id}`}
            />
          </span>
        ) : (
          <span className={`${styles.above} ${styles.actionsInline}`}>
            {ackable && (
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  void tasksApi.ack(task.id).catch((e: unknown) => log.warn('ack failed', e));
                }}
                data-testid={`list-ack-${task.id}`}
              >
                {t('ui.models.got-it')}
              </Button>
            )}
            {archivable && (
              <IconButton
                size="sm"
                variant="ghost"
                icon={<Icon icon={Archive} size={14} />}
                label={`${t('ui.cli-monitor.archive-chat')} · ${task.title}`}
                onClick={() => {
                  void tasksApi
                    .archive(task.id)
                    .catch((e: unknown) => log.warn('archive failed', e));
                }}
                data-testid={`list-archive-${task.id}`}
              />
            )}
            {action && (
              <IconButton
                size="sm"
                variant="ghost"
                icon={<Icon icon={action.icon} size={14} />}
                label={`${action.label} · ${task.title}`}
                onClick={() => {
                  void action.run().catch((e: unknown) => log.warn('quick action failed', e));
                }}
                data-testid={`list-action-${task.id}`}
              />
            )}
          </span>
        )}
      </div>
      <span className={styles.title} title={task.title}>
        {task.title}
      </span>
      {task.goal && task.goal !== task.title && <span className={styles.summary}>{task.goal}</span>}
      {!archivedMode && task.status === 'queued' && (
        <span className={styles.queueBanner} data-testid={`list-queue-${task.id}`}>
          {queueInfo && (
            <span className={boardStyles.queuePos}>
              {t('ui.providers-schedule.task-queue-pos', queueInfo.position)}
            </span>
          )}
          <span>{queueInfo ? formatQueueReason(queueInfo) : t('ui.mascot-theme.queued')}</span>
        </span>
      )}
      {!archivedMode && task.status === 'queued' && task.pending?.note && (
        <span className={styles.pendingNote}>
          {t('ui.providers-schedule.task-pending-note-prefix', task.pending.note)}
        </span>
      )}
      <span className={styles.meta}>
        <span className={styles.metaItem}>
          <ExecutorIcon ex={task.executor} />
          {executorLabel(task.executor)}
        </span>
        {task.priority && <PriorityBadge priority={task.priority} />}
        <span className={styles.metaItem}>{triggerLabel(task.trigger)}</span>
      </span>
      <span className={styles.badgesRow}>
        <OriginBadge task={task} />
        <LastRunBadge task={task} />
        {archivedMode && (
          <span className={boardStyles.badgeMuted}>
            {task.archiveReason === 'auto_24h'
              ? t('ui.providers-schedule.task-archived-auto-badge')
              : t('ui.providers-schedule.task-archived-manual-badge')}
          </span>
        )}
        {archiveHint && <span className={boardStyles.archiveTimer}>{archiveHint}</span>}
      </span>
      <span className={styles.track} data-column={trackOf(task) || undefined} aria-hidden />
      <span className={styles.foot}>
        <span className={styles.updated}>
          {t('ui.cli-monitor.fleet-updated', fmtAgo(task.archivedAt ?? task.updatedAt))}
        </span>
        {next && (
          <span className={styles.usage}>
            <span className={styles.usageItem}>
              <Icon icon={Clock} size={12} />
              {next}
            </span>
          </span>
        )}
      </span>
    </li>
  );
};

const LegacyCard: React.FC<{ item: LegacyItem; onOpen?: () => void }> = ({ item: x, onOpen }) => (
  <li className={styles.card} data-tone={x.enabled ? 'todo' : 'paused'}>
    <button
      type="button"
      className={styles.open}
      aria-label={x.title}
      onClick={onOpen}
      data-testid={`legacy-${x.id}`}
    />
    <div className={styles.cardHead}>
      <span className={styles.tile} aria-hidden>
        <Icon icon={x.source === 'reminder' ? Bell : CalendarClock} size={18} />
      </span>
      <span className={styles.name}>
        {t(
          x.source === 'reminder'
            ? 'ui.foundation.reminders'
            : 'ui.providers-schedule.tasks-group-scheduled',
        )}
      </span>
      <span className={styles.status} data-tone={x.enabled ? 'todo' : 'paused'}>
        <span className={styles.dot} aria-hidden />
        {x.enabled
          ? x.repeat
            ? describeRepeat(x.repeat)
            : t('ui.providers-schedule.task-once')
          : t('ui.providers-schedule.task-paused')}
      </span>
    </div>
    <span className={styles.title} title={x.title}>
      {x.title}
    </span>
    <span className={styles.track} data-column={x.enabled ? undefined : 'paused'} aria-hidden />
    <span className={styles.foot}>
      <span className={styles.updated}>
        {x.nextRunAt ? t('ui.providers-schedule.task-next-run', fmtTime(x.nextRunAt)) : ''}
      </span>
    </span>
  </li>
);

export const TaskList: React.FC<{
  tasks: Task[];
  legacy: LegacyItem[];
  queue?: Record<string, TaskQueueInfo>;
  archivedMode?: boolean;
  selected: string | null;
  onSelect: (id: string) => void;
  onOpenSchedule?: () => void;
  empty: string;
}> = ({ tasks, legacy, queue = {}, archivedMode, selected, onSelect, onOpenSchedule, empty }) => {
  if (!tasks.length && !legacy.length) {
    return (
      <div className={styles.panel}>
        <p className={styles.empty} data-testid="tasks-empty">
          {empty}
        </p>
      </div>
    );
  }
  return (
    <div className={styles.panel}>
      <ul className={styles.grid}>
        {tasks.map((task) => (
          <TaskCard
            key={task.id}
            task={task}
            queueInfo={queue[task.id]}
            archivedMode={archivedMode}
            selected={selected === task.id}
            onSelect={() => onSelect(task.id)}
          />
        ))}
        {legacy.map((x) => (
          <LegacyCard key={`${x.source}:${x.id}`} item={x} onOpen={onOpenSchedule} />
        ))}
      </ul>
    </div>
  );
};
