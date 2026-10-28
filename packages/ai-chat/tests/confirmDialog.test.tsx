// @vitest-environment happy-dom
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import {
  confirmDialog,
  promptDialog,
  resetConfirmDialogForTest,
} from '../src/components/ConfirmDialog';

afterEach(() => {
  act(() => resetConfirmDialogForTest());
});

/**
 * 在 act 里发起：宿主是第一次调用时另建的 React root，act 结束时同步提交它的渲染。不包的话渲染排在
 * React 的调度器里，全量并行时可能晚于 findBy* 的 1 秒等待
 */
function open<T>(start: () => Promise<T>): Promise<T> {
  let pending!: Promise<T>;
  act(() => {
    pending = start();
  });
  return pending;
}

describe('confirmDialog (in-app, not window.confirm)', () => {
  it('resolves true on confirm and false on cancel / Esc', async () => {
    let p = open(() => confirmDialog({ title: '删除「a」？', message: '说明', danger: true }));
    expect((await screen.findByTestId('confirm-dialog')).textContent).toContain('删除「a」？');
    fireEvent.click(screen.getByTestId('confirm-dialog-ok'));
    await expect(p).resolves.toBe(true);
    await waitFor(() => expect(screen.queryByTestId('confirm-dialog')).toBeNull());

    p = open(() => confirmDialog({ title: 'b' }));
    fireEvent.click(await screen.findByTestId('confirm-dialog-cancel'));
    await expect(p).resolves.toBe(false);

    p = open(() => confirmDialog({ title: 'c' }));
    await screen.findByTestId('confirm-dialog');
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    await expect(p).resolves.toBe(false);
  });

  it('queues concurrent requests and shows them one after another', async () => {
    const first = open(() => confirmDialog({ title: 'first' }));
    const second = open(() => confirmDialog({ title: 'second' }));
    expect((await screen.findByTestId('confirm-dialog')).textContent).toContain('first');
    fireEvent.click(screen.getByTestId('confirm-dialog-ok'));
    await expect(first).resolves.toBe(true);
    await waitFor(() =>
      expect(screen.getByTestId('confirm-dialog').textContent).toContain('second'),
    );
    fireEvent.click(screen.getByTestId('confirm-dialog-cancel'));
    await expect(second).resolves.toBe(false);
  });
});

describe('promptDialog (in-app, not window.prompt)', () => {
  it('prefills the value, resolves the edited text on OK / Enter and null on cancel', async () => {
    let p = open(() => promptDialog({ title: '账号名称', defaultValue: 'work' }));
    const input = (await screen.findByTestId('confirm-dialog-input')) as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe('work'));
    fireEvent.change(input, { target: { value: 'personal' } });
    fireEvent.click(screen.getByTestId('confirm-dialog-ok'));
    await expect(p).resolves.toBe('personal');

    p = open(() => promptDialog({ title: '账号名称', defaultValue: 'x' }));
    const again = (await screen.findByTestId('confirm-dialog-input')) as HTMLInputElement;
    fireEvent.change(again, { target: { value: 'via enter' } });
    fireEvent.submit(again.closest('form')!);
    await expect(p).resolves.toBe('via enter');

    p = open(() => promptDialog({ title: '账号名称' }));
    fireEvent.click(await screen.findByTestId('confirm-dialog-cancel'));
    await expect(p).resolves.toBeNull();
  });
});
