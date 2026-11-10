/** Source line plus the block's viewport offset survives lazy table size changes. */
export interface DocumentAnchor {
  line: number;
  top: number;
}
export function captureDocumentAnchor(root: HTMLElement): DocumentAnchor | undefined {
  const doc = root.ownerDocument;
  if (typeof doc.elementFromPoint !== 'function') return;
  const box = root.getBoundingClientRect();
  const target = doc.elementFromPoint(
    box.left + box.width / 2,
    box.top + Math.min(120, box.height / 3),
  );
  const block = target?.closest<HTMLElement>('[data-preview-line-start]');
  if (!block || !root.contains(block)) return;
  return {
    line: Number(block.dataset.previewLineStart),
    top: block.getBoundingClientRect().top - box.top,
  };
}
export function restoreDocumentAnchor(root: HTMLElement, anchor?: DocumentAnchor): boolean {
  if (!anchor) return false;
  const block = root.querySelector<HTMLElement>(`[data-preview-line-start="${anchor.line}"]`);
  if (!block) return false;
  const table = block.closest<HTMLElement>('[data-preview-lazy-table]');
  if (table) table.dataset.previewRevealed = 'true';
  root.scrollTop +=
    block.getBoundingClientRect().top - root.getBoundingClientRect().top - anchor.top;
  return true;
}
