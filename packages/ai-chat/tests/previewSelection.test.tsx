// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CodeDocument } from '../src/components/ResourcePreview/CodeDocument';
import { EditableMarkdown } from '../src/components/ResourcePreview/EditableMarkdown';
import { PreviewMarkdown } from '../src/components/ResourcePreview/PreviewMarkdown';
import { previewSelection } from '../src/components/ResourcePreview/previewSelection';

import { sourceView } from './helpers/codeView';

afterEach(() => {
  window.getSelection()?.removeAllRanges();
  cleanup();
});
function select(
  start: Node,
  offset: number,
  end = start,
  endOffset = start.textContent?.length ?? 0,
) {
  const range = document.createRange();
  range.setStart(start, offset);
  range.setEnd(end, endOffset);
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(range);
}
function documentView(text: string) {
  const view = render(
    <div data-preview-find-content>
      <PreviewMarkdown text={text} />
    </div>,
  );
  return view.container;
}
describe('preview paragraph source references', () => {
  it('distinguishes repeated paragraphs using source positions', () => {
    const root = documentView('# Heading\n\nRepeated.\n\nRepeated.\n');
    const second = root.querySelectorAll('p')[1]!;
    select(second.firstChild!, 0);
    expect(previewSelection(root, second)).toEqual({ text: 'Repeated.', start: 5, end: 5 });
  });
  it('does not include the next block when the selection ends at its first character', () => {
    const root = documentView('# Heading\n\nfirst\nline\n\n## Next\n');
    const paragraph = root.querySelector('p')!,
      next = screen.getByRole('heading', { name: 'Next' });
    select(paragraph.firstChild!, 1, next.firstChild!, 0);
    const chosen = previewSelection(root, paragraph);
    expect(chosen?.start).toBe(3);
    expect(chosen?.end).toBe(4);
    expect(chosen?.text).toContain('irst');
    expect(chosen?.text).not.toContain('Next');
  });
  it('uses exact source lines across heading, paragraph and GFM table cells', () => {
    const root = documentView('## Section\n\nIntro.\n\n| A | B |\n| --- | --- |\n| C | D |\n');
    const heading = screen.getByRole('heading'),
      cell = screen.getByRole('cell', { name: 'D' });
    select(heading.firstChild!, 0, cell.firstChild!, 1);
    const chosen = previewSelection(root, heading);
    expect(chosen?.start).toBe(1);
    expect(chosen?.end).toBe(7);
    expect(chosen?.text).toContain('Section');
    expect(chosen?.text).toContain('D');
  });
  it('can ask about the right-clicked paragraph without a text selection', () => {
    const root = documentView('# Heading\n\nParagraph with **bold**.\n');
    const bold = root.querySelector('strong')!;
    expect(previewSelection(root, bold)).toEqual({
      text: 'Paragraph with bold.',
      start: 3,
      end: 3,
    });
  });
  it('copies selected code without gutters and keeps the selected source-line range', () => {
    const { container: root } = render(
      <pre data-preview-find-content>
        <span id="preview-line-8" data-preview-find-line>
          <span className="react-syntax-highlighter-line-number">8</span>
          {'alpha\n'}
        </span>
        <span id="preview-line-9" data-preview-find-line>
          <span className="react-syntax-highlighter-line-number">9</span>beta
        </span>
      </pre>,
    );
    const lines = root.querySelectorAll('[data-preview-find-line]');
    select(lines[0]!.childNodes[1]!, 0, lines[1]!.childNodes[1]!, 4);
    expect(previewSelection(root, lines[0]!)).toEqual({ text: 'alpha\nbeta', start: 8, end: 9 });
  });
  it('uses textarea selection offsets, excluding the next line at an end-of-line boundary', () => {
    const { container: root } = render(
      <textarea data-preview-find-content defaultValue={'one\r\ntwo\r\nthree'} />,
    );
    const textarea = root.querySelector('textarea')!;
    textarea.setSelectionRange(textarea.value.indexOf('two'), textarea.value.indexOf('three'));
    const chosen = previewSelection(root, textarea);
    expect(chosen?.text.replace(/\r/g, '')).toBe('two\n');
    expect(chosen?.start).toBe(2);
    expect(chosen?.end).toBe(2);
  });
  it('updates following source locations after a rendered paragraph gains a line', () => {
    const onChange = vi.fn();
    const { container: root } = render(
      <div data-preview-find-content>
        <EditableMarkdown text={'first\n\nlast'} editable onChange={onChange} />
      </div>,
    );
    const [first, last] = root.querySelectorAll('p');
    first!.textContent = 'first\nsecond';
    fireEvent.input(first!);
    expect(onChange).toHaveBeenCalled();
    expect(previewSelection(root, last!)?.start).toBe(
      onChange.mock.lastCall![0].split('\n').length,
    );
  });
});

it('captures source text and source lines from a virtualized code selection including unmounted lines', () => {
  const text = Array.from({ length: 10_000 }, (_, index) => `line ${index + 1}`).join('\n');
  const { container } = render(
    <CodeDocument
      text={text}
      language="text"
      viewportRef={vi.fn()}
      onRendered={vi.fn()}
      onScroll={vi.fn()}
    />,
  );
  const view = sourceView(container);
  const from = view.state.doc.line(5).from,
    to = view.state.doc.line(9_990).to;
  view.dispatch({ selection: { anchor: from, head: to } });
  const captured = previewSelection(container, view.contentDOM);
  expect(captured).toEqual({ start: 5, end: 9_990, text: view.state.sliceDoc(from, to) });
  expect(container.querySelector('#preview-line-9990')).toBeNull();
});
