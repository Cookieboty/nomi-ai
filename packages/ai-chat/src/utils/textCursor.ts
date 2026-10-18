/**
 * 把 CLI 先后发来的正文收成一条字符串，并记下每一段的起点。
 * 流式片段直接拼接；一整段新消息另起一段；已经包含在内的快照不重复。
 * 分段起点一直指向原有前缀，后面的工具才能插回当时的位置。
 */
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
