// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ResourceLink } from '../src/components/ResourcePreview/ResourceLink';
import { ResourceScopeProvider } from '../src/contexts/ResourceContext';
import { useResourcePreview } from '../src/hooks/useResourcePreview';
import { resourcePreviewClient } from '../src/services/resourcePreviewClient';

vi.mock('../src/services/api', async () => (await import('./helpers/fakeApi')).fakeApiModule());
vi.mock('../src/services/resourcePreviewClient', () => ({
  resourcePreviewClient: {
    open: vi.fn(),
    save: vi.fn(async () => ({ ok: true, revision: 'saved' })),
    close: vi.fn(async () => undefined),
  },
}));
const document =
  '# Guide\n\n[first](#first) [named](guide.md#first) [cross](other.md#%E7%A4%BA%E4%BE%8B)\n\n## First\n\nEditable paragraph\n\n## Second\n';
function Shell() {
  const preview = useResourcePreview({ id: 'navigation-test', cwd: '/work' });
  return (
    <ResourceScopeProvider value={preview.value}>
      <textarea aria-label="composer" defaultValue="keep draft" />
      <ResourceLink href="/work/guide.md#second">guide</ResourceLink>
      <ResourceLink href="/work/guide.md#first">first chapter</ResourceLink>
      {preview.panel}
    </ResourceScopeProvider>
  );
}
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    const offset = this.tagName === 'H2' ? (this.textContent === 'First' ? 300 : 600) : 0;
    const scroll =
      this.tagName === 'H2' ? (this.closest('[data-resource-document]')?.scrollTop ?? 0) : 0;
    return {
      top: offset - scroll,
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
  vi.mocked(resourcePreviewClient.open).mockImplementation(async (_cwd, path) => ({
    ok: true,
    kind: 'markdown',
    path,
    content: path === '/work/guide.md' ? document : '# Other\n\n## 示例\n\n[back](guide.md#first)',
    editable: true,
    revision: 'initial',
    url: `/__nomi/preview/${path.includes('guide') ? 'guide' : 'other'}`,
  }));
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe('Preview file and heading navigation', () => {
  it('loads only the real file, then scrolls to a heading; new chapter requests do not reload or reset edited DOM', async () => {
    render(<Shell />);
    fireEvent.click(screen.getByRole('link', { name: 'guide' }));
    const preview = await screen.findByTestId('preview-markdown');
    expect(resourcePreviewClient.open).toHaveBeenCalledWith('/work', '/work/guide.md');
    expect(preview.scrollTop).toBe(600);
    const paragraph = screen.getByText('Editable paragraph');
    paragraph.textContent = 'My unsaved edit';
    fireEvent.input(paragraph);
    const composer = screen.getByRole('textbox', { name: 'composer' }) as HTMLTextAreaElement;
    composer.focus();
    fireEvent.click(screen.getByRole('link', { name: 'first chapter' }));
    expect(preview.scrollTop).toBe(300);
    expect(screen.getByTestId('preview-markdown')).toBe(preview);
    expect(screen.getByText('My unsaved edit')).toBe(paragraph);
    expect(resourcePreviewClient.open).toHaveBeenCalledTimes(1);
    expect(resourcePreviewClient.close).not.toHaveBeenCalled();
    expect(screen.getAllByRole('tab')).toHaveLength(1);
    expect(composer.value).toBe('keep draft');
    expect(window.document.activeElement).toBe(composer);
    preview.scrollTop = 10;
    fireEvent.click(screen.getByRole('link', { name: 'first chapter' }));
    expect(preview.scrollTop).toBe(300);
    // Explicit chapter requests also leave source mode and return to the rendered document.
    fireEvent.click(screen.getByTestId('resource-preview-mode'));
    await screen.findByTestId('resource-preview-source');
    fireEvent.click(screen.getByRole('link', { name: 'first chapter' }));
    expect((await screen.findByTestId('preview-markdown')).scrollTop).toBe(300);
    expect(screen.getByText('My unsaved edit')).toBeTruthy();
    expect(resourcePreviewClient.open).toHaveBeenCalledTimes(1);
  });
  it('follows cross-file headings, reuses the existing tab on return and handles named same-file links locally', async () => {
    render(<Shell />);
    fireEvent.click(screen.getByRole('link', { name: 'guide' }));
    await screen.findByTestId('preview-markdown');
    fireEvent.click(screen.getByRole('link', { name: 'cross' }));
    await screen.findByRole('heading', { name: '示例' });
    let preview = screen.getByTestId('preview-markdown');
    expect(preview.scrollTop).toBe(600);
    expect(resourcePreviewClient.open).toHaveBeenLastCalledWith('/work', '/work/other.md');
    expect(screen.getAllByRole('tab')).toHaveLength(2);
    fireEvent.click(screen.getByRole('link', { name: 'back' }));
    await screen.findByRole('heading', { name: 'First' });
    preview = screen.getByTestId('preview-markdown');
    expect(preview.scrollTop).toBe(300);
    expect(screen.getAllByRole('tab')).toHaveLength(2);
    const reads = vi.mocked(resourcePreviewClient.open).mock.calls.length;
    preview.scrollTop = 0;
    fireEvent.click(screen.getByRole('link', { name: 'named' }));
    expect(preview.scrollTop).toBe(300);
    expect(resourcePreviewClient.open).toHaveBeenCalledTimes(reads);
    // Tab selection restores the reader's last position instead of replaying its old fragment.
    preview.scrollTop = 120;
    fireEvent.scroll(preview);
    fireEvent.click(screen.getByRole('tab', { name: 'other.md' }));
    await screen.findByRole('heading', { name: '示例' });
    fireEvent.click(screen.getByRole('tab', { name: 'guide.md' }));
    await waitFor(() => expect(screen.getByTestId('preview-markdown').scrollTop).toBe(120));
  });
});
