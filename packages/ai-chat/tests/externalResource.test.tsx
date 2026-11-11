// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { confirmDialog } from '../src/components/ConfirmDialog';
import { useResourcePreview } from '../src/hooks/useResourcePreview';
import { APP_CSP } from '../src/security/csp';
import { isExternalResource, openExternalResource } from '../src/services/externalResource';
import { resourcePreviewClient } from '../src/services/resourcePreviewClient';

vi.mock('../src/services/api', async () => (await import('./helpers/fakeApi')).fakeApiModule());
vi.mock('../src/services/resourcePreviewClient', () => ({
  resourcePreviewClient: {
    open: vi.fn(),
    web: vi.fn(),
    close: vi.fn(async () => undefined),
    external: vi.fn(async () => ({ ok: true, kind: 'external' })),
  },
}));
vi.mock('../src/components/ConfirmDialog', () => ({ confirmDialog: vi.fn(async () => true) }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
const nativeExtensions = [
  'docx',
  'xlsx',
  'csv',
  'pptx',
  'pdf',
  'mp4',
  'webm',
  'mov',
  'm4v',
  'ogv',
  'mp3',
  'wav',
  'm4a',
  'ogg',
  'flac',
  'aac',
];
const origin = { id: 'cli:a', cwd: '/work' };
function Probe() {
  const p = useResourcePreview(origin);
  return (
    <>
      <textarea defaultValue="draft" data-testid="draft" />
      <button onClick={() => p.value.open('https://www.baidu.com/', p.value.scope)}>web</button>
      <button onClick={() => p.value.open('/work/page.HTML#L1', p.value.scope)}>html</button>
      <button
        onClick={() =>
          p.value.open('https://example.com/image.png', p.value.scope, { origin: 'assistant' })
        }
      >
        image link
      </button>
      {nativeExtensions.map((extension) => (
        <button
          key={extension}
          onClick={() => p.value.open(`/work/file.${extension}`, p.value.scope)}
        >
          {extension}
        </button>
      ))}
      <button onClick={() => p.value.open('/work/note.md', p.value.scope)}>markdown</button>
      <output data-testid="is-open">{String(p.isOpen)}</output>
      {p.panel}
    </>
  );
}
describe('external browser instead of embedded websites', () => {
  it('routes every ordinary http/https link and HTML file externally while explicit images remain previews', () => {
    expect(isExternalResource('https://www.baidu.com')).toBe(true);
    expect(isExternalResource('https://example.com/image.png', { origin: 'assistant' })).toBe(true);
    expect(
      isExternalResource('https://example.com/image.png', { origin: 'assistant', kind: 'image' }),
    ).toBe(false);
    for (const path of ['/work/index.html', './page.htm', 'file:///work/page.HTML#L12'])
      expect(isExternalResource(path)).toBe(true);
    expect(isExternalResource('/work/doc.md')).toBe(false);
    expect(APP_CSP['frame-src']).toEqual(["'none'"]);
  });
  it('does not open or resize the side preview when website/HTML is clicked, and preserves the draft', async () => {
    render(<Probe />);
    fireEvent.click(screen.getByText('web'));
    await waitFor(() =>
      expect(resourcePreviewClient.external).toHaveBeenCalledWith(
        '/work',
        'https://www.baidu.com/',
      ),
    );
    fireEvent.click(screen.getByText('html'));
    await waitFor(() =>
      expect(resourcePreviewClient.external).toHaveBeenCalledWith('/work', '/work/page.HTML'),
    );
    expect(screen.getByTestId('is-open').textContent).toBe('false');
    expect(screen.queryByTestId('resource-preview')).toBeNull();
    expect((screen.getByTestId('draft') as HTMLTextAreaElement).value).toBe('draft');
    expect(resourcePreviewClient.web).not.toHaveBeenCalled();
  });

  it.each(nativeExtensions)(
    'opens %s in the default app without mounting or resizing the side preview',
    async (extension) => {
      render(<Probe />);
      expect(isExternalResource(`./file.${extension.toUpperCase()}`)).toBe(true);
      fireEvent.click(screen.getByRole('button', { name: extension, exact: true }));
      await waitFor(() =>
        expect(resourcePreviewClient.external).toHaveBeenCalledWith(
          '/work',
          `/work/file.${extension}`,
        ),
      );
      expect(screen.getByTestId('is-open').textContent).toBe('false');
      expect(
        document.querySelector('video,audio,object,iframe,[data-testid="preview-office"]'),
      ).toBeNull();
      expect((screen.getByTestId('draft') as HTMLTextAreaElement).value).toBe('draft');
      expect(resourcePreviewClient.open).not.toHaveBeenCalled();
    },
  );
  it.each([
    ['./data.csv', './data.csv'],
    ['file:///work/annual%20report.CSV#L2', '/work/annual report.CSV'],
    ['/work/literal%2520.csv', '/work/literal%20.csv'],
  ])('opens CSV destination %s externally with its decoded file path', async (href, path) => {
    expect(isExternalResource(href)).toBe(true);
    expect(await openExternalResource('/work', href)).toMatchObject({ ok: true, kind: 'external' });
    expect(resourcePreviewClient.external).toHaveBeenCalledWith('/work', path);
    expect(resourcePreviewClient.open).not.toHaveBeenCalled();
  });
  it('keeps an existing Markdown preview and draft when CSV is opened externally', async () => {
    vi.mocked(resourcePreviewClient.open).mockResolvedValueOnce({
      ok: true,
      kind: 'markdown',
      path: '/work/note.md',
      content: '# Keep reading',
      url: '/__nomi/preview/note',
    });
    render(<Probe />);
    fireEvent.click(screen.getByRole('button', { name: 'markdown', exact: true }));
    // 预览组件是懒加载的：本文件第一次打开预览要等它加载，慢的 CI 机器上会超过默认的 1 秒
    const document = await screen.findByTestId('preview-markdown', {}, { timeout: 5000 });
    const draft = screen.getByTestId('draft') as HTMLTextAreaElement;
    fireEvent.change(draft, { target: { value: 'unsent draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'csv', exact: true }));
    await waitFor(() =>
      expect(resourcePreviewClient.external).toHaveBeenCalledWith('/work', '/work/file.csv'),
    );
    expect(screen.getByTestId('preview-markdown')).toBe(document);
    expect(screen.getByTestId('is-open').textContent).toBe('true');
    expect(draft.value).toBe('unsent draft');
    expect(resourcePreviewClient.open).toHaveBeenCalledTimes(1);
    expect(resourcePreviewClient.close).not.toHaveBeenCalled();
  });
  it('requests file consent for an outside-workspace document and respects cancellation', async () => {
    vi.mocked(resourcePreviewClient.external).mockResolvedValueOnce({
      ok: false,
      code: 'authorization',
      path: '/outside/book.xlsx',
    });
    vi.mocked(confirmDialog).mockResolvedValueOnce(false);
    expect(await openExternalResource('/work', '/outside/book.xlsx')).toEqual({
      ok: false,
      code: 'cancelled',
    });
    expect(resourcePreviewClient.external).toHaveBeenCalledTimes(1);
  });
  it('opens an ordinary assistant image URL externally unless explicitly clicked as an image', async () => {
    render(<Probe />);
    fireEvent.click(screen.getByText('image link'));
    await waitFor(() =>
      expect(resourcePreviewClient.external).toHaveBeenCalledWith(
        '/work',
        'https://example.com/image.png',
      ),
    );
    expect(screen.queryByTestId('image-lightbox')).toBeNull();
    expect(screen.getByTestId('is-open').textContent).toBe('false');
    expect(resourcePreviewClient.web).not.toHaveBeenCalled();
  });
  it('requests file consent before opening an outside-workspace HTML file and respects cancellation', async () => {
    vi.mocked(resourcePreviewClient.external).mockResolvedValueOnce({
      ok: false,
      code: 'authorization',
      path: '/outside/file.html',
    });
    await openExternalResource('/work', '/outside/file.html');
    expect(confirmDialog).toHaveBeenCalled();
    expect(resourcePreviewClient.external).toHaveBeenLastCalledWith(
      '/work',
      '/outside/file.html',
      true,
    );
    vi.mocked(confirmDialog).mockResolvedValueOnce(false);
    vi.mocked(resourcePreviewClient.external).mockResolvedValueOnce({
      ok: false,
      code: 'authorization',
    });
    expect(await openExternalResource('/work', '/outside/file.html')).toEqual({
      ok: false,
      code: 'cancelled',
    });
  });
  it('shows a real opening error instead of a blank iframe', async () => {
    vi.mocked(resourcePreviewClient.external).mockResolvedValueOnce({ ok: false, code: 'browser' });
    render(<Probe />);
    fireEvent.click(screen.getByText('web'));
    await screen.findByRole('alert');
    expect(document.querySelector('iframe')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /关闭|Close/ }));
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
