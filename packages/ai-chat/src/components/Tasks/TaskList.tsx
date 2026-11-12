/**
 * 任务的列表视图：与 Agent 看板同样的结构（面板、两列卡片）；样式单独一份（TaskList.module.css，从 Agent 看板复制，各自演进）。
 * 卡片：类型图标块 · 类型 · 状态胶囊 · 快捷操作 → 标题 → 目标 → 执行者 / 重要程度 / 触发 → 状态条 → 多久前有动静 · 下次运行。
 * 整张卡片点开右侧详情（卡片里铺一个透明按钮，快捷操作按钮叠在上面，不嵌套）。
 * 旧的提醒 / 定时作为同样的卡片排在后面，点开进日程面板。
 */
import { createLogger, Icon, IconButton, t } from '@nomi-ai/ui';
import { Bell, CalendarClock, Clock } from 'lucide-react';
import React from 'react';

import { describeRepeat } from '../../services/desktopClient';
import {
  CATEGORY_LABEL,
  categoryOf,
  executorLabel,
  fmtTime,
  stageOf,
  statusLabel,
  triggerLabel,
  type LegacyItem,
  type Task,
} from '../../services/tasksClient';
import { fmtAgo } from '../../utils/relativeTime';

import { CATEGORY_ICON, ExecutorIcon, PriorityBadge, quickAction } from './Board';
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

/** 状态条：进行中流动的主题色、完成整条 success、暂停 warning，其余只有底槽（不是完成度） */
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

const TaskCard: React.FC<{ task: Task; selected: boolean; onSelect: () => void }> = ({
  task,
  selected,
  onSelect,
}) => {
  const category = categoryOf(task);
  const tone = toneOf(task);
  const action = quickAction(task);
  const next =
    task.nextRunAt && task.status === 'idle' && task.enabled
      ? t('ui.providers-schedule.task-next-run', fmtTime(task.nextRunAt))
      : '';
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
        {action && (
          <IconButton
            size="sm"
            variant="ghost"
            className={styles.above}
            icon={<Icon icon={action.icon} size={14} />}
            label={`${action.label} · ${task.title}`}
            onClick={() => {
              void action.run().catch((e: unknown) => log.warn('quick action failed', e));
            }}
            data-testid={`list-action-${task.id}`}
          />
        )}
      </div>
      <span className={styles.title} title={task.title}>
        {task.title}
      </span>
      {task.goal && task.goal !== task.title && <span className={styles.summary}>{task.goal}</span>}
      <span className={styles.meta}>
        <span className={styles.metaItem}>
          <ExecutorIcon ex={task.executor} />
          {executorLabel(task.executor)}
        </span>
        {task.priority && <PriorityBadge priority={task.priority} />}
        <span className={styles.metaItem}>{triggerLabel(task.trigger)}</span>
      </span>
      <span className={styles.track} data-column={trackOf(task) || undefined} aria-hidden />
      <span className={styles.foot}>
        <span className={styles.updated}>
          {t('ui.cli-monitor.fleet-updated', fmtAgo(task.updatedAt))}
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
  selected: string | null;
  onSelect: (id: string) => void;
  onOpenSchedule?: () => void;
  empty: string;
}> = ({ tasks, legacy, selected, onSelect, onOpenSchedule, empty }) => {
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
