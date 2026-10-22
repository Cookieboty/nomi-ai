/** 从行级 DiffResult 还原旧/新文本（用于丢弃本轮变更） */
import type { DiffResult } from './lineDiff';

export function reconstructOldText(diff: DiffResult): string | null {
  if (!diff.lines.length) return null;
  const parts: string[] = [];
  let any = false;
  for (const l of diff.lines) {
    if (l.type === 'hunk') continue;
    if (l.type === 'ctx' || l.type === 'del') {
      parts.push(l.text);
      any = true;
    }
  }
  return any ? parts.join('\n') : null;
}

export function reconstructNewText(diff: DiffResult): string | null {
  if (!diff.lines.length) return null;
  const parts: string[] = [];
  let any = false;
  for (const l of diff.lines) {
    if (l.type === 'hunk') continue;
    if (l.type === 'ctx' || l.type === 'add') {
      parts.push(l.text);
      any = true;
    }
  }
  return any ? parts.join('\n') : null;
}
