/**
 * 任务看板：按进度（待开始 / 进行中 / 需要你 / 已结束）或按重要程度分列；
 * 排队中（queued）的任务置顶在「待开始」列的高亮「排队等待中」分区里，并透出具体等待原因与顺位。
 * 图标按钮不使用原生 title，只用 aria-label 或可见文案。
 */
import { isBuiltinCliId } from '@nomi-ai/cli-catalog';
import { Button, createLogger, Icon, IconButton, t } from '@nomi-ai/ui';
import {
  IconAlertTriangle as AlertTriangle,
  IconArchive as Archive,
  IconBell as Bell,
  IconBook2 as BookOpen,
  IconCalendarClock as CalendarClock,
  IconChevronDown as ChevronDown,
  IconChevronsUp as ChevronsUp,
  IconClock as Clock,
  IconCode as Code2,
  IconEqual as Equal,
  IconEye as Eye,
  IconListCheck as ListTodo,
  IconMinus as Minus,
  IconPlayerPause as Pause,
  IconEdit as PenLine,
  IconPlayerPlay as Play,
  IconRadar as Radar,
  type TablerIcon as IconGlyph,
} from '@tabler/icons-react';
import React, { useMemo } from 'react';

import { describeRepeat } from '../../services/desktopClient';
import {
  autoArchiveRemainingHours,
  CATEGORY_LABEL,
  categoryOf,
  executorLabel,
  fmtTime,
  formatQueueReason,
  isConversationBacked,
  isRecurringTask,
  isTerminalStatus,
  needsUserAttention,
  PRIORITIES,
  PRIORITY_LABEL,
  STAGE_LABEL,
  STAGES,
  stageOf,
  statusLabel,
  tasksApi,
  triggerLabel,
  type ExecutorSpec,
  type LegacyItem,
  type Task,
  type TaskCategory,
  type TaskPriority,
  type TaskQueueInfo,
  type TaskStage,
} from '../../services/tasksClient';
import { fmtAgo } from '../../utils/relativeTime';
import { EndpointIcon } from '../EndpointIcon';

import styles from './Board.module.css';

const log = createLogger('tasks-board');

export type BoardGroup = 'stage' | 'priority';

type PriorityKey = TaskPriority | 'none';
type ColumnKey = TaskStage | PriorityKey;

const PRIORITY_ICON: Record<PriorityKey, IconGlyph> = {
  urgent: AlertTriangle,
  high: ChevronsUp,
  medium: Equal,
  low: ChevronDown,
  none: Minus,
};

export const CATEGORY_ICON: Record<TaskCategory, IconGlyph> = {
  coding: Code2,
  review: Eye,
  research: BookOpen,
  writing: PenLine,
  monitor: Radar,
  chore: ListTodo,
};

/** 同一列里：排队中的在前（按队列顺位），其次按重要程度和最近更新时间 */
const PRIORITY_RANK: Record<PriorityKey, number> = {
  urgent: 0,
  high: 1,
  medium: 2,
  low: 3,
  none: 4,
};

export const PriorityBadge: React.FC<{ priority?: TaskPriority | undefined; quiet?: boolean }> = ({
  priority,
  quiet,
}) => {
  const key: PriorityKey = priority ?? 'none';
  return (
    <span className={styles.priority} data-priority={key} data-quiet={quiet || undefined}>
      <Icon icon={PRIORITY_ICON[key]} size={12} />
      {t(PRIORITY_LABEL[key])}
    </span>
  );
};

/** 执行者：agent 画它的图标，Nomi 画应用图标，只是提醒的画铃铛 */
export const ExecutorIcon: React.FC<{ ex: ExecutorSpec }> = ({ ex }) => {
  if (ex.kind === 'notify') return <Icon icon={Bell} size={14} />;
  if (ex.kind === 'nomi') return <EndpointIcon backend="nomi" size={16} decorative />;
  return <EndpointIcon backend={isBuiltinCliId(ex.cli) ? ex.cli : 'other'} size={16} decorative />;
};

/** 任务来源 / 性质徽章 */
export const OriginBadge: React.FC<{ task: Task }> = ({ task }) => {
  if (task.origin.via === 'delegate') {
    return (
      <span className={styles.badgeInfo} data-testid={`task-origin-${task.id}`}>
        {t('ui.cli-monitor.fleet-origin-conversation')}
      </span>
    );
  }
  if (task.origin.via === 'handoff') {
    return (
      <span className={styles.badgeInfo} data-testid={`task-origin-${task.id}`}>
        {t('ui.providers-schedule.task-origin-handoff')}
      </span>
    );
  }
  if (isRecurringTask(task)) {
    return (
      <span className={styles.badgeMuted} data-testid={`task-origin-${task.id}`}>
        {t('ui.providers-schedule.task-origin-recurring')}
      </span>
    );
  }
  return (
    <span className={styles.badgeMuted} data-testid={`task-origin-${task.id}`}>
      {t('ui.providers-schedule.task-origin-standalone')}
    </span>
  );
};

/** 持续自动化任务的上次执行结果徽章 */
export const LastRunBadge: React.FC<{ task: Task }> = ({ task }) => {
  if (!isRecurringTask(task) || !task.lastRunStatus) return null;
  const cls =
    task.lastRunStatus === 'succeeded'
      ? styles.badgeSuccess
      : task.lastRunStatus === 'failed'
        ? styles.badgeDanger
        : styles.badgeMuted;
  const key =
    task.lastRunStatus === 'succeeded'
      ? 'ui.providers-schedule.task-last-run-succeeded'
      : task.lastRunStatus === 'failed'
        ? 'ui.providers-schedule.task-last-run-failed'
        : 'ui.providers-schedule.task-last-run-cancelled';
  return <span className={cls}>{t(key)}</span>;
};

export function autoArchiveLabel(task: Task): string | null {
  const hours = autoArchiveRemainingHours(task);
  if (hours === null) return null;
  return hours <= 0
    ? t('ui.providers-schedule.task-auto-archive-soon')
    : t('ui.providers-schedule.task-auto-archive-hours', hours);
}

export function canAckFailure(task: Task): boolean {
  return (
    task.archivedAt == null &&
    (task.status === 'failed' || task.status === 'expired') &&
    !isConversationBacked(task) &&
    task.ackedAt == null
  );
}

export function canArchiveTask(task: Task): boolean {
  return task.archivedAt == null && isTerminalStatus(task.status) && !needsUserAttention(task);
}

/** 卡片上的快捷操作：只做不用再确认的 */
export function quickAction(
  task: Task,
): { icon: IconGlyph; label: string; run: () => Promise<unknown> } | null {
  const id = task.id;
  if (task.status === 'idle') {
    return task.enabled
      ? { icon: Play, label: t('ui.providers-schedule.run-now'), run: () => tasksApi.runNow(id) }
      : {
          icon: Play,
          label: t('ui.providers-schedule.task-resume'),
          run: () => tasksApi.resume(id),
        };
  }
  if ((task.status === 'running' || task.status === 'queued') && task.enabled) {
    return {
      icon: Pause,
      label: t('ui.providers-schedule.task-pause'),
      run: () => tasksApi.pause(id),
    };
  }
  return null;
}

const Card: React.FC<{
  task: Task;
  queueInfo?: TaskQueueInfo;
  group: BoardGroup;
  selected: boolean;
  onSelect: () => void;
}> = ({ task, queueInfo, group, selected, onSelect }) => {
  const stage = stageOf(task);
  const category = categoryOf(task);
  const next =
    task.nextRunAt && task.status === 'idle' && task.enabled
      ? t('ui.providers-schedule.task-next-run', fmtTime(task.nextRunAt))
      : '';
  const action = quickAction(task);
  const ackable = canAckFailure(task);
  const archivable = canArchiveTask(task);
  const archiveHint = autoArchiveLabel(task);

  // 已结束的收成紧凑卡片，展示归档倒计时与快捷归档操作
  if (stage === 'done') {
    return (
      <li className={styles.item}>
        <button
          type="button"
          className={styles.card}
          data-stage={stage}
          data-compact=""
          data-status={task.status}
          aria-current={selected ? 'true' : undefined}
          onClick={onSelect}
          data-testid={`board-card-${task.id}`}
        >
          <span className={styles.cardHead}>
            <span className={styles.tile} aria-hidden>
              <Icon icon={CATEGORY_ICON[category]} size={14} />
            </span>
            <span className={styles.cardTitle}>{task.title}</span>
            <span className={styles.pill} data-status={task.status}>
              {statusLabel(task)}
            </span>
          </span>
          {(archiveHint || task.origin.via) && (
            <span className={styles.cardSubRow}>
              <OriginBadge task={task} />
              {archiveHint && <span className={styles.archiveTimer}>{archiveHint}</span>}
            </span>
          )}
          <span className={styles.cardFoot} data-has-action={archivable ? '' : undefined}>
            <span className={styles.executor}>
              <ExecutorIcon ex={task.executor} />
              {executorLabel(task.executor)}
            </span>
            <span className={styles.ago}>{fmtAgo(task.endedAt ?? task.updatedAt)}</span>
          </span>
        </button>
        {archivable && (
          <IconButton
            size="sm"
            variant="ghost"
            className={styles.action}
            icon={<Icon icon={Archive} size={14} />}
            label={`${t('ui.cli-monitor.archive-chat')} · ${task.title}`}
            onClick={() => {
              void tasksApi.archive(task.id).catch((e: unknown) => log.warn('archive failed', e));
            }}
            data-testid={`board-archive-${task.id}`}
          />
        )}
      </li>
    );
  }

  // 按重要程度分列时，列已经说明了重要程度：卡片上改写进度
  const foot = group === 'priority' ? statusLabel(task) : next || statusLabel(task);
  return (
    <li className={styles.item}>
      <button
        type="button"
        className={styles.card}
        aria-current={selected ? 'true' : undefined}
        data-stage={stage}
        onClick={onSelect}
        data-testid={`board-card-${task.id}`}
      >
        <span className={styles.cardHead}>
          <span className={styles.tile} aria-hidden>
            <Icon icon={CATEGORY_ICON[category]} size={14} />
          </span>
          <span className={styles.cardTitle}>{task.title}</span>
          {group === 'stage' && task.priority && <PriorityBadge priority={task.priority} />}
        </span>
        {task.goal && task.goal !== task.title && (
          <span className={styles.cardGoal}>{task.goal}</span>
        )}
        {task.status === 'queued' && (
          <span className={styles.queueBanner} data-testid={`board-queue-${task.id}`}>
            {queueInfo && (
              <span className={styles.queuePos}>
                {t('ui.providers-schedule.task-queue-pos', queueInfo.position)}
              </span>
            )}
            <span>{queueInfo ? formatQueueReason(queueInfo) : t('ui.mascot-theme.queued')}</span>
          </span>
        )}
        {task.status === 'queued' && task.pending?.note && (
          <span className={styles.pendingNote}>
            {t('ui.providers-schedule.task-pending-note-prefix', task.pending.note)}
          </span>
        )}
        <span className={styles.cardMeta}>
          <span className={styles.tag}>{t(CATEGORY_LABEL[category])}</span>
          <OriginBadge task={task} />
          <LastRunBadge task={task} />
          <span className={styles.trigger}>{triggerLabel(task.trigger)}</span>
        </span>
        {stage === 'in_progress' && <span className={styles.track} aria-hidden />}
        <span className={styles.cardFoot} data-has-action={action || ackable ? '' : undefined}>
          <span className={styles.executor}>
            <ExecutorIcon ex={task.executor} />
            {executorLabel(task.executor)}
          </span>
          <span className={styles.cardStatus} title={foot}>
            {foot}
          </span>
        </span>
      </button>
      {action && (
        <IconButton
          size="sm"
          variant="secondary"
          className={styles.action}
          icon={<Icon icon={action.icon} size={14} />}
          label={`${action.label} · ${task.title}`}
          onClick={() => {
            void action.run().catch((e: unknown) => log.warn('quick action failed', e));
          }}
          data-testid={`board-action-${task.id}`}
        />
      )}
      {!action && ackable && (
        <Button
          size="sm"
          variant="secondary"
          className={styles.textAction}
          onClick={() => {
            void tasksApi.ack(task.id).catch((e: unknown) => log.warn('ack failed', e));
          }}
          data-testid={`board-ack-${task.id}`}
        >
          {t('ui.models.got-it')}
        </Button>
      )}
    </li>
  );
};

const LegacyBoardCard: React.FC<{ item: LegacyItem; onOpen?: () => void }> = ({
  item: x,
  onOpen,
}) => (
  <li className={styles.item}>
    <button
      type="button"
      className={styles.card}
      onClick={onOpen}
      data-testid={`board-legacy-${x.id}`}
    >
      <span className={styles.cardHead}>
        <span className={styles.tile} aria-hidden>
          <Icon icon={x.source === 'reminder' ? Bell : CalendarClock} size={14} />
        </span>
        <span className={styles.cardTitle}>{x.title}</span>
        <span className={styles.badgeMuted}>
          {x.enabled
            ? x.repeat
              ? describeRepeat(x.repeat)
              : t('ui.providers-schedule.task-once')
            : t('ui.providers-schedule.task-paused')}
        </span>
      </span>
      <span className={styles.cardFoot}>
        <span className={styles.executor}>
          {t(
            x.source === 'reminder'
              ? 'ui.foundation.reminders'
              : 'ui.providers-schedule.tasks-group-scheduled',
          )}
        </span>
        <span className={styles.cardStatus}>{x.nextRunAt ? fmtTime(x.nextRunAt) : ''}</span>
      </span>
    </button>
  </li>
);

export const TaskBoard: React.FC<{
  tasks: Task[];
  queue?: Record<string, TaskQueueInfo>;
  legacy?: LegacyItem[];
  group: BoardGroup;
  /** 按进度分列时只显示这些列（顶部的进度筛选）；不给就全显示 */
  stages?: readonly TaskStage[];
  selected: string | null;
  onSelect: (id: string) => void;
  onOpenSchedule?: () => void;
}> = ({ tasks, queue = {}, legacy = [], group, stages, selected, onSelect, onOpenSchedule }) => {
  const columns = useMemo(() => {
    const keys: ColumnKey[] = group === 'stage' ? [...(stages ?? STAGES)] : [...PRIORITIES, 'none'];
    const m = new Map<ColumnKey, Task[]>(keys.map((k) => [k, []]));
    for (const task of tasks) {
      const k: ColumnKey = group === 'stage' ? stageOf(task) : (task.priority ?? 'none');
      m.get(k)?.push(task);
    }
    for (const list of m.values())
      list.sort((a, b) => {
        const aq = a.status === 'queued' ? 0 : 1;
        const bq = b.status === 'queued' ? 0 : 1;
        if (aq !== bq) return aq - bq;
        if (aq === 0 && bq === 0) {
          const ap = queue[a.id]?.position ?? Number.MAX_SAFE_INTEGER;
          const bp = queue[b.id]?.position ?? Number.MAX_SAFE_INTEGER;
          if (ap !== bp) return ap - bp;
        }
        return (
          PRIORITY_RANK[a.priority ?? 'none'] - PRIORITY_RANK[b.priority ?? 'none'] ||
          b.updatedAt - a.updatedAt
        );
      });
    return keys.map((k) => ({ key: k, tasks: m.get(k)! }));
  }, [tasks, group, stages, queue]);

  return (
    <div
      className={styles.board}
      data-testid="tasks-board"
      data-group={group}
      data-single={columns.length === 1 ? '' : undefined}
    >
      {columns.map(({ key, tasks: list }) => {
        const label =
          group === 'stage'
            ? t(STAGE_LABEL[key as TaskStage])
            : t(PRIORITY_LABEL[key as PriorityKey]);
        const queuedInTodo =
          group === 'stage' && key === 'todo' ? list.filter((x) => x.status === 'queued') : [];
        const restInTodo =
          group === 'stage' && key === 'todo' ? list.filter((x) => x.status !== 'queued') : list;
        const showLegacyInCol = group === 'stage' && key === 'todo' && legacy.length > 0;
        const totalCount = list.length + (showLegacyInCol ? legacy.length : 0);

        return (
          <section
            key={key}
            className={styles.column}
            data-column={key}
            data-empty={totalCount ? undefined : true}
            aria-label={`${label} ${totalCount}`}
            data-testid={`board-column-${key}`}
          >
            <header className={styles.columnHead}>
              {group === 'stage' ? (
                <span className={styles.columnDot} data-column={key} aria-hidden />
              ) : (
                <span className={styles.columnIcon} data-column={key}>
                  <Icon icon={PRIORITY_ICON[key as PriorityKey]} size={14} />
                </span>
              )}
              <span className={styles.columnLabel}>{label}</span>
              <span className={styles.count}>{totalCount}</span>
            </header>
            <ul className={styles.cards}>
              {queuedInTodo.length > 0 && (
                <>
                  <li className={styles.queueGroupHead} data-testid="board-queued-group">
                    <Icon icon={Clock} size={13} />
                    {t('ui.providers-schedule.task-queued-group-title', queuedInTodo.length)}
                  </li>
                  {queuedInTodo.map((task) => (
                    <Card
                      key={task.id}
                      task={task}
                      queueInfo={queue[task.id]}
                      group={group}
                      selected={selected === task.id}
                      onSelect={() => onSelect(task.id)}
                    />
                  ))}
                  {restInTodo.length > 0 && (
                    <li className={styles.dividerHead}>
                      {t('ui.providers-schedule.task-waiting-trigger')}
                    </li>
                  )}
                </>
              )}
              {restInTodo.map((task) => (
                <Card
                  key={task.id}
                  task={task}
                  queueInfo={queue[task.id]}
                  group={group}
                  selected={selected === task.id}
                  onSelect={() => onSelect(task.id)}
                />
              ))}
              {showLegacyInCol &&
                legacy.map((x) => (
                  <LegacyBoardCard key={`${x.source}:${x.id}`} item={x} onOpen={onOpenSchedule} />
                ))}
              {!totalCount && (
                <li className={styles.columnEmpty}>
                  {t('ui.providers-schedule.task-board-empty')}
                </li>
              )}
            </ul>
          </section>
        );
      })}
    </div>
  );
};
