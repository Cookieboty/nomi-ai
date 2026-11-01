// @vitest-environment happy-dom
/** 设置 → 外部连接：检测本机 gh 登录、宽权限提示、复用 gh 登录 / 用令牌添加、删除先确认 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ConnectionsPanel } from '../src/components/ConnectionsPanel';

import { installFakeApi, resetFakeApi, type FakeApi } from './helpers/fakeApi';

vi.mock('../src/services/api', async () => (await import('./helpers/fakeApi')).fakeApiModule());
vi.mock('../src/components/ConfirmDialog', () => import('./helpers/confirmViaWindow'));

let fake: FakeApi;
let list: unknown[] = [];
beforeEach(() => {
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
    'connections.detect': () => ({
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
    }),
    'connections.addGithub': () => list[0],
    'connections.remove': () => true,
    'connections.check': () => list[0],
  });
});
afterEach(() => {
  cleanup();
  resetFakeApi();
});

describe('外部连接', () => {
  it('列出连接并如实提示宽权限；检测到 gh 登录可直接复用', async () => {
    render(<ConnectionsPanel />);
    await act(() => fake.settle());
    expect(screen.getByTestId('connection-conn_1').textContent).toContain('repo, workflow');
    expect(screen.getByTestId('connection-gh-option').textContent).toContain('octo');
    fireEvent.click(screen.getByTestId('connection-add-gh'));
    await act(() => fake.settle());
    expect(fake.calls).toContainEqual(['connections.addGithub', { mode: 'gh' }]);
  });

  it('用令牌添加；删除先确认', async () => {
    render(<ConnectionsPanel />);
    await act(() => fake.settle());
    fireEvent.change(screen.getByTestId('connection-token'), { target: { value: ' ghp_x ' } });
    fireEvent.click(screen.getByTestId('connection-add-token'));
    await act(() => fake.settle());
    expect(fake.calls).toContainEqual(['connections.addGithub', { mode: 'token', token: 'ghp_x' }]);
    const confirm = vi.fn(() => false);
    window.confirm = confirm;
    fireEvent.click(screen.getByTestId('connection-remove-conn_1'));
    await act(() => fake.settle());
    expect(confirm).toHaveBeenCalled();
    expect(fake.calls.some(([n]) => n === 'connections.remove')).toBe(false);
  });
});
