/**
 * 看板娘气泡文本的唯一出口。
 *
 * 安全约定：气泡**只渲染纯文本**（React 文本节点 / textContent），永不走 innerHTML。
 * 任何来源（AI 回复、提示语、工具结果、摘要、外部 API）进来的字符串都按字面显示，
 * 其中的 `<script>` / `<img onerror>` 等只是普通字符。本函数只做“显示层”清理：
 * 去掉控制字符 / 双向覆盖字符（防止视觉欺骗），把 Markdown 标记降级为朴素文字，合并空白，按字符截断。
 */
const MAX_LEN = 400;
// C0/C1 控制字符（保留 \n）、零宽与双向覆盖字符
const STRIP =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u0009\u000B-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;

/**
 * 把常见 Markdown 标记降级为朴素文本（气泡不渲染富文本，但也不该露出 `**` / `#` / 反引号）。
 * 只处理标记字符，不解释 HTML；行内代码 / 链接 / 图片保留可读文字，围栏代码块保留内容。
 */
export function stripMarkdown(src: string): string {
  return (
    src
      // 围栏代码块：去掉围栏与语言标记，保留内容
      .replace(/^[ \t]*(`{3,}|~{3,})[^\n]*\n?/gm, '')
      // 图片 / 链接：![alt](url) → alt，[text](url) → text
      .replace(/!\[([^\]\n]*)\]\([^)\n]*\)/g, '$1')
      .replace(/\[([^\]\n]+)\]\([^)\n]*\)/g, '$1')
      // 行内代码
      .replace(/`([^`\n]+)`/g, '$1')
      // 标题 / 引用 / 分隔线
      .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '')
      .replace(/^[ \t]{0,3}>[ \t]?/gm, '')
      .replace(/^[ \t]{0,3}([-*_])([ \t]*\1){2,}[ \t]*$/gm, '')
      // 无序列表符号
      .replace(/^([ \t]*)[-*+][ \t]+/gm, '$1• ')
      // 粗体 / 斜体 / 删除线（下划线强调只在词边界生效，避免吃掉 snake_case）
      .replace(/\*\*\*(?=\S)([\s\S]*?\S)\*\*\*/g, '$1')
      .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '$1')
      .replace(/(^|[^\w])(_{2,3})(?=\S)([^_\n]*?\S)\2(?!\w)/g, '$1$3')
      .replace(/\*(?=\S)([^*\n]*?\S)\*/g, '$1')
      .replace(/(^|[^\w])_(?=\S)([^_\n]*?\S)_(?!\w)/g, '$1$2')
      .replace(/~~(?=\S)([^~\n]*?\S)~~/g, '$1')
      // 被截断而没有闭合的粗体标记
      .replace(/\*\*/g, '')
  );
}

export function toBubbleText(input: unknown, max = MAX_LEN): string {
  if (input === null || input === undefined) return '';
  const s = typeof input === 'string' ? input : String(input);
  const cleaned = stripMarkdown(s.replace(STRIP, ''))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const chars = Array.from(cleaned);
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : cleaned;
}
