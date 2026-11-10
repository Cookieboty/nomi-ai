import { blockMarkdown, structuralDeletePatch, type MarkdownPatch } from './markdownEditing';

const selector = '[data-preview-edit-block]';
const mergeable = new Set(['paragraph', 'heading', 'listItem']);
export function selectedBlock(root: HTMLElement, node: Node | null): HTMLElement | undefined {
  const element =
    node?.nodeType === Node.ELEMENT_NODE ? (node as HTMLElement) : node?.parentElement;
  const block = element?.closest<HTMLElement>(selector);
  return block && root.contains(block) && !block.closest('[hidden]') ? block : undefined;
}
export function visibleEditBlocks(root: HTMLElement) {
  return Array.from(root.querySelectorAll<HTMLElement>(selector)).filter(
    (block) => !block.closest('[hidden]') && !block.querySelector(selector),
  );
}
/** Native caret placement can land on the host beside an empty paragraph. */
export function prepareEmptyMarkdownCaret(root: HTMLElement) {
  const selection = window.getSelection();
  if (
    !selection?.isCollapsed ||
    !root.contains(selection.anchorNode) ||
    selectedBlock(root, selection.anchorNode)
  )
    return;
  const block = root.querySelector<HTMLElement>('[data-md-empty-document]');
  if (block && !block.textContent && !block.closest('[hidden]')) focusBlockOffset(root, block, 0);
}
export function putMarkdownPatch(patches: Map<number, MarkdownPatch>, patch: MarkdownPatch) {
  for (const [key, old] of patches) {
    if (
      (old.start < patch.end && old.end > patch.start) ||
      (old.start === old.end && old.start >= patch.start && old.start <= patch.end)
    ) {
      if (!old.text && !patch.text) {
        patch = {
          start: Math.min(old.start, patch.start),
          end: Math.max(old.end, patch.end),
          text: '',
        };
      }
      patches.delete(key);
    }
  }
  patches.set(patch.start, patch);
}
export function focusBlockOffset(root: HTMLElement, block: HTMLElement, offset: number) {
  root.focus({ preventScroll: true });
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  let remaining = offset;
  const range = document.createRange();
  while (node) {
    if (remaining <= (node.textContent?.length ?? 0)) {
      const atomic = node.parentElement?.closest<HTMLElement>('[contenteditable="false"]');
      if (atomic && block.contains(atomic)) {
        if (remaining > 0) range.setStartAfter(atomic);
        else range.setStartBefore(atomic);
      } else range.setStart(node, remaining);
      range.collapse(true);
      break;
    }
    remaining -= node.textContent?.length ?? 0;
    node = walker.nextNode();
  }
  if (!node) {
    range.selectNodeContents(block);
    range.collapse(offset === 0);
  }
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}
export function caretAtStart(block: HTMLElement, range: Range) {
  if (!range.collapsed || !block.contains(range.startContainer)) return false;
  const before = range.cloneRange();
  before.selectNodeContents(block);
  before.setEnd(range.startContainer, range.startOffset);
  return !before.toString() && !before.cloneContents().querySelector('img');
}
export function caretAtEnd(block: HTMLElement, range: Range) {
  if (!range.collapsed || !block.contains(range.endContainer)) return false;
  const after = range.cloneRange();
  after.selectNodeContents(block);
  after.setStart(range.endContainer, range.endOffset);
  return !after.toString() && !after.cloneContents().querySelector('img');
}
interface EditContext {
  root: HTMLElement;
  source: string;
  patches: Map<number, MarkdownPatch>;
}
function removeBlock(context: EditContext, block: HTMLElement, preserveTrailingNewline = false) {
  let start = Number(
    block.dataset.mdKind === 'code' ? block.dataset.mdOuterStart : block.dataset.mdBlockStart,
  );
  let end = Number(
    block.dataset.mdKind === 'code' ? block.dataset.mdOuterEnd : block.dataset.mdBlockEnd,
  );
  if (!Number.isFinite(start) || !Number.isFinite(end)) return;
  // Quote markers belong to the container, but removing a whole paragraph must
  // also remove its line's marker and one quoted blank separator.
  const lineStart = context.source.lastIndexOf('\n', start - 1) + 1;
  const prefix = context.source.slice(lineStart, start);
  let quotedSeparator = false;
  if (/^(?:[ \t]*>[ \t]*)+$/.test(prefix)) {
    start = lineStart;
    const separator = /^\r?\n([ \t>]+)\r?\n/.exec(context.source.slice(end));
    if (separator && separator[1]!.replace(/\s/g, '') === prefix.replace(/\s/g, '')) {
      end += separator[0].length;
      quotedSeparator = true;
    }
  }
  const deletion = quotedSeparator
    ? { start, end, text: '' }
    : structuralDeletePatch(context.source, start, end);
  if (preserveTrailingNewline && /^\r?\n$/.test(context.source.slice(end))) deletion.end = end;
  putMarkdownPatch(context.patches, deletion);
  block.hidden = true;
}
function removeEmptyTableRows(context: EditContext, blocks: HTMLElement[]) {
  const rows = new Set(blocks.map((b) => b.closest<HTMLTableRowElement>('tr')).filter(Boolean));
  const tables = new Set(blocks.map((b) => b.closest<HTMLTableElement>('table')).filter(Boolean));
  const empty = (element: Element) =>
    !(element.textContent ?? '').replace(/\u200b/g, '').trim() && !element.querySelector('img');
  for (const row of rows) {
    if (!row || row.closest('thead') || !Array.from(row.cells).every(empty)) continue;
    const cell = row.cells[0] as HTMLElement | undefined;
    if (!cell) continue;
    putMarkdownPatch(
      context.patches,
      structuralDeletePatch(
        context.source,
        Number(cell.dataset.mdRowStart),
        Number(cell.dataset.mdRowEnd),
        true,
      ),
    );
    row.hidden = true;
  }
  for (const table of tables) {
    if (!table) continue;
    const cells = Array.from(table.querySelectorAll<HTMLElement>(selector)).filter(
      (b) => !b.closest('[hidden]'),
    );
    if (cells.length && !cells.every(empty)) continue;
    const cell = table.querySelector<HTMLElement>(selector);
    if (!cell) continue;
    putMarkdownPatch(
      context.patches,
      structuralDeletePatch(
        context.source,
        Number(cell.dataset.mdTableStart),
        Number(cell.dataset.mdTableEnd),
      ),
    );
    table.hidden = true;
  }
}
/** Apply cross-block deletion to the original source spans. Table delimiters are never
 * deleted as a side effect of the browser joining contenteditable elements. */
export function replaceMarkdownSelection(
  context: EditContext,
  range: Range,
  replacement = '',
): boolean {
  if (range.collapsed) return false;
  const all = visibleEditBlocks(context.root);
  const touched = all.filter((block) => range.intersectsNode(block));
  if (!touched.length) return false;
  if (
    touched.length === 1 &&
    touched[0]!.contains(range.startContainer) &&
    touched[0]!.contains(range.endContainer)
  )
    return false;
  const first = touched[0]!,
    last = touched[touched.length - 1]!;
  let caret = 0;
  for (const block of touched) {
    const local = range.cloneRange();
    if (!block.contains(local.startContainer)) local.setStart(block, 0);
    if (!block.contains(local.endContainer)) local.setEnd(block, block.childNodes.length);
    if (block === first) {
      const prefix = local.cloneRange();
      prefix.selectNodeContents(block);
      prefix.setEnd(local.startContainer, local.startOffset);
      caret = prefix.toString().length;
    }
    local.deleteContents();
    if (block === first && replacement) {
      local.insertNode(document.createTextNode(replacement));
      caret += replacement.length;
    }
  }
  const join =
    first !== last &&
    mergeable.has(first.dataset.mdKind ?? '') &&
    mergeable.has(last.dataset.mdKind ?? '') &&
    first.parentElement === last.parentElement;
  if (join) {
    while (last.firstChild) first.appendChild(last.firstChild);
    for (const block of touched.slice(1)) {
      if (block.dataset.mdKind !== 'tableCell') removeBlock(context, block, block === last);
    }
  }
  for (const block of touched) {
    if (block.closest('[hidden]')) continue;
    if (
      block !== first &&
      block !== last &&
      block.dataset.mdKind !== 'tableCell' &&
      !block.textContent
    ) {
      removeBlock(context, block);
      continue;
    }
    putMarkdownPatch(context.patches, blockMarkdown(block, context.source));
  }
  removeEmptyTableRows(context, touched);
  const visible = visibleEditBlocks(context.root);
  const target = visible.includes(first)
    ? first
    : visible.includes(last)
      ? last
      : (visible.filter((b) => all.indexOf(b) < all.indexOf(first)).pop() ?? visible[0]);
  if (target)
    focusBlockOffset(
      context.root,
      target,
      target === first ? caret : target === last ? 0 : (target.textContent?.length ?? 0),
    );
  return true;
}
/** Join ordinary text blocks at the caret; table cells keep their column boundaries. */
export function mergeMarkdownBackward(context: EditContext, target: HTMLElement): boolean {
  const blocks = visibleEditBlocks(context.root);
  const index = blocks.indexOf(target);
  if (index <= 0) return false;
  const previous = blocks[index - 1]!;
  if (
    !mergeable.has(target.dataset.mdKind ?? '') ||
    !mergeable.has(previous.dataset.mdKind ?? '') ||
    previous.parentElement !== target.parentElement
  ) {
    focusBlockOffset(context.root, previous, previous.textContent?.length ?? 0);
    return true;
  }
  const offset = previous.textContent?.length ?? 0;
  while (target.firstChild) previous.appendChild(target.firstChild);
  putMarkdownPatch(context.patches, blockMarkdown(previous, context.source));
  removeBlock(context, target, true);
  focusBlockOffset(context.root, previous, offset);
  return true;
}

export function mergeMarkdownForward(context: EditContext, target: HTMLElement): boolean {
  const blocks = visibleEditBlocks(context.root);
  const index = blocks.indexOf(target);
  const next = blocks[index + 1];
  if (index < 0 || !next) return false;
  if (
    !mergeable.has(target.dataset.mdKind ?? '') ||
    !mergeable.has(next.dataset.mdKind ?? '') ||
    next.parentElement !== target.parentElement
  ) {
    focusBlockOffset(context.root, next, 0);
    return true;
  }
  const offset = target.textContent?.length ?? 0;
  while (next.firstChild) target.appendChild(next.firstChild);
  putMarkdownPatch(context.patches, blockMarkdown(target, context.source));
  removeBlock(context, next, true);
  focusBlockOffset(context.root, target, offset);
  return true;
}
