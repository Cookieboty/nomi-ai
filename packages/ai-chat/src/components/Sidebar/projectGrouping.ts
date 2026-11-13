/**
 * 侧栏「按项目」分组：分组来自项目列表（没有会话的项目也显示），会话按 projectId 归进去——
 * Nomi 对话看会话自己的，CLI 会话看它的标签。没有项目（或项目已被移除）的会话放在「其他对话」里。
 * 分组按组内最近一次更新排序，没有会话的项目按它自己的更新时间。
 * 置顶不是单独的分类：置顶的会话留在自己的项目（或「其他对话」）里，排在该组最前面。
 */
import { useMemo } from 'react';

import type { ConversationListView } from '../../services/chatPrefs';
import type { HarnessTabMeta } from '../../services/harnessClient';
import { projectTitle, type Project } from '../../services/projects';
import type { ConversationBackend } from '../../types/chat';

import type { Meta } from './types';

export interface ProjectGroup {
  /** 项目 id：分组键与折叠记录的键 */
  key: string;
  project: Project;
  /** 悬停提示：项目名 + 全部文件夹 */
  title: string;
  items: Meta[];
  /** 组内最近一次更新（没有会话时是项目的更新时间） */
  updatedAt: number;
}

/**
 * 置顶的会话排到最前（后置顶的在上，按 pinnedAt 倒序），其余保持原来的先后（最近更新在上）。
 * 稳定排序：没有置顶时原样返回同一个数组。分组前先排一次，每个组内就都是「置顶在前」。
 */
export function pinnedFirst<T extends Pick<Meta, 'pinnedAt'>>(items: readonly T[]): T[] {
  const pinned = items.filter((m) => m.pinnedAt);
  if (!pinned.length) return items as T[];
  pinned.sort((a, b) => (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0));
  return [...pinned, ...items.filter((m) => !m.pinnedAt)];
}

/**
 * items 已按 updatedAt 倒序（置顶的已由 pinnedFirst 排到最前）；projectOf 取会话的项目 id（没有返回 undefined）。
 * 返回的 groups 与 rest 内部都保持原来的先后顺序。
 */
export function groupByProject(
  items: readonly Meta[],
  projects: readonly Project[],
  projectOf: (m: Meta) => string | undefined,
): { groups: ProjectGroup[]; rest: Meta[] } {
  const byKey = new Map<string, ProjectGroup>();
  for (const p of projects) {
    byKey.set(p.id, { key: p.id, project: p, title: projectTitle(p), items: [], updatedAt: 0 });
  }
  const rest: Meta[] = [];
  for (const m of items) {
    const g = byKey.get(projectOf(m) ?? '');
    if (!g) {
      rest.push(m);
      continue;
    }
    g.items.push(m);
    if (m.updatedAt > g.updatedAt) g.updatedAt = m.updatedAt;
  }
  for (const g of byKey.values()) if (!g.items.length) g.updatedAt = g.project.updatedAt;
  const groups = [...byKey.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  return { groups, rest };
}

/** 侧栏用：enabled = 「按项目分组」开着 */
export function useProjectGrouping(
  visible: readonly Meta[],
  projects: readonly Project[],
  tabById: Map<string, HarnessTabMeta>,
  enabled: boolean,
): { groups: ProjectGroup[]; rest: Meta[]; grouped: boolean } {
  const r = useMemo(
    () =>
      groupByProject(
        visible,
        projects,
        (m) => m.projectId ?? (m.tabId ? tabById.get(m.tabId)?.projectId : undefined),
      ),
    [visible, projects, tabById],
  );
  return { ...r, grouped: enabled };
}

/** 项目上的「新建」用哪个端：普通模式只有 Nomi；「按端」跟随筛选；「全部」沿用该项目最近一个会话的端 */
export function projectBackend(
  g: ProjectGroup,
  isNormal: boolean,
  view: ConversationListView,
  endpointFilter: ConversationBackend,
): ConversationBackend {
  return isNormal
    ? 'nomi'
    : view === 'by-endpoint'
      ? endpointFilter
      : (g.items[0]?.backend ?? 'nomi');
}
