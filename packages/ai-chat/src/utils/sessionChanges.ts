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
