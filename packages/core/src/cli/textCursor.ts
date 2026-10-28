/**
 * 把 CLI 先后发来的正文收成一条字符串，并记下每一段的起点。
 * 与渲染进程 packages/ai-chat/src/utils/textCursor.ts 保持同一规则。
 */
import type { HarnessEvent } from './types';

export function mergeAssistantText(
  prev: string,
  incoming: string,
  breaks: readonly number[],
  kind: 'segment' | 'final',
): { text: string; breaks: number[] } {
  const next = incoming;
  if (!next.trim()) return { text: prev, breaks: [...breaks] };
  if (!prev) return { text: next, breaks: [...breaks] };
  if (next === prev || prev.endsWith(next)) return { text: prev, breaks: [...breaks] };
  if (next.startsWith(prev)) return { text: next, breaks: [...breaks] };
  if (kind === 'final' && prev.includes(next.trim())) return { text: prev, breaks: [...breaks] };
  return { text: `${prev}\n\n${next}`, breaks: [...breaks, prev.length + 2] };
}

/** 按事件推进正文，并给工具 / 思考记下当时的字符位置 */
export function foldAssistantEvent(
  prev: string,
  breaks: readonly number[],
  ev: HarnessEvent,
): { text: string; breaks: number[]; ev: HarnessEvent } {
  if (ev.type === 'text-delta') return { text: prev + ev.text, breaks: [...breaks], ev };
  if (ev.type === 'text' || ev.type === 'done') {
    const folded = mergeAssistantText(
      prev,
      ev.text,
      breaks,
      ev.type === 'done' ? 'final' : 'segment',
    );
    return { text: folded.text, breaks: folded.breaks, ev };
  }
  if ((ev.type === 'tool' || ev.type === 'thinking') && ev.textAt === undefined)
    return { text: prev, breaks: [...breaks], ev: { ...ev, textAt: prev.length } };
  return { text: prev, breaks: [...breaks], ev };
}
