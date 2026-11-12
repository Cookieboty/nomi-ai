// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PreviewFilePicker } from '../src/components/ResourcePreview/PreviewFilePicker';
import { previewPathCrumbs } from '../src/components/ResourcePreview/previewPath';
import { resourcePreviewClient } from '../src/services/resourcePreviewClient';

vi.mock('../src/services/resourcePreviewClient', () => ({
  resourcePreviewClient: { listDirectory: vi.fn() },
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
const scope = { id: 'cli:a', cwd: '/work' };
const url = '/__nomi/preview/test';
const directories = {
  '/': [{ kind: 'dir', name: 'work', path: '/work' }],
  '/work': [
    { kind: 'dir', name: 'docs', path: '/work/docs' },
    { kind: 'file', name: 'LICENSE', path: '/work/LICENSE' },
  ],
  '/work/docs': [
    { kind: 'file', name: 'note.md', path: '/work/docs/note.md' },
    { kind: 'file', name: 'other.md', path: '/work/docs/other.md' },
  ],
};
function setup() {
  vi.mocked(resourcePreviewClient.listDirectory).mockImplementation(async (_, directory) => ({
    ok: true,
    entries: (directories[directory as keyof typeof directories] as never) ?? [],
  }));
  const onOpen = vi.fn();
  const r = render(
    <PreviewFilePicker path="/work/docs/note.md" url={url} scope={scope} onOpen={onOpen} />,
  );
  return { r, onOpen };
}
describe('shared absolute-path picker', () => {
  it('displays the complete path above the workspace and lists only after a click', async () => {
    vi.mocked(resourcePreviewClient.listDirectory).mockResolvedValue({ ok: true, entries: [] });
    render(
      <PreviewFilePicker
        path="/Users/tanx/Desktop/project/docs/file.md"
        url={url}
        scope={{ ...scope, cwd: '/Users/tanx/Desktop/project' }}
        onOpen={vi.fn()}
      />,
    );
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual([
      'Users',
      'tanx',
      'Desktop',
      'project',
      'docs',
      'file.md',
    ]);
    expect(resourcePreviewClient.listDirectory).not.toHaveBeenCalled();
    const users = screen.getByRole('button', { name: 'Users', exact: true });
    expect(users.textContent).toBe('Users');
    expect(users.getAttribute('title')).toBeNull();
    fireEvent.click(users);
    await waitFor(() =>
      expect(resourcePreviewClient.listDirectory).toHaveBeenCalledWith(url, '/Users'),
    );
  });
  it('marks the current file and selecting it changes neither the file nor the tab', async () => {
    const { onOpen } = setup();
    fireEvent.click(screen.getByTestId('preview-file-picker'));
    const current = await screen.findByRole('treeitem', { name: 'note.md' });
    expect(current.getAttribute('aria-selected')).toBe('true');
    fireEvent.click(current);
    expect(onOpen).not.toHaveBeenCalled();
    expect(screen.queryByTestId('preview-file-menu')).toBeNull();
  });
  it('selects another file with its absolute encoded href and original origin', async () => {
    const { onOpen } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'work', exact: true }));
    await screen.findByRole('treeitem', { name: 'LICENSE' });
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'LICENSE' } });
    fireEvent.click(screen.getByRole('treeitem', { name: 'LICENSE' }));
    expect(onOpen).toHaveBeenCalledWith('/work/LICENSE', scope);
  });
  it('switches directory menus and opens nested directories only on demand', async () => {
    setup();
    const docs = screen.getByRole('button', { name: 'docs', exact: true });
    const work = screen.getByRole('button', { name: 'work', exact: true });
    fireEvent.click(docs);
    await screen.findByRole('treeitem', { name: 'other.md' });
    expect(screen.queryByRole('treeitem', { name: 'LICENSE' })).toBeNull();
    fireEvent.click(work);
    const folder = await screen.findByRole('treeitem', { name: 'docs' });
    expect(work.getAttribute('aria-expanded')).toBe('true');
    expect(docs.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(folder);
    await screen.findByRole('treeitem', { name: 'note.md' });
    expect(resourcePreviewClient.listDirectory).toHaveBeenCalledWith(url, '/work/docs');
  });
  it('Escape closes only the menu and restores its actual trigger; outside clicks preserve focus', async () => {
    setup();
    const docs = screen.getByRole('button', { name: 'docs', exact: true });
    fireEvent.click(docs);
    await screen.findByRole('treeitem', { name: 'note.md' });
    const closePreview = vi.fn();
    window.addEventListener('keydown', closePreview);
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' });
    expect(document.activeElement).toBe(docs);
    expect(closePreview).not.toHaveBeenCalled();
    window.removeEventListener('keydown', closePreview);
    fireEvent.click(docs);
    fireEvent.pointerDown(document.body);
    expect(screen.queryByTestId('preview-file-menu')).toBeNull();
  });
  it('supports keyboard traversal, failed requests and empty results', async () => {
    setup();
    vi.mocked(resourcePreviewClient.listDirectory).mockResolvedValueOnce({ ok: false });
    fireEvent.click(screen.getByTestId('preview-file-picker'));
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toMatch(/无法读取|Could not read/),
    );
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: 'work', exact: true }));
    const docs = await screen.findByRole('treeitem', { name: 'docs' });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'ArrowDown' });
    expect(document.activeElement).toBe(docs);
    fireEvent.keyDown(docs, { key: 'ArrowRight' });
    await screen.findByRole('treeitem', { name: 'note.md' });
    fireEvent.keyDown(docs, { key: 'ArrowLeft' });
    expect(screen.queryByRole('treeitem', { name: 'note.md' })).toBeNull();
    fireEvent.click(screen.getByTestId('preview-file-picker'));
    await screen.findByRole('treeitem', { name: 'other.md' });
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'missing' } });
    expect(screen.getByRole('status').textContent).toMatch(/没有匹配|No matching/);
  });
  it('shows an outside-workspace absolute path and browses through its existing file capability', async () => {
    vi.mocked(resourcePreviewClient.listDirectory).mockResolvedValue({ ok: true, entries: [] });
    render(
      <PreviewFilePicker path="/other/docs/note.md" url={url} scope={scope} onOpen={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'other', exact: true }));
    await waitFor(() =>
      expect(resourcePreviewClient.listDirectory).toHaveBeenCalledWith(url, '/other'),
    );
  });
  it('does not recursively expand a directory symlink back to an ancestor', async () => {
    vi.mocked(resourcePreviewClient.listDirectory).mockResolvedValue({
      ok: true,
      entries: [
        { kind: 'dir', name: 'self-link', path: '/work/docs' },
        { kind: 'file', name: 'note.md', path: '/work/docs/note.md' },
      ],
    });
    render(
      <PreviewFilePicker path="/work/docs/note.md" url={url} scope={scope} onOpen={vi.fn()} />,
    );
    fireEvent.click(screen.getByTestId('preview-file-picker'));
    const alias = await screen.findByRole('treeitem', { name: 'self-link' });
    expect((alias as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getAllByRole('treeitem')).toHaveLength(2);
  });
  it('normalizes Windows paths and encodes filename characters once', async () => {
    vi.mocked(resourcePreviewClient.listDirectory).mockResolvedValue({
      ok: true,
      entries: [{ kind: 'file', name: 'a#b%.md', path: 'C:\\work\\docs\\a#b%.md' }],
    });
    const onOpen = vi.fn();
    render(
      <PreviewFilePicker
        path={String.raw`C:\work\docs\note.md`}
        url={url}
        scope={scope}
        onOpen={onOpen}
      />,
    );
    expect(
      screen.getByRole('button', { name: 'C:', exact: true }).getAttribute('title'),
    ).toBeNull();
    fireEvent.click(screen.getByTestId('preview-file-picker'));
    fireEvent.click(await screen.findByRole('treeitem', { name: 'a#b%.md' }));
    expect(onOpen).toHaveBeenCalledWith('C:/work/docs/a%23b%25.md', scope);
  });
  it('does not enumerate without a live preview capability or for a remote URL', () => {
    const r = render(
      <PreviewFilePicker path="/work/docs/note.md" scope={scope} onOpen={vi.fn()} />,
    );
    expect((screen.getByTestId('preview-file-picker') as HTMLButtonElement).disabled).toBe(true);
    expect(resourcePreviewClient.listDirectory).not.toHaveBeenCalled();
    r.rerender(
      <PreviewFilePicker path="https://example.com" url={url} scope={scope} onOpen={vi.fn()} />,
    );
    expect(screen.queryByRole('navigation')).toBeNull();
  });
  it('keeps root-level and Windows drive directory targets absolute', () => {
    expect(previewPathCrumbs('/note.md')).toEqual([
      { name: 'note.md', path: '/note.md', directory: '/' },
    ]);
    expect(previewPathCrumbs('C:\\note.md').map((c) => c.directory)).toEqual(['C:/', 'C:/']);
  });
});
