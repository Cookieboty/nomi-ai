/** 从会话 tool trace 聚合本会话改过的文件（Changes 面板） */
import type { ConvMessage } from '../types/conversation';

import { diffsOf, reduceTrace, type FileDiff, type ToolCall } from './toolTrace';

export interface ChangeEntry {
  file: string;
  added: number;
  removed: number;
  changeKind?: string;
  status: 'modified' | 'added' | 'deleted' | 'unknown';
  diff?: FileDiff;
  messageId: string;
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
        map.set(file, {
          file,
          added,
          removed,
          changeKind: d.changeKind,
          status: statusOf(d.changeKind, added, removed),
          diff: d,
          messageId: m.id,
        });
      }
    }
  }
  return [...map.values()].sort((a, b) => a.file.localeCompare(b.file));
}
