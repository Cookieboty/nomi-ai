/**
 * 标签区的标签弹到独立窗口（docs/design/side-tabs-workspace.md「弹出到新窗口」）：纯函数，便于单测。
 * - id：宿主记的身份 = [会话键, 标签键]（同一会话的同一个标签只开一个窗口，再弹一次是把它提到最前）；
 * - spec：新窗口要画什么，放在页面地址的 ?detached= 里（宿主原样转交，不解析）。
 *   子任务：会话键 + 子任务（harness / nested / nomi-task / side-chat）；文件：链接 + 来源会话的范围（cwd 等）。
 *   侧边聊天的内容不在 spec 里：经宿主内存交接（chatWindow.handoffPut / handoffTake，id 同窗口 id）。
 */
import type { ResourceScope } from '../contexts/ResourceContext';

import { agentKey, type SubagentTarget } from './sideTabs';

export const DETACH_QUERY = 'detached';

export type DetachSpec =
  | { v: 1; kind: 'agent'; scope: string; target: SubagentTarget; title: string }
  | {
      v: 1;
      kind: 'file';
      scope: string;
      key: string;
      href: string;
      origin: ResourceScope;
      title: string;
    };

export function detachedId(scope: string, key: string): string {
  return JSON.stringify([scope, key]);
}

export function parseDetachedId(id: string): { scope: string; key: string } | null {
  try {
    const v = JSON.parse(id) as unknown;
    if (Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && typeof v[1] === 'string')
      return { scope: v[0], key: v[1] };
  } catch {
    /* 不是我们发的 id */
  }
  return null;
}

/** 这个会话里弹出去了哪些标签（标签键） */
export function detachedKeysFor(ids: readonly string[], scope: string): Set<string> {
  const out = new Set<string>();
  for (const id of ids) {
    const p = parseDetachedId(id);
    if (p && p.scope === scope) out.add(p.key);
  }
  return out;
}

/** 弹出窗口里的标签键（宿主 id 的第二段） */
export function detachSpecKey(spec: DetachSpec): string {
  return spec.kind === 'agent' ? agentKey(spec.target) : spec.key;
}

/** 能不能弹出：主会话里的进程内子代理只读、靠主列的消息拼出来，独立窗口里没有主列，不弹 */
export function canDetachTarget(target: SubagentTarget): boolean {
  return target.kind !== 'nested' || target.parentTabId !== null;
}

const isScope = (v: unknown): v is ResourceScope =>
  !!v && typeof v === 'object' && typeof (v as { id?: unknown }).id === 'string';

/** 从页面地址的查询串里读 spec（不是弹出窗口时 null） */
export function parseDetachSpec(search: string): DetachSpec | null {
  let raw: string | null;
  try {
    raw = new URLSearchParams(search).get(DETACH_QUERY);
  } catch {
    return null;
  }
  if (!raw) return null;
  let v: Record<string, unknown>;
  try {
    v = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!v || typeof v !== 'object' || v.v !== 1 || typeof v.scope !== 'string') return null;
  const title = typeof v.title === 'string' ? v.title : '';
  if (v.kind === 'agent') {
    const t = v.target as Record<string, unknown> | undefined;
    if (!t || typeof t !== 'object') return null;
    let target: SubagentTarget | null = null;
    if (t.kind === 'harness' && typeof t.tabId === 'string' && t.tabId)
      target = { kind: 'harness', tabId: t.tabId };
    else if (t.kind === 'nomi-task' && typeof t.taskId === 'string' && t.taskId)
      target = { kind: 'nomi-task', taskId: t.taskId };
    else if (t.kind === 'side-chat' && typeof t.chatId === 'string' && t.chatId)
      target = { kind: 'side-chat', chatId: t.chatId };
    else if (
      t.kind === 'nested' &&
      typeof t.callId === 'string' &&
      t.callId &&
      typeof t.parentTabId === 'string'
    )
      target = { kind: 'nested', callId: t.callId, parentTabId: t.parentTabId };
    return target ? { v: 1, kind: 'agent', scope: v.scope, target, title } : null;
  }
  if (
    v.kind === 'file' &&
    typeof v.key === 'string' &&
    typeof v.href === 'string' &&
    isScope(v.origin)
  )
    return {
      v: 1,
      kind: 'file',
      scope: v.scope,
      key: v.key,
      href: v.href,
      origin: v.origin,
      title,
    };
  return null;
}
