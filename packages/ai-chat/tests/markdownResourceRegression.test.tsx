// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Markdown } from '../src/components/Conversation/Markdown';
import { EditableMarkdown } from '../src/components/ResourcePreview/EditableMarkdown';
import { MarkdownDocument } from '../src/components/ResourcePreview/MarkdownDocument';
import { PreviewDocumentContext } from '../src/components/ResourcePreview/PreviewDocumentContext';
import { PreviewMarkdown } from '../src/components/ResourcePreview/PreviewMarkdown';
import { ResourceScopeProvider } from '../src/contexts/ResourceContext';
import { resourceTarget, resolveDocumentHref, workspaceFileHref } from '../src/utils/resourceLinks';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Markdown file destinations', () => {
  it('does not auto-link ordinary source filenames', () => {
    const { container } = render(
      <Markdown text="demo.tsx demo.jsx demo.cpp readme.mdx demo.test.ts demo.ts.bak" settled />,
    );
    expect(container.querySelector('a')).toBeNull();
    expect(container.textContent).toContain('demo.test.ts demo.ts.bak');
  });
  it('keeps literal encoded-directory characters when resolving a document link', () => {
    expect(
      resourceTarget(resolveDocumentHref('/work/docs#1%20', './guide.md#intro')),
    ).toMatchObject({
      path: '/work/docs#1%20/guide.md',
      fragment: 'intro',
    });
  });
  it.each([
    ['guide.md#32-示例章节', 'guide.md', '32-示例章节'],
    ['/work/guide.md#32-%E7%A4%BA%E4%BE%8B', '/work/guide.md', '32-示例'],
    ['file:///work/my%20guide.md#intro', '/work/my guide.md', 'intro'],
    ['C:\\work\\guide.md#intro', 'C:\\work\\guide.md', 'intro'],
    ['guide.md#', 'guide.md', ''],
  ])('splits headings from the file read: %s', (href, path, fragment) => {
    expect(resourceTarget(href)).toMatchObject({ path, fragment });
    expect(resourceTarget(href)?.line).toBeUndefined();
  });
  it('retains literal escaped hashes and decodes the location only once', () => {
    expect(resourceTarget(workspaceFileHref('/work', 'file#intro.md'))?.path).toBe(
      '/work/file#intro.md',
    );
    expect(resourceTarget('file:///work/a%23b.md#part%2520one')).toMatchObject({
      path: '/work/a#b.md',
      fragment: 'part%20one',
    });
    expect(resourceTarget('src/demo.go#L7-L9')).toMatchObject({
      path: 'src/demo.go',
      line: 7,
      lineEnd: 9,
    });
  });
  it('keeps explicit source basenames and document fragments clickable', () => {
    const open = vi.fn();
    render(
      <ResourceScopeProvider value={{ scope: { id: 'sample', cwd: '/work' }, open }}>
        <Markdown text="[source](demo.go:7-9) [guide](docs/guide.md#示例)" settled />
      </ResourceScopeProvider>,
    );
    fireEvent.click(screen.getByRole('link', { name: 'source' }));
    expect(resourceTarget(open.mock.calls[0]![0])).toMatchObject({
      path: 'demo.go',
      line: 7,
      lineEnd: 9,
    });
    fireEvent.click(screen.getByRole('link', { name: 'guide' }));
    expect(resourceTarget(open.mock.calls[1]![0])).toMatchObject({
      path: 'docs/guide.md',
      fragment: '示例',
    });
  });
});

for (const editable of [false, true])
  describe(`${editable ? 'editable' : 'readonly'} Markdown pipeline`, () => {
    function setup(text: string) {
      const open = vi.fn(),
        onChange = vi.fn();
      const context = {
        scope: { id: 'sample', cwd: '/work' },
        open,
      };
      const result = render(
        <ResourceScopeProvider value={context}>
          <PreviewDocumentContext.Provider value={{ directory: '/work/docs' }}>
            {editable ? (
              <EditableMarkdown text={text} editable onChange={onChange} />
            ) : (
              <PreviewMarkdown text={text} />
            )}
          </PreviewDocumentContext.Provider>
        </ResourceScopeProvider>,
      );
      return { ...result, open, onChange };
    }
    it('renders table breaks and explicit links without changing code samples', () => {
      const { container, open } = setup(
        '| A | B |\n| --- | --- |\n| first<br>second<BR/>third<br />fourth | [source](/work/demo.go:7-9)<br>[`../other.go#L2-L4`](../other.go#L2-L4) |\n\n```text\n<br> /work/sample.go\n```',
      );
      expect(container.querySelectorAll('td br')).toHaveLength(4);
      expect(container.querySelector('td')?.textContent).not.toContain('<br');
      const links = container.querySelectorAll('td a');
      expect(links).toHaveLength(2);
      fireEvent.click(links[0]!);
      expect(resourceTarget(open.mock.calls[0]![0])?.path).toBe('/work/demo.go');
      fireEvent.click(links[1]!);
      expect(resourceTarget(open.mock.calls[1]![0])).toMatchObject({
        path: '/work/other.go',
        line: 2,
        lineEnd: 4,
      });
      expect(container.querySelector('pre a')).toBeNull();
      expect(container.querySelector('pre')?.textContent).toContain('<br> /work/sample.go');
    });
    it('does not enable raw HTML, event attributes or executable protocols', () => {
      const { container } = setup(
        'safe<br onclick="alert(1)">text <script>alert(1)</script> [bad](javascript:alert%281%29)\n\n<iframe src="https://example.com"></iframe>\n\n`<br>` and &lt;br&gt;',
      );
      expect(container.querySelector('script,iframe,[onclick]')).toBeNull();
      expect(container.querySelector('br')).toBeNull();
      expect(container.querySelector('a')).toBeNull();
      expect(container.querySelector('code')?.textContent).toBe('<br>');
    });
    it('keeps mail links out of filesystem resolution', () => {
      setup('[mail](mailto:demo@example.com)');
      expect(screen.getByRole('link', { name: 'mail' }).getAttribute('href')).toBe(
        'mailto:demo@example.com',
      );
    });
    it('passes file URIs, Windows paths and heading fragments to the same resource handler', () => {
      const { open } = setup(
        '[file](file:///work/demo.go#L2-L3) [win](C:/work/demo.go:7) [chapter](./guide.md#intro)',
      );
      fireEvent.click(screen.getByRole('link', { name: 'file' }));
      fireEvent.click(screen.getByRole('link', { name: 'win' }));
      fireEvent.click(screen.getByRole('link', { name: 'chapter' }));
      expect(open.mock.calls.map((c) => resourceTarget(c[0]))).toEqual([
        expect.objectContaining({ path: '/work/demo.go', line: 2, lineEnd: 3 }),
        expect.objectContaining({ path: 'C:/work/demo.go', line: 7 }),
        expect.objectContaining({
          path: '/work/docs/guide.md',
          fragment: 'intro',
        }),
      ]);
    });
  });

describe('Rendered edits preserve the source', () => {
  it('keeps unlinked paths and HTML break spelling when editing nearby text', () => {
    const onChange = vi.fn();
    const text =
      '| A | B |\r\n| --- | --- |\r\n| first<BR />second /work/demo.go:2 `../demo.go#L2` | untouched |\r\n';
    const { container } = render(
      <ResourceScopeProvider value={{ scope: { id: 'sample', cwd: '/work' }, open: vi.fn() }}>
        <EditableMarkdown text={text} editable onChange={onChange} />
      </ResourceScopeProvider>,
    );
    const cell = container.querySelector('td')!;
    cell.childNodes[0]!.textContent = 'changed';
    fireEvent.input(cell);
    expect(onChange).toHaveBeenLastCalledWith(text.replace('first', 'changed'));
  });
});

describe('Document-local heading navigation', () => {
  it('decodes anchors, scrolls only the document and keeps composer focus', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      return {
        top: this.tagName === 'H2' ? 350 : 0,
        bottom: 0,
        left: 0,
        right: 0,
        width: 500,
        height: 100,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      };
    });
    const open = vi.fn();
    render(
      <>
        <textarea aria-label="composer" />
        <MarkdownDocument
          text={'[local](#%E7%A4%BA%E4%BE%8B)\n\n## 示例\n\n[missing](#absent)'}
          context={{ scope: { id: 'sample', cwd: '/work' }, open }}
          documentDir="/work"
          outline
          onOutlineChange={vi.fn()}
          scrollTop={0}
          onScroll={vi.fn()}
        />
      </>,
    );
    screen.getByRole('textbox').focus();
    fireEvent.click(screen.getByRole('link', { name: 'local' }));
    expect(screen.getByTestId('preview-markdown').scrollTop).toBe(350);
    expect(document.activeElement).toBe(screen.getByRole('textbox'));
    expect(open).not.toHaveBeenCalled();
    const hash = window.location.hash;
    fireEvent.click(screen.getByRole('link', { name: 'missing' }));
    expect(window.location.hash).toBe(hash);
  });
});

describe('Unique document heading IDs', () => {
  it('avoids collisions between duplicate titles and explicitly numbered titles', () => {
    const { container } = render(
      <MarkdownDocument
        text={'# Same\n\n# Same\n\n# Same-1\n\n# Same'}
        context={{ scope: { id: 'sample' }, open: vi.fn() }}
        documentDir="/work"
        outline
        onOutlineChange={vi.fn()}
        scrollTop={0}
        onScroll={vi.fn()}
      />,
    );
    expect(Array.from(container.querySelectorAll('h1')).map((h) => h.id)).toEqual([
      'same',
      'same-1',
      'same-1-1',
      'same-2',
    ]);
  });
});
