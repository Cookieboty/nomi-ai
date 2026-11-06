/**
 * 侧栏「按工作区」分组：Nomi 对话按会话的工作区（ChatSession.cwd），CLI 标签按标签的目录。
 * 分组按组内最近一次更新排序；没有工作区的会话单独放在「最近」里。
 */
import { useMemo } from 'react';

import type { ConversationListView } from '../../services/chatPrefs';
import type { HarnessTabMeta } from '../../services/harnessClient';
import type { ConversationBackend } from '../../types/chat';

import type { Meta } from './types';

export interface WorkspaceGroup {
  /** 规范化后的路径，作分组键与折叠记录的键 */
  key: string;
  /** 原始路径（悬停提示） */
  path: string;
  /** 显示名：目录名；同名目录时带上父目录区分 */
  label: string;
  items: Meta[];
  /** 组内最近一次更新 */
  updatedAt: number;
}

/** 分组键：统一分隔符、去掉末尾斜杠；Windows 盘符与路径大小写不敏感 */
export function workspaceKey(path: string): string {
  const p = path.replace(/\\/g, '/').replace(/\/+$/, '') || '/';
  return /^[A-Za-z]:\//.test(p) || /^[A-Za-z]:$/.test(p) ? p.toLowerCase() : p;
}

function segments(key: string): string[] {
  return key.split('/').filter(Boolean);
}

/**
 * items 已按 updatedAt 倒序；cwdOf 取会话的工作区（没有返回空串）。
 * 返回的 groups 与 rest 内部都保持原来的先后顺序。
 */
export function groupByWorkspace(
  items: readonly Meta[],
  cwdOf: (m: Meta) => string | undefined,
): { groups: WorkspaceGroup[]; rest: Meta[] } {
  const byKey = new Map<string, WorkspaceGroup>();
  const rest: Meta[] = [];
  for (const m of items) {
    const cwd = cwdOf(m)?.trim();
    if (!cwd) {
      rest.push(m);
      continue;
    }
    const key = workspaceKey(cwd);
    let g = byKey.get(key);
    if (!g) {
      g = { key, path: cwd, label: '', items: [], updatedAt: m.updatedAt };
      byKey.set(key, g);
    }
    g.items.push(m);
    if (m.updatedAt > g.updatedAt) g.updatedAt = m.updatedAt;
  }
  const groups = [...byKey.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  // 目录名重名（如两个 app）：往上多带一级，直到能区分或用完
  const names = new Map<string, number>();
  for (const g of groups) {
    const base = segments(g.key).slice(-1)[0] ?? g.key;
    names.set(base, (names.get(base) ?? 0) + 1);
  }
  for (const g of groups) {
    const segs = segments(g.key);
    const base = segs[segs.length - 1] ?? g.key;
    g.label =
      (names.get(base) ?? 0) > 1 && segs.length > 1 ? segs.slice(-2).join('/') : base || g.path;
  }
  return { groups, rest };
}

/** 侧栏用：Nomi 对话看会话的工作区，CLI 标签看标签的目录；一个有工作区的会话都没有时不分组（平铺） */
export function useWorkspaceGrouping(
  visible: readonly Meta[],
  tabById: Map<string, HarnessTabMeta>,
  enabled: boolean,
): { groups: WorkspaceGroup[]; rest: Meta[]; grouped: boolean } {
  const r = useMemo(
    () => groupByWorkspace(visible, (m) => m.cwd || (m.tabId ? tabById.get(m.tabId)?.cwd : '')),
    [visible, tabById],
  );
  return { ...r, grouped: enabled && r.groups.length > 0 };
}

/** 文件夹上的「新建」用哪个端：普通模式只有 Nomi；「按端」跟随筛选；「全部」沿用该工作区最近一个会话的端 */
export function workspaceBackend(
  g: WorkspaceGroup,
  isNormal: boolean,
  view: ConversationListView,
  endpointFilter: ConversationBackend,
): ConversationBackend {
  const b = isNormal
    ? 'nomi'
    : view === 'by-endpoint'
      ? endpointFilter
      : (g.items[0]?.backend ?? 'nomi');
  return b === 'external' ? 'nomi' : b;
}
