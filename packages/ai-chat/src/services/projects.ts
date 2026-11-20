/**
 * 项目（契约 `project.*`，内核 core/projects）：有名字的一组文件夹。
 *
 * - primary 是主文件夹：会话的工作目录、相对路径的基准、git / worktree / AGENTS.md 的来源；
 *   folders 是其余文件夹，Nomi 与 agent 在里面同样能读写；
 * - 会话（Nomi 对话的 meta、CLI 标签）只记 projectId，目录由内核每次实时取；改了项目，下一轮起生效；
 * - 移除项目只删记录，不碰磁盘；引用它的会话变成没有项目。
 *
 * 这里是视图侧的同步门面：第一次用时拉一次列表，之后跟着 `project.changed` 更新。
 * 先订阅事件再拉列表，迟到的快照只要中间改过本地状态就丢掉（否则会把刚移除的项目写回来）。
 */
import { useSyncExternalStore } from 'react';

import { api, hasTransport } from './api';

export interface Project {
  id: string;
  name: string;
  primary: string;
  folders: string[];
  /** 此刻不存在或不再允许当项目目录的文件夹 */
  missing?: string[];
  createdAt: number;
  updatedAt: number;
}

let projects: readonly Project[] = [];
let byId = new Map<string, Project>();
let started = false;
/** 本地列表改过的次数：拉列表的结果回来时据此判断这份快照是不是已经过期 */
let rev = 0;
const subs = new Set<() => void>();

const norm = (list: readonly unknown[]): Project[] =>
  list.map((p) => {
    const o = p as Project;
    return { ...o, folders: o.folders ?? [] };
  });

function set(list: readonly unknown[]): void {
  rev += 1;
  projects = norm(list);
  byId = new Map(projects.map((p) => [p.id, p]));
  subs.forEach((f) => f());
}

function start(): void {
  if (started) return;
  started = true;
  if (!hasTransport()) return;
  // 先订阅再拉列表：请求还在路上时到达的 project.changed 不能丢
  const off = api.on('project.changed', (l) => set(l));
  import.meta.hot?.dispose(off);
  // 列表只是首帧快照。拉的过程中只要来过事件或本地改过（增删改、移除），rev 就变了，
  // 这份旧快照直接丢掉——否则迟到的结果会把刚移除的项目写回侧栏（要删两次才消失）。
  const at = rev;
  void api.project
    .list()
    .then((l) => {
      if (rev === at) set(l);
    })
    .catch(() => undefined);
}

const subscribe = (fn: () => void) => {
  start();
  subs.add(fn);
  return () => void subs.delete(fn);
};

/** 全部项目（创建先后） */
export function useProjects(): readonly Project[] {
  return useSyncExternalStore(
    subscribe,
    () => projects,
    () => projects,
  );
}

/** 按 id 取（非 React 场景） */
export function projectById(id: string | undefined): Project | undefined {
  start();
  return id ? byId.get(id) : undefined;
}

export function useProject(id: string | undefined): Project | undefined {
  useProjects();
  return id ? byId.get(id) : undefined;
}

const baseName = (p: string) =>
  p
    .replace(/[\\/]+$/, '')
    .split(/[\\/]/)
    .pop() || p;

/** 项目的悬停提示：名字 + 全部文件夹（主文件夹标 ★） */
export const projectTitle = (p: Project) =>
  [p.name, ...[p.primary, ...p.folders].map((d, i) => (i === 0 ? `★ ${d}` : `  ${d}`))].join('\n');

/**
 * 会话在哪：有项目时是项目名（悬停看全部文件夹），否则是 agent 标签的工作目录（目录名）。
 * Nomi 对话的项目记在会话上，CLI 会话的记在标签上
 */
export function sessionPlace(
  meta: { projectId?: string },
  tab: { projectId?: string; cwd?: string } | undefined,
): { label: string; title: string } {
  const p = projectById(meta.projectId ?? tab?.projectId);
  if (p) return { label: p.name, title: projectTitle(p) };
  const cwd = tab?.cwd ?? '';
  return { label: cwd ? baseName(cwd) : '', title: cwd };
}

/** 项目的全部文件夹，主文件夹在前 */
export const projectRoots = (p: Project): string[] => [p.primary, ...p.folders];

const apply = (p: Project) => {
  // 等不及事件：先把结果并进本地列表，界面马上能用
  const next = projects.some((x) => x.id === p.id)
    ? projects.map((x) => (x.id === p.id ? p : x))
    : [...projects, p];
  set(next);
  return p;
};

export const projectsClient = {
  available: () => hasTransport(),
  create: async (input: { name?: string; primary: string; folders?: string[] }) =>
    apply(norm([await api.project.create(input)])[0]!),
  update: async (input: { id: string; name?: string; primary?: string; folders?: string[] }) =>
    apply(norm([await api.project.update(input)])[0]!),
  remove: async (id: string) => {
    await api.project.remove({ id });
    set(projects.filter((p) => p.id !== id));
  },
};

/** 测试用：换掉本地列表 */
export function __setProjectsForTest(list: Project[]): void {
  started = true;
  set(list);
}

/** 测试用：回到「还没开始同步」的状态（给定本地已有的列表），用来演一遍首次拉列表 */
export function __resetProjectsForTest(list: Project[] = []): void {
  started = false;
  rev = 0;
  subs.clear();
  projects = norm(list);
  byId = new Map(projects.map((p) => [p.id, p]));
}
