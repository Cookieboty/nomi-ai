/**
 * 运行中发出、还没交出去的消息（输入框上方的待发列表）：
 * - steer（Enter）：插入这一轮。等到安全点再交给 CLI / Nomi：下一个工具开始时，或入列时正好有工具在跑
 *   （CLI 在这个工具结果处取走）。交出去之前可以撤回修改或删除；交不出去（后端不支持、这一轮已结束）就排队。
 * - queue（Ctrl+Enter）：排队到这一轮结束，再作为新的一轮发出。
 * Esc（输入框里、列表非空）：停止这一轮，把列表里的消息合成一条马上发出。
 */
import type { HarnessTraceEvent } from '../services/harnessClient';

export type PendingMode = 'steer' | 'queue';

export interface PendingSend {
  id: string;
  text: string;
  mode: PendingMode;
  /** Nomi：入列时开着知识库问答（出队时走问答，见 useSendQueue） */
  kb?: boolean;
}

let seq = 0;
export const newPendingId = (): string => `p${Date.now().toString(36)}${(seq++).toString(36)}`;

/** 合成一条发送的正文（多条之间空一行） */
export function mergePending(items: readonly Pick<PendingSend, 'text'>[]): string {
  return items
    .map((i) => i.text.trim())
    .filter(Boolean)
    .join('\n\n');
}

/** 轨迹里还有没结束的工具调用（此时交出的插入消息会在它的结果处被取走） */
export function hasRunningTool(trace: readonly HarnessTraceEvent[] | undefined): boolean {
  if (!trace?.length) return false;
  const open = new Set<string>();
  for (const ev of trace) {
    if (ev.type !== 'tool') continue;
    const key = ev.id ?? ev.detail ?? ev.name;
    if (ev.status === 'start') open.add(key);
    else open.delete(key);
  }
  return open.size > 0;
}

/** 取出所有插入消息（其余留在列表里，顺序不变） */
export function takeSteer(list: readonly PendingSend[]): {
  steer: PendingSend[];
  rest: PendingSend[];
} {
  const steer: PendingSend[] = [];
  const rest: PendingSend[] = [];
  for (const i of list) (i.mode === 'steer' ? steer : rest).push(i);
  return { steer, rest };
}

/** 交不出去的插入消息改为排队，放回列表最前（保持它们原来的先后） */
export function requeue(
  list: readonly PendingSend[],
  failed: readonly PendingSend[],
): PendingSend[] {
  return [...failed.map((i) => ({ ...i, mode: 'queue' as const })), ...list];
}
