// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';

import { CodeDocument } from '../src/components/ResourcePreview/CodeDocument';
import { ResourcePreview } from '../src/components/ResourcePreview/ResourcePreview';
import { resourcePreviewClient } from '../src/services/resourcePreviewClient';

import { changeSource, sourceEditable, sourceValue, sourceView } from './helpers/codeView';
vi.mock('../src/services/api', async () => (await import('./helpers/fakeApi')).fakeApiModule());
vi.mock('../src/services/resourcePreviewClient', () => ({
  resourcePreviewClient: {
    open: vi.fn(),
    save: vi.fn(),
    close: vi.fn(async () => undefined),
    web: vi.fn(),
  },
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
it('keeps Swift tokens live while editing with a virtualized editor and preserves unknown text as inert text', () => {
  const changed = vi.fn();
  const props = { viewportRef: vi.fn(), onRendered: vi.fn(), onScroll: vi.fn(), onChange: changed };
  const view = render(
    <CodeDocument
      editable
      {...props}
      text={'import Foundation\nlet value = "old"'}
      language="swift"
    />,
  );
  expect(view.container.querySelector('.token.keyword')?.textContent).toBe('import');
  const editor = screen.getByTestId('resource-preview-source');
  expect(sourceEditable(editor)).toBe(true);
  expect(view.container.querySelectorAll('.cm-lineNumbers .cm-gutterElement')).toHaveLength(3);
  changeSource(editor, 'import AppKit\nlet updated = "new"');
  expect(changed).toHaveBeenCalledWith('import AppKit\nlet updated = "new"');
  expect(view.container.querySelector('.token.keyword')?.textContent).toBe('import');
  view.rerender(
    <CodeDocument editable {...props} text={'<script>alert(1)</script>'} language="text" />,
  );
  expect(view.container.querySelector('script')).toBeNull();
  expect(view.container.querySelector('.token')).toBeNull();
});
it('retains the selected language when entering edit mode and keeps editing when the language is changed', async () => {
  vi.mocked(resourcePreviewClient.open).mockResolvedValue({
    ok: true,
    kind: 'text',
    path: '/work/main.swift',
    content: 'import Foundation\nlet value = "hello"',
    editable: true,
    url: '/__nomi/preview/swift',
    revision: 'a'.repeat(64),
  });
  vi.mocked(resourcePreviewClient.save).mockResolvedValue({ ok: true, revision: 'b'.repeat(64) });
  const props = {
    entries: [{ key: 'swift', href: '/work/main.swift', scope: { id: 'test', cwd: '/work' } }],
    activeKey: 'swift',
    expanded: true,
    originMismatch: false,
    onActive: vi.fn(),
    onCloseEntry: vi.fn(),
    onCloseEntries: vi.fn(),
    onExpanded: vi.fn(),
    onOpen: vi.fn(),
  };
  const { container } = render(<ResourcePreview {...props} />);
  await screen.findByTestId('resource-preview-edit');
  fireEvent.click(screen.getByTestId('resource-preview-edit'));
  await waitFor(() =>
    expect(sourceEditable(screen.getByTestId('resource-preview-source'))).toBe(true),
  );
  expect(container.querySelector('[data-preview-code-scroll] .token.keyword')?.textContent).toBe(
    'import',
  );
  fireEvent.change(screen.getByTestId('preview-syntax-select'), { target: { value: 'python' } });
  await waitFor(() =>
    expect(screen.getByTestId('resource-preview-source').getAttribute('data-code-language')).toBe(
      'python',
    ),
  );
  expect(sourceEditable(screen.getByTestId('resource-preview-source'))).toBe(true);
  changeSource(screen.getByTestId('resource-preview-source'), 'print("saved")');
  await waitFor(() =>
    expect(resourcePreviewClient.save).toHaveBeenCalledWith(
      '/__nomi/preview/swift',
      'a'.repeat(64),
      'print("saved")',
    ),
  );
  expect(container.querySelector('[data-preview-code-scroll] .token.string')?.textContent).toBe(
    '"saved"',
  );
});

it('keeps one editor, selection and undo stack across read-only and language changes, preserving CRLF', async () => {
  const onChange = vi.fn();
  const base = {
    text: 'import Foundation\r\nlet value = "old"\r\n',
    language: 'swift',
    viewportRef: vi.fn(),
    onRendered: vi.fn(),
    onScroll: vi.fn(),
    onChange,
  };
  const rendered = render(<CodeDocument {...base} editable />);
  const editor = sourceView(screen.getByTestId('resource-preview-source'));
  changeSource(editor.scrollDOM, 'import AppKit\r\nlet value = "new"\r\n');
  expect(onChange).toHaveBeenLastCalledWith('import AppKit\r\nlet value = "new"\r\n');
  const changed = onChange.mock.lastCall![0];
  editor.dispatch({ selection: { anchor: 4, head: 7 } });
  rendered.rerender(<CodeDocument {...base} text={changed} editable={false} />);
  expect(sourceView(editor.scrollDOM)).toBe(editor);
  expect(editor.state.selection.main.from).toBe(4);
  expect(editor.state.readOnly).toBe(true);
  rendered.rerender(<CodeDocument {...base} text={changed} language="python" editable />);
  const { undo } = await import('@codemirror/commands');
  undo(editor);
  expect(sourceValue(editor.scrollDOM)).toBe(base.text);
  expect(onChange).toHaveBeenLastCalledWith(base.text);
});
