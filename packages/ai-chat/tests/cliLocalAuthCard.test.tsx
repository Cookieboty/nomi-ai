// @vitest-environment happy-dom
/**
 * 本机官方登录卡片按清单能力位 capabilities.localAuth 显示（不按 CLI 名字）：
 * 有能力的（现只有 antigravity）显示状态与登录；没有的不显示登录 / 退出，也不问内核。
 */
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CliLocalAuthCard } from '../src/components/ProvidersPage/CliLocalAuthCard';
import { cliLocalAuthClient } from '../src/services/cliLocalAuthClient';

import { installFakeApi, resetFakeApi } from './helpers/fakeApi';

// fakeApi 没导出事件订阅（`api.on`，本机登录事件）：这里补上，卡片才能订阅；过程调用仍走 fake API
const listeners = new Map<string, Set<(payload: unknown) => void>>();

vi.mock('../src/services/api', async () => {
  const fake = await import('./helpers/fakeApi');
  return {
    ...fake.fakeApiModule(),
    on: (event: string, fn: (payload: unknown) => void) => {
      const set = listeners.get(event) ?? new Set();
      set.add(fn);
      listeners.set(event, set);
      return () => set.delete(fn);
    },
  };
});

/** 记下卡片问内核的过程名（经 cliLocalAuthClient 的调用） */
const calls: string[] = [];

beforeEach(() => {
  const status = cliLocalAuthClient.status.bind(cliLocalAuthClient);
  vi.spyOn(cliLocalAuthClient, 'status').mockImplementation((kind, probe) => {
    calls.push(`cli.localAuthStatus:${kind}:${probe ? 1 : 0}`);
    return status(kind, probe);
  });
  const loginStart = cliLocalAuthClient.loginStart.bind(cliLocalAuthClient);
  vi.spyOn(cliLocalAuthClient, 'loginStart').mockImplementation((kind) => {
    calls.push(`cli.localAuthLoginStart:${kind}`);
    return loginStart(kind);
  });
});

afterEach(() => {
  cleanup();
  listeners.clear();
  calls.length = 0;
  vi.restoreAllMocks();
  resetFakeApi();
});

/** 假内核：本机登录状态（其余过程给空对象） */
function setupLocalAuth(loggedIn: boolean) {
  installFakeApi(async (name: string, input?: { kind?: string }) => {
    if (name === 'cli.localAuthStatus')
      return { kind: input?.kind, loggedIn, canLogin: true, canLogout: true };
    return {};
  });
}

describe('CliLocalAuthCard 按能力位显示', () => {
  it('antigravity 有 localAuth 能力：打开仅读缓存状态，不自动发起后台 ACP 探针，点击刷新才探针', async () => {
    setupLocalAuth(false);
    const r = render(<CliLocalAuthCard kind="antigravity" />);
    await waitFor(() =>
      expect(r.getByTestId('cli-local-auth-status-badge').textContent).toBe('未登录'),
    );
    expect(r.getByTestId('cli-local-auth-login')).toBeTruthy();
    expect(r.queryByTestId('cli-local-auth-logout')).toBeNull();
    expect(calls).toContain('cli.localAuthStatus:antigravity:0');
    expect(calls).not.toContain('cli.localAuthStatus:antigravity:1');

    fireEvent.click(r.getByTestId('cli-local-auth-refresh'));
    await waitFor(() => expect(calls).toContain('cli.localAuthStatus:antigravity:1'));
  });

  it('没有 localAuth 能力的 CLI（claude）：只说明用本机登录，不渲染登录 / 退出，也不问内核', async () => {
    setupLocalAuth(false);
    const r = render(<CliLocalAuthCard kind="claude" />);
    expect(r.getByTestId('cli-local-only-claude')).toBeTruthy();
    expect(r.queryByTestId('cli-local-auth-login')).toBeNull();
    expect(r.queryByTestId('cli-local-auth-logout')).toBeNull();
    expect(r.queryByTestId('cli-local-auth-refresh')).toBeNull();
    expect(r.queryByTestId('cli-local-auth-status-badge')).toBeNull();
    await waitFor(() => expect(listeners.get('cli.localAuthEvent')?.size ?? 0).toBe(0));
    expect(calls).toEqual([]);
  });
});
