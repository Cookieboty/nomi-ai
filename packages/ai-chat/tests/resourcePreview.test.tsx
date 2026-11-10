// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { confirmDialog } from '../src/components/ConfirmDialog';
import { Markdown } from '../src/components/Conversation/Markdown';
import { MarkdownDocument } from '../src/components/ResourcePreview/MarkdownDocument';
import { ResourcePreview } from '../src/components/ResourcePreview/ResourcePreview';
import { ResourceScopeProvider } from '../src/contexts/ResourceContext';
import { useResourcePreview } from '../src/hooks/useResourcePreview';
import { resourcePreviewClient } from '../src/services/resourcePreviewClient';

import { changeSource, sourceEditable, sourceView } from './helpers/codeView';
import { untilIdle } from './helpers/fakeApi';

vi.mock('../src/services/api', async () => (await import('./helpers/fakeApi')).fakeApiModule());
vi.mock('../src/components/ConfirmDialog', () => ({ confirmDialog: vi.fn(async () => true) }));
vi.mock('../src/services/resourcePreviewClient', () => ({
  resourcePreviewClient: {
    open: vi.fn(),
    listDirectory: vi.fn(),
    save: vi.fn(),
    web: vi.fn(),
    close: vi.fn(async () => undefined),
    external: vi.fn(async () => ({ ok: true, kind: 'external' })),
  },
}));
beforeAll(() => {
  (
    window as unknown as { happyDOM: { settings: { disableIframePageLoading: boolean } } }
  ).happyDOM.settings.disableIframePageLoading = true;
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});
const entry = { key: 'a', href: '/w/note.md', scope: { id: 'cli:a', cwd: '/w' } };
const props = () => ({
  entries: [entry],
  activeKey: 'a',
  expanded: true,
  originMismatch: false,
  onActive: vi.fn(),
  onCloseEntry: vi.fn(),
  onCloseEntries: vi.fn(),
  onExpanded: vi.fn(),
  onOpen: vi.fn(),
});

describe('non-modal resource preview', () => {
  it.each(['office', 'pdf', 'video', 'audio'])(
    'hands a resolved %s file to the default app without rendering an embedded viewer',
    async (kind) => {
      vi.mocked(resourcePreviewClient.open).mockResolvedValue({
        ok: true,
        kind,
        path: '/w/resolved.pdf',
        url: '/__nomi/preview/stale',
      });
      const callbacks = props();
      render(<ResourcePreview {...callbacks} />);
      await waitFor(() =>
        expect(resourcePreviewClient.external).toHaveBeenCalledWith('/w', '/w/resolved.pdf'),
      );
      expect(callbacks.onCloseEntry).toHaveBeenCalledWith('a');
      expect(
        document.querySelector('video,audio,object,iframe,[data-testid="preview-office"]'),
      ).toBeNull();
    },
  );

  it('opens an outside-workspace source range from a rendered document, requests consent for the real file and highlights its lines', async () => {
    const path = '/other/backend/middleware/auth.go';
    vi.mocked(resourcePreviewClient.open).mockImplementation(async (_, input, approved) => {
      if (input === '/w/report.md')
        return { ok: true, kind: 'markdown', path: input, content: `[auth](${path}#L697-L719)` };
      if (input !== path) return { ok: false, code: 'missing' };
      return approved
        ? {
            ok: true,
            kind: 'text',
            path,
            content: Array.from({ length: 725 }, (_, i) => `source ${i + 1}`).join('\n'),
          }
        : { ok: false, code: 'authorization', path };
    });
    function Probe() {
      const p = useResourcePreview({ id: 'cli:a', cwd: '/w' });
      return (
        <>
          <button onClick={() => p.value.open('/w/report.md', p.value.scope)}>report</button>
          {p.panel}
        </>
      );
    }
    render(<Probe />);
    fireEvent.click(screen.getByText('report'));
    await screen.findByTestId('preview-markdown');
    fireEvent.click(screen.getByRole('link', { name: 'auth' }));
    const source = await screen.findByTestId('resource-preview-source');
    expect(resourcePreviewClient.open).toHaveBeenCalledWith('/w', path);
    expect(resourcePreviewClient.open).toHaveBeenCalledWith('/w', path, true);
    expect(confirmDialog).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining(path) }),
    );
    await waitFor(() =>
      expect(source.querySelector('#preview-line-697')?.getAttribute('data-active')).toBe('true'),
    );
    expect(source.querySelector('#preview-line-719')?.getAttribute('data-active')).toBe('true');
    expect(source.querySelector('#preview-line-720')?.hasAttribute('data-active')).toBe(false);
    expect(screen.queryByTestId('image-lightbox')).toBeNull();
  });

  it('keeps Go highlighting across outside-file authorization, edit/save, layout and tab changes', async () => {
    const path = '/other/backend/to_oai_chat_resp.go';
    const code = 'package backend\n\nfunc response() string { return "outside" }\n';
    vi.mocked(resourcePreviewClient.open).mockImplementation(async (_, input, approved) => {
      if (input === '/w/local.swift')
        return {
          ok: true,
          kind: 'text',
          path: input,
          content: 'import Foundation\nlet value = "local"',
        };
      return approved
        ? {
            ok: true,
            kind: 'text',
            path,
            content: code,
            editable: true,
            url: '/__nomi/preview/highlight-outside',
            revision: 'a'.repeat(64),
          }
        : { ok: false, code: 'authorization', path };
    });
    vi.mocked(resourcePreviewClient.save).mockResolvedValue({ ok: true, revision: 'b'.repeat(64) });
    const entries = [
      { key: 'outside-highlight', href: path, scope: { id: 'test-highlight', cwd: '/w' } },
      {
        key: 'local-highlight',
        href: '/w/local.swift',
        scope: { id: 'test-highlight', cwd: '/w' },
      },
    ];
    const input = { ...props(), entries, activeKey: 'outside-highlight' };
    const view = render(<ResourcePreview {...input} />);
    const source = await screen.findByTestId('resource-preview-source');
    expect(resourcePreviewClient.open).toHaveBeenCalledWith('/w', path, true);
    expect(source.getAttribute('data-code-language')).toBe('go');
    expect(source.querySelector('.token.keyword')?.textContent).toBe('package');
    expect(source.querySelector('.token.string')?.textContent).toBe('"outside"');
    view.rerender(<ResourcePreview {...input} expanded={false} originMismatch />);
    expect(
      screen.getByTestId('resource-preview-source').querySelector('.token.keyword')?.textContent,
    ).toBe('package');
    fireEvent.click(screen.getByTestId('resource-preview-edit'));
    await waitFor(() =>
      expect(sourceEditable(screen.getByTestId('resource-preview-source'))).toBe(true),
    );
    expect(
      view.container.querySelector('[data-preview-code-scroll] .token.keyword')?.textContent,
    ).toBe('package');
    const changed = code.replace('"outside"', '"saved"');
    changeSource(screen.getByTestId('resource-preview-source'), changed);
    await waitFor(() =>
      expect(resourcePreviewClient.save).toHaveBeenCalledWith(
        '/__nomi/preview/highlight-outside',
        'a'.repeat(64),
        changed,
      ),
    );
    expect(
      view.container.querySelector('[data-preview-code-scroll] .token.string')?.textContent,
    ).toBe('"saved"');
    fireEvent.click(screen.getByTestId('resource-preview-edit'));
    await waitFor(() =>
      expect(sourceEditable(screen.getByTestId('resource-preview-source'))).toBe(false),
    );
    expect(
      screen.getByTestId('resource-preview-source').querySelector('.token.string')?.textContent,
    ).toBe('"saved"');
    view.rerender(<ResourcePreview {...input} activeKey="local-highlight" />);
    await waitFor(() =>
      expect(screen.getByTestId('resource-preview-source').getAttribute('data-code-language')).toBe(
        'swift',
      ),
    );
    expect(
      screen.getByTestId('resource-preview-source').querySelector('.token.keyword')?.textContent,
    ).toBe('import');
    view.rerender(<ResourcePreview {...input} />);
    await waitFor(() =>
      expect(screen.getByTestId('resource-preview-source').getAttribute('data-code-language')).toBe(
        'go',
      ),
    );
    expect(
      screen.getByTestId('resource-preview-source').querySelector('.token.keyword')?.textContent,
    ).toBe('package');
  });

  it('scrolls a source range to its first line without taking keyboard focus from the conversation', async () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      return {
        top: this.id === 'preview-line-7' ? 260 : 20,
        left: 0,
        right: 100,
        bottom: 300,
        width: 100,
        height: 280,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      };
    });
    vi.mocked(resourcePreviewClient.open).mockResolvedValue({
      ok: true,
      kind: 'text',
      content: Array.from({ length: 20 }, (_, i) => `source ${i + 1}`).join('\n'),
    });
    render(
      <ResourcePreview {...props()} entries={[{ ...entry, href: '/other/auth.go#L7-L19' }]} />,
    );
    const source = await screen.findByTestId('resource-preview-source');
    const editor = sourceView(source);
    expect(editor.state.doc.lines).toBe(20);
    expect(editor.state.selection.main.from).toBe(0);
    // Geometry and offscreen line reveal are exercised in real-browser virtualization tests.
    expect(source.querySelector('#preview-line-7')?.getAttribute('data-active')).toBe('true');
    expect(document.activeElement).not.toBe(source);
  });
  it('does not read an outside-workspace range when file consent is declined', async () => {
    vi.mocked(confirmDialog).mockResolvedValueOnce(false);
    vi.mocked(resourcePreviewClient.open).mockResolvedValue({
      ok: false,
      code: 'authorization',
      path: '/other/auth.go',
    });
    render(
      <ResourcePreview {...props()} entries={[{ ...entry, href: '/other/auth.go#L7-L19' }]} />,
    );
    await screen.findByRole('alert');
    expect(resourcePreviewClient.open).toHaveBeenCalledTimes(1);
    expect(resourcePreviewClient.open).toHaveBeenCalledWith('/w', '/other/auth.go');
    expect(screen.queryByTestId('resource-preview-source')).toBeNull();
  });
  it('keeps distinct locations for ranges that start on the same line', async () => {
    vi.mocked(resourcePreviewClient.open).mockResolvedValue({
      ok: true,
      kind: 'text',
      content: 'a\nb\nc\nd',
    });
    function Probe() {
      const p = useResourcePreview({ id: 'a', cwd: '/w' });
      return (
        <>
          <ResourceScopeProvider value={p.value}>
            <Markdown text="[first](/other/a.go#L2-L3) [second](/other/a.go#L2-L4)" settled />
          </ResourceScopeProvider>
          {p.panel}
        </>
      );
    }
    render(<Probe />);
    fireEvent.click(screen.getByRole('link', { name: 'first' }));
    await screen.findByTestId('resource-preview-source');
    fireEvent.click(screen.getByRole('link', { name: 'second' }));
    await waitFor(() =>
      expect(
        screen
          .getByTestId('resource-preview-source')
          .querySelector('#preview-line-4')
          ?.getAttribute('data-active'),
      ).toBe('true'),
    );
  });

  it('shows Markdown by default with semantic heading outline, and switches to raw source', async () => {
    vi.mocked(resourcePreviewClient.open).mockResolvedValue({
      ok: true,
      kind: 'markdown',
      path: '/w/note.md',
      content: '# Title\n\n## Section\n\ntext',
      url: '/__nomi/preview/abc',
    });
    render(<ResourcePreview {...props()} />);
    await untilIdle();
    screen.getByTestId('preview-markdown');
    expect(screen.getByTestId('preview-outline').textContent).toContain('Section');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Title');
    fireEvent.click(screen.getByTestId('resource-preview-mode'));
    expect(screen.getByTestId('resource-preview-source').textContent).toContain('# Title');
    fireEvent.click(screen.getByTestId('resource-preview-mode'));
    expect(screen.queryByTestId('preview-markdown')).not.toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
  it('directly edits rendered cells and also autosaves optional source edits through the capability API', async () => {
    vi.mocked(resourcePreviewClient.open).mockResolvedValue({
      ok: true,
      kind: 'markdown',
      path: '/w/edit.md',
      editable: true,
      revision: 'a'.repeat(64),
      url: '/__nomi/preview/edit',
      content: '# Title\n\n| A | B |\n| --- | --- |\n| old | keep |\n',
    });
    vi.mocked(resourcePreviewClient.save).mockResolvedValue({ ok: true, revision: 'b'.repeat(64) });
    render(
      <ResourcePreview
        {...props()}
        entries={[{ ...entry, key: 'edit', href: '/w/edit.md' }]}
        activeKey="edit"
      />,
    );
    const body = await screen.findByTestId('preview-markdown');
    const cell = body.querySelector('td')!;
    cell.textContent = 'new';
    fireEvent.input(cell);
    await new Promise((r) => setTimeout(r, 500));
    await untilIdle();
    expect(resourcePreviewClient.save).toHaveBeenCalledWith(
      '/__nomi/preview/edit',
      'a'.repeat(64),
      '# Title\n\n| A | B |\n| --- | --- |\n| new | keep |\n',
    );
    expect(screen.getByTestId('preview-save-status').textContent).toMatch(/已保存|Saved/);
    fireEvent.click(screen.getByTestId('resource-preview-mode'));
    const source = screen.getByTestId('resource-preview-source');
    expect(sourceEditable(source)).toBe(true);
    changeSource(source, '# Source edit');
    await new Promise((r) => setTimeout(r, 500));
    await untilIdle();
    expect(resourcePreviewClient.save).toHaveBeenLastCalledWith(
      '/__nomi/preview/edit',
      'b'.repeat(64),
      '# Source edit',
    );
    fireEvent.click(screen.getByTestId('resource-preview-mode'));
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Source edit');
  });
  it('keeps the header outside document/source scrolling and the single-file tab available for context actions', async () => {
    vi.mocked(resourcePreviewClient.open).mockResolvedValue({
      ok: true,
      kind: 'markdown',
      path: '/w/note.md',
      content: '# Title\n\nbody',
    });
    render(<ResourcePreview {...props()} />);
    const document = await screen.findByTestId('preview-markdown');
    const header = screen.getByTestId('resource-preview-header');
    expect(header.parentElement).toBe(screen.getByTestId('resource-preview'));
    expect(document.contains(header)).toBe(false);
    expect(screen.getAllByRole('tab')).toHaveLength(1);
    fireEvent.scroll(document, { target: { scrollTop: 800 } });
    expect(screen.getByTestId('resource-preview-header')).toBe(header);
    fireEvent.click(screen.getByTestId('resource-preview-mode'));
    expect(screen.getByTestId('resource-preview-source').contains(header)).toBe(false);
    expect(screen.getByTestId('resource-preview-header')).toBe(header);
  });
  it('reads a removed delegated worktree result from its known parent and uses that root for links and the picker', async () => {
    vi.mocked(resourcePreviewClient.open)
      .mockResolvedValueOnce({ ok: false, code: 'missing' })
      .mockResolvedValueOnce({
        ok: true,
        kind: 'markdown',
        path: '/w/docs/report.md',
        content: '# Report\n\n[related](next.md)',
      });
    const p = props();
    render(
      <ResourcePreview
        {...p}
        entries={[
          {
            key: 'a',
            href: '/w/.delegate/x/docs/report.md',
            scope: { id: 'cli:a', cwd: '/w/.delegate/x', fallbackCwds: ['/w'] },
          },
        ]}
      />,
    );
    await screen.findByTestId('preview-markdown');
    expect(resourcePreviewClient.open).toHaveBeenNthCalledWith(
      1,
      '/w/.delegate/x',
      '/w/.delegate/x/docs/report.md',
    );
    expect(resourcePreviewClient.open).toHaveBeenNthCalledWith(2, '/w', '/w/docs/report.md');
    fireEvent.click(screen.getByText('related'));
    expect(p.onOpen).toHaveBeenCalledWith(
      '/w/docs/next.md',
      expect.objectContaining({ cwd: '/w' }),
      expect.anything(),
    );
  });
  it('does not relocate denied or outside paths, even when delegation fallback roots are present', async () => {
    for (const [path, code] of [
      ['/w/.delegate/x/report.md', 'denied'],
      ['/other/report.md', 'missing'],
    ] as const) {
      vi.mocked(resourcePreviewClient.open).mockClear().mockResolvedValue({ ok: false, code });
      render(
        <ResourcePreview
          {...props()}
          entries={[
            {
              key: 'a',
              href: path,
              scope: { id: 'cli:a', cwd: '/w/.delegate/x', fallbackCwds: ['/w'] },
            },
          ]}
        />,
      );
      await screen.findByRole('alert');
      expect(resourcePreviewClient.open).toHaveBeenCalledTimes(1);
      cleanup();
    }
  });
  it.each(['markdown', 'text'])(
    'provides the shared breadcrumb picker for %s rendering',
    async (kind) => {
      vi.mocked(resourcePreviewClient.open).mockResolvedValue({
        ok: true,
        kind,
        path: '/w/note.md',
        content: 'hello',
        url: '/__nomi/preview/abc',
      });
      const list = vi.spyOn(resourcePreviewClient, 'listDirectory').mockResolvedValue({
        ok: true,
        entries: [{ kind: 'file', name: 'b.txt', path: '/w/b.txt' }],
      });
      const p = props();
      render(<ResourcePreview {...p} />);
      await screen.findByTestId(
        kind === 'markdown' ? 'preview-markdown' : 'resource-preview-source',
      );
      expect(screen.getByRole('navigation', { name: /文件路径|File path/ })).toBeTruthy();
      expect(screen.queryByRole('button', { name: /标题目录|Document outline/ })).toBeNull();
      expect(screen.queryByRole('button', { name: /重新加载|Reload/ })).toBeNull();
      expect(screen.queryByRole('link', { name: /下载|Download/ })).toBeNull();
      fireEvent.click(screen.getByTestId('preview-file-picker'));
      fireEvent.click(await screen.findByRole('treeitem', { name: 'b.txt' }));
      expect(p.onOpen).toHaveBeenCalledWith('/w/b.txt', entry.scope);
      expect(p.onCloseEntry).not.toHaveBeenCalled();
      list.mockRestore();
    },
  );
  it('keeps the current tab when the picker opens a different file, and keeps it unchanged on reselect', async () => {
    vi.mocked(resourcePreviewClient.open).mockImplementation(async (_, path) => ({
      ok: true,
      kind: path.endsWith('.md') ? 'markdown' : 'text',
      path,
      content: `content ${path}`,
      url: `/__nomi/preview/${path.endsWith('.md') ? 'note' : 'other'}`,
    }));
    const list = vi.spyOn(resourcePreviewClient, 'listDirectory').mockResolvedValue({
      ok: true,
      entries: [
        { kind: 'file', name: 'note.md', path: '/w/note.md' },
        { kind: 'file', name: 'other.go', path: '/w/other.go' },
      ],
    });
    function Probe() {
      const p = useResourcePreview({ id: 'cli:a', cwd: '/w' });
      return (
        <>
          <button onClick={() => p.value.open('/w/note.md', p.value.scope)}>start</button>
          {p.panel}
        </>
      );
    }
    render(<Probe />);
    fireEvent.click(screen.getByText('start'));
    await screen.findByTestId('preview-markdown');
    fireEvent.click(screen.getByTestId('preview-file-picker'));
    fireEvent.click(await screen.findByRole('treeitem', { name: 'note.md' }));
    expect(screen.getAllByRole('tab')).toHaveLength(1);
    expect(screen.getByTestId('preview-markdown').textContent).toContain('content /w/note.md');
    fireEvent.click(screen.getByTestId('preview-file-picker'));
    fireEvent.click(await screen.findByRole('treeitem', { name: 'other.go' }));
    await screen.findByTestId('resource-preview-source');
    expect(screen.getAllByRole('tab')).toHaveLength(2);
    fireEvent.click(screen.getByRole('tab', { name: 'note.md' }));
    await screen.findByTestId('preview-markdown');
    expect(screen.getAllByRole('tab')).toHaveLength(2);
    list.mockRestore();
  });
  it('selecting an HTML file opens externally without closing the current document tab', async () => {
    vi.mocked(resourcePreviewClient.open).mockResolvedValue({
      ok: true,
      kind: 'text',
      path: '/w/note.md',
      content: 'hello',
      url: '/__nomi/preview/abc',
    });
    const list = vi.spyOn(resourcePreviewClient, 'listDirectory').mockResolvedValue({
      ok: true,
      entries: [{ kind: 'file', name: 'page.html', path: '/w/page.html' }],
    });
    const p = props();
    render(<ResourcePreview {...p} />);
    await screen.findByTestId('resource-preview-source');
    fireEvent.click(screen.getByTestId('preview-file-picker'));
    fireEvent.click(await screen.findByRole('treeitem', { name: 'page.html' }));
    expect(p.onOpen).toHaveBeenCalledWith('/w/page.html', entry.scope);
    expect(p.onCloseEntry).not.toHaveBeenCalled();
    list.mockRestore();
  });
  it('hands website links to the default browser and never mounts an iframe', async () => {
    const p = props();
    render(<ResourcePreview {...p} entries={[{ ...entry, href: 'https://example.com/' }]} />);
    await untilIdle();
    expect(resourcePreviewClient.external).toHaveBeenCalledWith('/w', 'https://example.com/');
    expect(resourcePreviewClient.web).not.toHaveBeenCalled();
    expect(screen.queryByTestId('resource-browser')).toBeNull();
    expect(document.querySelector('iframe')).toBeNull();
    expect(p.onCloseEntry).toHaveBeenCalledWith(entry.key);
  });
  it('opens local HTML externally instead of rendering HTML/source in the sidebar', async () => {
    const p = props();
    render(<ResourcePreview {...p} entries={[{ ...entry, href: '/w/page.html' }]} />);
    await untilIdle();
    expect(resourcePreviewClient.external).toHaveBeenCalledWith('/w', '/w/page.html');
    expect(resourcePreviewClient.open).not.toHaveBeenCalled();
    expect(screen.queryByTestId('resource-preview-mode')).toBeNull();
    expect(document.querySelector('iframe')).toBeNull();
    expect(p.onCloseEntry).toHaveBeenCalledWith(entry.key);
  });
  it('preserves render scroll when changing source mode', async () => {
    vi.mocked(resourcePreviewClient.open).mockResolvedValue({
      ok: true,
      kind: 'markdown',
      path: '/w/note.md',
      content: '# Title\n\nbody',
    });
    render(<ResourcePreview {...props()} />);
    await untilIdle();
    const body = screen.getByTestId('preview-markdown');
    body.scrollTop = 123;
    fireEvent.scroll(body);
    fireEvent.click(screen.getByTestId('resource-preview-mode'));
    fireEvent.click(screen.getByTestId('resource-preview-mode'));
    expect(screen.getByTestId('preview-markdown').scrollTop).toBe(123);
  });
  it('handles Escape in its own source editor while leaving unrelated inputs alone', async () => {
    vi.mocked(resourcePreviewClient.open).mockResolvedValue({
      ok: true,
      kind: 'markdown',
      content: 'hello',
      path: '/w/note.md',
      editable: true,
      url: '/__nomi/preview/editor-escape',
      revision: 'a'.repeat(64),
    });
    const p = props();
    const r = render(
      <>
        <textarea aria-label="unrelated input" />
        <ResourcePreview {...p} />
      </>,
    );
    await untilIdle();
    fireEvent.click(screen.getByTestId('resource-preview-mode'));
    const source = screen.getByTestId('resource-preview-source');
    expect(sourceEditable(source)).toBe(true);
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'unrelated input' }), { key: 'Escape' });
    expect(p.onExpanded).not.toHaveBeenCalled();
    fireEvent.keyDown(source, { key: 'Escape' });
    expect(p.onExpanded).toHaveBeenCalledWith(false);
    expect(p.onCloseEntries).not.toHaveBeenCalled();
    r.rerender(
      <>
        <textarea aria-label="unrelated input" />
        <ResourcePreview {...p} expanded={false} />
      </>,
    );
    fireEvent.keyDown(screen.getByTestId('resource-preview-source'), { key: 'Escape' });
    await waitFor(() => expect(p.onCloseEntries).toHaveBeenCalledWith(['a']));
  });
  it('leaves focus mode before closing on Escape and revoking local file capability', async () => {
    vi.mocked(resourcePreviewClient.open).mockResolvedValue({
      ok: true,
      kind: 'text',
      content: 'hello',
      url: '/__nomi/preview/abc',
    });
    const p = props();
    const r = render(<ResourcePreview {...p} />);
    await untilIdle();
    screen.getByTestId('resource-preview-source');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(p.onExpanded).toHaveBeenCalledWith(false);
    expect(p.onCloseEntries).not.toHaveBeenCalled();
    r.rerender(<ResourcePreview {...p} expanded={false} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(p.onCloseEntries).toHaveBeenCalledWith(['a']);
    r.unmount();
    expect(resourcePreviewClient.close).toHaveBeenCalledWith('/__nomi/preview/abc');
  });
  it('a late file response cannot replace the newly selected file', async () => {
    let resolve!: (v: { ok: boolean; kind: string; content: string }) => void;
    vi.mocked(resourcePreviewClient.open)
      .mockImplementationOnce(
        () =>
          new Promise((r) => {
            resolve = r;
          }),
      )
      .mockResolvedValue({ ok: true, kind: 'text', content: 'second' });
    const p = props();
    const r = render(<ResourcePreview {...p} />);
    await untilIdle();
    expect(resourcePreviewClient.open).toHaveBeenCalled();
    r.rerender(
      <ResourcePreview
        {...p}
        entries={[entry, { ...entry, key: 'b', href: '/w/b.txt' }]}
        activeKey="b"
      />,
    );
    await untilIdle();
    expect(screen.getByTestId('resource-preview-source').textContent).toContain('second');
    resolve({ ok: true, kind: 'text', content: 'stale first' });
    await untilIdle();
    expect(screen.getByTestId('resource-preview-source').textContent).not.toContain('stale');
  });
  it('opening/closing a preview keeps the conversation mounted and detects changed sending identity', async () => {
    vi.mocked(resourcePreviewClient.open).mockResolvedValue({
      ok: true,
      kind: 'text',
      content: 'hello',
    });
    const mounted = vi.fn();
    const unmounted = vi.fn();
    const Conversation = () => {
      React.useEffect(() => {
        mounted();
        return unmounted;
      }, []);
      return <textarea data-testid="preserved-input" defaultValue="draft" />;
    };
    const Probe: React.FC<{ id: string }> = ({ id }) => {
      const p = useResourcePreview({ id, cwd: '/w' });
      return (
        <>
          <Conversation />
          <button onClick={() => p.value.open('/w/note.txt', p.value.scope)}>open</button>
          <output data-testid="mismatch">{String(p.mismatch)}</output>
          {p.panel}
        </>
      );
    };
    const r = render(<Probe id="a" />);
    fireEvent.click(screen.getByText('open'));
    await untilIdle();
    screen.getByTestId('resource-preview');
    expect(mounted).toHaveBeenCalledTimes(1);
    expect(unmounted).not.toHaveBeenCalled();
    expect((screen.getByTestId('preserved-input') as HTMLTextAreaElement).value).toBe('draft');
    r.rerender(<Probe id="b" />);
    expect(screen.getByTestId('mismatch').textContent).toBe('true');
  });
});

describe('Markdown document outline', () => {
  it('uses distinct anchors for repeated titles, and never interprets fenced heading text as a title', () => {
    render(
      <MarkdownDocument
        text={'# Same\n\n## Same\n\n```md\n# not a heading\n```'}
        context={{ scope: entry.scope, open: vi.fn() }}
        documentDir="/w"
        outline
        onOutlineChange={vi.fn()}
        scrollTop={0}
        onScroll={vi.fn()}
      />,
    );
    const titles = screen.getAllByRole('heading');
    expect(titles.map((h) => h.id)).toEqual(['same', 'same-1']);
    expect(screen.getByTestId('preview-outline').querySelectorAll('button')).toHaveLength(2);
  });
});
