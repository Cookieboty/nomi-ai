// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FilePreview, type PreviewFile } from '../src/components/SessionWorkspace/FilePreview';
import { harnessClient } from '../src/services/harnessClient';
import type { FileDiff } from '../src/utils/toolTrace';

vi.mock('../src/services/harnessClient', () => ({
  harnessClient: {
    workspaceRead: vi.fn(),
    workspaceWrite: vi.fn(),
    workspaceDelete: vi.fn(),
    workspaceGitCheckout: vi.fn(),
  },
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

const file: PreviewFile = {
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
    <FilePreview
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
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('FilePreview 编辑 / 保存', () => {
  it('切到编辑模式读盘，改动后保存写回整份内容', async () => {
    const onSaved = vi.fn();
    renderPreview(onSaved);
    fireEvent.click(screen.getByTestId('preview-mode-file'));
    const ta = (await screen.findByTestId('preview-editor')) as HTMLTextAreaElement;
    await waitFor(() => expect(ta.value).toBe('head\nnew\ntail\n'));
    fireEvent.change(ta, { target: { value: 'head\nnew\ntail\n// saved\n' } });
    fireEvent.click(screen.getByTestId('preview-save'));
    await waitFor(() =>
      expect(harnessClient.workspaceWrite).toHaveBeenCalledWith(
        '/w',
        'src/a.ts',
        'head\nnew\ntail\n// saved\n',
      ),
    );
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
  });

  it('保存失败：显示错误，不当作已保存', async () => {
    vi.mocked(harnessClient.workspaceWrite).mockResolvedValue({
      ok: false,
      code: 'outside',
      error: 'x',
    });
    const onSaved = vi.fn();
    renderPreview(onSaved);
    fireEvent.click(screen.getByTestId('preview-mode-file'));
    const ta = (await screen.findByTestId('preview-editor')) as HTMLTextAreaElement;
    await waitFor(() => expect(ta.value).toContain('head'));
    fireEvent.change(ta, { target: { value: 'x' } });
    fireEvent.click(screen.getByTestId('preview-save'));
    const err = await screen.findByTestId('preview-error');
    expect(err.textContent).toContain('工作区');
    expect(onSaved).not.toHaveBeenCalled();
  });
});

describe('FilePreview 丢弃本轮变更', () => {
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
