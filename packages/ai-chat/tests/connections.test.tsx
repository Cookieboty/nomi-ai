// @vitest-environment happy-dom
/** 设置 → 应用与账号：检测本机 gh 登录、宽权限提示、复用 gh 登录 / 用令牌添加、删除先确认 */
import { ContractError } from '@nomi-ai/contract';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ConnectionsPanel } from '../src/components/ConnectionsPanel';

import { installFakeApi, resetFakeApi, type FakeApi } from './helpers/fakeApi';

vi.mock('../src/services/api', async () => (await import('./helpers/fakeApi')).fakeApiModule());
vi.mock('../src/components/ConfirmDialog', () => import('./helpers/confirmViaWindow'));

let fake: FakeApi;
let list: unknown[] = [];
let detect: () => unknown;
let add: (input: { onDuplicate?: string }) => unknown;
beforeEach(() => {
  add = () => list[0];
  detect = defaultDetect;
  list = [
    {
      id: 'conn_1',
      provider: 'github',
      label: 'GitHub · octo',
      auth: { kind: 'cli-login', host: 'github.com' },
      account: { login: 'octo', host: 'github.com' },
      wideScopes: ['repo', 'workflow'],
      status: 'ok',
      createdAt: 1,
    },
  ];
  fake = installFakeApi({
    'connections.list': () => list,
    'connections.detect': () => detect(),
    'connections.addGithub': (i: { onDuplicate?: string }) => add(i),
    'connections.remove': () => true,
    'connections.check': () => list[0],
    'connections.rebind': () => list[0],
  });
});
function defaultDetect() {
  return {
    gh: {
      installed: true,
      accounts: [
        {
          host: 'github.com',
          login: 'octo',
          scopes: ['repo', 'workflow'],
          wideScopes: ['repo', 'workflow'],
          tokenSource: 'keyring',
          active: true,
          state: 'success',
        },
      ],
    },
  };
}
afterEach(() => {
  cleanup();
  resetFakeApi();
});

describe('应用与账号', () => {
  it('已连接按应用分组、如实提示宽权限；gh 已接过的主机显示「已添加」，不能重复添加', async () => {
    render(<ConnectionsPanel />);
    await act(() => fake.settle());
    expect(screen.getByTestId('connections-group-github').textContent).toContain('GitHub · octo');
    expect(screen.getByTestId('connection-conn_1').textContent).toContain('repo, workflow');
    fireEvent.click(screen.getByTestId('connection-app-github'));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 300));
      await fake.settle();
    });
    expect(screen.getByTestId('connection-gh-option').textContent).toContain('octo');
    expect(screen.getByTestId('connection-gh-added')).toBeTruthy();
    expect(screen.queryByTestId('connection-add-gh')).toBeNull();
  });

  it('没接过的主机可以用 gh 登录；gh 里的其他账号提示改用令牌', async () => {
    list = [];
    detect = () => ({
      gh: {
        installed: true,
        accounts: [
          {
            host: 'github.com',
            login: 'octo',
            scopes: [],
            wideScopes: [],
            tokenSource: 'k',
            active: true,
            state: 'success',
          },
          {
            host: 'github.com',
            login: 'mona',
            scopes: [],
            wideScopes: [],
            tokenSource: 'k',
            active: false,
            state: 'success',
          },
        ],
      },
    });
    render(<ConnectionsPanel />);
    await act(() => fake.settle());
    fireEvent.click(screen.getByTestId('connection-app-github'));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 300));
      await fake.settle();
    });
    expect(screen.getByTestId('connection-gh-others').textContent).toContain('mona');
    fireEvent.click(screen.getByTestId('connection-add-gh'));
    await act(() => fake.settle());
    expect(fake.calls).toContainEqual(['connections.addGithub', { mode: 'gh' }]);
  });

  it('同一账号再用令牌添加：选保留两个（带名字）；删除先确认', async () => {
    let n = 0;
    add = (input) => {
      n += 1;
      if (!input.onDuplicate)
        throw new ContractError(
          'CONNECTIONS_DUPLICATE',
          'GitHub · octo: octo@github.com is already added',
        );
      return list[0];
    };
    render(<ConnectionsPanel />);
    await act(() => fake.settle());
    fireEvent.click(screen.getByTestId('connection-app-github'));
    await act(() => fake.settle());
    fireEvent.change(screen.getByTestId('connection-token'), { target: { value: ' ghp_x ' } });
    fireEvent.change(screen.getByTestId('connection-name'), { target: { value: '只读' } });
    fireEvent.click(screen.getByTestId('connection-add-token'));
    await act(() => fake.settle());
    expect(screen.getByTestId('connection-duplicate').textContent).toContain('GitHub · octo');
    fireEvent.click(screen.getByTestId('connection-keep-both'));
    await act(() => fake.settle());
    expect(fake.calls).toContainEqual([
      'connections.addGithub',
      { mode: 'token', token: 'ghp_x', name: '只读', onDuplicate: 'keep' },
    ]);
    expect(n).toBe(2);

    const confirm = vi.fn(() => false);
    window.confirm = confirm;
    fireEvent.click(screen.getByTestId('connection-remove-conn_1'));
    await act(() => fake.settle());
    expect(confirm).toHaveBeenCalled();
    expect(fake.calls.some(([x]) => x === 'connections.remove')).toBe(false);
  });

  it('gh 换了账号：写明当前账号，确认后改用', async () => {
    list = [{ ...(list[0] as object), status: 'needs_login', currentLogin: 'mona' }];
    render(<ConnectionsPanel />);
    await act(() => fake.settle());
    expect(screen.getByTestId('connection-switched-conn_1').textContent).toContain('mona');
    window.confirm = vi.fn(() => true);
    fireEvent.click(screen.getByTestId('connection-rebind-conn_1'));
    await act(() => fake.settle());
    expect(fake.calls).toContainEqual(['connections.rebind', { id: 'conn_1' }]);
  });
});
