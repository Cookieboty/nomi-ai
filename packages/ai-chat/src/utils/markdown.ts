/**
 * 流式 Markdown 的「安全分块」工具。
 * ReactMarkdown 负责解析与渲染；本工具只做增量分段，让已经完成的段落在后续 token
 * 到达时无需重新解析，提升性能。拆分边界必须在围栏代码块之外的空行之后，且前后
 * 不是列表 / 缩进 / 引用的延续（避免把一个松散列表拆成两个列表）。
 */
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s/;
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;
const QUOTE = /^ {0,3}>\s?/;

export function splitMarkdownChunks(src: string): string[] {
  const text = src.replace(/\r\n?/g, '\n');
  const lines = text.split('\n');
  const chunks: string[] = [];
  let start = 0;
  let fence: RegExp | null = null;
  let prevLine = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (fence) {
      if (fence.test(line)) fence = null;
      prevLine = line;
      continue;
    }
    const open = FENCE_OPEN.exec(line);
    if (open) {
      fence = new RegExp(`^ {0,3}${open[1]![0]}{${open[1]!.length},}\\s*$`);
      prevLine = line;
      continue;
    }
    if (!line.trim() && prevLine.trim()) {
      let j = i + 1;
      while (j < lines.length && !lines[j]!.trim()) j++;
      if (j < lines.length) {
        const next = lines[j]!;
        const sticky =
          LIST_ITEM.test(next) ||
          /^\s{2,}\S/.test(next) ||
          (QUOTE.test(next) && QUOTE.test(prevLine));
        if (!sticky) {
          chunks.push(lines.slice(start, j).join('\n'));
          start = j;
          i = j - 1;
          prevLine = '';
          continue;
        }
      }
    }
    if (line.trim()) prevLine = line;
  }
  chunks.push(lines.slice(start).join('\n'));
  return chunks;
}
