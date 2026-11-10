import { useCallback, useLayoutEffect, type RefObject } from 'react';

import { markdownCodeText } from './markdownEditing';
import {
  highlightPreviewCode,
  isHighlighterReady,
  loadHighlighter,
  subscribeHighlighter,
} from './markdownHighlight';

/** Lowlight handles grammar; this adapter updates only editable code tokens.
 * DOM-only changes keep React from replacing the live document or its undo state. */
export function useEditableCodeHighlight(root: RefObject<HTMLDivElement | null>) {
  const refresh = useCallback(
    (block?: HTMLElement) => {
      const editor = root.current;
      if (!editor) return;
      const blocks = block
        ? block.matches('[data-preview-code-language]')
          ? [block]
          : []
        : Array.from(editor.querySelectorAll<HTMLElement>('[data-preview-code-language]'));
      if (!blocks.length) return;
      if (!isHighlighterReady()) {
        void loadHighlighter();
        return;
      }
      for (const code of blocks) {
        if (code.dataset.previewComposing) continue;
        const text = markdownCodeText(code);
        const tokens = highlightPreviewCode(code.dataset.previewCodeLanguage ?? '', text);
        if (!tokens) continue;
        const doc = code.ownerDocument;
        const selection = doc.defaultView?.getSelection();
        const endpoint = (node: Node | null, offset: number) => {
          if (!node || !code.contains(node)) return;
          const range = doc.createRange();
          range.selectNodeContents(code);
          range.setEnd(node, offset);
          return markdownCodeText(range.cloneContents()).length;
        };
        const anchor = endpoint(selection?.anchorNode ?? null, selection?.anchorOffset ?? 0);
        const focus = endpoint(selection?.focusNode ?? null, selection?.focusOffset ?? 0);
        const fragment = doc.createDocumentFragment();
        type Token = (typeof tokens)[number];
        const append = (nodes: Token[], parent: Node) => {
          for (const node of nodes) {
            if (node.type === 'text') parent.appendChild(doc.createTextNode(node.value ?? ''));
            else if (node.type === 'element' && node.tagName === 'span') {
              const span = doc.createElement('span');
              const classes = node.properties?.className;
              if (Array.isArray(classes))
                span.className = classes
                  .filter((name) => /^hljs-[\w-]+$/.test(String(name)))
                  .join(' ');
              append(node.children ?? [], span);
              parent.appendChild(span);
            }
          }
        };
        append(tokens, fragment);
        if (text.endsWith('\n')) {
          const placeholder = doc.createElement('br');
          placeholder.dataset.previewLinePlaceholder = 'true';
          fragment.appendChild(placeholder);
        }
        code.replaceChildren(fragment);
        const at = (offset: number) => {
          const walker = doc.createTreeWalker(code, NodeFilter.SHOW_TEXT);
          let node = walker.nextNode();
          while (node) {
            const length = node.textContent?.length ?? 0;
            if (offset <= length) return { node, offset };
            offset -= length;
            node = walker.nextNode();
          }
          return { node: code as Node, offset: code.childNodes.length };
        };
        if (selection && (anchor !== undefined || focus !== undefined)) {
          const a =
            anchor === undefined
              ? { node: selection.anchorNode!, offset: selection.anchorOffset }
              : at(anchor);
          const f =
            focus === undefined
              ? { node: selection.focusNode!, offset: selection.focusOffset }
              : at(focus);
          // Selection direction and endpoints outside this code block are preserved.
          selection.setBaseAndExtent(a.node, a.offset, f.node, f.offset);
        }
      }
    },
    [root],
  );
  useLayoutEffect(() => subscribeHighlighter(() => refresh()), [refresh]);
  return refresh;
}
