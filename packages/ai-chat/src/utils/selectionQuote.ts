/**
 * 选中文字的引用（对话 / 子任务 / 文件里选中一段 →「添加到对话」/「在侧边聊天中提问」）。
 * 输入框草稿里存成一段带标记的引用块，编辑时显示成一个「引用」胶囊，发送时原样发给模型：
 *
 *   > [!quote] 来源
 *   > 选中的第一行
 *   > 选中的第二行
 *
 * 文件里的选区仍用文件链接（路径 + 行号，见 useReferenceDraft）。设计见 docs/design/side-tabs-workspace.md。
 */

export interface SelectionQuote {
  /** 选中的文字（已去掉首尾空行，超长截断） */
  text: string;
  /** 来源：「Nomi 的回复」「Claude Code · 你的消息」「a.ts:3-8」等 */
  source: string;
  /** 文件选区：文件链接（路径 + 行号）；有它时「添加到对话」用文件链接 */
  href?: string;
}

/** 一段引用最多带这么多字（再多就截断，避免把整篇对话贴进去） */
export const QUOTE_MAX_CHARS = 4000;
const MARKER = '[!quote]';

export function normalizeQuoteText(text: string): string {
  const t = text
    .replace(/\r\n?/g, '\n')
    .replace(/^\s*\n/, '')
    .replace(/\s+$/, '');
  return t.length > QUOTE_MAX_CHARS ? `${t.slice(0, QUOTE_MAX_CHARS)}…` : t;
}

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

/** 引用块的 Markdown（发给模型 / 存在草稿里） */
export function quoteMarkdown(q: SelectionQuote): string {
  const body = normalizeQuoteText(q.text)
    .split('\n')
    .map((line) => (line ? `> ${line}` : '>'));
  return [`> ${MARKER} ${oneLine(q.source)}`.trimEnd(), ...body].join('\n');
}

/** 胶囊上的短标签：前 24 个字 */
export function quoteExcerpt(text: string, max = 24): string {
  const s = oneLine(text);
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/**
 * 从第 start 行开始读一段引用块；不是引用块时返回 null。
 * end = 引用块之后的下一行下标。
 */
export function readQuoteBlock(
  lines: readonly string[],
  start: number,
): { quote: SelectionQuote; markdown: string; end: number } | null {
  const head = /^ {0,3}> \[!quote\](?: (.*))?$/.exec(lines[start] ?? '');
  if (!head) return null;
  const body: string[] = [];
  let i = start + 1;
  for (; i < lines.length; i++) {
    const m = /^ {0,3}>(?: (.*))?$/.exec(lines[i]!);
    if (!m) break;
    body.push(m[1] ?? '');
  }
  const text = body.join('\n');
  if (!text.trim()) return null;
  return {
    quote: { text, source: (head[1] ?? '').trim() },
    markdown: lines.slice(start, i).join('\n'),
    end: i,
  };
}

/** 草稿里引用胶囊的键（同一段引用只留一个） */
export function quoteKey(markdown: string): string {
  let h = 0;
  for (let i = 0; i < markdown.length; i++) h = (Math.imul(h, 31) + markdown.charCodeAt(i)) | 0;
  return `quote:${(h >>> 0).toString(36)}:${markdown.length}`;
}
