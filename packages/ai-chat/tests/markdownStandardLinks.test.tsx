// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Markdown } from '../src/components/Conversation/Markdown';
import { EditableMarkdown } from '../src/components/ResourcePreview/EditableMarkdown';
import { PreviewMarkdown } from '../src/components/ResourcePreview/PreviewMarkdown';
import { ResourceScopeProvider } from '../src/contexts/ResourceContext';
import { resourceTarget } from '../src/utils/resourceLinks';

const modes = ['completed', 'streaming', 'editable', 'preview'] as const;
afterEach(cleanup);

for (const mode of modes)
  describe(`${mode} Markdown link policy`, () => {
    function setup(text: string) {
      const open = vi.fn();
      const scope = { id: 'standard-links', cwd: '/work' };
      const result = render(
        <ResourceScopeProvider value={{ scope, open }}>
          {mode === 'editable' ? (
            <EditableMarkdown text={text} editable onChange={vi.fn()} />
          ) : mode === 'preview' ? (
            <PreviewMarkdown text={text} />
          ) : (
            <Markdown text={text} settled={mode === 'completed'} streaming={mode === 'streaming'} />
          )}
        </ResourceScopeProvider>,
      );
      return { ...result, open, scope };
    }

    it('leaves bare paths and inline-code paths untouched, including trailing location notes', () => {
      const path =
        '/Users/tanx/cursor-work/xy-token-api/backend/internal/user/handler/admin.go:615–617';
      const { container, open } = setup(
        `${path}（定位 L616）\n\n\`${path}\`\n\nsrc/context.go:L30–L33\n\nC:\\work\\demo.go:7–9\n\nfile:///work/demo.go#L7–L9`,
      );
      expect(container.querySelector('a')).toBeNull();
      expect(container.textContent).toContain(`${path}（定位 L616）`);
      expect(container.querySelector('code')?.textContent).toBe(path);
      expect(open).not.toHaveBeenCalled();
    });

    it('autolinks bare websites in conversation text and leaves bare emails as text', () => {
      const { container } = setup(
        '| 地址 | 说明 |\n| --- | --- |\n| https://example.com | ~~删除线~~ |\n\nwww.example.com demo@example.com\n\n`https://example.com`',
      );
      const links = [...container.querySelectorAll('a')];
      if (mode === 'completed' || mode === 'streaming') {
        expect(links.map((link) => link.getAttribute('href'))).toEqual([
          'https://example.com',
          'http://www.example.com',
        ]);
      } else expect(links).toHaveLength(0);
      expect(container.querySelector('a code')).toBeNull();
      expect(container.querySelector('table')).not.toBeNull();
      expect(container.querySelector('del')?.textContent).toBe('删除线');
      expect(container.textContent).toContain('https://example.com');
      expect(container.textContent).toContain('demo@example.com');
    });

    if (mode === 'completed' || mode === 'streaming') {
      it('renders the screenshot website and opens it through the existing resource handler', () => {
        const { open, scope } = setup('百度地址：https://www.baidu.com');
        const link = screen.getByRole('link', { name: 'https://www.baidu.com' });
        expect(link.getAttribute('href')).toBe('https://www.baidu.com');
        fireEvent.click(link);
        expect(open).toHaveBeenCalledExactlyOnceWith('https://www.baidu.com', scope, {
          origin: 'assistant',
        });
      });

      it('preserves URL paths, query strings and fragments, excluding surrounding punctuation', () => {
        setup('Visit (https://example.com/docs?q=hello&lang=zh#intro), or http://example.org.');
        expect(screen.getAllByRole('link').map((link) => link.getAttribute('href'))).toEqual([
          'https://example.com/docs?q=hello&lang=zh#intro',
          'http://example.org',
        ]);
      });

      it('keeps websites in inline and fenced code as text and rejects unsafe protocols', () => {
        const { container } = setup(
          '`https://example.com`\n\n```\nhttps://example.com\n```\n\njavascript:alert(1) data:text/html,example ftp://example.com\n\n[unsafe](javascript:alert%281%29)',
        );
        expect(container.querySelector('a')).toBeNull();
        expect(container.querySelectorAll('code')).toHaveLength(2);
      });
    }

    it('opens only the authored destination and keeps the location note outside the link', () => {
      const path = '/work/admin.go:615–617';
      const { container, open, scope } = setup(`[${path}](${path})（定位 L616）`);
      const link = screen.getByRole('link');
      expect(link.textContent).toBe(path);
      expect(container.textContent).toContain(`${path}（定位 L616）`);
      fireEvent.click(link);
      expect(open.mock.calls[0]?.slice(1)).toEqual([
        scope,
        { origin: mode === 'editable' || mode === 'preview' ? 'document' : 'assistant' },
      ]);
      expect(resourceTarget(open.mock.calls[0]![0])).toMatchObject({
        path: '/work/admin.go',
        line: 615,
        lineEnd: 617,
      });
    });

    it('retains inline, reference and standard angle-bracket links', () => {
      const { container, open } = setup(
        [
          '[inline](src/demo.go#L7–L9)',
          '[full][target] [collapsed][] [shortcut]',
          '[`code label`](src/demo.go:L7–L9)',
          '<https://example.com> <demo@example.com> <file:///work/demo.go#L7–L9>',
          '[target]: src/demo.go#L7–L9',
          '[collapsed]: src/demo.go#L7–L9',
          '[shortcut]: src/demo.go#L7–L9',
        ].join('\n\n'),
      );
      expect(container.querySelectorAll('a')).toHaveLength(8);
      expect(container.querySelector('a code')?.textContent).toBe('code label');
      for (const name of ['inline', 'full', 'collapsed', 'shortcut', 'code label']) {
        fireEvent.click(screen.getByRole('link', { name }));
        expect(resourceTarget(open.mock.calls.at(-1)![0])).toMatchObject({
          path: 'src/demo.go',
          line: 7,
          lineEnd: 9,
        });
      }
      expect(screen.getByRole('link', { name: 'demo@example.com' }).getAttribute('href')).toBe(
        'mailto:demo@example.com',
      );
    });

    it('does not turn escaped, malformed or code-example link syntax into hyperlinks', () => {
      const { container } = setup(
        '\\[escaped](/work/demo.go:7–9)\n\n[broken](/work/demo.go:7–9\n\n`[example](/work/demo.go:7–9)`\n\n```md\n[example](/work/demo.go:7–9)\n```',
      );
      expect(container.querySelector('a')).toBeNull();
    });
  });
