/**
 * 主区整页（任务 / Agent 看板 / 素材库）：入口在左侧导航栏，打开后替换对话区（对话区只隐藏不卸载），
 * 三个互斥；切到别的会话 / 标签、点侧栏会话或新建时回到对话。
 */
import React, { useCallback, useEffect, useMemo } from 'react';

import { useAssetLibraryHost } from '../components/AssetLibrary';
import { useFleetHost } from '../components/Fleet';
import { useTasksHost } from '../components/Tasks';

export type MainPage = 'tasks' | 'assets' | 'fleet';

export function useMainPages(onOpenSchedule: () => void) {
  const assets = useAssetLibraryHost(true);
  // 任务页：旧的提醒 / 定时点开进日程面板
  const tasks = useTasksHost(true, onOpenSchedule);
  // Agent 看板：导航栏一项 + 标题栏负载指示（docs/development/agent-board.md）
  const fleet = useFleetHost(true);
  const closeAssets = assets.close;
  const closeTasks = tasks.close;
  const closeFleet = fleet.close;

  useEffect(() => {
    if (!tasks.chatHidden) return;
    closeAssets();
    closeFleet();
  }, [tasks.chatHidden, closeAssets, closeFleet]);
  useEffect(() => {
    if (!assets.chatHidden) return;
    closeTasks();
    closeFleet();
  }, [assets.chatHidden, closeTasks, closeFleet]);
  useEffect(() => {
    if (!fleet.chatHidden) return;
    closeTasks();
    closeAssets();
  }, [fleet.chatHidden, closeTasks, closeAssets]);

  const openPage: MainPage | null = tasks.chatHidden
    ? 'tasks'
    : assets.chatHidden
      ? 'assets'
      : fleet.chatHidden
        ? 'fleet'
        : null;

  // 侧栏是 React.memo：入口元素记住，流式生成时根组件重渲染不带着侧栏重渲染
  const tasksNav = tasks.nav;
  const assetNav = assets.nav;
  const fleetNav = fleet.nav;
  const topNav = useMemo(
    () =>
      assetNav || tasksNav || fleetNav ? (
        <div className="side-top-nav">
          {tasksNav}
          {fleetNav}
          {assetNav}
        </div>
      ) : null,
    [tasksNav, assetNav, fleetNav],
  );

  // 侧栏里点会话 / 新建 / 打开历史：关掉整页，直接回到对话
  const leave = useCallback(() => {
    closeAssets();
    closeTasks();
    closeFleet();
  }, [closeAssets, closeTasks, closeFleet]);

  const pages = (
    <>
      {assets.page}
      {tasks.page}
      {fleet.page}
    </>
  );

  return {
    openPage,
    topNav,
    leave,
    pages,
    fleetIndicator: fleet.indicator,
    openTask: tasks.openTask,
    openAsset: assets.openAsset,
  };
}
