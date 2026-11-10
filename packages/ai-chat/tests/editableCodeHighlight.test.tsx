// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { EditableMarkdown } from '../src/components/ResourcePreview/EditableMarkdown';
import { loadHighlighter } from '../src/components/ResourcePreview/markdownHighlight';
import { ResourceScopeProvider } from '../src/contexts/ResourceContext';

const scope = { scope: { id: 'editable-code', cwd: '/other-workspace' }, open: vi.fn() };
afterEach(cleanup);
function setup(text: string) {
  const changed = vi.fn();
  const result = render(
    <ResourceScopeProvider value={scope}>
      <EditableMarkdown text={text} editable onChange={changed} />
      <input aria-label="chat composer" />
    </ResourceScopeProvider>,
  );
  return { ...result, changed };
}
const select = (code: HTMLElement, offset: number) => {
  screen.getByTestId('editable-markdown').focus();
  const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode()!;
  while (offset > (node.textContent?.length ?? 0)) {
    offset -= node.textContent?.length ?? 0;
    node = walker.nextNode()!;
  }
  const range = document.createRange();
  range.setStart(node, offset);
  range.collapse(true);
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(range);
};
const selectedOffset = (code: HTMLElement) => {
  const r = window.getSelection()!.getRangeAt(0).cloneRange();
  r.selectNodeContents(code);
  r.setEnd(window.getSelection()!.anchorNode!, window.getSelection()!.anchorOffset);
  return r.toString().length;
};
describe('editable Markdown code highlighting', () => {
  it('loads grammar asynchronously without touching adjacent edits, reference spelling or chat focus', async () => {
    const text =
      'A _word_ [label][r]\n\n```javascript\nconst value = "hello";\n```\n\n[r]: ./next.md\n';
    const { container, changed } = setup(text);
    const paragraph = container.querySelector('p')!;
    paragraph.firstChild!.textContent = 'Edited ';
    fireEvent.input(paragraph);
    screen.getByRole('textbox', { name: 'chat composer' }).focus();
    await act(async () => {
      await loadHighlighter();
    });
    await waitFor(() =>
      expect(container.querySelector('pre .hljs-keyword')?.textContent).toBe('const'),
    );
    expect(container.querySelector('p')).toBe(paragraph);
    expect(changed).toHaveBeenLastCalledWith(text.replace('A _word_', 'Edited _word_'));
    expect(changed).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'chat composer' }));
  });
  it('rehighlights edited fenced code without changing CRLF, fence spelling, caret or undo snapshots', async () => {
    await loadHighlighter();
    const text = '~~~javascript\r\nconst value = "old";\r\n~~~\r\n';
    const { container, changed } = setup(text);
    const code = container.querySelector<HTMLElement>('pre[data-md-kind="code"]')!;
    code.textContent = 'let updated = "new";';
    select(code, 4);
    fireEvent.input(code);
    expect(code.querySelector('.hljs-keyword')?.textContent).toBe('let');
    expect(selectedOffset(code)).toBe(4);
    expect(changed).toHaveBeenLastCalledWith(
      text.replace('const value = "old";', 'let updated = "new";'),
    );
    const editor = screen.getByTestId('editable-markdown');
    fireEvent.keyDown(editor, { key: 'z', metaKey: true });
    expect(changed).toHaveBeenLastCalledWith(text);
    expect(container.querySelector('pre .hljs-keyword')?.textContent).toBe('const');
    fireEvent.keyDown(editor, { key: 'z', metaKey: true, shiftKey: true });
    expect(container.querySelector('pre .hljs-keyword')?.textContent).toBe('let');
  });
  it('keeps a visible trailing code line without saving its caret placeholder', async () => {
    await loadHighlighter();
    const source = '```javascript\r\nlet value = 1;\r\n```\r\n';
    const { container, changed } = setup(source);
    const code = container.querySelector<HTMLElement>('pre[data-md-kind="code"]')!;
    select(code, code.textContent!.length);
    const enter = new InputEvent('beforeinput', {
      bubbles: true,
      cancelable: true,
      inputType: 'insertParagraph',
    });
    fireEvent(code, enter);
    expect(enter.defaultPrevented).toBe(true);
    expect(code.querySelector('[data-preview-line-placeholder]')).not.toBeNull();
    expect(changed).toHaveBeenLastCalledWith(
      source.replace('let value = 1;', 'let value = 1;\r\n'),
    );
    const offset = selectedOffset(code);
    expect(offset).toBe('let value = 1;\n'.length);
    const selection = window.getSelection()!;
    const range = selection.getRangeAt(0);
    const next = document.createTextNode('const next = 2;');
    range.insertNode(next);
    range.setStartAfter(next);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
    fireEvent.input(code);
    expect(code.querySelector('[data-preview-line-placeholder]')).toBeNull();
    expect(Array.from(code.querySelectorAll('.hljs-keyword'), (node) => node.textContent)).toEqual([
      'let',
      'const',
    ]);
    expect(changed).toHaveBeenLastCalledWith(
      source.replace('let value = 1;', 'let value = 1;\r\nconst next = 2;'),
    );
  });
  it('preserves a backwards selection spanning code and another paragraph while tokenizing', async () => {
    await loadHighlighter();
    const { container } = setup('before\n\n```javascript\nconst old = 1;\n```\n\nafter\n');
    const code = container.querySelector<HTMLElement>('pre[data-md-kind="code"]')!;
    code.textContent = 'let next = 2;';
    const outside = container.querySelector('p')!.firstChild!;
    const selection = window.getSelection()!;
    selection.setBaseAndExtent(code.firstChild!, 7, outside, 2);
    fireEvent.input(code);
    expect(selection.anchorNode?.parentElement?.closest('pre')).toBe(code);
    expect(selection.focusNode).toBe(outside);
    expect(selection.focusOffset).toBe(2);
    expect(code.querySelector('.hljs-keyword')?.textContent).toBe('let');
  });
  it('does not replace composing code DOM and highlights once composition ends', async () => {
    await loadHighlighter();
    const { container, changed } = setup('```javascript\nconst old = "old";\n```\n');
    const code = container.querySelector<HTMLElement>('pre[data-md-kind="code"]')!;
    select(code, code.textContent!.length);
    fireEvent.compositionStart(screen.getByTestId('editable-markdown'));
    code.textContent = 'const old = "中文";';
    fireEvent.input(code, { isComposing: true });
    expect(code.querySelector('span')).toBeNull();
    expect(changed).not.toHaveBeenCalled();
    select(code, code.textContent!.length);
    fireEvent.compositionEnd(code);
    expect(code.querySelector('.hljs-keyword')?.textContent).toBe('const');
    expect(changed).toHaveBeenLastCalledWith('```javascript\nconst old = "中文";\n```\n');
  });
});
