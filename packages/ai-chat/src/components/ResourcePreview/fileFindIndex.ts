// Bound DOM ranges and source-mirror nodes even for a single-character query in a large file.
export const MAX_FIND_MATCHES = 10_000;

export interface TextMatch {
  start: number;
  end: number;
}
export interface FileMatch extends TextMatch {
  range?: Range;
}

/** Literal, case-insensitive search. RegExp preserves UTF-16 offsets (lowercasing need not). */
export function findText(text: string, query: string, limit = MAX_FIND_MATCHES + 1): TextMatch[] {
  if (!query) return [];
  const expression = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu');
  const matches: TextMatch[] = [];
  for (const m of text.matchAll(expression)) {
    if (matches.length >= limit) break;
    matches.push({ start: m.index, end: m.index + m[0].length });
  }
  return matches;
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
