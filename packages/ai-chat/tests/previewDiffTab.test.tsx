// @vitest-environment happy-dom
/**
 * 文件的 Diff 是预览区的普通标签：每个改动文件一个，和文件标签同一排；
 * 同一文件的 Diff 与文件本身是两个标签；切到文件时 Diff 标签留着。
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { confirmDialog } from '../src/components/ConfirmDialog';
import { getPreviewEdits, flushPreviewEdits } from '../src/components/ResourcePreview/previewEdits';
import type { DiffTabSpec } from '../src/contexts/ResourceContext';
import { useResourcePreview } from '../src/hooks/useResourcePreview';
import { harnessClient } from '../src/services/harnessClient';
import { resourcePreviewClient } from '../src/services/resourcePreviewClient';
import { parsePatch } from '../src/utils/lineDiff';

vi.mock('../src/components/ConfirmDialog', () => ({ confirmDialog: vi.fn(async () => true) }));
vi.mock('../src/services/api', () => ({ hostAssetUrl: (url: string) => url }));
vi.mock('../src/services/harnessClient', () => ({
  harnessClient: {
    workspaceList: vi.fn(async () => ({ ok: true, entries: [] })),
    workspaceRead: vi.fn(async (_cwd: string, path: string) => ({
      ok: true,
      content: `disk ${path}`,
    })),
    workspaceWrite: vi.fn(),
  },
}));
vi.mock('../src/services/resourcePreviewClient', () => ({
  resourcePreviewClient: {
    open: vi.fn(async (_cwd: string, path: string) => ({
      ok: true,
      kind: 'text',
      content: `content of ${path}`,
      path,
    })),
    close: vi.fn(async () => undefined),
    save: vi.fn(),
    renew: vi.fn(),
  },
}));

beforeAll(async () => {
  await import('../src/components/ResourcePreview/ResourcePreview');
});
afterEach(() => {
  cleanup();
  vi.mocked(resourcePreviewClient.open).mockClear();
});

const patch = (file: string, line: string) => ({
  file,
  diff: parsePatch(`@@ -1 +1 @@\n-old\n+${line}\n`),
});
const diffOf = (path: string, line = 'new line'): DiffTabSpec => ({
  key: `git\u0000/work\u0000u:${path}`,
  path,
  cwd: '/work',
  file: { key: `u:${path}`, path, added: 1, removed: 1, gitDiff: patch(path, line) },
});

function Probe() {
  const preview = useResourcePreview({ id: 'diff-tabs', cwd: '/work' });
  const v = preview.value;
  return (
    <>
      <button onClick={() => v.openDiff(diffOf('src/a.ts'))}>diff a</button>
      <button onClick={() => v.openDiff(diffOf('src/b.ts'))}>diff b</button>
      <button onClick={() => v.updateDiff(diffOf('src/a.ts', 'newer line'))}>refresh a</button>
      <button onClick={() => v.updateDiff(diffOf('src/c.ts'))}>refresh c</button>
      <button onClick={() => v.open('/work/src/a.ts', v.scope)}>file a</button>
      {Array.from({ length: 13 }, (_, i) => (
        <button key={i} onClick={() => v.openDiff(diffOf(`extra-${i}.ts`))}>
          extra {i}
        </button>
      ))}
      {preview.panel}
    </>
  );
}

/** 只看预览区那一排标签（FileReview 里还有「Diff / 编辑」的切换） */
const previewTabs = () =>
  Array.from(document.querySelectorAll<HTMLElement>('[data-preview-tab-key] > [role="tab"]'));
const tabNames = () => previewTabs().map((x) => x.getAttribute('aria-label') ?? x.textContent);
const selected = () => previewTabs().find((x) => x.getAttribute('aria-selected') === 'true')!;

describe('文件 Diff 标签', () => {
  it('每个改动文件一个 Diff 标签，和文件标签同一排；再点同一文件切回已有标签', async () => {
    render(<Probe />);
    fireEvent.click(screen.getByText('diff a'));
    expect(await screen.findByTestId('preview-diff')).toBeTruthy();
    fireEvent.click(screen.getByText('diff b'));
    expect(tabNames()).toEqual(['a.ts 的改动', 'b.ts 的改动']);
    expect(selected().getAttribute('aria-label')).toBe('b.ts 的改动');
    fireEvent.click(screen.getByText('diff a'));
    expect(tabNames()).toHaveLength(2);
    expect(selected().getAttribute('aria-label')).toBe('a.ts 的改动');
    // Diff 标签不走文件预览的读盘
    expect(resourcePreviewClient.open).not.toHaveBeenCalled();
  });

  it('同一文件的 Diff 与文件本身是两个标签；切到文件时 Diff 标签留着', async () => {
    render(<Probe />);
    fireEvent.click(screen.getByText('diff a'));
    await screen.findByTestId('preview-diff');
    fireEvent.click(screen.getByText('file a'));
    await screen.findByTestId('resource-preview-source');
    expect(tabNames()).toEqual(['a.ts 的改动', 'a.ts']);
    expect(selected().textContent).toBe('a.ts');
    expect(screen.queryByTestId('preview-diff')).toBeNull();

    fireEvent.click(screen.getByRole('tab', { name: 'a.ts 的改动' }));
    expect(await screen.findByTestId('preview-diff')).toBeTruthy();
    expect(screen.getByTestId('resource-preview-header').hidden).toBe(true);
    expect(tabNames()).toEqual(['a.ts 的改动', 'a.ts']);
  });

  it('关掉 Diff 标签只关它自己', async () => {
    render(<Probe />);
    fireEvent.click(screen.getByText('file a'));
    await screen.findByTestId('resource-preview-source');
    fireEvent.click(screen.getByText('diff a'));
    await screen.findByTestId('preview-diff');
    const tab = screen.getByRole('tab', { name: 'a.ts 的改动' }).parentElement!;
    fireEvent.click(tab.querySelectorAll('button')[1]!);
    expect(tabNames()).toEqual(['a.ts']);
  });

  it('改动刷新只更新已开着的 Diff 标签，不会新开', async () => {
    render(<Probe />);
    fireEvent.click(screen.getByText('diff a'));
    await screen.findByTestId('preview-diff');
    fireEvent.click(screen.getByText('refresh c'));
    expect(tabNames()).toEqual(['a.ts 的改动']);
    fireEvent.click(screen.getByText('refresh a'));
    expect(await screen.findByText('newer line')).toBeTruthy();
  });
});

describe('embedded Diff editor drafts', () => {
  let sequence = 0;
  const keys = new Set<string>();
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(resourcePreviewClient.open).mockImplementation(async (_, path) => ({
      ok: true,
      kind: 'text',
      editable: true,
      path,
      content: `disk ${path}`,
      revision: `revision:${path}`,
      url: `/__nomi/preview/diff-${++sequence}`,
    }));
    vi.mocked(resourcePreviewClient.save).mockResolvedValue({ ok: true, revision: 'saved' });
  });
  afterEach(async () => {
    cleanup();
    for (const { session } of getPreviewEdits([...keys])) session.discardDraft();
    await flushPreviewEdits([...keys]);
    keys.clear();
  });
  const rememberKeys = () => {
    for (const tab of previewTabs()) keys.add(tab.parentElement!.dataset.previewTabKey!);
    return [...keys];
  };
  async function edit(name: string, text?: string) {
    fireEvent.click(screen.getByRole('button', { name: `diff ${name}` }));
    await screen.findByTestId('preview-diff');
    fireEvent.click(screen.getByTestId('preview-mode-file'));
    const editor = (await screen.findByTestId('preview-editor')) as HTMLTextAreaElement;
    await waitFor(() => expect(editor.value).not.toBe(''));
    rememberKeys();
    if (text !== undefined) fireEvent.change(editor, { target: { value: text } });
    return editor;
  }
  function closeMenu(name: string, action: string) {
    fireEvent.contextMenu(screen.getByRole('tab', { name }), { clientX: 100, clientY: 50 });
    fireEvent.click(screen.getByTestId(`preview-tab-${action}`));
  }
  it('keeps distinct drafts through a normal tab without autosaving and saves the correct revisions', async () => {
    render(<Probe />);
    await edit('a', 'draft A');
    await edit('b', 'draft B');
    fireEvent.click(screen.getByText('file a'));
    await screen.findByTestId('resource-preview-source');
    rememberKeys();
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(resourcePreviewClient.save).not.toHaveBeenCalled();
    for (const [name, draft] of [
      ['a', 'draft A'],
      ['b', 'draft B'],
    ]) {
      expect((await edit(name!)).value).toBe(draft);
      await act(async () => undefined);
      const calls = vi.mocked(resourcePreviewClient.open).mock;
      const index = calls.calls.findLastIndex(([, path]) => path === `src/${name}.ts`);
      const opened = await calls.results[index]!.value;
      fireEvent.click(screen.getByTestId('preview-save'));
      await waitFor(() =>
        expect(resourcePreviewClient.save).toHaveBeenLastCalledWith(
          opened.url,
          `revision:src/${name}.ts`,
          draft,
        ),
      );
    }
    expect(harnessClient.workspaceWrite).not.toHaveBeenCalled();
  });
  it('bulk closes inactive drafts and releases their sessions and capabilities', async () => {
    render(<Probe />);
    await edit('a', 'draft A');
    await edit('b', 'draft B');
    const draftKeys = rememberKeys();
    const urls = await Promise.all(
      vi.mocked(resourcePreviewClient.open).mock.results.map(async (r) => (await r.value).url),
    );
    closeMenu('b.ts 的改动', 'all');
    await waitFor(() => expect(previewTabs()).toHaveLength(0));
    expect(resourcePreviewClient.save).toHaveBeenCalledTimes(2);
    expect(getPreviewEdits(draftKeys)).toEqual([]);
    for (const url of urls) expect(resourcePreviewClient.close).toHaveBeenCalledWith(url);
  });
  it('keeps and activates the inactive tab whose close save fails', async () => {
    render(<Probe />);
    await edit('a', 'draft A');
    await edit('b', 'draft B');
    vi.mocked(resourcePreviewClient.save).mockResolvedValue({ ok: false, code: 'write' });
    closeMenu('a.ts 的改动', 'close');
    await waitFor(() => expect(selected().getAttribute('aria-label')).toBe('a.ts 的改动'));
    expect(tabNames()).toEqual(['a.ts 的改动', 'b.ts 的改动']);
    expect((await edit('a')).value).toBe('draft A');
    expect(await screen.findByTestId('preview-error')).toBeTruthy();
    expect(harnessClient.workspaceWrite).not.toHaveBeenCalled();
  });
  it('protects a dirty inactive Diff tab from the twelve-tab eviction limit', async () => {
    render(<Probe />);
    await edit('a', 'keep A');
    for (let i = 0; i < 13; i++) fireEvent.click(screen.getByText(`extra ${i}`));
    expect(previewTabs()).toHaveLength(12);
    expect(tabNames()).toContain('a.ts 的改动');
    expect((await edit('a')).value).toBe('keep A');
    expect(resourcePreviewClient.save).not.toHaveBeenCalled();
  });
  it('keeps conflicting text without a blind workspaceWrite fallback', async () => {
    render(<Probe />);
    await edit('a', 'keep conflict');
    await edit('b');
    vi.mocked(resourcePreviewClient.open).mockImplementation(async (_, path) => ({
      ok: true,
      kind: 'text',
      editable: true,
      path,
      content: 'external modification',
      revision: 'external',
      url: `/__nomi/preview/external-${++sequence}`,
    }));
    expect((await edit('a')).value).toBe('keep conflict');
    await screen.findByTestId('preview-error');
    fireEvent.click(screen.getByTestId('preview-save'));
    expect(resourcePreviewClient.save).not.toHaveBeenCalled();
    expect(harnessClient.workspaceWrite).not.toHaveBeenCalled();
  });
  it.each([{ editable: false }, { truncated: true }])(
    'rejects an unsupported edit grant %j',
    async (flags) => {
      vi.mocked(resourcePreviewClient.open).mockResolvedValue({
        ok: true,
        kind: 'text',
        content: 'partial',
        editable: true,
        ...flags,
        url: '/__nomi/preview/read-only',
        revision: 'initial',
      });
      render(<Probe />);
      fireEvent.click(screen.getByText('diff a'));
      await screen.findByTestId('preview-diff');
      fireEvent.click(screen.getByTestId('preview-mode-file'));
      await waitFor(() => expect(resourcePreviewClient.open).toHaveBeenCalled());
      await act(async () => undefined);
      expect(screen.queryByTestId('preview-editor')).toBeNull();
      expect((screen.getByTestId('preview-save') as HTMLButtonElement).disabled).toBe(true);
      expect(resourcePreviewClient.save).not.toHaveBeenCalled();
      expect(harnessClient.workspaceWrite).not.toHaveBeenCalled();
    },
  );
  it('retains an editable and copyable dirty draft when reopening the file fails', async () => {
    const copy = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
    render(<Probe />);
    await edit('a', 'recover A');
    vi.mocked(resourcePreviewClient.save).mockResolvedValue({ ok: false, code: 'write' });
    fireEvent.click(screen.getByTestId('preview-save'));
    await screen.findByTestId('preview-error');
    await edit('b');
    vi.mocked(resourcePreviewClient.open).mockResolvedValue({ ok: false, code: 'missing' });
    const editor = await edit('a');
    await act(async () => undefined);
    expect(editor.value).toBe('recover A');
    fireEvent.change(editor, { target: { value: 'recover A with more typing' } });
    expect(editor.value).toBe('recover A with more typing');
    // The error's first action copies the retained text, without needing a fresh disk grant.
    fireEvent.click(screen.getByTestId('preview-error').querySelector('button')!);
    expect(copy).toHaveBeenCalledWith('recover A with more typing');
    expect(harnessClient.workspaceWrite).not.toHaveBeenCalled();
    copy.mockRestore();
  });

  it('discards and retires a failed inactive draft from Diff mode without opening the editor', async () => {
    render(<Probe />);
    await edit('a', 'discard A');
    const aKey = selected().parentElement!.dataset.previewTabKey!;
    const firstOpen = await vi.mocked(resourcePreviewClient.open).mock.results[0]!.value;
    await edit('b');
    vi.mocked(resourcePreviewClient.save).mockResolvedValue({ ok: false, code: 'conflict' });
    closeMenu('a.ts 的改动', 'close');
    await waitFor(() => expect(selected().getAttribute('aria-label')).toBe('a.ts 的改动'));
    expect(screen.queryByTestId('preview-editor')).toBeNull();
    expect(getPreviewEdits([aKey])[0]?.session.state.text).toBe('discard A');
    const openCount = vi.mocked(resourcePreviewClient.open).mock.calls.length;
    fireEvent.click(await screen.findByTestId('preview-discard-draft'));
    await waitFor(() => expect(getPreviewEdits([aKey])).toEqual([]));
    expect(confirmDialog).toHaveBeenCalled();
    expect(resourcePreviewClient.close).toHaveBeenCalledWith(firstOpen.url);
    expect(resourcePreviewClient.open).toHaveBeenCalledTimes(openCount);
    expect(screen.queryByTestId('preview-editor')).toBeNull();
    closeMenu('a.ts 的改动', 'close');
    await waitFor(() => expect(tabNames()).toEqual(['b.ts 的改动']));
  });

  it('closes a stale open capability without registering an orphan draft', async () => {
    let finish!: (value: Awaited<ReturnType<typeof resourcePreviewClient.open>>) => void;
    vi.mocked(resourcePreviewClient.open).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    render(<Probe />);
    fireEvent.click(screen.getByText('diff a'));
    await screen.findByTestId('preview-diff');
    fireEvent.click(screen.getByTestId('preview-mode-file'));
    const staleKeys = rememberKeys();
    await waitFor(() => expect(resourcePreviewClient.open).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByText('diff b'));
    await act(async () =>
      finish({
        ok: true,
        kind: 'text',
        editable: true,
        content: 'late',
        url: '/__nomi/preview/late',
        revision: 'initial',
      }),
    );
    await waitFor(() =>
      expect(resourcePreviewClient.close).toHaveBeenCalledWith('/__nomi/preview/late'),
    );
    expect(getPreviewEdits(staleKeys)).toEqual([]);
    expect(resourcePreviewClient.save).not.toHaveBeenCalled();
  });
});
