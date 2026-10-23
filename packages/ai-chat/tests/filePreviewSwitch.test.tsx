// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FilePreview, type PreviewFile } from '../src/components/SessionWorkspace/FilePreview';
import { harnessClient } from '../src/services/harnessClient';
import { shouldIgnoreEscape } from '../src/utils/keyboard';
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
  file: 'a.md',
  diff: { added: 1, removed: 0, lines: [{ type: 'add', text: 'x', newNo: 1 }] },
};
const withDiff: PreviewFile = {
  key: 'a',
  path: 'a.md',
  gitDiff: diff,
};
const noDiff1: PreviewFile = { key: 'b', path: 'b.md' };
const noDiff2: PreviewFile = { key: 'c', path: 'c.md' };

const Harness: React.FC<{ files: PreviewFile[]; initial: string; onClose?: () => void }> = ({
  files,
  initial,
  onClose = () => undefined,
}) => {
  const [key, setKey] = React.useState(initial);
  return (
    <FilePreview files={files} activeKey={key} cwd="/w" onActiveKey={setKey} onClose={onClose} />
  );
};

beforeEach(() => {
  vi.mocked(harnessClient.workspaceRead).mockResolvedValue({ ok: true, content: 'body' });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('FilePreview 跨文件切换', () => {
  it('从「预览」切到没有 diff 的另一个文件：每个文件只读一次盘（不为旧模式多读一次）', async () => {
    render(<Harness files={[noDiff1, noDiff2]} initial="b" />);
    await waitFor(() => expect(harnessClient.workspaceRead).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByTestId('preview-mode-render'));
    await waitFor(() => expect(harnessClient.workspaceRead).toHaveBeenCalledTimes(2));
    vi.mocked(harnessClient.workspaceRead).mockClear();
    fireEvent.click(screen.getByTestId('preview-next'));
    await waitFor(() => expect(harnessClient.workspaceRead).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 30));
    expect(harnessClient.workspaceRead).toHaveBeenCalledTimes(1);
    expect(harnessClient.workspaceRead).toHaveBeenCalledWith('/w', 'c.md');
  });

  it('从「编辑」切到有 diff 的文件：直接看 diff，不读盘', async () => {
    render(<Harness files={[noDiff1, withDiff]} initial="b" />);
    await waitFor(() => expect(harnessClient.workspaceRead).toHaveBeenCalledTimes(1));
    vi.mocked(harnessClient.workspaceRead).mockClear();
    fireEvent.click(screen.getByTestId('preview-next'));
    await screen.findByTestId('preview-diff-body');
    await new Promise((r) => setTimeout(r, 30));
    expect(harnessClient.workspaceRead).not.toHaveBeenCalled();
  });

  it('切文件取消待确认的丢弃', async () => {
    const change = {
      file: 'a.md',
      added: 1,
      removed: 0,
      status: 'modified' as const,
      letter: 'M',
      diff,
      messageId: 'm',
    };
    render(<Harness files={[{ ...withDiff, change }, noDiff1]} initial="a" />);
    fireEvent.click(screen.getByTestId('preview-discard'));
    expect(screen.getByTestId('preview-discard-confirm')).toBeTruthy();
    fireEvent.click(screen.getByTestId('preview-next'));
    await waitFor(() => expect(screen.queryByTestId('preview-discard-confirm')).toBeNull());
  });
});

describe('Esc 不被聊天输入框触发', () => {
  it('预览之外的输入框里按 Esc：不关预览；预览自己的编辑框 / 非输入处按 Esc：关闭', async () => {
    const onClose = vi.fn();
    render(
      <>
        <textarea data-testid="chat-input" />
        <Harness files={[noDiff1]} initial="b" onClose={onClose} />
      </>,
    );
    const ta = await screen.findByTestId('preview-editor');
    fireEvent.keyDown(screen.getByTestId('chat-input'), { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(ta, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('shouldIgnoreEscape：已处理 / 输入法组词 / 外部可编辑控件', () => {
    const input = document.createElement('input');
    const div = document.createElement('div');
    expect(shouldIgnoreEscape({ defaultPrevented: true, isComposing: false, target: div })).toBe(
      true,
    );
    expect(shouldIgnoreEscape({ defaultPrevented: false, isComposing: true, target: div })).toBe(
      true,
    );
    expect(shouldIgnoreEscape({ defaultPrevented: false, isComposing: false, target: input })).toBe(
      true,
    );
    expect(
      shouldIgnoreEscape(
        { defaultPrevented: false, isComposing: false, target: input },
        () => true,
      ),
    ).toBe(false);
    expect(shouldIgnoreEscape({ defaultPrevented: false, isComposing: false, target: div })).toBe(
      false,
    );
  });
});
