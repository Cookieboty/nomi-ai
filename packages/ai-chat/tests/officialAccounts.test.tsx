// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { OfficialAccounts } from '../src/components/ProvidersPage/OfficialAccounts';

// 官方账号（docs/design/cli-plugin-architecture.md §5.10）：一个账号 = 一个 CLI 配置目录
afterEach(() => {
  cleanup();
  delete (window as { aiIPC?: unknown }).aiIPC;
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

function mockIpc(over: Record<string, (...a: unknown[]) => unknown> = {}) {
  const listeners: Record<string, Array<(p: unknown) => void>> = {};
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
  const handlers: Record<string, (...a: unknown[]) => unknown> = {
    'ai:cli-account:list': () => accounts,
    'ai:cli-account:refresh': () => accounts,
    'ai:cli-account:set-default': (_k, id) => {
      accounts = accounts.map((x) => ({ ...x, active: x.id === id }));
      return accounts.find((x) => x.id === id);
    },
    'ai:cli-account:remove': (id) => {
      accounts = accounts.filter((x) => x.id !== id);
      return undefined;
    },
    'ai:cli-account:login-start': () => ({ id: 'L1', kind: 'codex', state: 'starting' }),
    'ai:cli-account:login-input': () => true,
    'ai:cli-account:login-cancel': () => true,
    'ai:cli-account:open-url': () => true,
    ...over,
  };
  const invoke = vi.fn(async (ch: string, ...a: unknown[]) => handlers[ch]?.(...a));
  (window as unknown as { aiIPC: unknown }).aiIPC = {
    invoke,
    on: (ch: string, fn: (p: unknown) => void) => {
      (listeners[ch] ??= []).push(fn);
      return () => undefined;
    },
  };
  return { invoke, emit: (ch: string, p: unknown) => listeners[ch]?.forEach((f) => f(p)) };
}

describe('OfficialAccounts', () => {
  it('列出账号：默认 / 本机 / 套餐 / 在用标签数 / 需要重新登录；打开时用 CLI 状态命令刷新身份', async () => {
    const ipc = mockIpc();
    const r = render(<OfficialAccounts kind="codex" />);
    await waitFor(() => expect(r.getAllByTestId('cli-account-card')).toHaveLength(3));
    expect(ipc.invoke).toHaveBeenCalledWith('ai:cli-account:refresh', 'codex');
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
    expect(ipc.invoke).toHaveBeenCalledWith('ai:cli-account:set-default', 'codex', 'b');
    await waitFor(() => expect(r.getByTestId('cli-accounts-msg').textContent).toContain('b@x.com'));

    cleanup();
    mockIpc({ 'ai:cli-account:set-default': () => ({ __error: { message: '账号不存在' } }) });
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
    expect(ipc.invoke).toHaveBeenCalledWith('ai:cli-account:login-start', 'codex', 'c');
  });

  it('删除：确认后调用 remove', async () => {
    const ipc = mockIpc();
    const confirm = vi.fn(() => true);
    (window as unknown as { confirm: typeof confirm }).confirm = confirm;
    const r = render(<OfficialAccounts kind="codex" />);
    await waitFor(() => expect(r.getAllByTestId('cli-account-remove')).toHaveLength(2));
    await act(async () => fireEvent.click(r.getAllByTestId('cli-account-remove')[0]!));
    expect(String((confirm.mock.calls[0] as unknown[])[0])).toContain('登出');
    expect(ipc.invoke).toHaveBeenCalledWith('ai:cli-account:remove', 'b');
  });

  it('同一身份登录在两处：给出提示', async () => {
    mockIpc({
      'ai:cli-account:list': () => [acct({ id: 'x', label: 'x', duplicateOf: '本机登录' })],
      'ai:cli-account:refresh': () => [acct({ id: 'x', label: 'x', duplicateOf: '本机登录' })],
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
    expect(ipc.invoke).toHaveBeenCalledWith('ai:cli-account:login-start', 'codex', undefined);
    act(() =>
      ipc.emit('ai:cli-account:login', {
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
    expect(ipc.invoke).toHaveBeenCalledWith(
      'ai:cli-account:open-url',
      'https://auth.openai.com/codex/device',
    );
    act(() =>
      ipc.emit('ai:cli-account:login', {
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
      'ai:cli-account:login-start': () => ({ id: 'L2', kind: 'claude', state: 'starting' }),
    });
    const r = render(<OfficialAccounts kind="claude" />);
    await waitFor(() => r.getByTestId('cli-accounts-add'));
    await act(async () => fireEvent.click(r.getByTestId('cli-accounts-add')));
    act(() =>
      ipc.emit('ai:cli-account:login', {
        id: 'L2',
        kind: 'claude',
        state: 'waiting',
        url: 'https://claude.com/cai/oauth/authorize?x=1',
        needsCode: true,
      }),
    );
    fireEvent.change(r.getByTestId('cli-account-paste'), { target: { value: ' CODE-OK ' } });
    await act(async () => fireEvent.submit(r.getByTestId('cli-account-paste').closest('form')!));
    expect(ipc.invoke).toHaveBeenCalledWith('ai:cli-account:login-input', 'L2', 'CODE-OK');
    await act(async () => fireEvent.keyDown(document, { key: 'Escape' }));
    expect(ipc.invoke).toHaveBeenCalledWith('ai:cli-account:login-cancel', 'L2');
  });
});

describe('OfficialAccounts · Gemini', () => {
  it('登录没有链接和码：显示主进程给的「去浏览器完成」提示', async () => {
    const ipc = mockIpc({
      'ai:cli-account:list': () => [],
      'ai:cli-account:refresh': () => [],
      'ai:cli-account:login-start': () => ({ id: 'G1', kind: 'gemini', state: 'starting' }),
    });
    const r = render(<OfficialAccounts kind="gemini" />);
    await waitFor(() => r.getByTestId('cli-accounts-empty'));
    fireEvent.click(r.getByTestId('cli-accounts-add'));
    await waitFor(() => r.getByTestId('cli-account-login'));
    act(() =>
      ipc.emit('ai:cli-account:login', {
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
    expect(ipc.invoke).toHaveBeenCalledWith('ai:cli-account:login-start', 'gemini', undefined);
  });
});
