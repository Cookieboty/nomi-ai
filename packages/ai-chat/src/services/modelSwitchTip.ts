/**
 * 「会话中途换了模型」的弱提示（发送下一条消息前一直显示）：
 * 编程助手标签在 setTabModel / 带模型的 setTabSource 成功后记一笔，发送时清掉。
 * 只在内存里（不跨重启）；Nomi 对话不用它——直接比较最后一条助手消息的模型与当前模型。
 */
import { useSyncExternalStore } from 'react';

const switched = new Map<string, string>();
const listeners = new Set<() => void>();

function emit() {
  for (const fn of listeners) fn();
}

/** 标签换了模型（model 为空串 = 回到 CLI 默认模型） */
export function noteModelSwitch(tabId: string, model: string): void {
  if (switched.get(tabId) === model) return;
  switched.set(tabId, model);
  emit();
}

/** 发送了消息（新模型已经开始接手这段会话）：提示消失 */
export function clearModelSwitch(tabId: string): void {
  if (switched.delete(tabId)) emit();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** 这个标签自上次发送以来切到的模型；没切过返回 undefined */
export function useModelSwitch(tabId: string): string | undefined {
  return useSyncExternalStore(
    subscribe,
    () => switched.get(tabId),
    () => undefined,
  );
}

/**
 * 要不要显示提示：会话里已经有助手回复，切换后的模型和最后一条助手消息的模型不同
 * （切回原来的模型就不提示；旧消息没记模型时按「切过」处理）。
 */
export function modelSwitchTipFor(
  messages: ReadonlyArray<{ role: string; model?: string }>,
  target: string | undefined,
): string | null {
  if (target === undefined) return null;
  let last: { model?: string } | undefined;
  for (let i = messages.length - 1; i >= 0; i--)
    if (messages[i]!.role === 'assistant') {
      last = messages[i];
      break;
    }
  if (!last) return null;
  if (last.model && target && last.model === target) return null;
  return target;
}

/**
 * Nomi 对话：当前模型和最后一条助手消息记的模型不同（在别处换过模型也算），下一条会由新模型接手。
 * 两边都知道模型时才判断；会话还没有助手回复不提示。
 */
export function derivedSwitchTip(
  messages: ReadonlyArray<{ role: string; model?: string }>,
  current: string | undefined,
): string | null {
  if (!current) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== 'assistant') continue;
    return m.model && m.model !== current ? current : null;
  }
  return null;
}
