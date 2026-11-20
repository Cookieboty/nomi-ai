// @vitest-environment happy-dom
import { t } from '@nomi-ai/ui';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { confirmDialog } from '../src/components/ConfirmDialog';
import { FileReview, type ReviewFile } from '../src/components/SessionWorkspace/FileReview';
import { harnessClient } from '../src/services/harnessClient';
import { resourcePreviewClient } from '../src/services/resourcePreviewClient';
import type { FileDiff } from '../src/utils/toolTrace';

vi.mock('../src/components/ConfirmDialog', () => ({ confirmDialog: vi.fn(async () => true) }));
vi.mock('../src/services/harnessClient', () => ({
  harnessClient: {
    workspaceRead: vi.fn(),
    workspaceWrite: vi.fn(),
    workspaceDelete: vi.fn(),
    workspaceGitCheckout: vi.fn(),
    gitDiff: vi.fn(),
  },
}));

vi.mock('../src/services/resourcePreviewClient', () => ({
  resourcePreviewClient: { open: vi.fn(), save: vi.fn(), close: vi.fn() },
}));

const diff: FileDiff = {
  file: 'src/a.ts',
  diff: {
    added: 1,
    removed: 1,
    lines: [
      { type: 'ctx', text: 'head', oldNo: 1, newNo: 1 },
      { type: 'del', text: 'old', oldNo: 2 },
      { type: 'add', text: 'new', newNo: 2 },
    ],
  },
};

const file: ReviewFile = {
  key: 'k1',
  path: 'src/a.ts',
  change: {
    file: 'src/a.ts',
    added: 1,
    removed: 1,
    status: 'modified',
    letter: 'M',
    diff,
    messageId: 'm1',
  },
};

const renderPreview = (onSaved = vi.fn()) =>
  render(
    <FileReview
      files={[file]}
      activeKey="k1"
      cwd="/w"
      onActiveKey={() => undefined}
      onClose={() => undefined}
      onSaved={onSaved}
    />,
  );

beforeEach(() => {
  vi.mocked(harnessClient.workspaceRead).mockResolvedValue({
    ok: true,
    content: 'head\nnew\ntail\n',
  });
  vi.mocked(harnessClient.workspaceWrite).mockResolvedValue({ ok: true });
  vi.mocked(harnessClient.gitDiff).mockResolvedValue({
    ok: true,
    status: '',
    stat: '',
    diff: '',
    truncated: false,
  });
  vi.mocked(confirmDialog).mockResolvedValue(true);
  vi.mocked(resourcePreviewClient.open).mockResolvedValue({
    ok: true,
    editable: true,
    content: 'head\nnew\ntail\n',
    url: 'cap',
    revision: 'r1',
  });
  vi.mocked(resourcePreviewClient.save).mockResolvedValue({ ok: true, revision: 'r2' });
  vi.mocked(resourcePreviewClient.close).mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('FileReview 编辑 / 保存', () => {
  it('切到编辑模式读盘，改动后保存写回整份内容', async () => {
    const onSaved = vi.fn();
    renderPreview(onSaved);
    fireEvent.click(screen.getByTestId('preview-mode-file'));
    const ta = (await screen.findByTestId('preview-editor')) as HTMLTextAreaElement;
    await waitFor(() => expect(ta.value).toBe('head\nnew\ntail\n'));
    fireEvent.change(ta, { target: { value: 'head\nnew\ntail\n// saved\n' } });
    fireEvent.click(screen.getByTestId('preview-save'));
    await waitFor(() =>
      expect(resourcePreviewClient.save).toHaveBeenCalledWith(
        'cap',
        'r1',
        'head\nnew\ntail\n// saved\n',
      ),
    );
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
  });

  it('保存失败：显示错误，不当作已保存', async () => {
    vi.mocked(resourcePreviewClient.save).mockResolvedValue({
      ok: false,
      code: 'denied',
    });
    const onSaved = vi.fn();
    renderPreview(onSaved);
    fireEvent.click(screen.getByTestId('preview-mode-file'));
    const ta = (await screen.findByTestId('preview-editor')) as HTMLTextAreaElement;
    await waitFor(() => expect(ta.value).toContain('head'));
    fireEvent.change(ta, { target: { value: 'x' } });
    fireEvent.click(screen.getByTestId('preview-save'));
    const err = await screen.findByTestId('preview-error');
    expect(err.textContent).toBeTruthy();
    expect(onSaved).not.toHaveBeenCalled();
  });
});

describe('FileReview 丢弃本轮变更', () => {
  it('应用内确认（不调 window.confirm）：取消不写盘', () => {
    const confirm = vi.fn(() => true);
    vi.stubGlobal('confirm', confirm);
    renderPreview();
    fireEvent.click(screen.getByTestId('preview-discard'));
    expect(screen.getByTestId('preview-discard-confirm')).toBeTruthy();
    fireEvent.click(screen.getByTestId('preview-discard-cancel'));
    expect(screen.queryByTestId('preview-discard-confirm')).toBeNull();
    expect(confirm).not.toHaveBeenCalled();
    expect(harnessClient.workspaceWrite).not.toHaveBeenCalled();
  });

  it('确认后只把改动处换回旧内容，其余内容保留', async () => {
    const onSaved = vi.fn();
    renderPreview(onSaved);
    fireEvent.click(screen.getByTestId('preview-discard'));
    fireEvent.click(screen.getByTestId('preview-discard-ok'));
    await waitFor(() =>
      expect(harnessClient.workspaceWrite).toHaveBeenCalledWith(
        '/w',
        'src/a.ts',
        'head\nold\ntail\n',
      ),
    );
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
  });

  it('文件之后又被改过：提示，不写盘', async () => {
    vi.mocked(harnessClient.workspaceRead).mockResolvedValue({ ok: true, content: 'other\n' });
    renderPreview();
    fireEvent.click(screen.getByTestId('preview-discard'));
    fireEvent.click(screen.getByTestId('preview-discard-ok'));
    const err = await screen.findByTestId('preview-error');
    expect(err.textContent).toContain('无法安全撤销');
    expect(harnessClient.workspaceWrite).not.toHaveBeenCalled();
  });
});

describe('FileReview 刷新 Diff', () => {
  it('Diff 模式下点击刷新调用 onRefresh 并更新显示最新 git diff', async () => {
    const initialGitFile: ReviewFile = {
      key: 'u:src/a.ts',
      path: 'src/a.ts',
      gitDiff: {
        file: 'src/a.ts',
        diff: {
          added: 1,
          removed: 1,
          lines: [
            { type: 'del', text: 'before', oldNo: 1 },
            { type: 'add', text: 'first-edit', newNo: 1 },
          ],
        },
      },
    };
    const nextGitFile: ReviewFile = {
      ...initialGitFile,
      gitDiff: {
        file: 'src/a.ts',
        diff: {
          added: 1,
          removed: 1,
          lines: [
            { type: 'del', text: 'before', oldNo: 1 },
            { type: 'add', text: 'second-edit', newNo: 1 },
          ],
        },
      },
    };
    function Harness() {
      const [current, setCurrent] = React.useState(initialGitFile);
      return (
        <FileReview
          files={[current]}
          activeKey="u:src/a.ts"
          cwd="/w"
          onActiveKey={() => undefined}
          onClose={() => undefined}
          onRefresh={() => setCurrent(nextGitFile)}
        />
      );
    }
    render(<Harness />);
    expect(screen.getByText('first-edit')).toBeTruthy();
    fireEvent.click(screen.getByTestId('preview-refresh'));
    await waitFor(() => expect(screen.getByText('second-edit')).toBeTruthy());
    expect(screen.queryByText('first-edit')).toBeNull();
  });

  it('静态本会话变更在 Diff 模式下点刷新会重读 gitDiff，改动消失后清空旧 Diff', async () => {
    vi.mocked(harnessClient.gitDiff).mockResolvedValueOnce({
      ok: true,
      status: ' M src/a.ts',
      stat: '',
      diff: 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+updated-on-disk\n',
      truncated: false,
    });
    renderPreview();
    expect(screen.getByText('new')).toBeTruthy();
    fireEvent.click(screen.getByTestId('preview-refresh'));
    await waitFor(() => expect(screen.getByText('updated-on-disk')).toBeTruthy());
    expect(screen.queryByText('new')).toBeNull();

    vi.mocked(harnessClient.gitDiff).mockResolvedValueOnce({
      ok: true,
      status: '',
      stat: '',
      diff: '',
      truncated: false,
    });
    fireEvent.click(screen.getByTestId('preview-refresh'));
    await waitFor(() =>
      expect(
        screen.getByText(t('ui.session-workspace.no-diff-switch-to-file-to-view-disk')),
      ).toBeTruthy(),
    );
  });

  it('编辑模式下有未保存改动时点刷新确认后丢弃草稿并同时刷新磁盘与 Diff', async () => {
    const onRefresh = vi.fn();
    render(
      <FileReview
        files={[file]}
        activeKey="k1"
        cwd="/w"
        onActiveKey={() => undefined}
        onClose={() => undefined}
        onRefresh={onRefresh}
      />,
    );
    fireEvent.click(screen.getByTestId('preview-mode-file'));
    const ta = (await screen.findByTestId('preview-editor')) as HTMLTextAreaElement;
    await waitFor(() => expect(ta.value).toBe('head\nnew\ntail\n'));
    fireEvent.change(ta, { target: { value: 'unsaved draft' } });
    vi.mocked(harnessClient.workspaceRead).mockResolvedValueOnce({
      ok: true,
      content: 'head\ndisk-v2\ntail\n',
    });
    fireEvent.click(screen.getByTestId('preview-refresh'));
    await waitFor(() => expect(confirmDialog).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(ta.value).toBe('head\ndisk-v2\ntail\n'));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });
});
