// @vitest-environment happy-dom
import { t } from '@nomi-ai/ui';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  MAX_FIND_MATCHES,
  documentTextIndex,
  findText,
} from '../src/components/ResourcePreview/fileFindIndex';
import { ResourcePreview } from '../src/components/ResourcePreview/ResourcePreview';
import { resourcePreviewClient, type PreviewResult } from '../src/services/resourcePreviewClient';

import { changeSource, sourceEditable, sourceView } from './helpers/codeView';

vi.mock('../src/services/api', async () => (await import('./helpers/fakeApi')).fakeApiModule());
vi.mock('../src/components/ConfirmDialog', () => ({ confirmDialog: vi.fn(async () => true) }));
vi.mock('../src/services/resourcePreviewClient', () => ({
  resourcePreviewClient: {
    open: vi.fn(),
    save: vi.fn(async () => ({ ok: true, revision: 'r2' })),
    web: vi.fn(),
    close: vi.fn(async () => undefined),
    external: vi.fn(async () => ({ ok: true, kind: 'external' })),
  },
}));

let sequence = 0;
const highlights = new Map<string, TestHighlight>();
class TestHighlight {
  constructor(...ranges: Range[]) {
    this.ranges = ranges;
  }
  ranges: Range[];
}
beforeEach(() => {
  localStorage.clear();
  highlights.clear();
  vi.stubGlobal('Highlight', TestHighlight);
  vi.stubGlobal('CSS', Object.assign(Object.create(CSS), { highlights }));
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const label = (suffix: string) => t(`ui.session-workspace.preview-find${suffix}`);
const input = () => screen.getByRole('textbox', { name: label('') });
const count = () => within(screen.getByRole('search')).getByRole('status').textContent;
const key = (shiftKey = false, extra: KeyboardEventInit = {}) => {
  const e = new KeyboardEvent('keydown', {
    key: 'f',
    code: 'KeyF',
    ctrlKey: true,
    shiftKey,
    bubbles: true,
    cancelable: true,
    ...extra,
  });
  fireEvent(window, e);
  return e;
};
const query = async (text: string) => {
  key();
  fireEvent.change(input(), { target: { value: text } });
  await waitFor(() => expect(count()).not.toBe('0 / 0'));
};
async function mount(
  result: PreviewResult = {
    ok: true,
    kind: 'markdown',
    content: '# Guide\n\nAlpha **beta** and alpha beta.\n\n```js\nconst value = 1;\n```',
  },
) {
  const id = `find-${sequence++}`;
  const entry = { key: id, href: `/w/${id}.md`, scope: { id: 'cli:a', cwd: '/w' } };
  vi.mocked(resourcePreviewClient.open).mockResolvedValue(result);
  const props = {
    entries: [entry],
    activeKey: entry.key,
    expanded: true,
    originMismatch: false,
    onActive: vi.fn(),
    onCloseEntry: vi.fn(),
    onCloseEntries: vi.fn(),
    onExpanded: vi.fn(),
    onOpen: vi.fn(),
  };
  const rendered = render(
    <>
      <p>alpha beta outside current file</p>
      <ResourcePreview {...props} />
    </>,
  );
  await waitFor(() =>
    expect(screen.queryByText(t('ui.session-workspace.preview-loading'))).toBeNull(),
  );
  return { ...rendered, props };
}

describe('literal file search index', () => {
  it('escapes regex, handles Unicode offsets, case and Chinese without rewriting text', () => {
    expect(findText('a.* A.*', 'a.*')).toEqual([
      { start: 0, end: 3 },
      { start: 4, end: 7 },
    ]);
    expect(findText('İ中文😀x X', 'x')).toEqual([
      { start: 5, end: 6 },
      { start: 7, end: 8 },
    ]);
    expect(findText('中文 中文', '中文')).toHaveLength(2);
    expect(findText('anything', '')).toEqual([]);
  });
  it('bounds large-file matches without treating the query as a regular expression', () => {
    expect(findText('x'.repeat(20000), 'x')).toHaveLength(MAX_FIND_MATCHES + 1);
    expect(findText('abcabcabc', 'abc', 2)).toEqual([
      { start: 0, end: 3 },
      { start: 3, end: 6 },
    ]);
  });
  it('joins inline formatting, separates blocks and excludes line numbers and controls', () => {
    const root = document.createElement('div');
    root.innerHTML =
      '<p>Hello <b>world</b></p><p>Next</p><span aria-hidden="true">42</span><button>Hello</button><div data-preview-find-ignore>language</div>';
    const before = root.innerHTML;
    const index = documentTextIndex(root);
    const match = findText(index.text, 'hello world')[0]!;
    expect(index.range(match)?.toString()).toBe('Hello world');
    expect(index.text).toContain('world\nNext');
    expect(index.text).not.toMatch(/42|language/);
    expect(findText(index.text, 'hello')).toHaveLength(1);
    expect(root.innerHTML).toBe(before);
  });
});

describe('current preview file search', () => {
  it('counts only current rendered file, navigates/wraps and Esc closes find before preview', async () => {
    const { props, rerender } = await mount();
    const doc = screen.getByTestId('preview-markdown');
    const before = doc.querySelector('p')!.innerHTML;
    expect(key(true).defaultPrevented).toBe(false);
    expect(screen.queryByRole('search')).toBeNull();
    await query('ALPHA beta');
    expect(document.activeElement).toBe(input());
    expect(count()).toBe('1 / 2');
    expect(highlights.get('preview-find-matches')?.ranges.map((r) => r.toString())).toEqual([
      'Alpha beta',
      'alpha beta',
    ]);
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(count()).toBe('2 / 2');
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(count()).toBe('1 / 2');
    fireEvent.keyDown(input(), { key: 'Enter', shiftKey: true });
    expect(count()).toBe('2 / 2');
    expect(doc.querySelector('p')!.innerHTML).toBe(before);
    expect(doc.querySelector('mark')).toBeNull();
    expect(resourcePreviewClient.save).not.toHaveBeenCalled();
    const nativeSelection = window.getSelection()!;
    const selected = document.createRange();
    selected.selectNodeContents(doc.querySelector('strong')!);
    nativeSelection.removeAllRanges();
    nativeSelection.addRange(selected);
    expect(nativeSelection.toString()).toBe('beta');
    fireEvent.keyDown(input(), { key: 'Escape' });
    expect(screen.queryByRole('search')).toBeNull();
    expect(highlights.size).toBe(0);
    expect(nativeSelection.rangeCount).toBe(0);
    expect(props.onCloseEntries).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(screen.getByTestId('resource-preview'));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(props.onExpanded).toHaveBeenCalledWith(false);
    expect(props.onCloseEntries).not.toHaveBeenCalled();
    rerender(<ResourcePreview {...props} expanded={false} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(props.onCloseEntries).toHaveBeenCalledWith([props.activeKey]);
  });
  it('reindexes on mode/file change; excludes code toolbar labels and read-only line numbers', async () => {
    const { props, rerender } = await mount();
    await query('js');
    expect(count()).toBe(label('-empty'));
    fireEvent.click(screen.getByTestId('resource-preview-mode'));
    await waitFor(() => expect(count()).toBe('1 / 1'));
    fireEvent.change(input(), { target: { value: '**' } });
    expect(count()).toBe('1 / 2');
    const entry = { ...props.entries[0]!, key: 'different', href: '/w/different.txt' };
    vi.mocked(resourcePreviewClient.open).mockResolvedValue({
      ok: true,
      kind: 'text',
      content: '** only once',
    });
    rerender(
      <>
        <p>alpha beta outside current file</p>
        <ResourcePreview {...props} entries={[...props.entries, entry]} activeKey="different" />
      </>,
    );
    await waitFor(() => expect(count()).toBe('1 / 1'));
    fireEvent.change(input(), { target: { value: '1' } });
    expect(count()).toBe(label('-empty'));
    expect(resourcePreviewClient.open).toHaveBeenCalledTimes(2);
  });
  it('searches the current source draft without changing editor value, selection or autosave', async () => {
    await mount({
      ok: true,
      kind: 'text',
      content: 'draft\nDraft\nend',
      editable: true,
      revision: 'r1',
      url: '/__nomi/preview/find-source',
    });
    fireEvent.click(screen.getByTestId('resource-preview-edit'));
    await waitFor(() =>
      expect(sourceEditable(screen.getByTestId('resource-preview-source'))).toBe(true),
    );
    const editor = sourceView(screen.getByTestId('resource-preview-source'));
    editor.focus();
    editor.dispatch({ selection: { anchor: 0, head: 5 } });
    await query('draft');
    expect(count()).toBe('1 / 2');
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(editor.state.sliceDoc()).toBe('draft\nDraft\nend');
    expect(editor.state.selection.main.from).toBe(0);
    expect(
      screen
        .getByTestId('resource-preview')
        .querySelectorAll('.preview-code-find-match,.preview-code-find-current'),
    ).toHaveLength(2);
    expect(resourcePreviewClient.save).not.toHaveBeenCalled();
    changeSource(editor.scrollDOM, 'draft new draft draft');
    await waitFor(() => expect(count()).toBe('2 / 3'));
    fireEvent.keyDown(input(), { key: 'Escape' });
    expect(document.activeElement).toBe(editor.contentDOM);
    expect(editor.state.selection.main.from).toBe(0);
    expect(editor.state.selection.main.to).toBe(0);
    expect(editor.state.sliceDoc()).toBe('draft new draft draft');
  });
  it('uses macOS Command only; ignores IME, shortcut recording and modal dialogs', async () => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel');
    await mount();
    expect(key(false, { isComposing: true }).defaultPrevented).toBe(false);
    expect(screen.queryByRole('search')).toBeNull();
    const recording = document.createElement('input');
    recording.dataset.shortcutRecording = 'true';
    document.body.append(recording);
    fireEvent.keyDown(recording, { key: 'f', code: 'KeyF', ctrlKey: true });
    expect(screen.queryByRole('search')).toBeNull();
    recording.remove();
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    document.body.append(dialog);
    key();
    expect(screen.queryByRole('search')).toBeNull();
    dialog.remove();
    expect(key(false, { ctrlKey: false, metaKey: true }).defaultPrevented).toBe(true);
    fireEvent.change(input(), { target: { value: 'alpha' } });
    input().blur();
    expect(key().defaultPrevented).toBe(false);
    expect(key(false, { ctrlKey: false, metaKey: true }).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(input());
    expect((input() as HTMLInputElement).selectionEnd).toBe(5);
    fireEvent.keyDown(input(), { key: 'Enter', keyCode: 229 });
    expect(count()).toBe('1 / 2');
  });
  it('shows no-match/unavailable states without searching the conversation', async () => {
    await mount({ ok: false, code: 'missing' });
    key();
    expect(count()).toBe(label('-unavailable'));
    expect(screen.getByRole('button', { name: label('-next') }).hasAttribute('disabled')).toBe(
      true,
    );
  });
});
