// @vitest-environment happy-dom
/**
 * 文件的 Diff 是预览区的普通标签：每个改动文件一个，和文件标签同一排；
 * 同一文件的 Diff 与文件本身是两个标签；切到文件时 Diff 标签留着。
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { confirmDialog } from '../src/components/ConfirmDialog';
import {
  dirtyReviewDrafts,
  dropReviewDrafts,
} from '../src/components/SessionWorkspace/reviewDrafts';
import type { DiffTabSpec } from '../src/contexts/ResourceContext';
import { useResourcePreview } from '../src/hooks/useResourcePreview';
import { resourcePreviewClient } from '../src/services/resourcePreviewClient';
import { parsePatch } from '../src/utils/lineDiff';

vi.mock('../src/services/api', () => ({ hostAssetUrl: (url: string) => url }));
vi.mock('../src/services/harnessClient', () => ({
  harnessClient: {
    workspaceList: vi.fn(async () => ({ ok: true, entries: [] })),
    workspaceRead: vi.fn(async () => ({ ok: true, content: '' })),
  },
}));
vi.mock('../src/components/ConfirmDialog', () => ({ confirmDialog: vi.fn(async () => false) }));
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
  vi.mocked(confirmDialog).mockClear();
  dropReviewDrafts([tabKey('src/a.ts'), tabKey('src/b.ts')]);
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

/** 预览区 Diff 标签的 key（useResourcePreview 的 diffEntryKey） */
const tabKey = (path: string) => `diff\u0000${diffOf(path).key}`;

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

  it('Diff 里编辑的草稿：切到别的 Diff / 文件标签再回来还在；关掉要先确认（#338）', async () => {
    render(<Probe />);
    fireEvent.click(screen.getByText('diff a'));
    await screen.findByTestId('preview-diff');
    fireEvent.click(screen.getByText('diff b'));
    fireEvent.click(screen.getByRole('tab', { name: 'a.ts 的改动' }));
    fireEvent.click(await screen.findByTestId('preview-mode-file'));
    const editor = (await screen.findByTestId('preview-editor')) as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: 'draft A' } });
    expect(dirtyReviewDrafts([tabKey('src/a.ts')])).toHaveLength(1);

    fireEvent.click(screen.getByRole('tab', { name: 'b.ts 的改动' }));
    expect(screen.queryByTestId('preview-editor')).toBeNull();
    fireEvent.click(screen.getByText('file a'));
    await screen.findByTestId('resource-preview-source');
    fireEvent.click(screen.getByRole('tab', { name: 'a.ts 的改动' }));
    // 回到编辑模式，草稿接着在（不是重新读盘的内容）
    await waitFor(() =>
      expect((screen.getByTestId('preview-editor') as HTMLTextAreaElement).value).toBe('draft A'),
    );
    // b 的 Diff 没有被串写
    expect(dirtyReviewDrafts([tabKey('src/b.ts')])).toEqual([]);

    // 关掉：不放弃就留着并切回它；放弃才关
    const closeA = () =>
      fireEvent.click(
        screen
          .getByRole('tab', { name: 'a.ts 的改动' })
          .parentElement!.querySelectorAll('button')[1]!,
      );
    closeA();
    await waitFor(() => expect(confirmDialog).toHaveBeenCalledTimes(1));
    expect(tabNames()).toContain('a.ts 的改动');
    vi.mocked(confirmDialog).mockResolvedValueOnce(true);
    closeA();
    await waitFor(() => expect(tabNames()).not.toContain('a.ts 的改动'));
    expect(dirtyReviewDrafts([tabKey('src/a.ts')])).toEqual([]);
  });
});
