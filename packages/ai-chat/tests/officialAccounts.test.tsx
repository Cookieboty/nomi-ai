// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { OfficialAccounts } from '../src/components/ProvidersPage/OfficialAccounts';

// 官方账号（docs/design/cli-official-accounts.md §6）
afterEach(() => {
  cleanup();
  delete (window as { aiIPC?: unknown }).aiIPC;
});

function mockIpc(over: Record<string, (...a: unknown[]) => unknown> = {}) {
  const listeners: Record<string, Array<(p: unknown) => void>> = {};
  let accounts = [
    {
      id: 'a',
      kind: 'codex',
      label: 'a@x.com',
      identity: { key: 'ka', email: 'a@x.com', plan: 'plus' },
      active: true,
      createdAt: 1,
    },
    {
      id: 'b',
      kind: 'codex',
      label: 'b@x.com',
      identity: { key: 'kb', email: 'b@x.com' },
      active: false,
      createdAt: 2,
    },
  ];
  let live: unknown = { key: 'kc', email: 'c@x.com' };
  const handlers: Record<string, (...a: unknown[]) => unknown> = {
    'ai:cli-account:list': () => accounts,
    'ai:cli-account:live': () => live,
    'ai:cli-account:activate': (id) => {
      accounts = accounts.map((x) => ({ ...x, active: x.id === id }));
      return accounts.find((x) => x.id === id);
    },
    'ai:cli-account:import-current': () => {
      accounts = [
        ...accounts,
        {
          id: 'c',
          kind: 'codex',
          label: 'c@x.com',
          identity: { key: 'kc', email: 'c@x.com' },
          active: true,
          createdAt: 3,
        },
      ];
      return accounts[2];
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
  return {
    invoke,
    emit: (ch: string, p: unknown) => listeners[ch]?.forEach((f) => f(p)),
    setLive: (v: unknown) => (live = v),
  };
}

describe('OfficialAccounts', () => {
  it('列出账号（当前标记 / 套餐）、终端当前登录；终端账号不在列表里时可导入', async () => {
    const ipc = mockIpc();
    const r = render(<OfficialAccounts kind="codex" />);
    await waitFor(() => expect(r.getAllByTestId('cli-account-card')).toHaveLength(2));
    expect(r.getByTestId('cli-accounts-live').textContent).toContain('c@x.com');
    expect(r.getByTestId('cli-account-current')).toBeTruthy();
    expect(r.getByText('plus')).toBeTruthy();
    await act(async () => fireEvent.click(r.getByTestId('cli-accounts-import')));
    await waitFor(() => expect(r.getAllByTestId('cli-account-card')).toHaveLength(3));
    expect(ipc.invoke).toHaveBeenCalledWith('ai:cli-account:import-current', 'codex');
    expect(r.queryByTestId('cli-accounts-import')).toBeNull();
  });

  it('切换：调用 activate，成功提示；失败时显示主进程给的原因', async () => {
    const ipc = mockIpc();
    const r = render(<OfficialAccounts kind="codex" />);
    await waitFor(() => r.getByTestId('cli-account-activate'));
    await act(async () => fireEvent.click(r.getByTestId('cli-account-activate')));
    expect(ipc.invoke).toHaveBeenCalledWith('ai:cli-account:activate', 'b', 'codex');
    await waitFor(() => expect(r.getByTestId('cli-accounts-msg').textContent).toContain('b@x.com'));

    cleanup();
    mockIpc({
      'ai:cli-account:activate': () => ({
        __error: { message: 'Codex 把登录凭据存在系统钥匙串里' },
      }),
    });
    const r2 = render(<OfficialAccounts kind="codex" />);
    await waitFor(() => r2.getByTestId('cli-account-activate'));
    await act(async () => fireEvent.click(r2.getByTestId('cli-account-activate')));
    await waitFor(() => expect(r2.getByTestId('cli-accounts-msg').textContent).toContain('钥匙串'));
  });

  it('设备码登录：弹窗显示一次性码与打开登录页；完成后提示并刷新', async () => {
    const ipc = mockIpc();
    const r = render(<OfficialAccounts kind="codex" />);
    await waitFor(() => r.getByTestId('cli-accounts-add'));
    await act(async () => fireEvent.click(r.getByTestId('cli-accounts-add')));
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
        account: {
          id: 'n',
          kind: 'codex',
          label: 'n@x.com',
          identity: { key: 'kn', email: 'n@x.com' },
          active: false,
          createdAt: 9,
        },
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
      'ai:cli-account:live': () => null,
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
    expect(ipc.invoke).toHaveBeenCalledWith('ai:cli-account:login-start', 'gemini');
  });
});
