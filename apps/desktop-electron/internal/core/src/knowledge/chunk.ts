/**
 * 文本分块：按段落累积到 ~size 字符，过长段落硬切；相邻块保留 overlap 字符上下文。
 * pdf 逐页分块，块上记录页码，方便引用跳转。
 */
export interface Chunk {
  text: string;
  page?: number;
  /** 块在原文（或该页）中的起始字符位置 */
  offset: number;
}

export function chunkText(text: string, size = 800, overlap = 120, page?: number): Chunk[] {
  const clean = text.replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n');
  const out: Chunk[] = [];
  if (!clean.trim()) return out;
  let start = 0;
  while (start < clean.length) {
    let end = Math.min(clean.length, start + size);
    if (end < clean.length) {
      // 尽量在段落 / 句子边界断开
      const win = clean.slice(start + Math.floor(size * 0.5), end);
      const cut = Math.max(
        win.lastIndexOf('\n\n'),
        win.lastIndexOf('\n'),
        win.lastIndexOf('。'),
        win.lastIndexOf('. '),
      );
      if (cut > 0) end = start + Math.floor(size * 0.5) + cut + 1;
    }
    const t = clean.slice(start, end).trim();
    if (t) out.push({ text: t, offset: start, ...(page ? { page } : {}) });
    if (end >= clean.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return out;
}

export function chunkPages(pages: string[], size = 800, overlap = 120): Chunk[] {
  return pages.flatMap((p, i) => chunkText(p, size, overlap, i + 1));
}
