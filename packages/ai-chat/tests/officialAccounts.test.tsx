// @vitest-environment happy-dom
import { ContractError } from '@nomi-ai/contract';
import { ModalHostContext } from '@nomi-ai/ui';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { OfficialAccounts } from '../src/components/ProvidersPage/OfficialAccounts';

import { installFakeApi, resetFakeApi } from './helpers/fakeApi';

vi.mock('../src/services/api', async () => (await import('./helpers/fakeApi')).fakeApiModule());

vi.mock('../src/components/ConfirmDialog', () => import('./helpers/confirmViaWindow'));

// 官方账号（docs/development/coding-agents.md）：一个账号 = 一个 CLI 配置目录
afterEach(() => {
  cleanup();
  resetFakeApi();
});

const acct = (o: Record<string, unknown>) => ({
  kind: 'codex',
  identity: null,
  active: false,
  loggedIn: true,
  inUse: 0,
  createdAt: 1,
  ...o,
});

type Handler = (i: any) => unknown;

function mockIpc(over: Record<string, Handler> = {}) {
  // 只有 Nomi 管理的官方账号（没有「本机登录」这一行）
  let accounts = [
    acct({ id: 'b', label: 'b@x.com', identity: { key: 'kb', email: 'b@x.com' }, inUse: 2 }),
    acct({ id: 'c', label: '工作', loggedIn: false, needsLogin: true }),
    acct({
      id: 'a',
      label: '个人',
      active: true,
      identity: { key: 'ka', email: 'me@x.com', plan: 'plus' },
    }),
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
  it('列出账号：默认 / 套餐 / 在用标签数 / 需要重新登录；没有「本机登录」；打开时用 CLI 状态命令刷新身份', async () => {
    const ipc = mockIpc();
    const r = render(<OfficialAccounts kind="codex" />);
    await waitFor(() => expect(r.getAllByTestId('cli-account-card')).toHaveLength(3));
    expect(ipc.invoke).toHaveBeenCalledWith('cliAccount.refresh', { kind: 'codex' });
    expect(r.getByTestId('cli-account-current')).toBeTruthy();
    expect(r.getByText('plus')).toBeTruthy();
    expect(r.getByText('2 个标签在用')).toBeTruthy();
    expect(r.getByTestId('cli-account-needs-login')).toBeTruthy();
    // 每个账号都是 Nomi 管理的目录，都能删；没有「本机登录」那一行
    expect(r.getAllByTestId('cli-account-remove')).toHaveLength(3);
    expect(r.queryByText('本机登录')).toBeNull();
    expect(r.queryByText('本机')).toBeNull();
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
    await waitFor(() => expect(r.getAllByTestId('cli-account-remove')).toHaveLength(3));
    await act(async () => fireEvent.click(r.getAllByTestId('cli-account-remove')[0]!));
    expect(String((confirm.mock.calls[0] as unknown[])[0])).toContain('登出');
    expect(ipc.invoke).toHaveBeenCalledWith('cliAccount.remove', { id: 'b', force: false });
  });

  it('删除时无法确认 Nomi 之外的 CLI 进程是否在用（unknown-live）：英文文案下也再确认一次，确认后只强制删除一次（#137）', async () => {
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
    await waitFor(() => expect(r.getAllByTestId('cli-account-remove')).toHaveLength(3));
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

  it('删除时 Nomi 之外还有 CLI 进程在用（external-busy）：说明进程号，确认后让 Nomi 结束它们再删除；不确认就不动', async () => {
    const calls: unknown[][] = [];
    mockIpc({
      'cliAccount.remove': ({ id, force, stopExternal }) => {
        calls.push([id, force, stopExternal]);
        if (stopExternal === true) return undefined;
        throw new ContractError(
          'ACCOUNT_EXTERNAL_BUSY',
          '还有 2 个 Nomi 之外的 CLI 进程在用这个账号（进程号 26348, 26351），请先在终端里退出它们',
        );
      },
    });
    const messages: string[] = [];
    (window as unknown as { confirm: (m: string) => boolean }).confirm = (m: string) => {
      messages.push(String(m));
      return true;
    };
    const r = render(<OfficialAccounts kind="codex" />);
    await waitFor(() => expect(r.getAllByTestId('cli-account-remove')).toHaveLength(3));
    await act(async () => fireEvent.click(r.getAllByTestId('cli-account-remove')[0]!));
    await waitFor(() =>
      expect(calls).toEqual([
        ['b', false, undefined],
        ['b', false, true],
      ]),
    );
    expect(messages[1]).toContain('26348, 26351');
    expect(messages[1]).toContain('结束这些进程');

    cleanup();
    calls.length = 0;
    let n = 0;
    (window as unknown as { confirm: () => boolean }).confirm = () => n++ === 0;
    const r2 = render(<OfficialAccounts kind="codex" />);
    await waitFor(() => expect(r2.getAllByTestId('cli-account-remove')).toHaveLength(3));
    await act(async () => fireEvent.click(r2.getAllByTestId('cli-account-remove')[0]!));
    await waitFor(() => expect(r2.getByTestId('cli-accounts-msg')).toBeTruthy());
    expect(calls).toEqual([['b', false, undefined]]);
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
    await waitFor(() => expect(r.getAllByTestId('cli-account-remove')).toHaveLength(3));
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
    await waitFor(() => expect(r2.getAllByTestId('cli-account-remove')).toHaveLength(3));
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

  it.each(['codex', 'grok'] as const)(
    '%s：设置页内嵌模式下登录仍打开弹窗，Esc 取消登录',
    async (kind) => {
      const ipc = mockIpc({
        'cliAccount.loginStart': () => ({ id: 'L1', kind, state: 'starting' }),
      });
      const r = render(
        <ModalHostContext.Provider value={{ mode: 'inline' }}>
          <OfficialAccounts kind={kind} />
        </ModalHostContext.Provider>,
      );
      await act(async () => fireEvent.click(r.getByTestId('cli-accounts-add')));
      const dialog = r.getByRole('dialog');
      expect(dialog.getAttribute('data-testid')).toBe('cli-account-login');
      expect(dialog.getAttribute('aria-modal')).toBe('true');
      expect(r.getByTestId('cli-account-login-overlay').parentElement).toBe(document.body);
      await act(async () => fireEvent.keyDown(document, { key: 'Escape' }));
      expect(ipc.invoke).toHaveBeenCalledWith('cliAccount.loginCancel', { id: 'L1' });
      expect(r.queryByRole('dialog')).toBeNull();
    },
  );

  it.each(['codex', 'grok'] as const)(
    '%s：拿到设备码后自动打开浏览器一次，重复事件不会再打开',
    async (kind) => {
      const ipc = mockIpc({
        'cliAccount.loginStart': () => ({ id: 'L1', kind, state: 'starting' }),
      });
      const r = render(<OfficialAccounts kind={kind} />);
      await act(async () => fireEvent.click(r.getByTestId('cli-accounts-add')));
      const waiting = {
        id: 'L1',
        kind,
        state: 'waiting',
        url:
          kind === 'codex'
            ? 'https://auth.openai.com/codex/device'
            : 'https://accounts.x.ai/oauth2/device?user_code=ABCD-12345',
        code: 'ABCD-12345',
        needsCode: false,
      };
      await act(() => ipc.emit('cliAccount.login', waiting));
      await act(() => ipc.emit('cliAccount.login', waiting));
      expect(ipc.invoke.mock.calls.filter(([ch]) => ch === 'cliAccount.openUrl')).toEqual([
        ['cliAccount.openUrl', { url: waiting.url }],
      ]);
    },
  );

  it('同一个账号重试登录时仍自动打开新的登录页', async () => {
    const ipc = mockIpc({
      'cliAccount.loginStart': () => ({ id: 'c', kind: 'codex', state: 'starting' }),
    });
    const r = render(<OfficialAccounts kind="codex" />);
    await waitFor(() => r.getByTestId('cli-account-login'));
    await act(async () => fireEvent.click(r.getByTestId('cli-account-login')));
    const waiting = {
      id: 'c',
      kind: 'codex',
      state: 'waiting',
      url: 'https://auth.openai.com/codex/device',
      code: 'TEST-CODE1',
    };
    await act(() => ipc.emit('cliAccount.login', waiting));
    await act(() =>
      ipc.emit('cliAccount.login', {
        id: 'c',
        kind: 'codex',
        state: 'error',
        hint: 'network-blocked',
      }),
    );
    await act(async () => fireEvent.click(r.getByTestId('cli-account-login-retry')));
    await act(() => ipc.emit('cliAccount.login', { ...waiting, code: 'TEST-CODE2' }));
    expect(ipc.invoke.mock.calls.filter(([ch]) => ch === 'cliAccount.openUrl')).toHaveLength(2);
  });

  it('关闭后到达的取消和等待事件不会重新打开空弹窗', async () => {
    const ipc = mockIpc();
    const r = render(<OfficialAccounts kind="codex" />);
    await act(async () => fireEvent.click(r.getByTestId('cli-accounts-add')));
    await act(async () => fireEvent.keyDown(document, { key: 'Escape' }));
    await act(() => ipc.emit('cliAccount.login', { id: 'L1', kind: 'codex', state: 'cancelled' }));
    await act(() => ipc.emit('cliAccount.login', { id: 'L1', kind: 'codex', state: 'waiting' }));
    expect(r.queryByRole('dialog')).toBeNull();
  });

  it('再次登录还在启动时，旧会话的取消事件不影响新的登录', async () => {
    let calls = 0;
    let resolveStart!: (event: unknown) => void;
    const ipc = mockIpc({
      'cliAccount.loginStart': () =>
        ++calls === 1
          ? { id: 'L1', kind: 'codex', state: 'starting' }
          : new Promise((resolve) => {
              resolveStart = resolve;
            }),
    });
    const r = render(<OfficialAccounts kind="codex" />);
    await act(async () => fireEvent.click(r.getByTestId('cli-accounts-add')));
    await act(async () => fireEvent.keyDown(document, { key: 'Escape' }));
    await act(async () => fireEvent.click(r.getByTestId('cli-accounts-add')));
    await act(() => ipc.emit('cliAccount.login', { id: 'L1', kind: 'codex', state: 'cancelled' }));
    await act(async () => resolveStart({ id: 'L2', kind: 'codex', state: 'starting' }));
    expect(r.getByRole('dialog')).toBeTruthy();
    expect(ipc.invoke).not.toHaveBeenCalledWith('cliAccount.loginCancel', { id: 'L2' });
  });

  it('没有主动登录时，不为全局的登录事件弹窗', async () => {
    const ipc = mockIpc();
    const r = render(<OfficialAccounts kind="codex" />);
    await act(() =>
      ipc.emit('cliAccount.login', { id: 'other', kind: 'codex', state: 'cancelled' }),
    );
    expect(r.queryByRole('dialog')).toBeNull();
  });

  it('登录启动响应晚于设备码事件时，不退回启动状态', async () => {
    let resolveStart!: (event: unknown) => void;
    const ipc = mockIpc({
      'cliAccount.loginStart': () =>
        new Promise((resolve) => {
          resolveStart = resolve;
        }),
    });
    const r = render(<OfficialAccounts kind="codex" />);
    await act(async () => fireEvent.click(r.getByTestId('cli-accounts-add')));
    await act(() =>
      ipc.emit('cliAccount.login', {
        id: 'L1',
        kind: 'codex',
        state: 'waiting',
        url: 'https://auth.openai.com/codex/device',
        code: 'ABCD-12345',
      }),
    );
    await act(async () => resolveStart({ id: 'L1', kind: 'codex', state: 'starting' }));
    expect(r.getByTestId('cli-account-code').textContent).toBe('ABCD-12345');
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
