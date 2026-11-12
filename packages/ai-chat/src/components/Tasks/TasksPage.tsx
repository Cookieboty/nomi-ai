/** 任务页主体（列表 / 看板、详情、新建）：首次打开任务页时才加载（见 index.tsx 的 useTasksHost） */
import { Button, EmptyState, Icon, Select, t, Tabs } from '@nomi-ai/ui';
import { ListChecks, Plus, Search } from 'lucide-react';
import React, { useEffect, useMemo, useState } from 'react';

import {
  CATEGORIES,
  CATEGORY_LABEL,
  categoryOf,
  STAGE_LABEL,
  STAGES,
  stageOf,
  type TaskCategory,
  type TaskStage,
} from '../../services/tasksClient';

import { TaskBoard, type BoardGroup } from './Board';
import styles from './index.module.css';
import { TaskDetail } from './TaskDetail';
import { TaskForm } from './TaskForm';
import { TaskList } from './TaskList';
import { useTasks } from './useTasks';

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

export const TasksPage: React.FC<{
  active: boolean;
  onBack: () => void;
  /** 旧的提醒 / 定时：打开原有的日程面板 */
  onOpenSchedule?: () => void;
  /** 从搜索打开某个任务：打开后选中它（nonce 变了就再选一次） */
  focus?: { id: string; nonce: number } | null;
  /** 命令面板「新建任务」：nonce 变了就再打开一次表单 */
  createNonce?: number;
}> = ({ active, onBack, onOpenSchedule, focus, createNonce = 0 }) => {
  const { data } = useTasks(active);
  const [selected, setSelected] = useState<string | null>(null);
  // 已处理到的 nonce 从 0 / 无开始：任务页第一次挂载时带着的请求（首次从搜索打开、首次「新建任务」）也要处理
  const [focusSeen, setFocusSeen] = useState<number | undefined>(undefined);
  if (focus && focus.nonce !== focusSeen) {
    setFocusSeen(focus.nonce);
    setSelected(focus.id);
  }
  const [creating, setCreating] = useState(false);
  const [createSeen, setCreateSeen] = useState(0);
  if (createNonce !== createSeen) {
    setCreateSeen(createNonce);
    if (createNonce > 0) setCreating(true);
  }
  const [layout, setLayout] = useState(loadView);
  const [category, setCategory] = useState<TaskCategory | 'all'>('all');
  const [query, setQuery] = useState('');
  /** 进度筛选（列表与看板共用）：all 或某一档 */
  const [stage, setStage] = useState<TaskStage | 'all'>('all');
  const changeLayout = (patch: Partial<typeof layout>) => {
    const next = { ...layout, ...patch };
    setLayout(next);
    saveView(next);
  };
  const allTasks = useMemo(() => data?.tasks ?? [], [data]);
  /** 类型与搜索（标题、目标）筛过的；列表与看板共用 */
  const tasks = useMemo(() => {
    const q = query.trim().toLowerCase();
    return allTasks.filter(
      (x) =>
        (category === 'all' || categoryOf(x) === category) &&
        (!q || `${x.title} ${x.goal}`.toLowerCase().includes(q)),
    );
  }, [allTasks, category, query]);
  const stageCounts = useMemo(() => {
    const m = new Map<TaskStage, number>();
    for (const x of tasks) m.set(stageOf(x), (m.get(stageOf(x)) ?? 0) + 1);
    return m;
  }, [tasks]);
  const boardTasks = useMemo(
    () => (stage === 'all' ? tasks : tasks.filter((x) => stageOf(x) === stage)),
    [tasks, stage],
  );
  const legacy = data?.legacy ?? [];
  // 旧的提醒 / 定时：只在「全部」与「待开始」里列出（只读，点开进日程面板）
  const shownLegacy = stage === 'all' || stage === 'todo' ? legacy : [];
  const current = allTasks.find((x) => x.id === selected) ?? null;

  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      if (creating) setCreating(false);
      else if (selected) setSelected(null);
      // 回对话：导航栏的「对话」，或者什么都没开时按 Esc
      else onBack();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, creating, selected, onBack]);

  return (
    <section
      className={styles.page}
      aria-label={t('ui.providers-schedule.tasks')}
      data-testid="tasks"
    >
      <header className={styles.pageHead}>
        <span className={styles.headIcon} aria-hidden>
          <Icon icon={ListChecks} size={20} />
        </span>
        <div className={styles.headText}>
          <h2 className={styles.pageTitle}>{t('ui.providers-schedule.tasks')}</h2>
          <p className={styles.hint}>{t('ui.providers-schedule.tasks-hint')}</p>
        </div>
        <span className={styles.spacer} />
        {allTasks.length > 0 && (
          <label className={styles.search}>
            <Icon icon={Search} size={14} />
            <input
              className={styles.searchInput}
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('ui.providers-schedule.task-search')}
              aria-label={t('ui.providers-schedule.task-search')}
              data-testid="tasks-search"
            />
          </label>
        )}
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
        {allTasks.length > 0 && (
          <>
            <div
              className={styles.chips}
              role="group"
              aria-label={t('ui.providers-schedule.task-stage-filter')}
            >
              {(['all', ...STAGES] as const).map((k) => (
                <button
                  key={k}
                  type="button"
                  className={styles.chip}
                  aria-pressed={stage === k}
                  onClick={() => setStage(k)}
                  data-testid={`tasks-stage-${k}`}
                >
                  {k === 'all' ? t('ui.providers-schedule.all') : t(STAGE_LABEL[k])}
                  <span className={styles.chipCount}>
                    {k === 'all' ? tasks.length : (stageCounts.get(k) ?? 0)}
                  </span>
                </button>
              ))}
            </div>
            {layout.view === 'board' && (
              <Select
                size="sm"
                variant="ghost"
                className={styles.filter}
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
              variant="ghost"
              className={styles.filter}
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
            <span className={styles.count}>
              {t('ui.providers-schedule.task-count', tasks.length)}
            </span>
          </>
        )}
      </div>
      <div className={styles.body}>
        {layout.view === 'board' && data && !allTasks.length && (
          <EmptyState
            className={styles.boardEmpty}
            icon={ListChecks}
            title={t('ui.providers-schedule.tasks-empty')}
            action={
              <Button size="sm" variant="primary" onClick={() => setCreating(true)}>
                <Icon icon={Plus} size={14} />
                {t('ui.providers-schedule.new-task')}
              </Button>
            }
            data-testid="tasks-board-empty"
          />
        )}
        {layout.view === 'board' && allTasks.length > 0 && (
          <TaskBoard
            tasks={boardTasks}
            group={layout.group}
            stages={stage === 'all' ? undefined : [stage]}
            selected={selected}
            onSelect={setSelected}
          />
        )}
        <div className={styles.list} data-testid="tasks-list" hidden={layout.view === 'board'}>
          {data && (
            <TaskList
              tasks={boardTasks}
              legacy={shownLegacy}
              selected={selected}
              onSelect={setSelected}
              onOpenSchedule={onOpenSchedule}
              empty={t('ui.providers-schedule.tasks-empty')}
            />
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
