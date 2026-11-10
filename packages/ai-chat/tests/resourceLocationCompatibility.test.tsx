// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Markdown } from '../src/components/Conversation/Markdown';
import { EditableMarkdown } from '../src/components/ResourcePreview/EditableMarkdown';
import { PreviewDocumentContext } from '../src/components/ResourcePreview/PreviewDocumentContext';
import { PreviewMarkdown } from '../src/components/ResourcePreview/PreviewMarkdown';
import { ResourceScopeProvider } from '../src/contexts/ResourceContext';
import { resourceTarget, workspaceFileHref } from '../src/utils/resourceLinks';

const separators = ['-', '–', '—', '−'];
afterEach(cleanup);

describe('source location spelling compatibility', () => {
  it.each(separators)(
    'parses line ranges separated by %s without changing the file path',
    (dash) => {
      for (const [href, path, line, lineEnd] of [
        [`/Users/a/project/admin.go:615${dash}617`, '/Users/a/project/admin.go', 615, 617],
        [`src/context.go:31${dash}34`, 'src/context.go', 31, 34],
        [`context.go:L30${dash}L33`, 'context.go', 30, 33],
        [`context.go:30${dash}L33`, 'context.go', 30, 33],
        [`context.go:L30${dash}33`, 'context.go', 30, 33],
        ['context.go:L30', 'context.go', 30, undefined],
        [`../context.go#L30${dash}L33`, '../context.go', 30, 33],
        [`../context.go#L30C2${dash}33C8`, '../context.go', 30, 33],
        [`C:\\work\\context.go:L30:2${dash}L33:8`, 'C:\\work\\context.go', 30, 33],
        [`/work/feature–branch/context.go:30${dash}33`, '/work/feature–branch/context.go', 30, 33],
        [
          `file:///work/my%20project/context.go:L30${dash}L33`,
          '/work/my project/context.go',
          30,
          33,
        ],
        [`file:///C:/work/context.go#L30${dash}L33`, 'C:/work/context.go', 30, 33],
      ] as const) {
        expect(resourceTarget(href)).toMatchObject({ href, path, line });
        expect(resourceTarget(href)?.lineEnd).toBe(lineEnd);
        expect(resourceTarget(href)?.fragment).toBeUndefined();
      }
    },
  );

  it.each(['%E2%80%93', '%e2%80%94', '%E2%88%92'])(
    'recognizes URL-encoded range separator %s only after literal location markers',
    (dash) => {
      for (const href of [
        `context.go:L30${dash}L33`,
        `/work/context.go:30${dash}33`,
        `/work/context.go#L30${dash}L33`,
        `file:///work/context.go:L30${dash}L33`,
      ])
        expect(resourceTarget(href)).toMatchObject({
          path: href.startsWith('context') ? 'context.go' : '/work/context.go',
          line: 30,
          lineEnd: 33,
        });
    },
  );

  it.each(separators)('rejects invalid locations separated by %s', (dash) => {
    for (const href of [
      `src/a.go:L0${dash}L7`,
      `src/a.go:L19${dash}L7`,
      `src/a.go#L0${dash}L7`,
      `src/a.go#L19${dash}L7`,
      `src/a.go:2${dash}1`,
      'src/a.go:L9007199254740992',
    ])
      expect(resourceTarget(href)).toBeNull();
  });

  it('preserves encoded filename punctuation and does not decode twice', () => {
    for (const filename of ['context.go:L30–L33', 'context.go:31—34', 'context.go#L30−L33']) {
      const target = resourceTarget(workspaceFileHref('/work', filename));
      expect(target?.path).toBe(`/work/${filename}`);
      expect(target?.line).toBeUndefined();
      expect(target?.fragment).toBeUndefined();
    }
    expect(resourceTarget('file:///work/context.go%3AL30%E2%80%93L33')).toMatchObject({
      path: '/work/context.go:L30–L33',
    });
    expect(resourceTarget('file:///work/context.go%3AL30%E2%80%93L33')?.line).toBeUndefined();
    expect(resourceTarget('/work/context.go:L30%25E2%2580%2593L33')).toMatchObject({
      path: '/work/context.go:L30%E2%80%93L33',
    });
    expect(resourceTarget('/work/context.go:L30%25E2%2580%2593L33')?.line).toBeUndefined();
    expect(resourceTarget('https://example.com/context.go:L30–L33')).toMatchObject({ web: true });
    expect(resourceTarget('guide.md#chapter–two')).toMatchObject({
      path: 'guide.md',
      fragment: 'chapter–two',
    });
  });
});

for (const editable of [false, true])
  describe(`${editable ? 'editable' : 'readonly'} location link clicks`, () => {
    it('opens relative Markdown files from the document directory and preserves fragments', () => {
      const open = vi.fn();
      const scope = { id: 'relative-document', cwd: '/work' };
      const text = [
        '[Same directory](guide.md)',
        '[Explicit current](./guide.md)',
        '[Parent](../README.md)',
        '[Nested file](details/design.md)',
        '[Space](./design%20notes.md)',
        '[Heading](guide.md#installation)',
        '[Website](https://example.com/help)',
      ].join('\n\n');
      render(
        <ResourceScopeProvider value={{ scope, open }}>
          <PreviewDocumentContext.Provider value={{ directory: '/work/docs' }}>
            {editable ? (
              <EditableMarkdown text={text} editable onChange={vi.fn()} />
            ) : (
              <PreviewMarkdown text={text} />
            )}
          </PreviewDocumentContext.Provider>
        </ResourceScopeProvider>,
      );
      for (const link of screen.getAllByRole('link')) fireEvent.click(link);
      expect(open.mock.calls.map(([href]) => resourceTarget(href as string))).toEqual([
        expect.objectContaining({ path: '/work/docs/guide.md' }),
        expect.objectContaining({ path: '/work/docs/guide.md' }),
        expect.objectContaining({ path: '/work/README.md' }),
        expect.objectContaining({ path: '/work/docs/details/design.md' }),
        expect.objectContaining({ path: '/work/docs/design notes.md' }),
        expect.objectContaining({ path: '/work/docs/guide.md', fragment: 'installation' }),
        expect.objectContaining({ href: 'https://example.com/help', web: true }),
      ]);
      for (const [, origin, info] of open.mock.calls) {
        expect(origin).toEqual(scope);
        expect(info).toEqual({ origin: 'document' });
      }
    });
    it.each(separators)(
      'opens explicit Markdown links with plain and inline-code labels using %s',
      (dash) => {
        const open = vi.fn();
        const scope = { id: 'sample', cwd: '/work' };
        const context = { scope, open };
        const text = [
          '| 来源 | 链接 |',
          '| --- | --- |',
          `| 第一处 | [/Users/a/project/admin.go:615${dash}617（定位 L616）](/Users/a/project/admin.go:615${dash}617) |`,
          `| 第二处 | [src/context.go:31${dash}34](src/context.go:31${dash}34) |`,
          `| 第三处 | [\`context.go:L30${dash}L33\`](context.go:L30${dash}L33) |`,
        ].join('\n');
        const { container } = render(
          <ResourceScopeProvider value={context}>
            <PreviewDocumentContext.Provider value={{ directory: '/work/docs' }}>
              {editable ? (
                <EditableMarkdown text={text} editable onChange={vi.fn()} />
              ) : (
                <PreviewMarkdown text={text} />
              )}
            </PreviewDocumentContext.Provider>
          </ResourceScopeProvider>,
        );
        expect(container.querySelectorAll('td a[data-resource-preview]')).toHaveLength(3);
        for (const link of screen.getAllByRole('link')) fireEvent.click(link);
        expect(open.mock.calls.map(([href]) => resourceTarget(href as string))).toEqual([
          expect.objectContaining({ path: '/Users/a/project/admin.go', line: 615, lineEnd: 617 }),
          expect.objectContaining({ path: '/work/docs/src/context.go', line: 31, lineEnd: 34 }),
          expect.objectContaining({ path: '/work/docs/context.go', line: 30, lineEnd: 33 }),
        ]);
        for (const [, origin] of open.mock.calls) expect(origin).toEqual(scope);
      },
    );
  });

for (const settled of [false, true])
  describe(`${settled ? 'completed' : 'streaming'} main conversation location links`, () => {
    it.each(separators)('opens full #L697%sL719 ranges in the conversation workspace', (dash) => {
      const open = vi.fn();
      const scope = { id: 'main-conversation', cwd: '/work' };
      const text = [
        `[auth.go#L697${dash}L719](/work/backend/middleware/auth.go#L697${dash}L719)`,
        `[\`auth.go#L697${dash}L719\`](auth.go#L697${dash}L719)`,
        `[backend/middleware/auth.go#L697${dash}L719](backend/middleware/auth.go#L697${dash}L719)`,
        `[\`auth.go:L697${dash}L719\`](auth.go:L697${dash}L719)`,
      ].join('\n\n');
      const { container } = render(
        <ResourceScopeProvider value={{ scope, open }}>
          <Markdown text={text} settled={settled} streaming={!settled} />
        </ResourceScopeProvider>,
      );
      expect(container.querySelectorAll('a[data-resource-preview]')).toHaveLength(4);
      for (const link of screen.getAllByRole('link')) fireEvent.click(link);
      expect(open.mock.calls.map(([href]) => resourceTarget(href as string))).toEqual([
        expect.objectContaining({
          path: '/work/backend/middleware/auth.go',
          line: 697,
          lineEnd: 719,
        }),
        expect.objectContaining({ path: 'auth.go', line: 697, lineEnd: 719 }),
        expect.objectContaining({ path: 'backend/middleware/auth.go', line: 697, lineEnd: 719 }),
        expect.objectContaining({ path: 'auth.go', line: 697, lineEnd: 719 }),
      ]);
      for (const [, origin, options] of open.mock.calls) {
        expect(origin).toEqual(scope);
        expect(options).toEqual({ origin: 'assistant' });
      }
      expect(container.querySelector('a a')).toBeNull();
    });
  });
