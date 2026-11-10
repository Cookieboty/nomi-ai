import type { MarkdownPatch } from './markdownEditing';

interface Node {
  type: string;
  children?: Node[];
  position?: { start: { offset?: number; line: number }; end: { offset?: number; line: number } };
  data?: { hProperties?: Record<string, unknown> };
}

/** Preserve the file's source locations without changing Markdown rendering. */
export function remarkPreviewSourceRanges() {
  return (tree: Node) => {
    const visit = (node: Node) => {
      const position = node.position;
      if (position && ['paragraph', 'heading', 'tableCell', 'code'].includes(node.type)) {
        node.data ??= {};
        node.data.hProperties ??= {};
        Object.assign(node.data.hProperties, {
          'data-preview-source-start': position.start.offset,
          'data-preview-source-end': position.end.offset,
          'data-preview-line-start': position.start.line,
          'data-preview-line-end': position.end.line,
        });
      }
      node.children?.forEach(visit);
    };
    visit(tree);
  };
}

export const sourceRangeProps = (props: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(props).filter(([key]) => /^data-preview-(source|line)-/.test(key)),
  );

/** Build once per source snapshot; each block lookup is then logarithmic. */
export function sourceLineIndex(text: string): (offset: number) => number {
  const starts = [0];
  for (let offset = text.indexOf('\n'); offset !== -1; offset = text.indexOf('\n', offset + 1))
    starts.push(offset + 1);
  return (offset) => {
    let low = 0,
      high = starts.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (starts[middle]! <= offset) low = middle + 1;
      else high = middle;
    }
    return Math.max(1, low);
  };
}

export function sourceLine(text: string, offset: number): number {
  return sourceLineIndex(text)(offset);
}

/** Stable edit DOM still refers to the original source; account for pending source patches. */
export function updatePreviewSourceRanges(
  root: HTMLElement | null,
  text: string,
  edits: MarkdownPatch[],
) {
  if (!root || !edits.length) return;
  const lineAt = sourceLineIndex(text);
  const sorted = [...edits].sort((a, b) => a.start - b.start);
  const mapOffset = (offset: number, end: boolean) => {
    let delta = 0;
    for (const edit of sorted) {
      if (offset < edit.start || (offset === edit.start && !end)) break;
      if (offset >= edit.end) delta += edit.text.length - (edit.end - edit.start);
      else return edit.start + delta + (end ? edit.text.length : 0);
    }
    return offset + delta;
  };
  root.querySelectorAll<HTMLElement>('[data-preview-source-start]').forEach((element) => {
    const start = mapOffset(Number(element.dataset.previewSourceStart), false);
    const end = mapOffset(Number(element.dataset.previewSourceEnd), true);
    element.dataset.previewLineStart = String(lineAt(start));
    element.dataset.previewLineEnd = String(lineAt(Math.max(start, end - 1)));
  });
}
