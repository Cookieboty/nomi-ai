/** 从会话 tool trace 聚合本会话改过的文件（Changes 面板） */
import type { ConvMessage } from '../types/conversation';

import { diffsOf, reduceTrace, type FileDiff, type ToolCall } from './toolTrace';

export interface ChangeEntry {
  file: string;
  added: number;
  removed: number;
  changeKind?: string;
  status: 'modified' | 'added' | 'deleted' | 'unknown';
  /** 展示用单字母，贴近 Codex M/A/D */
  letter: 'M' | 'A' | 'D' | '?';
  diff?: FileDiff;
  messageId: string;
}

export interface ChangesSummary {
  files: number;
  added: number;
  removed: number;
}

function statusOf(kind?: string, added = 0, removed = 0): ChangeEntry['status'] {
  const k = (kind ?? '').toLowerCase();
  if (k.includes('add') || k.includes('create')) return 'added';
  if (k.includes('del') || k.includes('remov')) return 'deleted';
  if (added && !removed && !k) return 'added';
  if (removed && !added && !k) return 'deleted';
  if (added || removed || k) return 'modified';
  return 'unknown';
}

function letterOf(status: ChangeEntry['status']): ChangeEntry['letter'] {
  if (status === 'added') return 'A';
  if (status === 'deleted') return 'D';
  if (status === 'modified') return 'M';
  return '?';
}

function toolCallsOf(m: ConvMessage): ToolCall[] {
  const events = m.trace;
  if (!events?.length) return [];
  return reduceTrace(events)
    .filter((e): e is Extract<typeof e, { type: 'tool' }> => e.type === 'tool')
    .map((e) => e.call);
}

/** 聚合会话内所有编辑/写入产物；同路径后写覆盖先写 */
export function aggregateSessionChanges(messages: readonly ConvMessage[]): ChangeEntry[] {
  const map = new Map<string, ChangeEntry>();
  for (const m of messages) {
    if (m.role !== 'assistant') continue;
    for (const call of toolCallsOf(m)) {
      for (const d of diffsOf(call)) {
        const file = d.file || '(unnamed)';
        const added = d.diff.added;
        const removed = d.diff.removed;
        const status = statusOf(d.changeKind, added, removed);
        map.set(file, {
          file,
          added,
          removed,
          changeKind: d.changeKind,
          status,
          letter: letterOf(status),
          diff: d,
          messageId: m.id,
        });
      }
    }
  }
  return [...map.values()].sort((a, b) => a.file.localeCompare(b.file));
}

export function summarizeChanges(entries: readonly ChangeEntry[]): ChangesSummary {
  let added = 0;
  let removed = 0;
  for (const e of entries) {
    added += e.added;
    removed += e.removed;
  }
  return { files: entries.length, added, removed };
}

/** 滚动到会话里产生该变更的助手消息并短暂高亮 */
export function locateChangeMessage(messageId: string): boolean {
  if (typeof document === 'undefined') return false;
  const el = document.querySelector(`[data-message-id="${CSS.escape(messageId)}"]`);
  if (!(el instanceof HTMLElement)) return false;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.setAttribute('data-change-flash', '1');
  window.setTimeout(() => el.removeAttribute('data-change-flash'), 1600);
  return true;
}

/** 单条助手消息内的文件变更（同路径后写覆盖） */
export function aggregateTurnChanges(message: ConvMessage): ChangeEntry[] {
  if (message.role !== 'assistant') return [];
  const map = new Map<string, ChangeEntry>();
  for (const call of toolCallsOf(message)) {
    for (const d of diffsOf(call)) {
      const file = d.file || '(unnamed)';
      const added = d.diff.added;
      const removed = d.diff.removed;
      const status = statusOf(d.changeKind, added, removed);
      map.set(file, {
        file,
        added,
        removed,
        changeKind: d.changeKind,
        status,
        letter: letterOf(status),
        diff: d,
        messageId: message.id,
      });
    }
  }
  return [...map.values()].sort((a, b) => a.file.localeCompare(b.file));
}

export function splitPathDisplay(file: string): { dir: string; name: string } {
  const norm = file.replace(/\\/g, '/');
  const i = norm.lastIndexOf('/');
  if (i < 0) return { dir: '', name: norm };
  return { dir: norm.slice(0, i + 1), name: norm.slice(i + 1) };
}

export interface ChangeTreeDir {
  kind: 'dir';
  name: string;
  path: string;
  children: ChangeTreeNode[];
}

export interface ChangeTreeFile {
  kind: 'file';
  name: string;
  path: string;
  entry: ChangeEntry;
}

export type ChangeTreeNode = ChangeTreeDir | ChangeTreeFile;

/** 按目录分组的变更树（右栏） */
export function buildChangeFileTree(entries: readonly ChangeEntry[]): ChangeTreeNode[] {
  type MutableDir = {
    kind: 'dir';
    name: string;
    path: string;
    children: ChangeTreeNode[];
    map: Map<string, MutableDir>;
  };
  const root: MutableDir = { kind: 'dir', name: '', path: '', children: [], map: new Map() };

  const ensureDir = (parent: MutableDir, name: string): MutableDir => {
    let d = parent.map.get(name);
    if (!d) {
      const path = parent.path ? `${parent.path}/${name}` : name;
      d = { kind: 'dir', name, path, children: [], map: new Map() };
      parent.map.set(name, d);
      parent.children.push(d);
    }
    return d;
  };

  for (const e of entries) {
    const parts = e.file.replace(/\\/g, '/').split('/').filter(Boolean);
    if (!parts.length) continue;
    let cur = root;
    for (let i = 0; i < parts.length - 1; i++) {
      cur = ensureDir(cur, parts[i]!);
    }
    const name = parts[parts.length - 1]!;
    cur.children.push({ kind: 'file', name, path: e.file, entry: e });
  }

  const freeze = (n: ChangeTreeNode): ChangeTreeNode => {
    if (n.kind === 'file') return n;
    const d = n as MutableDir;
    const children = d.children.map(freeze).sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return { kind: 'dir', name: d.name, path: d.path, children };
  };

  return root.children.map(freeze).sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

export function projectNameFromCwd(cwd?: string | null): string {
  if (!cwd) return 'workspace';
  const norm = cwd.replace(/\\/g, '/').replace(/\/+$/, '');
  const i = norm.lastIndexOf('/');
  return i >= 0 ? norm.slice(i + 1) || 'workspace' : norm || 'workspace';
}
