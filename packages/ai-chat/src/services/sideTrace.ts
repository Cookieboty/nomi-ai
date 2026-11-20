/**
 * 运行轨迹工作区标签的内存注册表（只存当前运行时，不跨应用重启落盘）：
 * - 让 TraceAction（单轮）、SessionDetails（全会话）与任务页可把轨迹打开在 SideWorkspace 独立标签中；
 * - TraceSource / Task / ConvMessage 引用只保留在内存 Map 中，避免把重对象写进 localStorage。
 */
import { useSyncExternalStore } from 'react';

import type { TraceSource } from '../components/TraceDrawer/sessionLoader';
import type { ConvMessage } from '../types/conversation';

import type { Attempt, Task } from './tasksClient';

export type SideTraceSpec =
  | { kind: 'session'; title?: string }
  | {
      kind: 'turn';
      message: ConvMessage;
      source: TraceSource;
      userPrompt?: string;
      title?: string;
    }
  | { kind: 'task'; task: Task; attempts?: readonly Attempt[]; title?: string };

export interface SideTraceEntry {
  id: string;
  scope: string;
  spec: SideTraceSpec;
}

const entries = new Map<string, SideTraceEntry>();
const listeners = new Set<() => void>();
let seq = 0;

function emit(): void {
  for (const fn of listeners) fn();
}

function nextId(): string {
  return `tr-${Date.now().toString(36)}-${(++seq).toString(36)}`;
}

export function subscribeSideTrace(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function sideTraceOf(id: string): SideTraceEntry | undefined {
  return entries.get(id);
}

export function useSideTrace(id: string): SideTraceEntry | undefined {
  return useSyncExternalStore(
    subscribeSideTrace,
    () => entries.get(id),
    () => undefined,
  );
}

/** 注册或更新一条内存轨迹标签载荷，返回其唯一 id */
export function registerSideTrace(scope: string, spec: SideTraceSpec, id = nextId()): string {
  entries.set(id, { id, scope, spec });
  emit();
  return id;
}

export function discardSideTrace(id: string): void {
  if (!entries.delete(id)) return;
  emit();
}

export function discardSideTracesInScope(scope: string): void {
  if (!scope) return;
  let changed = false;
  for (const [id, entry] of entries) {
    if (entry.scope === scope) {
      entries.delete(id);
      changed = true;
    }
  }
  if (changed) emit();
}

export function migrateSideTracesScope(fromScope: string, toScope: string): void {
  if (!fromScope || !toScope || fromScope === toScope) return;
  let changed = false;
  for (const [id, entry] of entries) {
    if (entry.scope === fromScope) {
      entries.set(id, { ...entry, scope: toScope });
      changed = true;
    }
  }
  if (changed) emit();
}

export function clearSideTracesForTest(): void {
  if (entries.size === 0) return;
  entries.clear();
  emit();
}
