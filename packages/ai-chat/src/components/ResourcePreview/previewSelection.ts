import { codeViewAt } from './codeViewModel';
import { sourceLine } from './previewSourceRanges';

export interface PreviewSelection {
  text: string;
  start: number;
  end: number;
}
const BLOCK = '[data-preview-line-start]';
const IGNORED = '[data-preview-find-ignore], .react-syntax-highlighter-line-number';
const plain = (fragment: DocumentFragment | HTMLElement) => {
  const copy = fragment.cloneNode(true) as DocumentFragment | HTMLElement;
  copy.querySelectorAll(IGNORED).forEach((node) => node.remove());
  return copy.textContent ?? '';
};

/** Capture selection and source lines before moving focus to the context menu. */
export function previewSelection(root: HTMLElement, target: Element): PreviewSelection | null {
  const content = target.closest<HTMLElement>('[data-preview-find-content]');
  if (
    !content ||
    !root.contains(content) ||
    target.closest('[data-preview-find-ignore], .cm-gutters')
  )
    return null;
  const code = codeViewAt(content);
  if (code) {
    const range = code.state.selection.main;
    const at = code.contentDOM.contains(target) ? code.posAtDOM(target) : range.head;
    const line = code.state.doc.lineAt(at);
    const from = range.empty ? line.from : range.from;
    const to = range.empty ? line.to : range.to;
    const text = code.state.sliceDoc(from, to);
    return text.trim()
      ? {
          text,
          start: code.state.doc.lineAt(from).number,
          end: code.state.doc.lineAt(Math.max(from, to - 1)).number,
        }
      : null;
  }
  if (content instanceof HTMLTextAreaElement) {
    let start = content.selectionStart,
      end = content.selectionEnd;
    if (start === end) {
      start = content.value.lastIndexOf('\n', start - 1) + 1;
      const next = content.value.indexOf('\n', end);
      end = next < 0 ? content.value.length : next;
    }
    const text = content.value.slice(start, end);
    return text.trim()
      ? {
          text,
          start: sourceLine(content.value, start),
          end: sourceLine(content.value, Math.max(start, end - 1)),
        }
      : null;
  }
  const selection = window.getSelection();
  const range = selection?.rangeCount && !selection.isCollapsed ? selection.getRangeAt(0) : null;
  if (range && content.contains(range.commonAncestorContainer) && range.intersectsNode(target)) {
    const blocks = Array.from(
      content.querySelectorAll<HTMLElement>(`${BLOCK}, [data-preview-find-line]`),
    ).filter((block) => {
      if (!range.intersectsNode(block)) return false;
      // Empty intersections at the next paragraph boundary must not add a source line.
      const intersection = range.cloneRange();
      intersection.selectNodeContents(block);
      if (range.compareBoundaryPoints(Range.START_TO_START, intersection) > 0)
        intersection.setStart(range.startContainer, range.startOffset);
      if (range.compareBoundaryPoints(Range.END_TO_END, intersection) < 0)
        intersection.setEnd(range.endContainer, range.endOffset);
      return !!plain(intersection.cloneContents()).trim();
    });
    const lines = blocks.map(lineRange).filter((item): item is [number, number] => !!item);
    const text = content.hasAttribute('data-resource-document')
      ? selection!.toString()
      : plain(range.cloneContents());
    if (text.trim() && lines.length)
      return {
        text,
        start: Math.min(...lines.map(([start]) => start)),
        end: Math.max(...lines.map(([, end]) => end)),
      };
  }
  const block = target.closest<HTMLElement>(`${BLOCK}, [data-preview-find-line]`);
  const lines = block && content.contains(block) ? lineRange(block) : null;
  const text = block ? plain(block) : '';
  return lines && text.trim() ? { text, start: lines[0], end: lines[1] } : null;
}
function lineRange(element: HTMLElement): [number, number] | null {
  const start = Number(element.dataset.previewLineStart ?? element.id.replace('preview-line-', ''));
  const end = Number(element.dataset.previewLineEnd ?? start);
  return Number.isSafeInteger(start) && start > 0 && end >= start ? [start, end] : null;
}
