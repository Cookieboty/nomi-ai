/**
 * Nomi 委派出去的 agent（delegate_to_cli）对应哪个标签。
 * 委派卡片按调用 id 找标签；同一种委派接着用上一次的标签时（主进程 RebindDelegation 把标签上的
 * callId / taskId 换成了新那次），旧的委派就找不到了——会话详情里点它会掉成「进程内子代理」，
 * 打开一个只读的空会话。这里按结果里的 taskId / tabId 把它找回来：还是同一个 CLI 会话，
 * 接着说就是接着它自己的上下文。只用来打开 / 悬停，状态仍按这一次自己的结果。
 */
import type { HarnessTabMeta } from '../services/harnessClient';
import type { ConvMessage } from '../types/conversation';

import type { SubagentTarget } from './sideTabs';
import { baseToolName, reduceTraceCached, type ToolCall } from './toolTrace';

type Tabs = readonly HarnessTabMeta[] | undefined;

/** 工具输出里的 taskId / tabId（同步委派的 taskId 就是标签 id） */
function resultIds(output: string | undefined): string[] {
  if (!output) return [];
  try {
    const o = JSON.parse(output) as { ok?: boolean; data?: { taskId?: unknown; tabId?: unknown } };
    if (!o.ok || !o.data) return [];
    return [o.data.tabId, o.data.taskId].filter((x): x is string => typeof x === 'string' && !!x);
  } catch {
    return [];
  }
}

export function delegateOpenTab(
  call: ToolCall,
  tabs: Tabs,
  result?: { taskId?: string; tabId?: string },
): HarnessTabMeta | null {
  if (!tabs?.length) return null;
  const own = tabs.find((x) => x.delegation?.callId === call.id);
  if (own) return own;
  const prevByCall = tabs.find((x) => x.delegation?.prevCallIds?.includes(call.id));
  if (prevByCall) return prevByCall;
  const ids = [
    ...[result?.tabId, result?.taskId].filter((x): x is string => !!x),
    ...resultIds(call.output),
  ];
  if (!ids.length) return null;
  return (
    tabs.find((x) => ids.includes(x.id)) ??
    tabs.find((x) => !!x.delegation?.taskId && ids.includes(x.delegation.taskId)) ??
    tabs.find((x) => x.delegation?.prevTaskIds?.some((t) => ids.includes(t))) ??
    null
  );
}

/** 父转录里 callId 这次 delegate_to_cli 调用（没有 / 不是委派时为 null） */
export function findDelegateCall(
  messages: readonly ConvMessage[] | undefined,
  callId: string,
): ToolCall | null {
  if (!messages?.length) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const trace = messages[i]!.trace;
    if (!trace?.length) continue;
    for (const e of reduceTraceCached(trace)) {
      if (e.type === 'tool' && e.call.id === callId)
        return baseToolName(e.call.name) === 'delegate_to_cli' ? e.call : null;
    }
  }
  return null;
}

/**
 * 侧栏里按「进程内子代理」开着的其实是 Nomi 的一次委派（会话详情 / 旧版本按调用 id 打开的）：
 * 换成它的 agent 标签，和委派卡片打开的是同一个会话。找不到标签时原样返回。
 */
export function resolveDelegateTarget(
  target: SubagentTarget,
  tabs: Tabs,
  columnMessages: readonly ConvMessage[] | undefined,
): SubagentTarget {
  if (target.kind !== 'nested' || target.parentTabId) return target;
  const call = findDelegateCall(columnMessages, target.callId);
  const tab = call ? delegateOpenTab(call, tabs) : null;
  return tab ? { kind: 'harness', tabId: tab.id } : target;
}
