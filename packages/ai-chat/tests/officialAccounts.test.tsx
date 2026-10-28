// @vitest-environment happy-dom
import { ContractError } from '@nomi-ai/contract';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { OfficialAccounts } from '../src/components/ProvidersPage/OfficialAccounts';

import { installFakeApi, resetFakeApi } from './helpers/fakeApi';

vi.mock('../src/services/api', async () => (await import('./helpers/fakeApi')).fakeApiModule());

vi.mock('../src/components/ConfirmDialog', () => import('./helpers/confirmViaWindow'));

// 官方账号（docs/design/cli-plugin-architecture.md §5.10）：一个账号 = 一个 CLI 配置目录
afterEach(() => {
  cleanup();
  resetFakeApi();
});

const acct = (o: Record<string, unknown>) => ({
  kind: 'codex',
  identity: null,
  active: false,
  local: false,
  loggedIn: true,
  inUse: 0,
  createdAt: 1,
  ...o,
});

type Handler = (i: any) => unknown;

function mockIpc(over: Record<string, Handler> = {}) {
  let accounts = [
    acct({
      id: 'local-codex',
      label: '本机登录',
      local: true,
      active: true,
      identity: { key: 'kl', email: 'me@x.com', plan: 'plus' },
    }),
    acct({ id: 'b', label: 'b@x.com', identity: { key: 'kb', email: 'b@x.com' }, inUse: 2 }),
    acct({ id: 'c', label: '工作', loggedIn: false, needsLogin: true }),
  ];
  const handlers: Record<string, Handler> = {
    'cliAccount.list': () => accounts,
    'cliAccount.refresh': () => accounts,
    'cliAccount.setDefault': ({ id }) => {
      accounts = accounts.map((x) => ({ ...x, active: x.id === id }));
      return accounts.find((x) => x.id === id);
    },
    'cliAccount.remove': ({ id }) => {
      accounts = accounts.filter((x) => x.id !== id);
      return undefined;
    },
    'cliAccount.loginStart': () => ({ id: 'L1', kind: 'codex', state: 'starting' }),
    'cliAccount.loginInput': () => true,
    'cliAccount.loginCancel': () => true,
    'cliAccount.openUrl': () => true,
    ...over,
  };
  const invoke = vi.fn(async (ch: string, i?: unknown) => handlers[ch]?.(i));
  const fake = installFakeApi(invoke);
  return { invoke, emit: (ch: string, p: unknown) => fake.emit(ch, p) };
}

describe('OfficialAccounts', () => {
  it('列出账号：默认 / 本机 / 套餐 / 在用标签数 / 需要重新登录；打开时用 CLI 状态命令刷新身份', async () => {
    const ipc = mockIpc();
    const r = render(<OfficialAccounts kind="codex" />);
    await waitFor(() => expect(r.getAllByTestId('cli-account-card')).toHaveLength(3));
    expect(ipc.invoke).toHaveBeenCalledWith('cliAccount.refresh', { kind: 'codex' });
    expect(r.getByTestId('cli-account-current')).toBeTruthy();
    expect(r.getByText('plus')).toBeTruthy();
    expect(r.getByText('2 个标签在用')).toBeTruthy();
    expect(r.getByTestId('cli-account-needs-login')).toBeTruthy();
    // 本机登录不能删
    expect(r.getAllByTestId('cli-account-remove')).toHaveLength(2);
  });

  it('设为默认：调用 set-default，成功提示；失败时显示主进程给的原因', async () => {
    const ipc = mockIpc();
    const r = render(<OfficialAccounts kind="codex" />);
    await waitFor(() => expect(r.getAllByTestId('cli-account-activate')).toHaveLength(2));
    await act(async () => fireEvent.click(r.getAllByTestId('cli-account-activate')[0]!));
    expect(ipc.invoke).toHaveBeenCalledWith('cliAccount.setDefault', { kind: 'codex', id: 'b' });
    await waitFor(() => expect(r.getByTestId('cli-accounts-msg').textContent).toContain('b@x.com'));

    cleanup();
    mockIpc({
      'cliAccount.setDefault': () => {
        throw new ContractError('ACCOUNT_NOT_FOUND', '账号不存在');
      },
    });
    const r2 = render(<OfficialAccounts kind="codex" />);
    await waitFor(() => r2.getAllByTestId('cli-account-activate'));
    await act(async () => fireEvent.click(r2.getAllByTestId('cli-account-activate')[0]!));
    await waitFor(() =>
      expect(r2.getByTestId('cli-accounts-msg').textContent).toContain('账号不存在'),
    );
  });

  it('需要重新登录的账号：在它自己的目录里登录（带账号 id）', async () => {
    const ipc = mockIpc();
    const r = render(<OfficialAccounts kind="codex" />);
    await waitFor(() => r.getByTestId('cli-account-login'));
    await act(async () => fireEvent.click(r.getByTestId('cli-account-login')));
    expect(ipc.invoke).toHaveBeenCalledWith('cliAccount.loginStart', {
      kind: 'codex',
      accountId: 'c',
    });
  });

  it('删除：确认后调用 remove', async () => {
    const ipc = mockIpc();
    const confirm = vi.fn(() => true);
    (window as unknown as { confirm: typeof confirm }).confirm = confirm;
    const r = render(<OfficialAccounts kind="codex" />);
    await waitFor(() => expect(r.getAllByTestId('cli-account-remove')).toHaveLength(2));
    await act(async () => fireEvent.click(r.getAllByTestId('cli-account-remove')[0]!));
    expect(String((confirm.mock.calls[0] as unknown[])[0])).toContain('登出');
    expect(ipc.invoke).toHaveBeenCalledWith('cliAccount.remove', { id: 'b', force: false });
  });

  it('删除时无法确认外部 CLI 是否在用（unknown-live）：英文文案下也再确认一次，确认后只强制删除一次（#137）', async () => {
    const calls: unknown[][] = [];
    const ipc = mockIpc({
      'cliAccount.remove': ({ id, force }) => {
        calls.push([id, force]);
        if (force === true) return undefined;
        throw new ContractError(
          'ACCOUNT_UNKNOWN_LIVE',
          'Could not confirm whether a CLI is still using this account. If you are sure, confirm to force-delete it.',
        );
      },
    });
    const confirm = vi.fn(() => true);
    (window as unknown as { confirm: typeof confirm }).confirm = confirm;
    const r = render(<OfficialAccounts kind="codex" />);
    await waitFor(() => expect(r.getAllByTestId('cli-account-remove')).toHaveLength(2));
    await act(async () => fireEvent.click(r.getAllByTestId('cli-account-remove')[0]!));
    await waitFor(() =>
      expect(calls).toEqual([
        ['b', false],
        ['b', true],
      ]),
    );
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(ipc.invoke).toHaveBeenCalledWith('cliAccount.remove', { id: 'b', force: true });
  });

  it('删除：第二次确认取消、或者是别的错误（在用）都不强制删除', async () => {
    const calls: unknown[][] = [];
    mockIpc({
      'cliAccount.remove': ({ id, force }) => {
        calls.push([id, force]);
        throw new ContractError('ACCOUNT_UNKNOWN_LIVE', 'Could not confirm');
      },
    });
    let n = 0;
    (window as unknown as { confirm: () => boolean }).confirm = () => n++ === 0;
    const r = render(<OfficialAccounts kind="codex" />);
    await waitFor(() => expect(r.getAllByTestId('cli-account-remove')).toHaveLength(2));
    await act(async () => fireEvent.click(r.getAllByTestId('cli-account-remove')[0]!));
    await waitFor(() => expect(calls).toEqual([['b', false]]));

    cleanup();
    calls.length = 0;
    mockIpc({
      'cliAccount.remove': ({ id, force }) => {
        calls.push([id, force]);
        throw new ContractError('ACCOUNT_IN_USE', 'unknown error, force delete?');
      },
    });
    (window as unknown as { confirm: () => boolean }).confirm = () => true;
    const r2 = render(<OfficialAccounts kind="codex" />);
    await waitFor(() => expect(r2.getAllByTestId('cli-account-remove')).toHaveLength(2));
    await act(async () => fireEvent.click(r2.getAllByTestId('cli-account-remove')[0]!));
    await waitFor(() => expect(r2.getByTestId('cli-accounts-msg')).toBeTruthy());
    expect(calls).toEqual([['b', false]]);
  });

  it('同一身份登录在两处：给出提示', async () => {
    mockIpc({
      'cliAccount.list': () => [acct({ id: 'x', label: 'x', duplicateOf: '本机登录' })],
      'cliAccount.refresh': () => [acct({ id: 'x', label: 'x', duplicateOf: '本机登录' })],
    });
    const r = render(<OfficialAccounts kind="codex" />);
    await waitFor(() =>
      expect(r.getByTestId('cli-account-duplicate').textContent).toContain('本机登录'),
    );
  });

  it('设备码登录：弹窗显示一次性码与打开登录页；完成后提示', async () => {
    const ipc = mockIpc();
    const r = render(<OfficialAccounts kind="codex" />);
    await waitFor(() => r.getByTestId('cli-accounts-add'));
    await act(async () => fireEvent.click(r.getByTestId('cli-accounts-add')));
    expect(ipc.invoke).toHaveBeenCalledWith('cliAccount.loginStart', { kind: 'codex' });
    await act(() =>
      ipc.emit('cliAccount.login', {
        id: 'L1',
        kind: 'codex',
        state: 'waiting',
        url: 'https://auth.openai.com/codex/device',
        code: 'ABCD-12345',
        needsCode: false,
      }),
    );
    expect(r.getByTestId('cli-account-code').textContent).toBe('ABCD-12345');
    await act(async () => fireEvent.click(r.getByTestId('cli-account-open-url')));
    expect(ipc.invoke).toHaveBeenCalledWith('cliAccount.openUrl', {
      url: 'https://auth.openai.com/codex/device',
    });
    await act(() =>
      ipc.emit('cliAccount.login', {
        id: 'L1',
        kind: 'codex',
        state: 'done',
        account: acct({ id: 'n', label: 'n@x.com', identity: { key: 'kn', email: 'n@x.com' } }),
      }),
    );
    expect(r.getByTestId('cli-account-login-done').textContent).toContain('n@x.com');
  });

  it('Claude：粘贴授权码提交给主进程；关闭未结束的登录会取消它', async () => {
    const ipc = mockIpc({
      'cliAccount.loginStart': () => ({ id: 'L2', kind: 'claude', state: 'starting' }),
    });
    const r = render(<OfficialAccounts kind="claude" />);
    await waitFor(() => r.getByTestId('cli-accounts-add'));
    await act(async () => fireEvent.click(r.getByTestId('cli-accounts-add')));
    await act(() =>
      ipc.emit('cliAccount.login', {
        id: 'L2',
        kind: 'claude',
        state: 'waiting',
        url: 'https://claude.com/cai/oauth/authorize?x=1',
        needsCode: true,
      }),
    );
    fireEvent.change(r.getByTestId('cli-account-paste'), { target: { value: ' CODE-OK ' } });
    await act(async () => fireEvent.submit(r.getByTestId('cli-account-paste').closest('form')!));
    expect(ipc.invoke).toHaveBeenCalledWith('cliAccount.loginInput', { id: 'L2', text: 'CODE-OK' });
    await act(async () => fireEvent.keyDown(document, { key: 'Escape' }));
    expect(ipc.invoke).toHaveBeenCalledWith('cliAccount.loginCancel', { id: 'L2' });
  });
});

describe('OfficialAccounts · Gemini', () => {
  it('登录没有链接和码：显示主进程给的「去浏览器完成」提示', async () => {
    const ipc = mockIpc({
      'cliAccount.list': () => [],
      'cliAccount.refresh': () => [],
      'cliAccount.loginStart': () => ({ id: 'G1', kind: 'gemini', state: 'starting' }),
    });
    const r = render(<OfficialAccounts kind="gemini" />);
    await waitFor(() => r.getByTestId('cli-accounts-empty'));
    fireEvent.click(r.getByTestId('cli-accounts-add'));
    await waitFor(() => r.getByTestId('cli-account-login'));
    await act(() =>
      ipc.emit('cliAccount.login', {
        id: 'G1',
        kind: 'gemini',
        state: 'waiting',
        message: '已在浏览器里打开 Google 登录页',
      }),
    );
    await waitFor(() =>
      expect(r.getByTestId('cli-account-waiting').textContent).toContain('Google'),
    );
    expect(r.queryByTestId('cli-account-open-url')).toBeNull();
    expect(ipc.invoke).toHaveBeenCalledWith('cliAccount.loginStart', { kind: 'gemini' });
  });
});
