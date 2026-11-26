/**
 * 右栏（改动 · 文件）与中栏：
 * - 看哪些文件夹：agent 标签用标签的工作目录，Nomi 对话用项目的主文件夹；再加项目的其余文件夹
 *   （委派的 worktree 在主文件夹里面，主文件夹不重复列）。没有工作目录时不显示右栏；
 * - 右栏默认收起、不常驻：顶栏开关 / 右栏 × 切换，记住上次的选择；点摘要卡「查看变更」时收起着也展开；
 * - 中栏：右栏的文件预览或子任务侧栏开着时出现；本会话 Diff 是预览区的一个标签，不占这一栏。
 */
import { useCallback, useMemo, useState } from 'react';

import { useChangesUi } from '../components/SessionWorkspace';
import { useSubagentPane } from '../components/SubagentPane';
import type { HarnessTabsCore } from '../contexts/HarnessTabsContext';
import { useNomiProject } from '../hooks/useNomiProject';
import { persistFilesRailOpen, readFilesRailOpen } from '../services/filesRailPrefs';
import type { HarnessState, HarnessTabMeta } from '../services/harnessClient';
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
  /**
   * 并排会话时「焦点面板显示的 CLI 标签」：右栏跟着焦点面板的会话（它可能不是 harness 的当前标签）。
   * 不给时沿用 tabs.activeTab（单面板与原来一致）。
   */
  focusedTab?: HarnessTabMeta | null;
}) {
  const { tabs, isDev, harness, busyHere } = opts;
  const { workbench, previewOpen } = useChangesUi();
  const [railPref, setRailPref] = useState(readFilesRailOpen);
  // 当前会话是不是 CLI 标签：焦点面板可能是别的标签（并排会话），所以由 App 指定
  const activeTab = opts.focusedTab ?? tabs.activeTab;
  const cliTab = isDev && (opts.focusedTab ? !!opts.focusedTab : tabs.isCliTab);
  const nomiOnMain = !cliTab && harness?.backend === 'nomi' && harnessClient.available();
  const nomiProjectId = useNomiProject().projectId;
  const nomiProject = useProject(nomiProjectId);
  const cliProject = useProject(cliTab ? activeTab?.projectId : undefined);
  const cwd = cliTab
    ? (activeTab?.cwd ?? null)
    : nomiOnMain && nomiProject
      ? nomiProject.primary
      : null;
  const project = cliTab ? cliProject : nomiOnMain ? nomiProject : undefined;
  const roots = useMemo(() => railRootsOf(cwd, project), [cwd, project]);
  const messages = cliTab ? opts.cliConvMessages : opts.nomiMessages;
  const busy = cliTab
    ? activeTab?.status === 'running' || activeTab?.status === 'queued'
    : busyHere;
  // 开着子任务标签（标签区，开着时占对话旁；文件标签由 App 按预览区另算）
  const subagentOpen = (useSubagentPane()?.targets.length ?? 0) > 0;
  // 本会话 Diff 不再单独占一栏：它是预览区的一个标签（见 App 的 useResourcePreview）
  const centerOpen = (!!cwd && previewOpen) || subagentOpen;
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
  /** 当前会话所属的项目（侧边聊天按它带项目上下文） */
  const projectId =
    (cliTab ? activeTab?.projectId : nomiOnMain ? nomiProjectId : undefined) ?? null;
  /** 项目主文件夹优先（即便是 worktree 里的 CLI 标签，默认终端也落到主工程路径） */
  const projectPrimary = project?.primary ?? cwd ?? null;
  return { cwd, roots, messages, busy, centerOpen, open, toggle, close, projectId, projectPrimary };
}

export type RailState = ReturnType<typeof useRail>;
