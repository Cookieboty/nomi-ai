// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Markdown } from '../src/components/Conversation/Markdown';
import { ResourceScopeProvider } from '../src/contexts/ResourceContext';
import { resourceTarget, workspaceFileHref } from '../src/utils/resourceLinks';

afterEach(cleanup);
describe('shared resource links', () => {
  it('resolves full paths, escaped file URIs, relative paths and source line locations', () => {
    expect(resourceTarget('/Users/a/文档 space.md:42')?.path).toBe('/Users/a/文档 space.md');
    expect(resourceTarget('/Users/a/文档 space.md:42')?.line).toBe(42);
    expect(resourceTarget('file:///Users/a/file%20name.md')?.path).toBe('/Users/a/file name.md');
    expect(resourceTarget('C:\\work\\a.ts:7:2')?.path).toBe('C:\\work\\a.ts');
    expect(resourceTarget('src/a.ts#L8')?.line).toBe(8);
    expect(resourceTarget('.../backend/internal/a.go')?.path).toBe('.../backend/internal/a.go');
  });

  it.each([
    [
      '/Users/a/other/backend/middleware/auth.go#L697-L719',
      '/Users/a/other/backend/middleware/auth.go',
      697,
      719,
    ],
    ['src/auth.go#L7-19', 'src/auth.go', 7, 19],
    ['../auth.go#L7C2-L19C8', '../auth.go', 7, 19],
    ['C:\\other\\auth.go:7:2-19:8', 'C:\\other\\auth.go', 7, 19],
    [
      'file:///Users/a/other%20project/auth.go#L697-L719',
      '/Users/a/other project/auth.go',
      697,
      719,
    ],
    ['file:///C:/other/auth.go#L7', 'C:/other/auth.go', 7, undefined],
    ['file:///Users/a/auth.go:7:2', '/Users/a/auth.go', 7, undefined],
  ])('separates source locations from real file paths: %s', (href, path, line, lineEnd) => {
    expect(resourceTarget(href as string)).toMatchObject({ path, line });
    expect(resourceTarget(href as string)?.lineEnd).toBe(lineEnd);
  });
  it('does not decode escaped filename punctuation into a line location or decode URI paths twice', () => {
    for (const [href, path] of [
      ['file:///Users/a/auth.go%23L7-L19', '/Users/a/auth.go#L7-L19'],
      ['file:///Users/a/name%2520.go#L7-L19', '/Users/a/name%20.go'],
      [workspaceFileHref('/work', 'auth.go#L7-L19'), '/work/auth.go#L7-L19'],
      [workspaceFileHref('/work', 'auth.go:7-19'), '/work/auth.go:7-19'],
    ])
      expect(resourceTarget(href!)?.path).toBe(path);
    expect(resourceTarget('file:///Users/a/auth.go%23L7-L19')?.line).toBeUndefined();
  });
  it('encodes literal file-list names once, including URL punctuation, line suffixes and Windows drives', () => {
    for (const [cwd, filename, expected] of [
      ['/work', '文档 %20#L8.md', '/work/文档 %20#L8.md'],
      ['/work', 'LICENSE:42', '/work/LICENSE:42'],
      ['/work %20', 'note.md', '/work %20/note.md'],
      ['C:\\work', '文档 #L8.md', 'C:/work/文档 #L8.md'],
      ['/work', '/other/final%23.md', '/other/final%23.md'],
    ]) {
      const target = resourceTarget(workspaceFileHref(cwd!, filename!));
      expect(target?.path).toBe(expected);
      expect(target?.line).toBeUndefined();
    }
  });

  it.each(['src/a.go#L0-L7', 'src/a.go#L19-L7', 'src/a.go#L9007199254740992', 'src/a.go:2-1'])(
    'rejects invalid source locations instead of treating them as paths: %s',
    (href) => expect(resourceTarget(href)).toBeNull(),
  );
  it('rejects dangerous schemes and URL credentials', () => {
    for (const value of [
      'javascript:alert(1)',
      'data:text/html,hello',
      'https://user:secret@example.com/',
      'file://remote-host/a.md',
      '/a\u0000b.md',
    ])
      expect(resourceTarget(value)).toBeNull();
  });
  it('links explicit file destinations and bare websites, leaving bare and inline-code file paths alone', () => {
    const open = vi.fn();
    const value = { scope: { id: 'cli:one', cwd: '/work' }, open };
    const { container } = render(
      <ResourceScopeProvider value={value}>
        <Markdown
          text={
            '文件：`/work/文档 space.md`\n\nhttps://example.com\n\n[说明](src/readme.md)\n\n```txt\n/work/no-link.md\n```'
          }
          settled
        />
      </ResourceScopeProvider>,
    );
    const links = container.querySelectorAll('a');
    expect(links).toHaveLength(2);
    expect(screen.getByRole('link', { name: 'https://example.com' }).getAttribute('href')).toBe(
      'https://example.com',
    );
    fireEvent.click(screen.getByText('说明'));
    expect(resourceTarget(open.mock.calls[0]![0] as string)?.path).toBe('src/readme.md');
    expect(container.querySelector('code a')).toBeNull();
    expect(open.mock.calls[0]![1]).toEqual(value.scope);
    expect(container.querySelector('pre a')).toBeNull();
    expect(container.querySelector('a a')).toBeNull();
  });
  it('cached rendering binds clicks to the surrounding conversation, not the first rendered workspace', () => {
    const open = vi.fn();
    const text = '[result](note.md)';
    const { rerender } = render(
      <ResourceScopeProvider value={{ scope: { id: 'a', cwd: '/a' }, open }}>
        <Markdown text={text} settled />
      </ResourceScopeProvider>,
    );
    fireEvent.click(screen.getByText('result'));
    rerender(
      <ResourceScopeProvider value={{ scope: { id: 'b', cwd: '/b' }, open }}>
        <Markdown text={text} settled />
      </ResourceScopeProvider>,
    );
    fireEvent.click(screen.getByText('result'));
    expect(open.mock.calls[1]).toEqual([
      'note.md',
      { id: 'b', cwd: '/b' },
      { origin: 'assistant' },
    ]);
  });
});
