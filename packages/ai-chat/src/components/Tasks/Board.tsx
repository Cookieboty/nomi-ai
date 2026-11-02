/**
 * 任务看板：按进度（待开始 / 进行中 / 需要你 / 待验收 / 已结束）或按重要程度分列；卡片写清类型、
 * 重要程度、执行者与下一步。点卡片在右侧看详情（与列表视图同一个详情面板）。
 * 进度由任务状态决定，不能拖动改；重要程度在详情里改。
 * 列是中性底色的泳道，只有列头的图标带颜色（深色主题下大面积彩色底太脏）。
 */
import { Icon, t } from '@nomi-ai/ui';
import {
  AlertTriangle,
  CheckCircle2,
  Circle,
  CircleAlert,
  CircleDot,
  Eye,
  ChevronDown,
  ChevronsUp,
  Equal,
  Minus,
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
type ColumnKey = TaskStage | PriorityKey;

const PRIORITY_ICON: Record<PriorityKey, LucideIcon> = {
  urgent: AlertTriangle,
  high: ChevronsUp,
  medium: Equal,
  low: ChevronDown,
  none: Minus,
};

const STAGE_ICON: Record<TaskStage, LucideIcon> = {
  todo: Circle,
  in_progress: CircleDot,
  needs_you: CircleAlert,
  review: Eye,
  done: CheckCircle2,
};

/** 同一列里：重要的在前，其次最近更新的 */
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
  // 按重要程度分列时，列已经说明了重要程度：卡片上改写进度
  const foot = group === 'priority' ? statusLabel(task) : next || triggerLabel(task.trigger);
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
          <span className={styles.tag}>{t(CATEGORY_LABEL[categoryOf(task)])}</span>
          <span className={styles.executor}>{executorLabel(task.executor)}</span>
        </span>
        <span className={styles.cardTitle}>{task.title}</span>
        {task.goal && task.goal !== task.title && (
          <span className={styles.cardGoal}>{task.goal}</span>
        )}
        <span className={styles.cardFoot}>
          {group === 'stage' && task.priority && <PriorityBadge priority={task.priority} />}
          <span className={styles.cardStatus} title={foot}>
            {foot}
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
    const keys: ColumnKey[] = group === 'stage' ? [...STAGES] : [...PRIORITIES, 'none'];
    const m = new Map<ColumnKey, Task[]>(keys.map((k) => [k, []]));
    for (const task of tasks) {
      const k: ColumnKey = group === 'stage' ? stageOf(task) : (task.priority ?? 'none');
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
        const icon =
          group === 'stage' ? STAGE_ICON[key as TaskStage] : PRIORITY_ICON[key as PriorityKey];
        return (
          <section
            key={key}
            className={styles.column}
            data-column={key}
            data-empty={list.length ? undefined : true}
            aria-label={`${label} ${list.length}`}
            data-testid={`board-column-${key}`}
          >
            <header className={styles.columnHead}>
              <span className={styles.columnIcon} data-column={key}>
                <Icon icon={icon} size={14} />
              </span>
              <span className={styles.columnLabel}>{label}</span>
              <span className={styles.count}>{list.length}</span>
            </header>
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
              {!list.length && (
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
