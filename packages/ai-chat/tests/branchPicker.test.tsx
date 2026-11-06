// @vitest-environment happy-dom
/** 分支切换器：列出本地分支、切换、新建并检出；git 拒绝（有会被覆盖的改动等）时把原因留在菜单里 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BranchPicker } from '../src/components/BranchPicker';
import { resetConfirmDialogForTest } from '../src/components/ConfirmDialog';
import { GIT_BRANCH_CHANGED_EVENT } from '../src/services/gitEvents';

import { installFakeApi, resetFakeApi } from './helpers/fakeApi';

vi.mock('../src/services/api', async () => (await import('./helpers/fakeApi')).fakeApiModule());

type Input = { cwd?: string; branch?: string; create?: boolean };
let checkout: (i: Input) => unknown = () => ({ ok: true });
const calls: Array<[string, Input]> = [];

beforeEach(() => {
  calls.length = 0;
  checkout = () => ({ ok: true });
  installFakeApi(
    vi.fn(async (ch: string, input?: Input) => {
      calls.push([ch, input ?? {}]);
      if (ch === 'harness.gitBranches')
        return { current: 'feat/subagents', branches: ['feat/subagents', 'master', 'feat/model'] };
      if (ch === 'harness.gitCheckout') return checkout(input ?? {});
      return {};
    }),
  );
});
afterEach(() => {
  cleanup();
  resetConfirmDialogForTest();
  resetFakeApi();
});

const mount = (onSwitched = vi.fn()) =>
  render(<BranchPicker cwd="/w/share-harness" branch="feat/subagents" onSwitched={onSwitched} />);

describe('BranchPicker', () => {
  it('列出分支（当前打勾），能搜索；点别的分支就切过去并广播刷新', async () => {
    const onSwitched = vi.fn();
    const changed = vi.fn();
    window.addEventListener(GIT_BRANCH_CHANGED_EVENT, changed);
    const r = mount(onSwitched);
    fireEvent.click(r.getByTestId('branch-picker-button'));
    await waitFor(() => expect(screen.getAllByTestId('branch-item')).toHaveLength(3));
    const current = screen.getAllByTestId('branch-item')[0]!;
    expect(current.getAttribute('aria-checked')).toBe('true');
    expect((screen.getByTestId('branch-picker-search') as HTMLInputElement).placeholder).toContain(
      'share-harness',
    );

    fireEvent.change(screen.getByTestId('branch-picker-search'), { target: { value: 'mas' } });
    expect(screen.getAllByTestId('branch-item').map((x) => x.textContent)).toEqual(['master']);
    fireEvent.click(screen.getByTestId('branch-item'));
    await waitFor(() =>
      expect(calls).toContainEqual([
        'harness.gitCheckout',
        { cwd: '/w/share-harness', branch: 'master', create: false },
      ]),
    );
    await waitFor(() => expect(onSwitched).toHaveBeenCalledWith('master'));
    expect(changed).toHaveBeenCalled();
    expect(screen.queryByTestId('branch-picker-menu')).toBeNull();
    window.removeEventListener(GIT_BRANCH_CHANGED_EVENT, changed);
  });

  it('有会被覆盖的改动：不切换，菜单里说明原因', async () => {
    checkout = () => ({ ok: false, code: 'dirty' });
    const onSwitched = vi.fn();
    const r = mount(onSwitched);
    fireEvent.click(r.getByTestId('branch-picker-button'));
    fireEvent.click((await screen.findAllByTestId('branch-item'))[1]!);
    expect((await screen.findByTestId('branch-picker-error')).textContent).toContain('先提交');
    expect(onSwitched).not.toHaveBeenCalled();
  });

  it('创建并检出新分支：输入名字后以 create 切过去', async () => {
    const r = mount();
    fireEvent.click(r.getByTestId('branch-picker-button'));
    fireEvent.change(await screen.findByTestId('branch-picker-search'), {
      target: { value: 'feat/new' },
    });
    fireEvent.click(screen.getByTestId('branch-picker-create'));
    const input = (await screen.findByTestId('confirm-dialog')).querySelector('input')!;
    expect(input.value).toBe('feat/new');
    fireEvent.click(screen.getByTestId('confirm-dialog-ok'));
    await waitFor(() =>
      expect(calls).toContainEqual([
        'harness.gitCheckout',
        { cwd: '/w/share-harness', branch: 'feat/new', create: true },
      ]),
    );
  });
});
