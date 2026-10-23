// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ChangesUiProvider,
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
