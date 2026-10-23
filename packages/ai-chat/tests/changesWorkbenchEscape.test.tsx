// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ChangesUiProvider,
  CenterChangesHost,
  ChangesWorkbenchHost,
  useChangesUi,
} from '../src/components/SessionWorkspace';

afterEach(() => cleanup());

const Opener: React.FC = () => {
  const { openDetail } = useChangesUi();
  return (
    <button type="button" data-testid="open" onClick={() => openDetail({})}>
      open
    </button>
  );
};

describe('全屏审查 Esc', () => {
  it('Esc 只关全屏审查本身，不会传给 window 上其它的 Esc 监听（中栏 Diff / 文件预览）', () => {
    const behind = vi.fn();
    window.addEventListener('keydown', behind);
    try {
      render(
        <ChangesUiProvider>
          <Opener />
          <ChangesWorkbenchHost messages={[]} cwd="/tmp/p" />
        </ChangesUiProvider>,
      );
      fireEvent.click(screen.getByTestId('open'));
      expect(screen.getByTestId('changes-workbench')).toBeTruthy();

      act(() => {
        fireEvent.keyDown(window, { key: 'Escape' });
      });
      expect(screen.queryByTestId('changes-workbench')).toBeNull();
      expect(behind).not.toHaveBeenCalled();

      // 关掉之后，Esc 恢复正常传播
      act(() => {
        fireEvent.keyDown(window, { key: 'Escape' });
      });
      expect(behind).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener('keydown', behind);
    }
  });
});

const CenterOpener: React.FC = () => {
  const { openWorkbench } = useChangesUi();
  return (
    <button type="button" data-testid="open" onClick={() => openWorkbench({})}>
      open
    </button>
  );
};

describe('中栏 Diff 的 Esc', () => {
  it('聊天输入框里按 Esc 不关中栏 Diff；在别处按 Esc 仍然关闭', () => {
    render(
      <ChangesUiProvider>
        <CenterOpener />
        <textarea data-testid="chat-input" />
        <CenterChangesHost messages={[]} cwd="/tmp/p" />
      </ChangesUiProvider>,
    );
    fireEvent.click(screen.getByTestId('open'));
    expect(screen.getByTestId('center-changes-pane')).toBeTruthy();

    act(() => {
      fireEvent.keyDown(screen.getByTestId('chat-input'), { key: 'Escape' });
    });
    expect(screen.getByTestId('center-changes-pane')).toBeTruthy();

    act(() => {
      fireEvent.keyDown(document.body, { key: 'Escape' });
    });
    expect(screen.queryByTestId('center-changes-pane')).toBeNull();
  });
});
