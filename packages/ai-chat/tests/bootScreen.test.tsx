// @vitest-environment happy-dom
/** 对话窗口的启动画面：载入 / 导入进度 / 读不到时的错误与重试（不显示空列表） */
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BootScreen } from '../src/components/BootScreen';

afterEach(cleanup);

describe('BootScreen', () => {
  it('shows a status while loading and the import progress', () => {
    const r = render(<BootScreen state={{ kind: 'loading' }} />);
    expect(r.getByTestId('boot-loading')).toBeTruthy();
    r.rerender(<BootScreen state={{ kind: 'migrating', done: 3, total: 10 }} />);
    expect(r.getByTestId('boot-loading').textContent).toContain('3');
    expect(r.getByTestId('boot-loading').textContent).toContain('10');
    expect(r.queryByTestId('boot-error')).toBeNull();
  });

  it('shows an error with retry instead of an empty list when the history cannot be read', () => {
    const onRetry = vi.fn();
    const r = render(<BootScreen state={{ kind: 'failed' }} onRetry={onRetry} />);
    expect(r.getByRole('alert')).toBeTruthy();
    fireEvent.click(r.getByTestId('boot-retry'));
    expect(onRetry).toHaveBeenCalledTimes(1);
    r.rerender(<BootScreen state={{ kind: 'failed', retrying: true }} onRetry={onRetry} />);
    expect((r.getByTestId('boot-retry') as HTMLButtonElement).disabled).toBe(true);
  });
});
