/**
 * 任务看板：按进度（待开始 / 进行中 / 需要你 / 待验收 / 已结束）或按重要程度分列；卡片写清类型、
 * 重要程度、执行者与下一步。点卡片在右侧看详情（与列表视图同一个详情面板）。
 * 进度由任务状态决定，不能拖动改；重要程度在详情里改。卡片右下角的快捷操作只做不用再确认的：
 * 待开始的立即运行 / 恢复，进行中的暂停；其余都在详情里。
 * 颜色只用主题令牌：列头一个色点（进行中用主题色），已结束的卡片左侧一条 success。
 */
import { isBuiltinCliId } from '@nomi-ai/cli-catalog';
import { createLogger, Icon, IconButton, t } from '@nomi-ai/ui';
import {
  AlertTriangle,
  Bell,
  BookOpen,
  ChevronDown,
  ChevronsUp,
  Code2,
  Equal,
  Eye,
  ListTodo,
  Minus,
  Pause,
  PenLine,
  Play,
  Radar,
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
  tasksApi,
  triggerLabel,
  type ExecutorSpec,
  type Task,
  type TaskCategory,
  type TaskPriority,
  type TaskStage,
} from '../../services/tasksClient';
import { fmtAgo } from '../../utils/relativeTime';
import { EndpointIcon } from '../EndpointIcon';

import styles from './Board.module.css';

const log = createLogger('tasks-board');

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

export const CATEGORY_ICON: Record<TaskCategory, LucideIcon> = {
  coding: Code2,
  review: Eye,
  research: BookOpen,
  writing: PenLine,
  monitor: Radar,
  chore: ListTodo,
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

/** 执行者：编程助手画它的图标，Nomi 画应用图标，只是提醒的画铃铛 */
export const ExecutorIcon: React.FC<{ ex: ExecutorSpec }> = ({ ex }) => {
  if (ex.kind === 'notify') return <Icon icon={Bell} size={14} />;
  if (ex.kind === 'nomi') return <EndpointIcon backend="nomi" size={16} decorative />;
  return (
    <EndpointIcon backend={isBuiltinCliId(ex.cli) ? ex.cli : 'external'} size={16} decorative />
  );
};

/** 卡片上的快捷操作：只做不用再确认的 */
export function quickAction(
  task: Task,
): { icon: LucideIcon; label: string; run: () => Promise<unknown> } | null {
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
  group: BoardGroup;
  selected: boolean;
  onSelect: () => void;
}> = ({ task, group, selected, onSelect }) => {
  const stage = stageOf(task);
  const category = categoryOf(task);
  const next =
    task.nextRunAt && task.status === 'idle' && task.enabled
      ? t('ui.providers-schedule.task-next-run', fmtTime(task.nextRunAt))
      : '';
  const action = quickAction(task);

  // 已结束的收成一行：类型图标、标题、结果、多久前
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
          <span className={styles.cardFoot}>
            <span className={styles.executor}>
              <ExecutorIcon ex={task.executor} />
              {executorLabel(task.executor)}
            </span>
            <span className={styles.ago}>{fmtAgo(task.updatedAt)}</span>
          </span>
        </button>
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
          {/* 图标只是装饰：同一张卡片下面已经写着分类名，读屏不再重复一遍 */}
          <span className={styles.tile} aria-hidden>
            <Icon icon={CATEGORY_ICON[category]} size={14} />
          </span>
          <span className={styles.cardTitle}>{task.title}</span>
          {group === 'stage' && task.priority && <PriorityBadge priority={task.priority} />}
        </span>
        {task.goal && task.goal !== task.title && (
          <span className={styles.cardGoal}>{task.goal}</span>
        )}
        <span className={styles.cardMeta}>
          <span className={styles.tag}>{t(CATEGORY_LABEL[category])}</span>
          <span className={styles.trigger}>{triggerLabel(task.trigger)}</span>
        </span>
        {stage === 'in_progress' && <span className={styles.track} aria-hidden />}
        <span className={styles.cardFoot} data-has-action={action ? '' : undefined}>
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
    </li>
  );
};

export const TaskBoard: React.FC<{
  tasks: Task[];
  group: BoardGroup;
  /** 按进度分列时只显示这些列（顶部的进度筛选）；不给就全显示 */
  stages?: readonly TaskStage[];
  selected: string | null;
  onSelect: (id: string) => void;
}> = ({ tasks, group, stages, selected, onSelect }) => {
  const columns = useMemo(() => {
    const keys: ColumnKey[] = group === 'stage' ? [...(stages ?? STAGES)] : [...PRIORITIES, 'none'];
    const m = new Map<ColumnKey, Task[]>(keys.map((k) => [k, []]));
    for (const task of tasks) {
      const k: ColumnKey = group === 'stage' ? stageOf(task) : (task.priority ?? 'none');
      m.get(k)?.push(task);
    }
    for (const list of m.values())
      list.sort(
        (a, b) =>
          PRIORITY_RANK[a.priority ?? 'none'] - PRIORITY_RANK[b.priority ?? 'none'] ||
          b.updatedAt - a.updatedAt,
      );
    return keys.map((k) => ({ key: k, tasks: m.get(k)! }));
  }, [tasks, group, stages]);

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
            data-empty={list.length ? undefined : true}
            aria-label={`${label} ${list.length}`}
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
