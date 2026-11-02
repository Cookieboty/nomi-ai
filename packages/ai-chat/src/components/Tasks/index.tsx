/**
 * 任务页（docs/design/persistent-tasks.md §12）：侧栏会话列表上方、与素材库并列的「任务」入口，带「需要你」角标；
 * 打开后在主区整页显示（替换对话区，对话区只隐藏不卸载）。
 *
 * - 列表按「需要你 / 运行中 / 等触发 / 已结束」分组（第一条匹配的胜出），每行写清在等谁、要什么；
 * - 旧的提醒与定时代理任务作为两个分组并入（只读，点开进原有的日程面板）；
 * - 点一行在右侧看详情，处理收件箱里的事（批准、补充、验收、核对），以及暂停、取消、撤销授权；
 * - 「新建任务」走表单 + 授权卡片（确认后才创建）；
 * - 看板视图：按进度或重要程度分列，可按类型筛选（视图选择记在本机）。
 * 数据来自契约 tasks.*；内核在任务变化时推 tasks.changed。
 */
import { Button, Icon, Select, t, Tabs } from '@nomi-ai/ui';
import { ArrowLeft, ListChecks, Plus } from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { selectFirstMessageId, useAiChatSelector } from '../../contexts/aiChatStore';
import { useHarnessTabs } from '../../contexts/HarnessTabsContext';
import { describeRepeat } from '../../services/desktopClient';
import {
  CATEGORIES,
  CATEGORY_LABEL,
  categoryOf,
  fmtTime,
  groupOf,
  statusLabel,
  tasksApi,
  tasksAvailable,
  triggerLabel,
  type LegacyItem,
  type Task,
  type TaskCategory,
  type TaskGroup,
} from '../../services/tasksClient';

import { PriorityBadge, TaskBoard, type BoardGroup } from './Board';
import styles from './index.module.css';
import { TaskDetail } from './TaskDetail';
import { TaskForm } from './TaskForm';

/** 任务列表：拉一次并跟着 tasks.changed 刷新 */
export function useTasks(enabled = true) {
  const [data, setData] = useState<{ tasks: Task[]; legacy: LegacyItem[] } | null>(null);
  const load = useCallback(() => {
    if (!tasksAvailable()) return;
    void tasksApi
      .list()
      .then(setData)
      .catch(() => setData({ tasks: [], legacy: [] }));
  }, []);
  useEffect(() => {
    if (!enabled || !tasksAvailable()) return;
    load();
    return tasksApi.onChange(load);
  }, [enabled, load]);
  return { data, reload: load };
}

export const TasksNav: React.FC<{
  collapsed: boolean;
  active: boolean;
  needsYou: number;
  onOpen: () => void;
}> = ({ collapsed, active, needsYou, onOpen }) => {
  const label = needsYou
    ? t('ui.providers-schedule.tasks-nav-needs-you', needsYou)
    : t('ui.providers-schedule.tasks');
  return (
    <button
      type="button"
      className={styles.nav}
      data-collapsed={collapsed || undefined}
      aria-current={active ? 'page' : undefined}
      aria-label={label}
      title={label}
      onClick={onOpen}
      data-testid="tasks-open"
    >
      <Icon icon={ListChecks} size={16} />
      {!collapsed && <span className={styles.navLabel}>{t('ui.providers-schedule.tasks')}</span>}
      {needsYou > 0 && (
        <span className={styles.navBadge} data-collapsed={collapsed || undefined}>
          {needsYou}
        </span>
      )}
    </button>
  );
};

type View = 'list' | 'board';
const VIEW_KEY = 'nomi.tasks.view';

/** 本机记住的视图选择（读不到就用默认，private window 等情况下 localStorage 会抛错） */
function loadView(): { view: View; group: BoardGroup } {
  try {
    const v = JSON.parse(localStorage.getItem(VIEW_KEY) ?? '{}') as {
      view?: unknown;
      group?: unknown;
    };
    return {
      view: v.view === 'board' ? 'board' : 'list',
      group: v.group === 'priority' ? 'priority' : 'stage',
    };
  } catch {
    return { view: 'list', group: 'stage' };
  }
}

function saveView(v: { view: View; group: BoardGroup }): void {
  try {
    localStorage.setItem(VIEW_KEY, JSON.stringify(v));
  } catch {
    /* 存不了就只在这次有效 */
  }
}

const GROUPS: { key: TaskGroup; label: string }[] = [
  { key: 'needs_you', label: 'ui.providers-schedule.tasks-group-needs-you' },
  { key: 'running', label: 'ui.knowledge-local.running' },
  { key: 'waiting_trigger', label: 'ui.providers-schedule.task-waiting-trigger' },
  { key: 'ended', label: 'ui.mascot-theme.ended' },
];

export const TasksPage: React.FC<{
  active: boolean;
  onBack: () => void;
  /** 旧的提醒 / 定时：打开原有的日程面板 */
  onOpenSchedule?: () => void;
}> = ({ active, onBack, onOpenSchedule }) => {
  const { data } = useTasks(active);
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [layout, setLayout] = useState(loadView);
  const [category, setCategory] = useState<TaskCategory | 'all'>('all');
  const changeLayout = (patch: Partial<typeof layout>) => {
    const next = { ...layout, ...patch };
    setLayout(next);
    saveView(next);
  };
  const allTasks = useMemo(() => data?.tasks ?? [], [data]);
  const tasks = useMemo(
    () => (category === 'all' ? allTasks : allTasks.filter((x) => categoryOf(x) === category)),
    [allTasks, category],
  );
  const grouped = useMemo(() => {
    const m = new Map<TaskGroup, Task[]>();
    for (const task of tasks) {
      const g = groupOf(task);
      m.set(g, [...(m.get(g) ?? []), task]);
    }
    return m;
  }, [tasks]);
  const legacy = data?.legacy ?? [];
  const reminders = legacy.filter((x) => x.source === 'reminder');
  const scheduled = legacy.filter((x) => x.source === 'schedule');
  const current = allTasks.find((x) => x.id === selected) ?? null;

  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      if (creating) setCreating(false);
      else if (selected) setSelected(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, creating, selected]);

  return (
    <section
      className={styles.page}
      aria-label={t('ui.providers-schedule.tasks')}
      data-testid="tasks"
    >
      <header className={styles.pageHead}>
        <Button size="sm" variant="ghost" onClick={onBack} data-testid="tasks-back">
          <Icon icon={ArrowLeft} size={14} />
          {t('ui.chat-settings.back-to-chat')}
        </Button>
        <h2 className={styles.pageTitle}>{t('ui.providers-schedule.tasks')}</h2>
        <span className={styles.spacer} />
        <Button
          size="sm"
          variant="primary"
          onClick={() => setCreating(true)}
          data-testid="tasks-new"
        >
          <Icon icon={Plus} size={14} />
          {t('ui.providers-schedule.new-task')}
        </Button>
      </header>
      <p className={styles.hint}>{t('ui.providers-schedule.tasks-hint')}</p>
      <div className={styles.toolbar}>
        <Tabs
          items={[
            {
              value: 'list',
              label: t('ui.providers-schedule.task-view-list'),
              testId: 'tasks-view-list',
            },
            {
              value: 'board',
              label: t('ui.providers-schedule.task-view-board'),
              testId: 'tasks-view-board',
            },
          ]}
          value={layout.view}
          onChange={(view) => changeLayout({ view })}
          aria-label={t('ui.model-quality.view')}
        />
        {layout.view === 'board' && (
          <Select
            size="sm"
            value={layout.group}
            onChange={(e) => changeLayout({ group: e.target.value as BoardGroup })}
            aria-label={t('ui.providers-schedule.task-board-group')}
            options={[
              { value: 'stage', label: t('ui.providers-schedule.task-board-by-stage') },
              { value: 'priority', label: t('ui.providers-schedule.task-board-by-priority') },
            ]}
            data-testid="tasks-board-group"
          />
        )}
        <Select
          size="sm"
          value={category}
          onChange={(e) => setCategory(e.target.value as TaskCategory | 'all')}
          aria-label={t('ui.providers-schedule.task-category')}
          options={[
            { value: 'all', label: t('ui.providers-schedule.task-category-all') },
            ...CATEGORIES.map((c) => ({ value: c, label: t(CATEGORY_LABEL[c]) })),
          ]}
          data-testid="tasks-category"
        />
        <span className={styles.spacer} />
        <span className={styles.groupCount}>
          {t('ui.providers-schedule.task-count', tasks.length)}
        </span>
      </div>
      <div className={styles.body}>
        {layout.view === 'board' && (
          <TaskBoard
            tasks={tasks}
            group={layout.group}
            selected={selected}
            onSelect={setSelected}
          />
        )}
        <div className={styles.list} data-testid="tasks-list" hidden={layout.view === 'board'}>
          {data && !tasks.length && !legacy.length && (
            <p className={styles.empty} data-testid="tasks-empty">
              {t('ui.providers-schedule.tasks-empty')}
            </p>
          )}
          {GROUPS.map(({ key, label }) => {
            const rows = grouped.get(key);
            if (!rows?.length) return null;
            return (
              <div key={key} className={styles.group} data-testid={`tasks-group-${key}`}>
                <h3 className={styles.groupTitle}>
                  {t(label)} <span className={styles.groupCount}>{rows.length}</span>
                </h3>
                <ul className={styles.rows}>
                  {rows.map((task) => (
                    <li key={task.id}>
                      <button
                        type="button"
                        className={styles.row}
                        aria-current={selected === task.id ? 'true' : undefined}
                        data-attention={key === 'needs_you' || undefined}
                        onClick={() => setSelected(task.id)}
                        data-testid={`task-${task.id}`}
                      >
                        <span className={styles.rowTitle}>{task.title}</span>
                        <span className={styles.rowStatus}>{statusLabel(task)}</span>
                        <span className={styles.rowMeta}>
                          {task.priority && <PriorityBadge priority={task.priority} />}
                          {triggerLabel(task.trigger)}
                          {task.nextRunAt && task.status === 'idle' && task.enabled
                            ? ` · ${t('ui.providers-schedule.task-next-run', fmtTime(task.nextRunAt))}`
                            : ''}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
          {[
            {
              rows: reminders,
              label: 'ui.foundation.reminders',
              key: 'reminders',
            },
            {
              rows: scheduled,
              label: 'ui.providers-schedule.tasks-group-scheduled',
              key: 'scheduled',
            },
          ].map(
            ({ rows, label, key }) =>
              rows.length > 0 && (
                <div key={key} className={styles.group} data-testid={`tasks-group-${key}`}>
                  <h3 className={styles.groupTitle}>
                    {t(label)} <span className={styles.groupCount}>{rows.length}</span>
                  </h3>
                  <ul className={styles.rows}>
                    {rows.map((x) => (
                      <li key={`${x.source}:${x.id}`}>
                        <button
                          type="button"
                          className={styles.row}
                          data-disabled={!x.enabled || undefined}
                          onClick={onOpenSchedule}
                          title={t('ui.providers-schedule.tasks-open-schedule')}
                          data-testid={`legacy-${x.id}`}
                        >
                          <span className={styles.rowTitle}>{x.title}</span>
                          <span className={styles.rowStatus}>
                            {x.enabled
                              ? x.repeat
                                ? describeRepeat(x.repeat)
                                : t('ui.providers-schedule.task-once')
                              : t('ui.providers-schedule.task-paused')}
                          </span>
                          <span className={styles.rowMeta}>{fmtTime(x.nextRunAt)}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              ),
          )}
        </div>
        {current && (
          <TaskDetail key={current.id} task={current} onClose={() => setSelected(null)} />
        )}
      </div>
      {creating && (
        <TaskForm
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false);
            setSelected(id);
          }}
        />
      )}
    </section>
  );
};

/** App 用：侧栏入口 + 主区整页；切会话 / 标签时回到对话 */
export function useTasksHost(collapsed: boolean, onOpenSchedule?: () => void) {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const { data } = useTasks(tasksAvailable());
  const needsYou = (data?.tasks ?? []).filter((x) => groupOf(x) === 'needs_you').length;
  const show = useCallback(() => {
    setOpen(true);
    setMounted(true);
  }, []);
  const close = useCallback(() => setOpen(false), []);
  const first = useAiChatSelector(selectFirstMessageId);
  const tabId = useHarnessTabs().state?.activeTabId;
  const last = useRef({ first, tabId });
  useEffect(() => {
    if (last.current.first !== first || last.current.tabId !== tabId) setOpen(false);
    last.current = { first, tabId };
  }, [first, tabId]);
  if (!tasksAvailable()) return { nav: null, page: null, chatHidden: false, close };
  const nav = <TasksNav collapsed={collapsed} active={open} needsYou={needsYou} onOpen={show} />;
  const page = mounted ? (
    <div className={styles.main} hidden={!open} data-testid="tasks-main">
      <TasksPage
        active={open}
        onBack={close}
        onOpenSchedule={
          onOpenSchedule
            ? () => {
                setOpen(false);
                onOpenSchedule();
              }
            : undefined
        }
      />
    </div>
  ) : null;
  return { nav, page, chatHidden: open, close };
}
