/**
 * 任务看板：按进度（待开始 / 进行中 / 需要你 / 待验收 / 已结束）或按重要程度分列；卡片写清类型、
 * 重要程度、执行者与下一步。点卡片在右侧看详情（与列表视图同一个详情面板）。
 * 进度由任务状态决定，不能拖动改；重要程度在详情里改。
 */
import { Icon, t } from '@nomi-ai/ui';
import {
  AlertTriangle,
  Minus,
  SignalHigh,
  SignalLow,
  SignalMedium,
  type LucideIcon,
} from 'lucide-react';
import React, { useMemo } from 'react';

import {
  CATEGORY_LABEL,
  categoryOf,
  executorLabel,
  fmtTime,
  PRIORITIES,
  PRIORITY_LABEL,
  STAGE_LABEL,
  STAGES,
  stageOf,
  statusLabel,
  triggerLabel,
  type Task,
  type TaskPriority,
  type TaskStage,
} from '../../services/tasksClient';

import styles from './Board.module.css';

export type BoardGroup = 'stage' | 'priority';

type PriorityKey = TaskPriority | 'none';

const PRIORITY_ICON: Record<PriorityKey, LucideIcon> = {
  urgent: AlertTriangle,
  high: SignalHigh,
  medium: SignalMedium,
  low: SignalLow,
  none: Minus,
};

/** 同一列里：需要人的、重要的在前，其次最近更新的 */
const PRIORITY_RANK: Record<PriorityKey, number> = {
  urgent: 0,
  high: 1,
  medium: 2,
  low: 3,
  none: 4,
};

export const PriorityBadge: React.FC<{ priority?: TaskPriority | undefined }> = ({ priority }) => {
  const key: PriorityKey = priority ?? 'none';
  return (
    <span className={styles.priority} data-priority={key}>
      <Icon icon={PRIORITY_ICON[key]} size={12} />
      {t(PRIORITY_LABEL[key])}
    </span>
  );
};

const Card: React.FC<{
  task: Task;
  group: BoardGroup;
  selected: boolean;
  onSelect: () => void;
}> = ({ task, group, selected, onSelect }) => {
  const next =
    task.nextRunAt && task.status === 'idle' && task.enabled
      ? t('ui.providers-schedule.task-next-run', fmtTime(task.nextRunAt))
      : '';
  return (
    <li>
      <button
        type="button"
        className={styles.card}
        aria-current={selected ? 'true' : undefined}
        data-stage={stageOf(task)}
        onClick={onSelect}
        data-testid={`board-card-${task.id}`}
      >
        <span className={styles.cardMeta}>
          <span className={styles.category}>{t(CATEGORY_LABEL[categoryOf(task)])}</span>
          <span>{executorLabel(task.executor)}</span>
        </span>
        <span className={styles.cardTitle}>{task.title}</span>
        {task.goal && task.goal !== task.title && (
          <span className={styles.cardGoal}>{task.goal}</span>
        )}
        <span className={styles.cardFoot}>
          <PriorityBadge priority={task.priority} />
          <span className={styles.cardStatus}>
            {group === 'priority' ? statusLabel(task) : next || triggerLabel(task.trigger)}
          </span>
        </span>
      </button>
    </li>
  );
};

export const TaskBoard: React.FC<{
  tasks: Task[];
  group: BoardGroup;
  selected: string | null;
  onSelect: (id: string) => void;
}> = ({ tasks, group, selected, onSelect }) => {
  const columns = useMemo(() => {
    const keys: (TaskStage | PriorityKey)[] =
      group === 'stage' ? [...STAGES] : [...PRIORITIES, 'none'];
    const m = new Map<string, Task[]>(keys.map((k) => [k, []]));
    for (const task of tasks) {
      const k = group === 'stage' ? stageOf(task) : (task.priority ?? 'none');
      m.get(k)!.push(task);
    }
    for (const list of m.values())
      list.sort(
        (a, b) =>
          PRIORITY_RANK[a.priority ?? 'none'] - PRIORITY_RANK[b.priority ?? 'none'] ||
          b.updatedAt - a.updatedAt,
      );
    return keys.map((k) => ({ key: k, tasks: m.get(k)! }));
  }, [tasks, group]);

  return (
    <div className={styles.board} data-testid="tasks-board" data-group={group}>
      {columns.map(({ key, tasks: list }) => {
        const label =
          group === 'stage'
            ? t(STAGE_LABEL[key as TaskStage])
            : t(PRIORITY_LABEL[key as PriorityKey]);
        return (
          <section
            key={key}
            className={styles.column}
            data-column={key}
            aria-label={`${label} ${list.length}`}
            data-testid={`board-column-${key}`}
          >
            <header className={styles.columnHead}>
              <span className={styles.pill} data-column={key}>
                {group === 'priority' && (
                  <Icon icon={PRIORITY_ICON[key as PriorityKey]} size={12} />
                )}
                {label}
              </span>
              <span className={styles.count}>{list.length}</span>
            </header>
            {list.length ? (
              <ul className={styles.cards}>
                {list.map((task) => (
                  <Card
                    key={task.id}
                    task={task}
                    group={group}
                    selected={selected === task.id}
                    onSelect={() => onSelect(task.id)}
                  />
                ))}
              </ul>
            ) : (
              <p className={styles.columnEmpty}>{t('ui.providers-schedule.task-board-empty')}</p>
            )}
          </section>
        );
      })}
    </div>
  );
};
