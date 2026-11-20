// Bound DOM ranges and source-mirror nodes even for a single-character query in a large file.
export const MAX_FIND_MATCHES = 10_000;

export interface TextMatch {
  start: number;
  end: number;
}
export interface FileMatch extends TextMatch {
  range?: Range;
}
export interface FindOptions {
  caseSensitive?: boolean;
  wholeWord?: boolean;
  regex?: boolean;
}
export interface FindResult {
  matches: TextMatch[];
  limited?: boolean;
  error?: string;
}

const UNICODE_WORD_CHAR = /[\p{L}\p{N}_]/u;

/** 编译查找表达式；空查询返回空对象，非法正则返回 error */
export function compileFindExpression(
  query: string,
  options?: FindOptions,
): { regex?: RegExp; error?: string } {
  if (!query) return {};
  const caseSensitive = !!options?.caseSensitive;
  const wholeWord = !!options?.wholeWord;
  const isRegex = !!options?.regex;
  try {
    let pattern: string;
    let flags: string;
    if (isRegex) {
      pattern = wholeWord ? `\\b(?:${query})\\b` : query;
      flags = caseSensitive ? 'gmu' : 'gimu';
    } else {
      const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (wholeWord) {
        const chars = Array.from(query);
        const prefix =
          chars.length && UNICODE_WORD_CHAR.test(chars[0]!) ? '(?<![\\p{L}\\p{N}_])' : '';
        const suffix =
          chars.length && UNICODE_WORD_CHAR.test(chars[chars.length - 1]!)
            ? '(?![\\p{L}\\p{N}_])'
            : '';
        pattern = `${prefix}${escaped}${suffix}`;
      } else {
        pattern = escaped;
      }
      flags = caseSensitive ? 'gu' : 'giu';
    }
    return { regex: new RegExp(pattern, flags) };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/** 通用文本查找：支持区分大小写、全字匹配、正则表达式，并自动跳过零宽空匹配 */
export function findTextMatches(
  text: string,
  query: string,
  options?: FindOptions,
  limit = MAX_FIND_MATCHES + 1,
): FindResult {
  if (!query) return { matches: [] };
  const compiled = compileFindExpression(query, options);
  if (compiled.error) return { matches: [], error: compiled.error };
  if (!compiled.regex) return { matches: [] };
  const matches: TextMatch[] = [];
  let limited = false;
  for (const m of text.matchAll(compiled.regex)) {
    if (!m[0].length) continue;
    if (matches.length >= limit) {
      limited = true;
      break;
    }
    matches.push({ start: m.index, end: m.index + m[0].length });
  }
  return limited ? { matches, limited: true } : { matches };
}

/** Literal, case-insensitive search. RegExp preserves UTF-16 offsets (lowercasing need not). */
export function findText(text: string, query: string, limit = MAX_FIND_MATCHES + 1): TextMatch[] {
  return findTextMatches(text, query, undefined, limit).matches;
}

function expandRegexReplacement(replacement: string, match: RegExpExecArray, text: string): string {
  const index = match.index ?? 0;
  return replacement.replace(
    /\\([nrt\\])|\$(\$|&|`|'|\d{1,2})/g,
    (token, esc?: string, ref?: string) => {
      if (esc !== undefined) {
        if (esc === 'n') return '\n';
        if (esc === 'r') return '\r';
        if (esc === 't') return '\t';
        return '\\';
      }
      if (ref === '$') return '$';
      if (ref === '&') return match[0];
      if (ref === '`') return text.slice(0, index);
      if (ref === "'") return text.slice(index + match[0].length);
      const group = Number(ref);
      if (group >= 1 && group < match.length) return match[group] ?? '';
      if (group >= 10) {
        const single = Math.floor(group / 10);
        const rest = ref!.slice(1);
        if (single >= 1 && single < match.length) return (match[single] ?? '') + rest;
      }
      return token;
    },
  );
}

/** 计算单次替换插入文本：非正则模式原样返回字面字符串，正则模式支持捕获组与转义符 */
export function computeReplacement(
  text: string,
  match: TextMatch,
  query: string,
  replacement: string,
  options?: FindOptions,
): string {
  if (!options?.regex) return replacement;
  const compiled = compileFindExpression(query, options);
  if (!compiled.regex) return replacement;
  const sticky = new RegExp(compiled.regex.source, `${compiled.regex.flags.replace(/g/g, '')}y`);
  sticky.lastIndex = match.start;
  const executed = sticky.exec(text);
  if (!executed) return replacement;
  return expandRegexReplacement(replacement, executed, text);
}

/** 替换文本中的单个匹配项 */
export function replaceSingleInText(
  text: string,
  match: TextMatch,
  query: string,
  replacement: string,
  options?: FindOptions,
): { text: string; insertedLength: number } {
  const inserted = computeReplacement(text, match, query, replacement, options);
  return {
    text: text.slice(0, match.start) + inserted + text.slice(match.end),
    insertedLength: inserted.length,
  };
}

/** 一次线性遍历替换全文本中的所有非空匹配 */
export function replaceAllInText(
  text: string,
  query: string,
  replacement: string,
  options?: FindOptions,
): { text: string; count: number; error?: string } {
  if (!query) return { text, count: 0 };
  const compiled = compileFindExpression(query, options);
  if (compiled.error) return { text, count: 0, error: compiled.error };
  if (!compiled.regex) return { text, count: 0 };
  const parts: string[] = [];
  let cursor = 0;
  let count = 0;
  for (const m of text.matchAll(compiled.regex)) {
    if (!m[0].length) continue;
    parts.push(text.slice(cursor, m.index));
    const inserted = options?.regex ? expandRegexReplacement(replacement, m, text) : replacement;
    parts.push(inserted);
    cursor = m.index + m[0].length;
    count++;
  }
  if (!count) return { text, count: 0 };
  parts.push(text.slice(cursor));
  return { text: parts.join(''), count };
}

const IGNORE =
  'button, input, textarea, [aria-hidden="true"], [data-preview-find-ignore], .react-syntax-highlighter-line-number, script, style';
const BLOCK = 'p, h1, h2, h3, h4, h5, h6, pre, li, td, th, blockquote, [data-preview-find-line]';

/** Index only document text, joining inline formatting but separating paragraphs/cells. */
export function documentTextIndex(root: Element) {
  const nodes: { node: Text; start: number; end: number }[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let text = '';
  let previousBlock: Element | null = null;
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    if (!node.data || node.parentElement?.closest(IGNORE)) continue;
    const block = node.parentElement?.closest(BLOCK) ?? root;
    if (nodes.length && block !== previousBlock && !text.endsWith('\n')) text += '\n';
    nodes.push({ node, start: text.length, end: text.length + node.data.length });
    text += node.data;
    previousBlock = block;
  }
  const nodeAt = (offset: number, end: boolean) => {
    let low = 0,
      high = nodes.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (end ? nodes[mid]!.end < offset : nodes[mid]!.end <= offset) low = mid + 1;
      else high = mid;
    }
    return nodes[low];
  };
  return {
    text,
    range(match: TextMatch) {
      const start = nodeAt(match.start, false);
      const end = nodeAt(match.end, true);
      if (!start || !end) return undefined;
      const range = document.createRange();
      range.setStart(start.node, Math.max(0, match.start - start.start));
      range.setEnd(end.node, match.end - end.start);
      return range;
    },
  };
}

/** Scroll only document-owned scrollers, never the conversation or the app window. */
export function revealFindRange(range: Range, boundary: HTMLElement) {
  // Search can target text in a table whose layout has been deferred. Reveal it
  // before measuring the range so both the viewport and horizontal scroller move.
  const table = range.startContainer.parentElement?.closest<HTMLElement>(
    '[data-preview-lazy-table]',
  );
  if (table && boundary.contains(table)) table.dataset.previewRevealed = 'true';
  let el = range.startContainer.parentElement;
  while (el && el !== boundary) {
    const css = getComputedStyle(el);
    const rect = range.getBoundingClientRect();
    const box = el.getBoundingClientRect();
    if (/auto|scroll/.test(css.overflowY) && (rect.top < box.top || rect.bottom > box.bottom))
      el.scrollTop += rect.top - box.top - el.clientHeight / 2;
    if (/auto|scroll/.test(css.overflowX) && (rect.left < box.left || rect.right > box.right))
      el.scrollLeft += rect.left - box.left - el.clientWidth / 2;
    el = el.parentElement;
  }
}

/** 选中 textarea 中指定区间并在超出可视区时滚动到中央（不抢占焦点） */
export function revealTextareaRange(
  textarea: HTMLTextAreaElement,
  start: number,
  end: number,
): void {
  try {
    textarea.setSelectionRange(start, end);
  } catch {
    /* ignore */
  }
  const before = textarea.value.slice(0, start);
  let line = 0;
  for (let i = 0; i < before.length; i++) {
    if (before.charCodeAt(i) === 10) line++;
  }
  const css = getComputedStyle(textarea);
  const parsedLineHeight = Number.parseFloat(css.lineHeight);
  const lineHeight =
    Number.isFinite(parsedLineHeight) && parsedLineHeight > 0 ? parsedLineHeight : 20;
  const paddingTop = Number.parseFloat(css.paddingTop) || 0;
  const targetY = paddingTop + line * lineHeight;
  const viewTop = textarea.scrollTop;
  const viewBottom = viewTop + textarea.clientHeight;
  if (textarea.clientHeight > 0 && (targetY < viewTop || targetY + lineHeight > viewBottom)) {
    textarea.scrollTop = Math.max(0, targetY - textarea.clientHeight / 2);
  }
}
