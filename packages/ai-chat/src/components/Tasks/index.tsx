/**
 * 任务页（docs/features/scheduling-calendar.md）：侧栏会话列表上方、与素材库并列的「任务」入口，带「需要你」角标；
 * 打开后在主区整页显示（替换对话区，对话区只隐藏不卸载）。
 *
 * - 列表按「需要你 / 运行中 / 等触发 / 已结束」分组（第一条匹配的胜出），每行写清在等谁、要什么；
 * - 旧的提醒与定时代理任务作为两个分组并入（只读，点开进原有的日程面板）；
 * - 点一行在右侧看详情，处理收件箱里的事（批准、补充、验收、核对），以及暂停、取消、撤销授权；
 * - 「新建任务」走表单 + 授权卡片（确认后才创建）；
 * - 看板视图：按进度或重要程度分列，可按类型筛选（视图选择记在本机）。
 * 数据来自契约 tasks.*；内核在任务变化时推 tasks.changed。
 */
import { t } from '@nomi-ai/ui';
import {} from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { selectFirstMessageId, useAiChatSelector } from '../../contexts/aiChatStore';
import { useHarnessTabs } from '../../contexts/HarnessTabsContext';
import { groupOf, OPEN_TASK_EVENT, tasksAvailable } from '../../services/tasksClient';
import { OPEN_TASKS_PAGE_EVENT } from '../../services/workbenchNav';
import { FEATURE_ICONS } from '../AppIcons';
import { lazyComponent } from '../lazyPanels';
import { SideNavItem } from '../Sidebar/SideNavItem';

import styles from './index.module.css';
import { useTasks } from './useTasks';

export { useTasks } from './useTasks';

/** 任务页主体：首次打开时才加载（不进对话窗首屏 chunk；首屏空闲后会预取） */
const TasksPage = lazyComponent(() => import('./TasksPage').then((m) => m.TasksPage));

export const TasksNav: React.FC<{
  collapsed: boolean;
  active: boolean;
  needsYou: number;
  /** 运行中（含排队）的条数：没有要你处理的事时显示成普通计数 */
  running: number;
  onOpen: () => void;
}> = ({ collapsed, active, needsYou, running, onOpen }) => {
  const label = needsYou
    ? t('ui.providers-schedule.tasks-nav-needs-you', needsYou)
    : running
      ? t('ui.providers-schedule.tasks-nav-running', running)
      : t('ui.providers-schedule.tasks');
  return (
    <SideNavItem
      icon={FEATURE_ICONS.tasks}
      label={t('ui.providers-schedule.tasks')}
      title={label}
      collapsed={collapsed}
      active={active}
      badge={needsYou}
      count={running}
      onOpen={onOpen}
      testId="tasks-open"
    />
  );
};

export function useTasksHost(collapsed: boolean, onOpenSchedule?: () => void) {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const { data } = useTasks(tasksAvailable());
  const needsYou = (data?.tasks ?? []).filter((x) => groupOf(x) === 'needs_you').length;
  const running = (data?.tasks ?? []).filter((x) => groupOf(x) === 'running').length;
  const show = useCallback(() => {
    setOpen(true);
    setMounted(true);
  }, []);
  const close = useCallback(() => setOpen(false), []);
  const [focus, setFocus] = useState<{ id: string; nonce: number } | null>(null);
  const [createNonce, setCreateNonce] = useState(0);
  /** 搜索里点了任务：打开任务页并选中它 */
  const openTask = useCallback((id: string) => {
    setFocus((f) => ({ id, nonce: (f?.nonce ?? 0) + 1 }));
    setOpen(true);
    setMounted(true);
  }, []);
  useEffect(() => {
    const on = (e: Event) => {
      const id = (e as CustomEvent<string>).detail;
      if (typeof id === 'string' && id) openTask(id);
    };
    window.addEventListener(OPEN_TASK_EVENT, on);
    const onPage = (e: Event) => {
      const create = (e as CustomEvent<{ create?: boolean }>).detail?.create;
      setOpen(true);
      setMounted(true);
      if (create) setCreateNonce((n) => n + 1);
    };
    window.addEventListener(OPEN_TASKS_PAGE_EVENT, onPage);
    return () => {
      window.removeEventListener(OPEN_TASK_EVENT, on);
      window.removeEventListener(OPEN_TASKS_PAGE_EVENT, onPage);
    };
  }, [openTask]);
  const first = useAiChatSelector(selectFirstMessageId);
  const tabId = useHarnessTabs().state?.activeTabId;
  const last = useRef({ first, tabId });
  useEffect(() => {
    if (last.current.first !== first || last.current.tabId !== tabId) setOpen(false);
    last.current = { first, tabId };
  }, [first, tabId]);
  const available = tasksAvailable();
  // 记住入口元素：侧栏是 React.memo，每次给新元素会让它跟着 App 根组件每帧重渲染
  const nav = useMemo(
    () =>
      available ? (
        <TasksNav
          collapsed={collapsed}
          active={open}
          needsYou={needsYou}
          running={running}
          onOpen={show}
        />
      ) : null,
    [available, collapsed, open, needsYou, running, show],
  );
  if (!available) return { nav: null, page: null, chatHidden: false, close, openTask: undefined };
  const page = mounted ? (
    <div className={styles.main} hidden={!open} data-testid="tasks-main">
      <TasksPage
        active={open}
        onBack={close}
        focus={focus}
        createNonce={createNonce}
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
  return { nav, page, chatHidden: open, close, openTask };
}
