// @vitest-environment happy-dom
/**
 * 文件的 Diff 是预览区的普通标签：每个改动文件一个，和文件标签同一排；
 * 同一文件的 Diff 与文件本身是两个标签；切到文件时 Diff 标签留着。
 */
import { t } from '@nomi-ai/ui';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React, { useState } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { confirmDialog } from '../src/components/ConfirmDialog';
import type { PreviewTabsControl } from '../src/components/ResourcePreview/ResourcePreview';
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
      <button onClick={() => v.openDiff?.(diffOf('src/a.ts'))}>diff a</button>
      <button onClick={() => v.openDiff?.(diffOf('src/b.ts'))}>diff b</button>
      <button onClick={() => v.updateDiff?.(diffOf('src/a.ts', 'newer line'))}>refresh a</button>
      <button onClick={() => v.updateDiff?.(diffOf('src/c.ts'))}>refresh c</button>
      <button onClick={() => v.syncDiffs?.('git\u0000/work\u0000', [])}>clear work diffs</button>
      <button
        onClick={() => v.syncDiffs?.('git\u0000/work\u0000', [diffOf('src/a.ts', 'synced line')])}
      >
        sync a
      </button>
      <button onClick={() => v.open('/work/src/a.ts', v.scope)}>file a</button>
      {preview.panel}
    </>
  );
}

function EmbeddedProbe() {
  const preview = useResourcePreview({ id: 'embedded-diff-tabs', cwd: '/work' });
  const [fileControl] = useState<{ current: PreviewTabsControl | null }>(() => ({ current: null }));
  const [diffControl] = useState<{ current: PreviewTabsControl | null }>(() => ({ current: null }));
  return (
    <>
      <button onClick={() => preview.value.openDiff?.(diffOf('src/a.ts'))}>embedded diff</button>
      <button onClick={() => preview.value.open('/work/src/a.ts', preview.value.scope)}>
        embedded file
      </button>
      <div data-testid="embedded-files">
        {preview.renderEmbedded({
          inactive: false,
          expanded: false,
          onExpanded: () => undefined,
          controlRef: fileControl,
          showTabs: true,
          mode: 'files',
        })}
      </div>
      <div data-testid="embedded-diffs">
        {preview.renderEmbedded({
          inactive: false,
          expanded: false,
          onExpanded: () => undefined,
          controlRef: diffControl,
          showTabs: true,
          mode: 'diffs',
        })}
      </div>
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

  it('改动刷新只更新已开着的 Diff 标签，不会新开；syncDiffs 在改动消失时清空旧 Diff', async () => {
    render(<Probe />);
    fireEvent.click(screen.getByText('diff a'));
    await screen.findByTestId('preview-diff');
    fireEvent.click(screen.getByText('refresh c'));
    expect(tabNames()).toEqual(['a.ts 的改动']);
    fireEvent.click(screen.getByText('refresh a'));
    expect(await screen.findByText('newer line')).toBeTruthy();

    fireEvent.click(screen.getByText('sync a'));
    expect(await screen.findByText('synced line')).toBeTruthy();
    expect(screen.queryByText('newer line')).toBeNull();

    fireEvent.click(screen.getByText('clear work diffs'));
    expect(tabNames()).toEqual(['a.ts 的改动']);
    await waitFor(() => expect(screen.queryByText('synced line')).toBeNull());
    expect(
      screen.getByText(t('ui.session-workspace.no-diff-switch-to-file-to-view-disk')),
    ).toBeTruthy();
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

  it('嵌入到工作区时，文件页和变更页各自只显示自己的 tabs', async () => {
    render(<EmbeddedProbe />);
    fireEvent.click(screen.getByText('embedded diff'));
    expect(await screen.findByTestId('preview-diff')).toBeTruthy();
    fireEvent.click(screen.getByText('embedded file'));
    await screen.findByTestId('resource-preview-source');

    const files = screen.getByTestId('embedded-files');
    const diffs = screen.getByTestId('embedded-diffs');
    expect(
      Array.from(files.querySelectorAll('[data-preview-tab-key] > [role="tab"]')).map(
        (tab) => tab.textContent,
      ),
    ).toEqual(['a.ts']);
    expect(
      Array.from(diffs.querySelectorAll('[data-preview-tab-key] > [role="tab"]')).map((tab) =>
        tab.getAttribute('aria-label'),
      ),
    ).toEqual(['a.ts 的改动']);
  });
});

describe('多会话同文件 Diff 预览隔离与 scope 迁移 (#403)', () => {
  it('两个会话打开同工作区同文件 Diff：互不串编辑草稿，在一处关闭不关掉另一处的 Diff，且支持 migrateScope', async () => {
    const ScopedProbe: React.FC = () => {
      const [scopeId, setScopeId] = useState('s1');
      const preview = useResourcePreview({ id: scopeId, cwd: '/work' }, { scoped: true });
      return (
        <>
          <button onClick={() => setScopeId('s1')}>to s1</button>
          <button onClick={() => setScopeId('s2')}>to s2</button>
          <button onClick={() => setScopeId('s1-settled')}>to s1-settled</button>
          <button onClick={() => preview.value.openDiff?.(diffOf('src/a.ts'))}>open diff a</button>
          <button
            onClick={() => preview.closeEntries([`diff\u0000s1\u0000${diffOf('src/a.ts').key}`])}
          >
            close active diff
          </button>
          <button
            onClick={() =>
              preview.closeEntries([`diff\u0000s2\u0000${diffOf('src/a.ts').key}`], 's2')
            }
          >
            close s2 explicitly
          </button>
          <button onClick={() => preview.migrateScope('s1', 's1-settled')}>migrate s1</button>
          <div data-testid="entry-count">{preview.entries.length}</div>
          <div data-testid="entry-keys">{preview.entries.map((e) => e.key).join(',')}</div>
          {preview.panel}
        </>
      );
    };
    render(<ScopedProbe />);

    // 会话 s1 打开 src/a.ts Diff 并写编辑草稿
    fireEvent.click(screen.getByText('open diff a'));
    await screen.findByTestId('preview-diff');
    expect(screen.getByTestId('entry-keys').textContent).toBe(
      `diff\u0000s1\u0000${diffOf('src/a.ts').key}`,
    );
    fireEvent.click(await screen.findByTestId('preview-mode-file'));
    fireEvent.change(await screen.findByTestId('preview-editor'), {
      target: { value: 's1 draft' },
    });

    // 切到 s2，同样打开 src/a.ts Diff（各自 key 与草稿互不冲突）
    fireEvent.click(screen.getByText('to s2'));
    expect(screen.getByTestId('entry-count').textContent).toBe('0');
    fireEvent.click(screen.getByText('open diff a'));
    await screen.findByTestId('preview-diff');
    expect(screen.getByTestId('entry-keys').textContent).toBe(
      `diff\u0000s2\u0000${diffOf('src/a.ts').key}`,
    );

    // 切回 s1，关闭 s1 的 Diff；s2 的 Diff 不受任何影响
    fireEvent.click(screen.getByText('to s1'));
    expect(screen.getByTestId('entry-count').textContent).toBe('1');
    // 测试 migrateScope 把 s1 及其 Diff key 与草稿迁移到 s1-settled
    fireEvent.click(screen.getByText('migrate s1'));
    fireEvent.click(screen.getByText('to s1-settled'));
    expect(screen.getByTestId('entry-keys').textContent).toBe(
      `diff\u0000s1-settled\u0000${diffOf('src/a.ts').key}`,
    );
    expect(dirtyReviewDrafts([`diff\u0000s1-settled\u0000${diffOf('src/a.ts').key}`])).toHaveLength(
      1,
    );
    expect(dirtyReviewDrafts([`diff\u0000s1\u0000${diffOf('src/a.ts').key}`])).toEqual([]);

    // 确认只关 s1 不影响 s2：即使传入 s1-settled 也不影响 s2；切换到 s2 查看仍在
    fireEvent.click(screen.getByText('to s2'));
    expect(screen.getByTestId('entry-count').textContent).toBe('1');
    // 在 s2 里即使故意调用关闭 active（携带的是 s1 的 key），也不会关掉 s2
    fireEvent.click(screen.getByText('close active diff'));
    expect(screen.getByTestId('entry-count').textContent).toBe('1');
    // 只有指定 s2 的 key 才会关 s2
    fireEvent.click(screen.getByText('close s2 explicitly'));
    expect(screen.getByTestId('entry-count').textContent).toBe('0');
    dropReviewDrafts([`diff\u0000s1-settled\u0000${diffOf('src/a.ts').key}`]);
  });
});
