/**
 * 右栏（改动 · 文件）与中栏：
 * - 看哪些文件夹：编程助手标签用标签的工作目录，Nomi 对话用项目的主文件夹；再加项目的其余文件夹
 *   （委派的 worktree 在主文件夹里面，主文件夹不重复列）。没有工作目录时不显示右栏；
 * - 右栏默认收起、不常驻：顶栏开关 / 右栏 × 切换，记住上次的选择；点摘要卡「查看变更」时收起着也展开；
 * - 中栏：右栏的文件预览开着时出现；本会话 Diff 是预览区的一个标签，不占这一栏。
 *   子任务会话在主对话列，不占中栏。
 */
import { useCallback, useMemo, useState } from 'react';

import { useChangesUi } from '../components/SessionWorkspace';
import type { HarnessTabsCore } from '../contexts/HarnessTabsContext';
import { useNomiProject } from '../hooks/useNomiProject';
import { persistFilesRailOpen, readFilesRailOpen } from '../services/filesRailPrefs';
import type { HarnessState } from '../services/harnessClient';
import { harnessClient } from '../services/harnessClient';
import { projectRoots, useProject, type Project } from '../services/projects';
import type { ConvMessage } from '../types/conversation';
import { workspaceKey } from '../utils/workspacePath';

const inside = (child: string, parent: string) => {
  const c = workspaceKey(child);
  const p = workspaceKey(parent);
  return c === p || c.startsWith(`${p}/`);
};

/** 工作目录在前，再加项目里不包含它的其余文件夹 */
export function railRootsOf(cwd: string | null, project: Project | undefined): string[] | null {
  if (!cwd) return null;
  if (!project) return [cwd];
  return [cwd, ...projectRoots(project).filter((d) => !inside(cwd, d))];
}

export function useRail(opts: {
  tabs: HarnessTabsCore;
  isDev: boolean;
  harness: HarnessState | null;
  busyHere: boolean;
  cliConvMessages: readonly ConvMessage[];
  nomiMessages: readonly ConvMessage[];
}) {
  const { tabs, isDev, harness, busyHere } = opts;
  const { workbench, previewOpen } = useChangesUi();
  const [railPref, setRailPref] = useState(readFilesRailOpen);
  const cliTab = isDev && tabs.isCliTab;
  const nomiOnMain = !tabs.isCliTab && harness?.backend === 'nomi' && harnessClient.available();
  const nomiProject = useProject(useNomiProject().projectId);
  const cliProject = useProject(cliTab ? tabs.activeTab?.projectId : undefined);
  const cwd = cliTab
    ? (tabs.activeTab?.cwd ?? null)
    : nomiOnMain && nomiProject
      ? nomiProject.primary
      : null;
  const project = cliTab ? cliProject : nomiOnMain ? nomiProject : undefined;
  const roots = useMemo(() => railRootsOf(cwd, project), [cwd, project]);
  const messages = tabs.isCliTab ? opts.cliConvMessages : opts.nomiMessages;
  const busy = tabs.isCliTab
    ? tabs.activeTab?.status === 'running' || tabs.activeTab?.status === 'queued'
    : busyHere;
  // 本会话 Diff 不再单独占一栏：它是预览区的一个标签（见 App 的 useResourcePreview）
  const centerOpen = !!cwd && previewOpen;
  const open = !!cwd && railPref;
  const setOpen = useCallback((v: boolean) => {
    setRailPref(v);
    persistFilesRailOpen(v);
  }, []);
  const toggle = useCallback(() => setOpen(!open), [open, setOpen]);
  const close = useCallback(() => setOpen(false), [setOpen]);
  // 摘要卡「查看变更」要在右栏定位文件：收起着也展开（渲染期比对，不在 effect 里 setState）
  const [prevWorkbench, setPrevWorkbench] = useState(workbench);
  if (prevWorkbench !== workbench) {
    setPrevWorkbench(workbench);
    if (workbench && cwd && !railPref) setOpen(true);
  }
  return { cwd, roots, messages, busy, centerOpen, open, toggle, close };
}

export type RailState = ReturnType<typeof useRail>;
