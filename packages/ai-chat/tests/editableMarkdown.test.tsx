// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { EditableMarkdown } from '../src/components/ResourcePreview/EditableMarkdown';
import { applyMarkdownPatches } from '../src/components/ResourcePreview/markdownEditing';
import { ResourceScopeProvider } from '../src/contexts/ResourceContext';

afterEach(cleanup);
function setup(text: string) {
  const onChange = vi.fn();
  const r = render(
    <ResourceScopeProvider value={{ scope: { id: 'a', cwd: '/work' }, open: vi.fn() }}>
      <EditableMarkdown text={text} editable onChange={onChange} />
    </ResourceScopeProvider>,
  );
  return { ...r, onChange };
}
describe('Direct source-preserving rendered Markdown edits', () => {
  it('edits a rendered heading and table cell without touching Mermaid or rewriting table formatting', () => {
    const text =
      '# 标题\r\n\r\n| 项目 | 说明 |\r\n| :--- | ---: |\r\n| A | **重点** 与 [链接][r] |\r\n\r\n```mermaid\r\nA --> B\r\n```\r\n\r\n[r]: ./a.md\r\n';
    const { onChange, container } = setup(text);
    const heading = screen.getByRole('heading', { level: 1 });
    expect(screen.getByTestId('editable-markdown').getAttribute('contenteditable')).toBe('true');
    expect(heading.hasAttribute('contenteditable')).toBe(false);
    heading.textContent = '新标题';
    fireEvent.input(heading);
    expect(onChange).toHaveBeenLastCalledWith(text.replace('# 标题', '# 新标题'));
    const cell = container.querySelectorAll('td')[0]!;
    cell.textContent = '新 A';
    fireEvent.input(cell);
    const expected = text.replace('# 标题', '# 新标题').replace('| A |', '| 新 A |');
    expect(onChange).toHaveBeenLastCalledWith(expected);
    expect(
      container.querySelector('[data-testid="mermaid-diagram"]')?.getAttribute('contenteditable'),
    ).not.toBe('true');
  });
  it('preserves unchanged inline spelling, reference links and rich marks while editing nearby text', () => {
    const text = 'A **bold** and _italic_ and [label][ref].\n\n[ref]: ./file.md\n';
    const { onChange, container } = setup(text);
    const p = container.querySelector('p')!;
    p.childNodes[0]!.textContent = 'New ';
    fireEvent.input(p);
    expect(onChange).toHaveBeenLastCalledWith(text.replace('A **', 'New **'));
    p.querySelector('strong')!.textContent = 'changed';
    fireEvent.input(p);
    expect(onChange).toHaveBeenLastCalledWith(text.replace('A **bold**', 'New **changed**'));
  });
  it('escapes typed Markdown punctuation in a table rather than changing its columns or formatting', () => {
    const { onChange, container } = setup('| A | B |\n| --- | --- |\n| old | stay |\n');
    const cell = container.querySelector('td')!;
    cell.textContent = 'one|two *plain*';
    fireEvent.input(cell);
    expect(onChange.mock.lastCall?.[0]).toContain('one\\|two \\*plain\\*');
  });
  it('edits tight list items and quoted paragraphs, retaining container prefixes', () => {
    const text = '- old\n- stay\n\n> quoted **bold**\n';
    const { onChange, container } = setup(text);
    const li = container.querySelector('li')!;
    li.textContent = 'new';
    fireEvent.input(li);
    expect(onChange).toHaveBeenLastCalledWith(text.replace('- old', '- new'));
    const quote = container.querySelector('blockquote p')!;
    quote.childNodes[0]!.textContent = 'new quote ';
    fireEvent.input(quote);
    expect(onChange).toHaveBeenLastCalledWith(
      text.replace('- old', '- new').replace('quoted **', 'new quote **'),
    );
  });
  it('edits fenced code directly and widens fences when the edited code contains closing ticks', () => {
    const source = '# Keep\n\n```js\nconst old = 1;\n```\n';
    const { container, onChange } = setup(source);
    const code = container.querySelector('pre[data-preview-edit-block]')!;
    expect(code).not.toBeNull();
    code.textContent = 'const next = 2;\n```';
    fireEvent.input(code);
    expect(onChange).toHaveBeenLastCalledWith('# Keep\n\n````js\nconst next = 2;\n```\n````\n');
  });
  it('adds text to empty table cells and serializes a new rendered paragraph without flattening it', () => {
    const source = 'First\n\n| A | B |\n| --- | --- |\n|   | stay |\n';
    const { container, onChange } = setup(source);
    const cell = container.querySelector('td')!;
    cell.textContent = 'new';
    fireEvent.input(cell);
    expect(onChange.mock.lastCall?.[0]).toContain('| new  | stay |');
    const p = container.querySelector('p')!;
    const line = document.createElement('div');
    line.textContent = 'Next';
    p.appendChild(line);
    fireEvent.input(p);
    expect(onChange.mock.lastCall?.[0]).toContain('First\n\nNext');
  });
  it('deletes an emptied rendered block on the next Backspace and moves to the previous block', () => {
    const source = 'Above\n\nRemove me\n\nBelow\n';
    const { container, onChange } = setup(source);
    const paragraphs = container.querySelectorAll('p');
    const removed = paragraphs[1] as HTMLElement;
    removed.textContent = '';
    fireEvent.input(removed);
    fireEvent.keyDown(removed, { key: 'Backspace', code: 'Backspace' });
    expect(onChange).toHaveBeenLastCalledWith('Above\n\nBelow\n');
    expect(removed.hidden).toBe(true);
    expect(document.activeElement).toBe(screen.getByTestId('editable-markdown'));
    expect(paragraphs[0]!.contains(window.getSelection()?.anchorNode ?? null)).toBe(true);
  });
  it('keeps structural deletion through the draft update rerender', () => {
    const source = 'Before\n\n| A | B |\n| --- | --- |\n| remove | row |\n\nAfter\n';
    function Controlled() {
      const [value, setValue] = React.useState(source);
      return (
        <ResourceScopeProvider value={{ scope: { id: 'a', cwd: '/work' }, open: vi.fn() }}>
          <EditableMarkdown text={value} editable onChange={setValue} />
        </ResourceScopeProvider>
      );
    }
    const { container } = render(<Controlled />);
    const row = container.querySelector('tbody tr')!;
    const cells = row.querySelectorAll<HTMLElement>('td');
    cells.forEach((cell) => {
      cell.textContent = '';
      fireEvent.input(cell);
    });
    fireEvent.keyDown(cells[1]!, { key: 'Backspace', code: 'Backspace' });
    expect(row.hidden).toBe(true);
    expect(container.textContent).not.toContain('remove');
  });
  it('does not leave a trailing blank line when deleting the last rendered block', () => {
    const source = 'Above\n\nRemove me\n';
    const { container, onChange } = setup(source);
    const removed = container.querySelectorAll('p')[1] as HTMLElement;
    removed.textContent = '';
    fireEvent.input(removed);
    fireEvent.keyDown(removed, { key: 'Backspace', code: 'Backspace' });
    expect(onChange).toHaveBeenLastCalledWith('Above');
  });
  it('removes completely emptied table rows and then removes the whole empty table without blank lines', () => {
    const source =
      'Before\n\n| A | B |\n| --- | --- |\n| keep | row |\n| remove | this |\n\nAfter\n';
    const { container, onChange } = setup(source);
    const bodyRows = container.querySelectorAll('tbody tr');
    const removeRow = bodyRows[1] as HTMLTableRowElement;
    const removeCells = removeRow.querySelectorAll<HTMLElement>('td');
    removeCells.forEach((cell) => {
      cell.textContent = '';
      fireEvent.input(cell);
    });
    fireEvent.keyDown(removeCells[0]!, { key: 'Backspace', code: 'Backspace' });
    expect(onChange).toHaveBeenLastCalledWith(
      'Before\n\n| A | B |\n| --- | --- |\n| keep | row |\n\nAfter\n',
    );
    expect(removeRow.hidden).toBe(true);

    const keepRow = bodyRows[0] as HTMLTableRowElement;
    const keepCells = keepRow.querySelectorAll<HTMLElement>('td');
    expect(keepCells[0]!.contains(window.getSelection()?.anchorNode ?? null)).toBe(true);
    keepCells.forEach((cell) => {
      cell.textContent = '';
      fireEvent.input(cell);
    });
    fireEvent.keyDown(keepCells[1]!, { key: 'Backspace', code: 'Backspace' });
    expect(keepRow.hidden).toBe(true);

    const headers = container.querySelectorAll<HTMLElement>('th');
    headers.forEach((cell) => {
      cell.textContent = '';
      fireEvent.input(cell);
    });
    fireEvent.keyDown(headers[1]!, { key: 'Backspace', code: 'Backspace' });
    expect(onChange).toHaveBeenLastCalledWith('Before\n\nAfter\n');
    expect(container.querySelector('table')?.hidden).toBe(true);
  });
  it('merges paragraphs at the start caret while preserving untouched Markdown and reference links', () => {
    const source =
      'First **bold**\r\n\r\nSecond [link][r]\r\n\r\n```js\r\nconst unchanged = 1;\r\n```\r\n\r\n[r]: ./next.md\r\n';
    const { container, onChange } = setup(source);
    const paragraphs = container.querySelectorAll('p');
    const editor = screen.getByTestId('editable-markdown');
    editor.focus();
    const range = document.createRange();
    range.setStart(paragraphs[1]!.firstChild!, 0);
    range.collapse(true);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    fireEvent.keyDown(editor, { key: 'Backspace' });
    expect(onChange).toHaveBeenLastCalledWith(
      source.replace('First **bold**\r\n\r\nSecond [link][r]', 'First **bold**Second [link][r]'),
    );
    expect(paragraphs[1]!.hidden).toBe(true);
  });
  it.each(['# Heading', '## Heading ##', '###### Heading', 'Heading\n=======', 'Heading\n-------'])(
    'demotes %s before merging it with the previous paragraph and supports independent undo',
    (heading) => {
      const source = `Before\n\n${heading}\n\nAfter\n`;
      const { container, onChange } = setup(source);
      const editor = screen.getByTestId('editable-markdown');
      const range = document.createRange();
      range.setStart(screen.getByRole('heading').firstChild!, 0);
      range.collapse(true);
      window.getSelection()!.removeAllRanges();
      window.getSelection()!.addRange(range);
      fireEvent.keyDown(editor, { key: 'Backspace' });
      const demoted = 'Before\n\nHeading\n\nAfter\n';
      expect(onChange).toHaveBeenLastCalledWith(demoted);
      expect(container.querySelector('h1,h2,h3,h4,h5,h6')).toBeNull();
      expect(container.querySelectorAll('p')).toHaveLength(3);
      expect(window.getSelection()!.anchorNode?.textContent).toBe('Heading');
      expect(window.getSelection()!.anchorOffset).toBe(0);
      fireEvent.keyDown(editor, { key: 'Backspace' });
      expect(onChange).toHaveBeenLastCalledWith('BeforeHeading\n\nAfter\n');
      fireEvent.keyDown(editor, { key: 'z', metaKey: true });
      expect(onChange).toHaveBeenLastCalledWith(demoted);
      fireEvent.keyDown(editor, { key: 'z', metaKey: true });
      expect(onChange).toHaveBeenLastCalledWith(source);
      expect(screen.getByRole('heading').textContent).toBe('Heading');
    },
  );
  it('keeps pending edits, CRLF and reference links when demoting a heading adjacent to body text', () => {
    const source = 'Before\r\n## A **bold** [link][r]\r\nAfter\r\n\r\n[r]: ./next.md\r\n';
    const { container, onChange } = setup(source);
    const heading = screen.getByRole('heading');
    heading.firstChild!.textContent = 'Changed ';
    fireEvent.input(heading);
    container.querySelector('p')!.firstChild!.textContent = 'Edited before';
    fireEvent.input(container.querySelector('p')!);
    const range = document.createRange();
    range.setStart(heading.firstChild!, 0);
    range.collapse(true);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    fireEvent.keyDown(screen.getByTestId('editable-markdown'), { key: 'Backspace' });
    expect(onChange).toHaveBeenLastCalledWith(
      'Edited before\r\n\r\nChanged **bold** [link][r]\r\n\r\nAfter\r\n\r\n[r]: ./next.md\r\n',
    );
    expect(container.querySelectorAll('p')).toHaveLength(3);
    expect(container.querySelector('strong')?.textContent).toBe('bold');
    expect(container.querySelector('a')?.getAttribute('data-md-href')).toBe('./next.md');
  });
  it.each([
    ['# Literal', '\\# Literal'],
    ['- Literal', '\\- Literal'],
    ['1. Literal', '1\\. Literal'],
    ['---', '\\---'],
  ])(
    'keeps %s as paragraph text after demotion rather than parsing it as another block',
    (content, source) => {
      const { container, onChange } = setup(`## ${content}\n`);
      const range = document.createRange();
      range.setStart(screen.getByRole('heading').firstChild!, 0);
      range.collapse(true);
      window.getSelection()!.removeAllRanges();
      window.getSelection()!.addRange(range);
      fireEvent.keyDown(screen.getByTestId('editable-markdown'), { key: 'Backspace' });
      expect(onChange).toHaveBeenLastCalledWith(`${source}\n`);
      expect(container.querySelector('p')?.textContent).toBe(content);
      expect(container.querySelector('h1,h2,h3,h4,h5,h6,ul,ol,hr')).toBeNull();
    },
  );
  it('keeps a heading inside its blockquote while removing its heading markers', () => {
    const { container, onChange } = setup('> Before\n> ## Heading\n> After\n');
    const range = document.createRange();
    range.setStart(screen.getByRole('heading').firstChild!, 0);
    range.collapse(true);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    fireEvent.keyDown(screen.getByTestId('editable-markdown'), { key: 'Backspace' });
    expect(onChange).toHaveBeenLastCalledWith('> Before\n> \n> Heading\n> \n> After\n');
    expect(container.querySelectorAll('blockquote p')).toHaveLength(3);
    fireEvent.keyDown(screen.getByTestId('editable-markdown'), { key: 'Backspace' });
    expect(onChange).toHaveBeenLastCalledWith('> BeforeHeading\n> \n> After\n');
  });
  it('does not demote a heading when Backspace is pressed within its text', () => {
    const { onChange } = setup('## Heading\n');
    const range = document.createRange();
    range.setStart(screen.getByRole('heading').firstChild!, 3);
    range.collapse(true);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    expect(fireEvent.keyDown(screen.getByTestId('editable-markdown'), { key: 'Backspace' })).toBe(
      true,
    );
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole('heading').textContent).toBe('Heading');
  });
  it('demotes a first heading through native beforeinput without deleting its text', () => {
    const { onChange } = setup('## Heading\n');
    const heading = screen.getByRole('heading');
    const range = document.createRange();
    range.setStart(heading.firstChild!, 0);
    range.collapse(true);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    const input = new InputEvent('beforeinput', {
      inputType: 'deleteContentBackward',
      bubbles: true,
      cancelable: true,
    });
    screen.getByTestId('editable-markdown').dispatchEvent(input);
    expect(input.defaultPrevented).toBe(true);
    expect(onChange).toHaveBeenLastCalledWith('Heading\n');
  });
  it('deletes selected table rows across cells instead of flattening the table', () => {
    const source =
      'Before\n\n| A | B |\n| --- | --- |\n| keep | row |\n| remove | this |\n| last | stay |\n\nAfter\n';
    const { container, onChange } = setup(source);
    const row = container.querySelectorAll('tbody tr')[1]!;
    const cells = row.querySelectorAll('td');
    const editor = screen.getByTestId('editable-markdown');
    editor.focus();
    const range = document.createRange();
    range.setStart(cells[0]!.firstChild!, 0);
    range.setEnd(cells[1]!.firstChild!, 4);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    fireEvent.keyDown(editor, { key: 'Backspace' });
    expect(onChange).toHaveBeenLastCalledWith(source.replace('| remove | this |\n', ''));
    expect((row as HTMLElement).hidden).toBe(true);
  });
  it('uses one editing host and replaces a cross-paragraph selection with typed text', () => {
    const { container, onChange } = setup('Alpha first\n\nBeta second\n');
    const editor = screen.getByTestId('editable-markdown');
    const paragraphs = container.querySelectorAll('p');
    expect(container.querySelectorAll('[contenteditable="true"]')).toHaveLength(1);
    const range = document.createRange();
    range.setStart(paragraphs[0]!.firstChild!, 6);
    range.setEnd(paragraphs[1]!.firstChild!, 4);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    const input = new InputEvent('beforeinput', {
      inputType: 'insertText',
      data: 'new',
      bubbles: true,
      cancelable: true,
    });
    editor.dispatchEvent(input);
    expect(input.defaultPrevented).toBe(true);
    expect(onChange).toHaveBeenLastCalledWith('Alpha new second\n');
  });
  it('undoes and redoes structural edits through source snapshots, including removed table rows', () => {
    const source = 'Before\n\n| A | B |\n| --- | --- |\n| remove | row |\n| last | stay |\n';
    const { container, onChange } = setup(source);
    const cells = container.querySelectorAll('tbody tr')[0]!.querySelectorAll('td');
    const editor = screen.getByTestId('editable-markdown');
    editor.focus();
    const range = document.createRange();
    range.setStart(cells[0]!.firstChild!, 0);
    range.setEnd(cells[1]!.firstChild!, 3);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    fireEvent.keyDown(editor, { key: 'Backspace' });
    const deleted = source.replace('| remove | row |\n', '');
    expect(onChange).toHaveBeenLastCalledWith(deleted);
    fireEvent.keyDown(editor, { key: 'z', metaKey: true });
    expect(onChange).toHaveBeenLastCalledWith(source);
    expect(container.querySelectorAll('tbody tr')).toHaveLength(2);
    expect(container.querySelector('tbody tr')!.hasAttribute('hidden')).toBe(false);
    fireEvent.keyDown(editor, { key: 'z', metaKey: true, shiftKey: true });
    expect(onChange).toHaveBeenLastCalledWith(deleted);
    expect(container.querySelectorAll('tbody tr')).toHaveLength(1);
  });
  it('rejects overlapping source patches and does not enable edits for readonly documents', () => {
    expect(() =>
      applyMarkdownPatches('12345', [
        { start: 0, end: 3, text: 'x' },
        { start: 2, end: 4, text: 'y' },
      ]),
    ).toThrow();
    render(<EditableMarkdown text="# Readonly" editable={false} onChange={vi.fn()} />);
    expect(screen.getByRole('heading').getAttribute('contenteditable')).toBeNull();
  });
});
