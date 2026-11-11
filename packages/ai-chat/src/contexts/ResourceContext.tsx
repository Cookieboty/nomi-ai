/** Surface-neutral resource-opening interface; no rendering or lifecycle ownership. */
import React, { createContext, useContext } from 'react';

import type { ChangeEntry } from '../utils/sessionChanges';
import type { FileDiff } from '../utils/toolTrace';

export interface ResourceScope {
  id: string;
  cwd?: string | null;
  source?: string;
  /** Known workspace candidates after a delegated worktree was removed. Kernel validates each. */
  fallbackCwds?: string[];
}
export interface ResourceImageInfo {
  origin: 'assistant' | 'user' | 'document';
  kind?: 'image';
  prompt?: string;
  model?: string;
  aspect?: string;
  createdAt?: number;
  source?: string;
  editedFrom?: string;
  references?: string[];
}
/** Identity of a resource request, independent of any preview UI. */
export interface ResourceEntry {
  key: string;
  href: string;
  scope: ResourceScope;
  image?: ResourceImageInfo;
}
/** Diff 标签里的那个文件（与 FileReview 的 ReviewFile 同形；这里不依赖界面组件） */
export interface DiffTabFile {
  key: string;
  path: string;
  letter?: string;
  added?: number;
  removed?: number;
  /** 本会话的改动 */
  change?: ChangeEntry;
  /** git 的改动 */
  gitDiff?: FileDiff;
  cwds?: string[];
}
/** 一个文件的 Diff 标签：和文件标签同一排，同一文件的 Diff 与文件本身是两个标签 */
export interface DiffTabSpec {
  /** 同一个文件、同一个来源（git 暂存 / 未暂存、本会话改动）的稳定标识 */
  key: string;
  /** 文件路径（标签名取文件名） */
  path: string;
  /** 这个文件的改动（FileReview 渲染） */
  file: DiffTabFile;
  /** 相对路径基于这个目录 */
  cwd?: string | null;
  /** 在 Diff 里保存了文件之后（刷新 git） */
  onSaved?: () => void;
}
export interface ResourceContextValue {
  scope: ResourceScope;
  open: (href: string, scope: ResourceScope, image?: ResourceImageInfo) => void;
  /** 在预览区打开（或切到）这个文件的 Diff 标签，带上最新的改动 */
  openDiff?: (diff: DiffTabSpec) => void;
  /** 已经开着的 Diff 标签换成最新的改动（没开着不打开） */
  updateDiff?: (diff: DiffTabSpec) => void;
}
export const ResourceContext = createContext<ResourceContextValue | null>(null);
export const useResourceContext = () => useContext(ResourceContext);
export const ResourceScopeProvider: React.FC<{
  value: ResourceContextValue;
  children: React.ReactNode;
}> = ({ value, children }) => (
  <ResourceContext.Provider value={value}>{children}</ResourceContext.Provider>
);
