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

function occurrences(hay: string, needle: string): number[] {
  const at: number[] = [];
  if (!needle) return at;
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + 1)) {
    at.push(i);
    if (at.length > 1) break;
  }
  return at;
}

/**
 * 在「当前文件内容」上反向应用一份 diff（把「新」换回「旧」），返回还原后的整份内容。
 *
 * 工具产生的 diff 只是改动片段（Edit 的 old_string / new_string、补丁的几个 hunk），
 * 不是整个文件，所以不能用 reconstructOldText 的结果直接覆盖文件（那会把整个文件替换成一小段）。
 * 这里把每一段（以 hunk 行分隔）里的「新文本」在当前内容中定位，必须恰好出现一次才替换；
 * 找不到（文件之后又被改过）或出现多次（无法确定是哪一处）时返回 null，不要猜。
 */
export function reverseApplyDiff(current: string, diff: DiffResult): string | null {
  const eol = current.includes('\r\n') ? '\r\n' : '\n';
  const segments: { oldLines: string[]; newLines: string[]; changed: boolean }[] = [];
  let seg = { oldLines: [] as string[], newLines: [] as string[], changed: false };
  const flush = () => {
    if (seg.changed) segments.push(seg);
    seg = { oldLines: [], newLines: [], changed: false };
  };
  for (const l of diff.lines) {
    if (l.type === 'hunk') flush();
    else if (l.type === 'ctx') {
      seg.oldLines.push(l.text);
      seg.newLines.push(l.text);
    } else if (l.type === 'del') {
      seg.oldLines.push(l.text);
      seg.changed = true;
    } else {
      seg.newLines.push(l.text);
      seg.changed = true;
    }
  }
  flush();
  if (!segments.length) return null;

  let out = current;
  for (const s of segments) {
    const needle = s.newLines.join(eol);
    if (!needle) return null; // 纯删除且没有上下文：无法定位
    const at = occurrences(out, needle);
    if (at.length !== 1) return null;
    const i = at[0]!;
    if (s.oldLines.length) {
      out = out.slice(0, i) + s.oldLines.join(eol) + out.slice(i + needle.length);
    } else {
      // 纯新增：连同一个换行一起删掉
      const end = i + needle.length;
      out = out.startsWith(eol, end)
        ? out.slice(0, i) + out.slice(end + eol.length)
        : i >= eol.length && out.startsWith(eol, i - eol.length)
          ? out.slice(0, i - eol.length) + out.slice(end)
          : out.slice(0, i) + out.slice(end);
    }
  }
  return out;
}
