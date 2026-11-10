// @vitest-environment happy-dom
import { syntaxTree } from '@codemirror/language';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';

import { CodeDocument } from '../src/components/ResourcePreview/CodeDocument';
import { resolveCodeLanguage } from '../src/components/ResourcePreview/codeSyntax';
import { ResourcePreview } from '../src/components/ResourcePreview/ResourcePreview';
import { resourcePreviewClient } from '../src/services/resourcePreviewClient';

import { sourceValue, sourceView } from './helpers/codeView';

vi.mock('../src/services/api', async () => (await import('./helpers/fakeApi')).fakeApiModule());
vi.mock('../src/services/resourcePreviewClient', () => ({
  resourcePreviewClient: {
    open: vi.fn(),
    close: vi.fn(async () => undefined),
    save: vi.fn(),
    web: vi.fn(),
  },
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it.each([
  ['auth.go', 'go'],
  ['C:\\work\\App.TSX', 'tsx'],
  ['Dockerfile', 'docker'],
  ['Dockerfile.prod', 'docker'],
  ['Makefile', 'makefile'],
  ['.env.local', 'bash'],
  ['config.yaml', 'yaml'],
  ['code.zig', 'zig'],
  ['package.json', 'json'],
  ['file.unknown', 'text'],
  ['README', 'text'],
  ['notes.txt', 'text'],
])('resolves a safe explicit grammar for %s', (path, language) => {
  expect(resolveCodeLanguage(path)).toBe(language);
});
it('uses shebangs for extensionless scripts and never guesses a grammar from ordinary prose', () => {
  expect(resolveCodeLanguage('script', '#!/usr/bin/env python3\nprint(1)')).toBe('python');
  expect(resolveCodeLanguage('notes.data', 'const value = 1')).toBe('text');
});

it.each([
  ['go', 'package main\nfunc main() { println("hello") }', 'package'],
  ['swift', 'import Foundation\nlet value = "hello"', 'import'],
  ['typescript', 'const value: string = "hello";', 'const'],
])(
  'renders %s tokens on the first commit without runtime grammar loading',
  (language, text, keyword) => {
    const { container } = render(
      <CodeDocument
        text={text}
        language={language}
        viewportRef={vi.fn()}
        onRendered={vi.fn()}
        onScroll={vi.fn()}
      />,
    );
    expect(container.querySelector('.token.keyword')?.textContent).toBe(keyword);
    expect(container.querySelector('.token.string')?.textContent).toBe('"hello"');
  },
);

it('uses the real third-party Go grammar and preserves line ranges and searchable source text', async () => {
  const text = 'package main\n\nfunc main() {\n\tprintln("hello")\n}';
  const onRendered = vi.fn();
  const { container } = render(
    <CodeDocument
      text={text}
      language="go"
      line={3}
      lineEnd={4}
      viewportRef={vi.fn()}
      onRendered={onRendered}
      onScroll={vi.fn()}
    />,
  );
  await waitFor(() =>
    expect(container.querySelector('.token.keyword')?.textContent).toBe('package'),
  );
  expect(container.querySelector('#preview-line-3')?.getAttribute('data-active')).toBe('true');
  expect(container.querySelector('#preview-line-4')?.getAttribute('data-active')).toBe('true');
  expect(container.querySelector('#preview-line-5')?.hasAttribute('data-active')).toBe(false);
  expect(sourceValue(screen.getByTestId('resource-preview-source'))).toBe(text);
  expect(container.querySelector('textarea,[contenteditable="true"]')).toBeNull();
  expect(onRendered).toHaveBeenCalled();
});

it('treats unknown text and HTML-shaped source as inert text', async () => {
  const text = '<script>alert("example")</script>\n<img src=x onerror="alert(1)">';
  const { container } = render(
    <CodeDocument
      text={text}
      language="text"
      viewportRef={vi.fn()}
      onRendered={vi.fn()}
      onScroll={vi.fn()}
    />,
  );
  await waitFor(() => expect(container.querySelector('#preview-line-2')).not.toBeNull());
  expect(sourceValue(screen.getByTestId('resource-preview-source'))).toBe(text);
  expect(container.querySelector('script,img')).toBeNull();
});

function props(activeKey = 'go') {
  return {
    entries: [
      { key: 'go', href: '/work/auth.go', scope: { id: 'test', cwd: '/work' } },
      { key: 'unknown', href: '/work/notes.unknown', scope: { id: 'test', cwd: '/work' } },
    ],
    activeKey,
    expanded: true,
    originMismatch: false,
    onActive: vi.fn(),
    onCloseEntry: vi.fn(),
    onCloseEntries: vi.fn(),
    onExpanded: vi.fn(),
    onOpen: vi.fn(),
  };
}
it('replaces the text source button with syntax selection, remembers overrides per tab and restores detection', async () => {
  vi.mocked(resourcePreviewClient.open).mockImplementation(async (_, path) => ({
    ok: true,
    kind: 'text',
    path,
    content: 'const answer = 42;',
  }));
  const view = render(<ResourcePreview {...props()} />);
  await screen.findByTestId('preview-syntax-select');
  expect(screen.getByTestId('resource-preview-source').getAttribute('data-code-language')).toBe(
    'go',
  );
  expect(screen.queryByTestId('resource-preview-mode')).toBeNull();
  fireEvent.change(screen.getByTestId('preview-syntax-select'), {
    target: { value: 'javascript' },
  });
  await waitFor(() =>
    expect(
      screen.getByTestId('resource-preview-source').querySelector('.token.keyword')?.textContent,
    ).toBe('const'),
  );
  view.rerender(<ResourcePreview {...props('unknown')} />);
  await waitFor(() =>
    expect(screen.getByTestId('resource-preview-source').getAttribute('data-code-language')).toBe(
      'text',
    ),
  );
  view.rerender(<ResourcePreview {...props()} />);
  await waitFor(() =>
    expect(screen.getByTestId('resource-preview-source').getAttribute('data-code-language')).toBe(
      'javascript',
    ),
  );
  fireEvent.change(screen.getByTestId('preview-syntax-select'), { target: { value: 'text' } });
  await waitFor(() =>
    expect(screen.getByTestId('resource-preview-source').querySelector('.token')).toBeNull(),
  );
  fireEvent.change(screen.getByTestId('preview-syntax-select'), { target: { value: 'auto' } });
  expect(screen.getByTestId('resource-preview-source').getAttribute('data-code-language')).toBe(
    'go',
  );
  expect(resourcePreviewClient.save).not.toHaveBeenCalled();
});

it('keeps the document and syntax tree when scroll handlers or host layout update', () => {
  const input = {
    text: 'package main\nfunc main() {}',
    language: 'go',
    viewportRef: vi.fn(),
    onRendered: vi.fn(),
    onScroll: vi.fn(),
  };
  const rendered = render(<CodeDocument {...input} />);
  const editor = sourceView(screen.getByTestId('resource-preview-source'));
  const doc = editor.state.doc,
    tree = syntaxTree(editor.state);
  rendered.rerender(<CodeDocument {...input} onRendered={vi.fn()} onScroll={vi.fn()} />);
  fireEvent.scroll(editor.scrollDOM, { target: { scrollTop: 80 } });
  expect(sourceView(screen.getByTestId('resource-preview-source'))).toBe(editor);
  expect(editor.state.doc).toBe(doc);
  expect(syntaxTree(editor.state)).toBe(tree);
});

it('keeps a 100,000-line source model while drawing a bounded viewport', () => {
  const text = Array.from({ length: 100_000 }, (_, index) => `line ${index + 1}`).join('\n');
  const { container } = render(
    <CodeDocument
      text={text}
      language="text"
      viewportRef={vi.fn()}
      onRendered={vi.fn()}
      onScroll={vi.fn()}
    />,
  );
  const editor = sourceView(screen.getByTestId('resource-preview-source'));
  expect(editor.state.doc.lines).toBe(100_000);
  expect(editor.state.doc.line(99_990).text).toBe('line 99990');
  expect(container.querySelectorAll('.cm-line').length).toBeLessThan(500);
  expect(container.querySelectorAll('.cm-gutterElement').length).toBeLessThan(500);
});
