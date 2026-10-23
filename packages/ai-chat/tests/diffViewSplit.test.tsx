// @vitest-environment happy-dom
/** 中栏 Diff 够宽时左右并排；Markdown 文件预览有编辑 / 预览两种模式 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DiffView, pairSplitLines } from '../src/components/Conversation/DiffView';
import { FilePreview } from '../src/components/SessionWorkspace/FilePreview';
import type { DiffLine } from '../src/utils/lineDiff';
import type { FileDiff } from '../src/utils/toolTrace';

vi.mock('../src/services/harnessClient', () => ({
  harnessClient: {
    workspaceRead: vi.fn(async (_cwd: string, file: string) => ({
      ok: true,
      content: file.endsWith('.md') ? '# Old title\n' : 'const a = 1;\n',
    })),
    workspaceWrite: vi.fn(async () => ({ ok: true })),
  },
}));

const lines: DiffLine[] = [
  { type: 'hunk', text: '@@ -1,4 +1,4 @@' },
  { type: 'ctx', text: 'keep', oldNo: 1, newNo: 1 },
  { type: 'del', text: 'old a', oldNo: 2 },
  { type: 'del', text: 'old b', oldNo: 3 },
  { type: 'add', text: 'new a', newNo: 2 },
  { type: 'ctx', text: 'tail', oldNo: 4, newNo: 3 },
  { type: 'add', text: 'extra', newNo: 4 },
];
const diff: FileDiff = { file: 'src/a.ts', diff: { lines, added: 2, removed: 2 } };

/** 让 ResizeObserver 报告给定宽度 */
function mockWidth(width: number) {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(private cb: ResizeObserverCallback) {}
      observe() {
        this.cb([{ contentRect: { width } } as ResizeObserverEntry], this as never);
      }
      disconnect() {}
      unobserve() {}
    },
  );
}

describe('split diff', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('pairs deletions with the following additions; context shows on both sides', () => {
    const pairs = pairSplitLines(lines);
    const show = pairs.map((p) =>
      p.kind === 'hunk' ? 'hunk' : `${p.left?.text ?? '_'}|${p.right?.text ?? '_'}`,
    );
    expect(show).toEqual(['hunk', 'keep|keep', 'old a|new a', 'old b|_', 'tail|tail', '_|extra']);
  });

  it('goes side by side when wide, and the toggle switches every diff back to unified', () => {
    mockWidth(1000);
    render(
      <>
        <DiffView diff={diff} fill split="auto" />
        <DiffView diff={diff} fill split="auto" />
      </>,
    );
    const views = screen.getAllByTestId('tool-diff');
    expect(views.map((v) => v.getAttribute('data-layout'))).toEqual(['split', 'split']);
    expect(screen.getAllByTestId('diff-split-row').length).toBeGreaterThan(0);
    act(() => fireEvent.click(screen.getAllByTestId('diff-layout-toggle')[0]!));
    expect(views.map((v) => v.getAttribute('data-layout'))).toEqual(['unified', 'unified']);
    expect(localStorage.getItem('nomi.diffLayout')).toBe('unified');
    act(() => fireEvent.click(screen.getAllByTestId('diff-layout-toggle')[1]!));
    expect(views[0]!.getAttribute('data-layout')).toBe('split');
  });

  it('stays unified when narrow or inside the chat', () => {
    mockWidth(600);
    render(<DiffView diff={diff} fill split="auto" />);
    expect(screen.getByTestId('tool-diff').getAttribute('data-layout')).toBe('unified');
    expect(screen.queryByTestId('diff-layout-toggle')).toBeNull();
    cleanup();
    mockWidth(1400);
    render(<DiffView diff={diff} />);
    expect(screen.getByTestId('tool-diff').getAttribute('data-layout')).toBe('unified');
  });
});

describe('markdown file preview', () => {
  afterEach(() => cleanup());

  it('opens .md in edit mode; 预览 renders the unsaved draft', async () => {
    render(
      <FilePreview
        hideFileTabs
        files={[{ key: 'd:README.md', path: 'README.md' }]}
        activeKey="d:README.md"
        cwd="/tmp/proj"
        onActiveKey={() => undefined}
        onClose={() => undefined}
      />,
    );
    const editor = (await screen.findByTestId('preview-editor')) as HTMLTextAreaElement;
    await waitFor(() => expect(editor.value).toContain('# Old title'));
    fireEvent.change(editor, { target: { value: '# New title\n\nhello **world**\n' } });
    fireEvent.click(screen.getByTestId('preview-mode-render'));
    const body = await screen.findByTestId('preview-render-body');
    // 对话的 Markdown 渲染把标题降一级（# → h2）
    await waitFor(() => expect(body.querySelector('h2')?.textContent).toBe('New title'));
    expect(body.querySelector('strong')?.textContent).toBe('world');
    expect(body.textContent).toContain('未保存');
    // 切回编辑仍是草稿
    fireEvent.click(screen.getByTestId('preview-mode-file'));
    await waitFor(() =>
      expect((screen.getByTestId('preview-editor') as HTMLTextAreaElement).value).toContain(
        '# New title',
      ),
    );
  });

  it('other files have no 预览 tab but are editable', async () => {
    render(
      <FilePreview
        hideFileTabs
        files={[{ key: 'd:a.ts', path: 'a.ts' }]}
        activeKey="d:a.ts"
        cwd="/tmp/proj"
        onActiveKey={() => undefined}
        onClose={() => undefined}
      />,
    );
    await screen.findByTestId('preview-editor');
    expect(screen.queryByTestId('preview-mode-render')).toBeNull();
    expect(screen.getByTestId('preview-save')).toBeTruthy();
  });
});
