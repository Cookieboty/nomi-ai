import { t } from '@nomi-ai/ui';
import React, { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Components } from 'react-markdown';

import { useEditableCodeHighlight } from './editableCodeHighlight';
import { MarkdownEditHistory, type MarkdownCaret } from './markdownEditHistory';
import {
  applyMarkdownPatches,
  blockMarkdown,
  structuralDeletePatch,
  type MarkdownPatch,
} from './markdownEditing';
import { LARGE_MARKDOWN_SIZE } from './markdownParseClient';
import {
  caretAtStart,
  focusBlockOffset,
  visibleEditBlocks,
  caretAtEnd,
  mergeMarkdownBackward,
  mergeMarkdownForward,
  putMarkdownPatch,
  prepareEmptyMarkdownCaret,
  replaceMarkdownSelection,
  selectedBlock,
} from './markdownSelectionEditing';
import { PreviewImage } from './PreviewImage';
import { previewMarkdownComponents } from './PreviewMarkdown';
import markdownStyles from './PreviewMarkdown.module.css';
import { PreviewMarkdownContent } from './PreviewMarkdownContent';
import { updatePreviewSourceRanges } from './previewSourceRanges';
import styles from './ResourcePreview.module.css';

function editableBlockIsEmpty(element: HTMLElement) {
  return (element.textContent ?? '').replace(/\u200b/g, '').trim() === '';
}

function focusEditableEnd(element?: HTMLElement) {
  if (!element) return;
  const editor = element.closest<HTMLElement>('[data-testid="editable-markdown"]');
  (editor ?? element).focus({ preventScroll: true });
  const selection = window.getSelection();
  if (!selection) return;
  const range = document.createRange();
  range.selectNodeContents(element);
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
}

function previousEditableBlock(blocks: HTMLElement[], target: HTMLElement, excluded?: HTMLElement) {
  for (let index = blocks.indexOf(target) - 1; index >= 0; index--) {
    const candidate = blocks[index]!;
    if (
      !candidate.hidden &&
      !candidate.closest('[hidden]') &&
      (!excluded || !excluded.contains(candidate))
    )
      return candidate;
  }
  return undefined;
}

function previousTableCell(target: HTMLElement) {
  const row = target.closest<HTMLTableRowElement>('tr');
  const table = target.closest('table');
  if (!row || !table) return undefined;
  const column = Array.from(row.cells).indexOf(target as HTMLTableCellElement);
  if (column < 0) return undefined;
  let previous = row.previousElementSibling as HTMLTableRowElement | null;
  while (previous && previous.closest('table') === table) {
    const cell = previous.cells.item(column) as HTMLElement | null;
    if (cell?.matches('[data-preview-edit-block]') && !previous.hidden && !cell.hidden) return cell;
    previous = previous.previousElementSibling as HTMLTableRowElement | null;
  }
  return undefined;
}

/** One editing host permits continuous selection. Source transactions preserve untouched
 * Markdown; typing keeps stable DOM, and undo restores source and rendered structure together. */
export const EditableMarkdown = React.memo(function EditableMarkdown({
  text,
  editable,
  onChange,
  editHistory,
}: {
  text: string;
  editable: boolean;
  onChange: (text: string) => void;
  editHistory?: MarkdownEditHistory;
}) {
  const [base, setBase] = useState(text);
  const [renderVersion, setRenderVersion] = useState(0);
  const history = useRef(editHistory ?? new MarkdownEditHistory(text));
  useLayoutEffect(() => () => history.current.closeGroup(), []);
  const restoreCaret = useRef<MarkdownCaret | undefined>(undefined);
  const root = useRef<HTMLDivElement>(null);
  const highlightCode = useEditableCodeHighlight(root);
  const patches = useRef(new Map<number, MarkdownPatch>());
  const callback = useRef(onChange);
  useLayoutEffect(() => {
    callback.current = onChange;
  }, [onChange]);
  useLayoutEffect(() => {
    if (!editHistory || history.current === editHistory) return;
    history.current.closeGroup();
    history.current = editHistory;
    patches.current.clear();
    restoreCaret.current = undefined;
    setBase(text);
    setRenderVersion((version) => version + 1);
  }, [editHistory, text]);
  const caret = useCallback((): MarkdownCaret | undefined => {
    const editor = root.current,
      selection = window.getSelection();
    if (!editor || !selection?.rangeCount) return;
    const block = selectedBlock(editor, selection.anchorNode);
    if (!block) return;
    const before = selection.getRangeAt(0).cloneRange();
    before.selectNodeContents(block);
    before.setEnd(selection.anchorNode!, selection.anchorOffset);
    return { block: visibleEditBlocks(editor).indexOf(block), offset: before.toString().length };
  }, []);
  const publish = useCallback(
    (group = '') => {
      const next = applyMarkdownPatches(base, [...patches.current.values()]);
      history.current.record(next, caret(), group);
      updatePreviewSourceRanges(root.current, next, [...patches.current.values()]);
      callback.current(next);
    },
    [base, caret],
  );
  const restoreHistory = useCallback((redo = false) => {
    const snapshot = redo ? history.current.redo() : history.current.undo();
    if (!snapshot) return false;
    patches.current.clear();
    restoreCaret.current = snapshot.caret ?? { block: 0, offset: 0 };
    setBase(snapshot.text);
    setRenderVersion((v) => v + 1);
    callback.current(snapshot.text);
    return true;
  }, []);
  const components = useMemo<Components>(() => {
    const block = (tag: string) =>
      function EditableBlock(props: Record<string, unknown>) {
        const { node: _node, children, ...rest } = props;
        const hasRange = rest['data-md-start'] !== undefined;
        return React.createElement(
          tag,
          {
            ...rest,
            suppressContentEditableWarning: true,
            'data-preview-edit-block': editable && hasRange ? true : undefined,
            spellCheck: false,
          },
          (children as React.ReactNode) || <br data-preview-line-placeholder="true" />,
        );
      };
    return {
      ...previewMarkdownComponents,
      pre: (props) => {
        const child = React.Children.toArray(props.children)[0];
        if (
          React.isValidElement<Record<string, unknown>>(child) &&
          child.props['data-md-kind'] === 'code'
        ) {
          const { children, className, node: _node, ...data } = child.props;
          return (
            <div className={markdownStyles.codeBlock}>
              <div
                className={markdownStyles.codeHead}
                contentEditable={false}
                data-preview-find-ignore
              >
                {String(className ?? '').replace('language-', '') || t('ui.usage-tools.code')}
              </div>
              <pre
                {...data}
                className={markdownStyles.codePre}
                suppressContentEditableWarning
                spellCheck={false}
                data-preview-edit-block={editable || undefined}
                data-preview-code-language={String(className ?? '').replace('language-', '')}
              >
                {String(children ?? '').replace(/\n$/, '')}
              </pre>
            </div>
          );
        }
        const Pre = previewMarkdownComponents.pre! as React.ElementType;
        return (
          <div contentEditable={false}>
            <Pre {...props} />
          </div>
        );
      },
      p: block('p'),
      h1: block('h1'),
      h2: block('h2'),
      h3: block('h3'),
      h4: block('h4'),
      h5: block('h5'),
      h6: block('h6'),
      td: block('td'),
      th: block('th'),
      li: block('li'),
      a: (props) => {
        const { node: _node, href, ...rest } = props;
        const A = previewMarkdownComponents.a! as React.ElementType;
        return (
          <A {...rest} href={href} data-md-href={href} contentEditable={false} draggable={false} />
        );
      },
      img: (props) => {
        const { node: _node, src, alt, ...rest } = props;
        return (
          <span {...rest} contentEditable={false}>
            <PreviewImage src={src ?? ''} alt={alt ?? ''} />
          </span>
        );
      },
    } as Components;
  }, [editable]);
  const rendered = useCallback(() => {
    if (!root.current || root.current.querySelector('[data-preview-markdown-pending]')) return;
    root.current.querySelectorAll<HTMLElement>('[data-md-original]').forEach((el) => {
      el.dataset.mdSnapshot = el.textContent ?? '';
    });
    highlightCode();
    const saved = restoreCaret.current;
    if (saved && root.current) {
      const blocks = visibleEditBlocks(root.current);
      const target = blocks[saved.block] ?? blocks[blocks.length - 1];
      const focused = root.current.ownerDocument.activeElement;
      if (target && (!focused || focused === document.body || root.current.contains(focused)))
        focusBlockOffset(root.current, target, saved.offset);
      restoreCaret.current = undefined;
    }
  }, [highlightCode]);
  // The outer host ref attaches after child layout effects on the first mount.
  useLayoutEffect(rendered, [rendered, components, base, renderVersion]);
  useLayoutEffect(() => {
    const editor = root.current;
    if (!editor) return;
    const leave = (event: Event) => {
      if (event.target instanceof Node && !editor.contains(event.target))
        restoreCaret.current = undefined;
    };
    editor.ownerDocument.addEventListener('focusin', leave);
    editor.ownerDocument.addEventListener('pointerdown', leave, true);
    return () => {
      editor.ownerDocument.removeEventListener('focusin', leave);
      editor.ownerDocument.removeEventListener('pointerdown', leave, true);
    };
  }, []);
  const input = useCallback(
    (event: React.FormEvent<HTMLDivElement>) => {
      const editor = root.current;
      const target =
        editor &&
        (selectedBlock(editor, event.target as Node) ??
          selectedBlock(editor, window.getSelection()?.anchorNode ?? null));
      if (!target || !root.current?.contains(target)) return;
      if ((event.nativeEvent as InputEvent).isComposing) return;
      const patch = blockMarkdown(target, base);
      putMarkdownPatch(patches.current, patch);
      publish(`block:${patch.start}`);
      highlightCode(target);
    },
    [base, publish, highlightCode],
  );
  const backspaceEmptyBlock = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key !== 'Backspace' || event.nativeEvent.isComposing) return;
      const editor = root.current;
      const target =
        editor &&
        (selectedBlock(editor, event.target as Node) ??
          selectedBlock(editor, window.getSelection()?.anchorNode ?? null));
      if (!target || !editor?.contains(target) || !editableBlockIsEmpty(target)) return;

      let host: HTMLElement = target;
      let start = Number(target.dataset.mdBlockStart);
      let end = Number(target.dataset.mdBlockEnd);
      let lineOnly = false;
      if (target.dataset.mdKind === 'code') {
        start = Number(target.dataset.mdOuterStart);
        end = Number(target.dataset.mdOuterEnd);
      } else if (target.dataset.mdKind === 'tableCell') {
        const row = target.closest<HTMLElement>('tr');
        const table = target.closest<HTMLElement>('table');
        const rowEmpty =
          !!row &&
          Array.from(row.querySelectorAll<HTMLElement>('[data-preview-edit-block]')).every(
            editableBlockIsEmpty,
          );
        const bodyRows = table
          ? Array.from(table.querySelectorAll<HTMLElement>('tbody tr')).filter(
              (candidate) => !candidate.hidden,
            )
          : [];
        const removeWholeTable =
          target.dataset.mdRowHeader === 'true' &&
          bodyRows.every((candidate) =>
            Array.from(candidate.querySelectorAll<HTMLElement>('[data-preview-edit-block]')).every(
              editableBlockIsEmpty,
            ),
          );
        if (removeWholeTable && table) {
          host = table;
          start = Number(target.dataset.mdTableStart);
          end = Number(target.dataset.mdTableEnd);
        } else if (rowEmpty && target.dataset.mdRowHeader !== 'true' && row) {
          host = row;
          start = Number(target.dataset.mdRowStart);
          end = Number(target.dataset.mdRowEnd);
          lineOnly = true;
        } else {
          const blocks = Array.from(
            editor.querySelectorAll<HTMLElement>('[data-preview-edit-block]'),
          );
          const previous = previousEditableBlock(blocks, target) ?? previousTableCell(target);
          event.preventDefault();
          focusEditableEnd(previous);
          return;
        }
      }
      if (!Number.isFinite(start) || !Number.isFinite(end)) return;

      const blocks = Array.from(editor.querySelectorAll<HTMLElement>('[data-preview-edit-block]'));
      const previous =
        target.dataset.mdKind === 'tableCell' && host !== target.closest('table')
          ? (previousTableCell(target) ??
            previousEditableBlock(blocks, target, target.closest('table') ?? undefined))
          : previousEditableBlock(blocks, target, host);
      const deletion = structuralDeletePatch(base, start, end, lineOnly);
      putMarkdownPatch(patches.current, deletion);
      host.hidden = true;
      event.preventDefault();
      if (!visibleEditBlocks(editor).length) {
        const next = applyMarkdownPatches(base, [...patches.current.values()]);
        history.current.record(next, { block: 0, offset: 0 });
        patches.current.clear();
        restoreCaret.current = { block: 0, offset: 0 };
        setBase(next);
        setRenderVersion((version) => version + 1);
        callback.current(next);
      } else {
        publish();
        focusEditableEnd(previous);
      }
    },
    [base, publish],
  );
  const emit = useCallback(() => {
    publish();
    const block =
      root.current && selectedBlock(root.current, window.getSelection()?.anchorNode ?? null);
    if (block) highlightCode(block);
  }, [publish, highlightCode]);
  const context = useCallback(
    () =>
      root.current ? { root: root.current, source: base, patches: patches.current } : undefined,
    [base],
  );
  const replaceSelection = useCallback(
    (replacement = '') => {
      const current = context(),
        selection = window.getSelection();
      if (!current || !selection?.rangeCount) return false;
      const range = selection.getRangeAt(0);
      if (!current.root.contains(range.commonAncestorContainer)) return false;
      if (!replaceMarkdownSelection(current, range, replacement)) return false;
      emit();
      return true;
    },
    [context, emit],
  );
  // Reparse this structural change so the heading immediately becomes a paragraph.
  // Its original inline source and all pending edits survive the rebase.
  const demoteHeading = useCallback(
    (target: HTMLElement) => {
      const editor = root.current;
      if (!editable || !editor || target.dataset.mdKind !== 'heading') return false;
      const start = Number(target.dataset.mdBlockStart),
        end = Number(target.dataset.mdBlockEnd),
        inlineStart = Number(target.dataset.mdStart),
        inlineEnd = Number(target.dataset.mdEnd);
      if (![start, end, inlineStart, inlineEnd].every(Number.isFinite)) return false;
      const inline = (patches.current.get(inlineStart)?.text ?? base.slice(inlineStart, inlineEnd))
        // Heading content may start with syntax that would become a new block in a paragraph.
        .replace(
          /^([ \t]*)(?=#{1,6}(?:[ \t]|$)|>|[-+*][ \t]|`{3}|~{3}|(?:-[ \t]*){3,}$|(?:\*[ \t]*){3,}$|(?:_[ \t]*){3,}$)/,
          '$1\\',
        )
        .replace(/^([ \t]*\d+)([.)])(?=[ \t])/, '$1\\$2');
      const newline = base.includes('\r\n') ? '\r\n' : '\n';
      const lineStart = base.lastIndexOf('\n', start - 1) + 1;
      const prefix = base
        .slice(lineStart, start)
        .replace(/(?:[-+*]|\d+[.)])[ \t]+/g, (marker) => ' '.repeat(marker.length));
      // Removing a heading must keep adjacent blocks separate until the next Backspace.
      const before =
        target.previousElementSibling && !/\r?\n[ \t>]*\r?\n[ \t>]*$/.test(base.slice(0, start))
          ? newline + prefix
          : '';
      const after =
        target.nextElementSibling && !/^\r?\n[ \t>]*\r?\n/.test(base.slice(end))
          ? newline + prefix
          : '';
      putMarkdownPatch(patches.current, { start, end, text: before + inline + after });
      const next = applyMarkdownPatches(base, [...patches.current.values()]);
      const saved = { block: visibleEditBlocks(editor).indexOf(target), offset: 0 };
      history.current.record(next, saved);
      restoreCaret.current = saved;
      patches.current.clear();
      setBase(next);
      setRenderVersion((version) => version + 1);
      callback.current(next);
      return true;
    },
    [base, editable],
  );
  const keyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!editable || event.nativeEvent.isComposing) return;
    history.current.present.caret = caret();
    if (
      (event.metaKey || event.ctrlKey) &&
      !event.altKey &&
      (event.key.toLowerCase() === 'z' || event.key.toLowerCase() === 'y')
    ) {
      event.preventDefault();
      restoreHistory(event.shiftKey || event.key.toLowerCase() === 'y');
      return;
    }
    if (event.nativeEvent.isComposing || (event.key !== 'Backspace' && event.key !== 'Delete'))
      return;
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed && replaceSelection()) {
      event.preventDefault();
      return;
    }
    const current = context();
    const target =
      current &&
      (selectedBlock(current.root, event.target as Node) ??
        selectedBlock(current.root, selection?.anchorNode ?? null));
    if (
      event.key === 'Backspace' &&
      current &&
      target &&
      selection?.rangeCount &&
      caretAtStart(target, selection.getRangeAt(0))
    ) {
      if (demoteHeading(target)) {
        event.preventDefault();
        return;
      }
      if (!editableBlockIsEmpty(target) && mergeMarkdownBackward(current, target)) {
        event.preventDefault();
        emit();
        return;
      }
    }
    if (
      event.key === 'Delete' &&
      current &&
      target &&
      selection?.rangeCount &&
      caretAtEnd(target, selection.getRangeAt(0)) &&
      mergeMarkdownForward(current, target)
    ) {
      event.preventDefault();
      emit();
      return;
    }
    backspaceEmptyBlock(event);
  };
  useLayoutEffect(() => {
    const editor = root.current;
    if (!editor || !editable) return;
    const beforeInput = (event: InputEvent) => {
      if (editor.querySelector('[data-preview-markdown-pending]')) {
        event.preventDefault();
        return;
      }
      prepareEmptyMarkdownCaret(editor);
      if (event.isComposing) return;
      if (event.inputType === 'historyUndo' || event.inputType === 'historyRedo') {
        event.preventDefault();
        restoreHistory(event.inputType === 'historyRedo');
        return;
      }
      history.current.present.caret = caret();
      const selection = window.getSelection();
      if (!selection?.rangeCount) return;
      if (event.inputType.startsWith('delete') && replaceSelection()) {
        event.preventDefault();
        return;
      }
      if (event.inputType === 'deleteContentBackward') {
        const range = selection.getRangeAt(0);
        const block = selectedBlock(editor, range.startContainer);
        if (block && caretAtStart(block, range) && demoteHeading(block)) {
          event.preventDefault();
          return;
        }
      }
      if (event.inputType === 'insertText' && replaceSelection(event.data ?? '')) {
        event.preventDefault();
        return;
      }
      if (!['insertParagraph', 'insertLineBreak'].includes(event.inputType)) return;
      replaceSelection();
      const range = selection.getRangeAt(0);
      const block = selectedBlock(editor, range.startContainer);
      if (!block || !block.contains(range.endContainer)) return;
      event.preventDefault();
      range.deleteContents();
      const line =
        block.dataset.mdKind === 'code'
          ? document.createTextNode('\n')
          : document.createElement('br');
      range.insertNode(line);
      range.setStartAfter(line);
      range.collapse(true);
      if (line.nodeType === Node.ELEMENT_NODE && !line.nextSibling) {
        const placeholder = document.createElement('br');
        placeholder.dataset.previewLinePlaceholder = 'true';
        block.appendChild(placeholder);
      }
      selection.removeAllRanges();
      selection.addRange(range);
      putMarkdownPatch(patches.current, blockMarkdown(block, base));
      emit();
    };
    editor.addEventListener('beforeinput', beforeInput);
    return () => editor.removeEventListener('beforeinput', beforeInput);
  }, [base, editable, emit, replaceSelection, caret, restoreHistory, demoteHeading]);
  const pointer = useRef({ x: 0, y: 0, dragged: false });
  return (
    <div
      ref={root}
      className={`${markdownStyles.md} ${styles.markdown}`}
      data-testid="editable-markdown"
      data-preview-large-markdown={base.length >= LARGE_MARKDOWN_SIZE || undefined}
      onInput={input}
      contentEditable={editable || undefined}
      suppressContentEditableWarning
      onKeyDown={keyDown}
      onPointerDown={(event) => {
        pointer.current = { x: event.clientX, y: event.clientY, dragged: false };
      }}
      onPointerMove={(event) => {
        if (
          event.buttons &&
          Math.hypot(event.clientX - pointer.current.x, event.clientY - pointer.current.y) > 4
        )
          pointer.current.dragged = true;
      }}
      onClickCapture={(event) => {
        if (pointer.current.dragged && !window.getSelection()?.isCollapsed) {
          event.preventDefault();
          event.stopPropagation();
        }
      }}
      onCompositionStart={(event) => {
        if (root.current) prepareEmptyMarkdownCaret(root.current);
        const block =
          root.current &&
          (selectedBlock(root.current, event.target as Node) ??
            selectedBlock(root.current, window.getSelection()?.anchorNode ?? null));
        if (block?.dataset.mdKind === 'code') block.dataset.previewComposing = 'true';
        replaceSelection();
      }}
      onCompositionEnd={(event) => {
        const block =
          root.current &&
          (selectedBlock(root.current, event.target as Node) ??
            selectedBlock(root.current, window.getSelection()?.anchorNode ?? null));
        if (block) delete block.dataset.previewComposing;
        event.target.dispatchEvent(new Event('input', { bubbles: true }));
      }}
      onPaste={(event) => {
        if (!editable) return;
        event.preventDefault();
        if (root.current) prepareEmptyMarkdownCaret(root.current);
        history.current.present.caret = caret();
        const text = event.clipboardData.getData('text/plain');
        if (replaceSelection(text)) return;
        const editor = root.current,
          selection = window.getSelection();
        if (!editor || !selection?.rangeCount) return;
        const range = selection.getRangeAt(0);
        const block = selectedBlock(editor, range.startContainer);
        if (!block || !block.contains(range.endContainer)) return;
        range.deleteContents();
        const node = document.createTextNode(text);
        range.insertNode(node);
        range.setStartAfter(node);
        range.collapse(true);
        selection.removeAllRanges();
        selection.addRange(range);
        block.dispatchEvent(new Event('input', { bubbles: true }));
      }}
      aria-label={editable ? t('ui.session-workspace.preview-edit-document') : undefined}
    >
      <PreviewMarkdownContent
        key={renderVersion}
        text={base}
        editable
        synchronous={renderVersion > 0}
        components={components}
        onRendered={rendered}
      />
    </div>
  );
});
