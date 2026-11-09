/**
 * 右栏 / 中栏 / @ 路径补全看的文件夹：工作目录在前（编程助手标签的目录 / Nomi 对话项目的主文件夹），
 * 再加项目的其余文件夹（委派的 worktree 在主文件夹里面，主文件夹不重复列）。
 */
import { useMemo } from 'react';

import { projectRoots, type Project } from '../services/projects';
import { workspaceKey } from '../utils/workspacePath';

const inside = (child: string, parent: string) => {
  const c = workspaceKey(child);
  const p = workspaceKey(parent);
  return c === p || c.startsWith(`${p}/`);
};

export function useRailRoots(cwd: string | null, project: Project | undefined): string[] | null {
  return useMemo(() => {
    if (!cwd) return null;
    if (!project) return [cwd];
    return [cwd, ...projectRoots(project).filter((d) => !inside(cwd, d))];
  }, [cwd, project]);
}
