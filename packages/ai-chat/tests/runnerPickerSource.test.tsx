// @vitest-environment happy-dom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RunnerModelPicker, type RunnerSpecValue } from '../src/components/RunnerModelPicker';
import { resetAutoRefreshedAccounts } from '../src/hooks/useCliAccounts';
import { resetAccountLabelCache } from '../src/services/cliAccountClient';
import type { GatewayState } from '../src/services/gatewayClient';

import { installFakeApi, resetFakeApi } from './helpers/fakeApi';

vi.mock('../src/services/api', async () => (await import('./helpers/fakeApi')).fakeApiModule());

beforeEach(() => {
  resetAccountLabelCache();
  resetAutoRefreshedAccounts();
});
afterEach(() => {
  resetAccountLabelCache();
  resetAutoRefreshedAccounts();
  cleanup();
  resetFakeApi();
});

const gateway = {
  status: { state: 'running', port: 6129, url: 'http://127.0.0.1:6129' },
  providers: [],
  clients: {},
} as unknown as GatewayState;

const officialAccount = {
  id: 'acct-work',
  kind: 'claude',
  label: 'Work Pro',
  loggedIn: true,
  identity: { key: 'work@example.com', email: 'work@example.com', plan: 'Pro' },
  active: true,
  inUse: 0,
  createdAt: 0,
};

const initial: RunnerSpecValue = {
  cli: 'claude',
  source: 'official',
  accountId: 'acct-work',
  model: null,
  reasoningEffort: null,
};

type CatalogCall = { backend: string; source?: string };

/** 两个登录都在：本机登录与官方账号的模型目录不同 */
function installLocalOnly(
  modelCatalog: (in_: { backend: string; source?: string }) => unknown,
  calls: CatalogCall[],
) {
  installFakeApi({
    'cliAccount.list': () => [],
    'cli.launcherGet': () => ({
      claude: { accountSource: 'local', enabled: false, command: '', hasLocalLogin: true },
    }),
    'harness.modelCatalog': (in_: { backend: string; source?: string }) => {
      calls.push({ backend: in_.backend, source: in_.source });
      return modelCatalog(in_);
    },
  });
}

function installOfficialOnly(
  modelCatalog: (in_: { backend: string; source?: string }) => unknown,
  calls: CatalogCall[],
) {
  installFakeApi({
    'cliAccount.list': () => [officialAccount],
    'cli.launcherGet': () => ({
      claude: { accountSource: 'nomi', enabled: false, command: '', hasLocalLogin: false },
    }),
    'harness.modelCatalog': (in_: { backend: string; source?: string }) => {
      calls.push({ backend: in_.backend, source: in_.source });
      return modelCatalog(in_);
    },
  });
}

function installBothLogins(
  modelCatalog: (in_: { backend: string; source?: string }) => unknown,
  calls: CatalogCall[],
) {
  installFakeApi({
    'cliAccount.list': () => [officialAccount],
    'cli.launcherGet': () => ({
      claude: { accountSource: 'nomi', enabled: false, command: '', hasLocalLogin: true },
    }),
    'cli.launcherTest': () => ({ ok: true, version: '1.0.0' }),
    'harness.modelCatalog': (in_: { backend: string; source?: string }) => {
      calls.push({ backend: in_.backend, source: in_.source });
      return modelCatalog(in_);
    },
  });
}

function mountPicker(value: RunnerSpecValue = initial) {
  return render(
    <RunnerModelPicker
      open
      value={value}
      installed={['claude']}
      localAvailable={{ claude: true }}
      gateway={gateway}
      onConfirm={() => undefined}
      onClose={() => undefined}
      onOpenProviders={() => undefined}
    />,
  );
}

const payload = (source: string | undefined, label?: string) => ({
  backend: 'claude',
  models: [{ id: `${source}-only-model`, label, efforts: [], contextWindow: 200000 }],
  defaultModel: null,
});

/** 官方/本机模型下拉里的选项文字（透明原生 <select> 带 aria-hidden，按作用域取） */
function optionTexts(r: ReturnType<typeof mountPicker>): string[] {
  const select = r.queryByTestId('runner-picker-official-model') as HTMLSelectElement | null;
  const opts = select?.options as ArrayLike<HTMLOptionElement> | undefined;
  return opts
    ? (Array.prototype.map.call(opts, (o: HTMLOptionElement) => o.textContent ?? '') as string[])
    : [];
}

/** 让挂起的 Promise 回调跑完（不去等那条故意挂住的请求） */
const drain = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('RunnerModelPicker model catalog by source', () => {
  it('local-only sign-in requests the local catalog', async () => {
    const calls: CatalogCall[] = [];
    installLocalOnly((in_) => payload(in_.source, 'Local Only'), calls);
    const r = mountPicker({ ...initial, source: 'local', accountId: null });
    await waitFor(() => expect(optionTexts(r)).toContain('Local Only'));
    expect(calls.every((c) => c.source === 'local')).toBe(true);
    // 没有官方账号时不出官方账号行
    expect(r.queryByTestId('runner-picker-official-acct-work')).toBeNull();
  });

  it('official-only sign-in requests the official catalog', async () => {
    const calls: CatalogCall[] = [];
    installOfficialOnly((in_) => payload(in_.source, 'Official Only'), calls);
    const r = mountPicker();
    await waitFor(() => expect(optionTexts(r)).toContain('Official Only'));
    expect(calls).toContainEqual({ backend: 'claude', source: 'official' });
    expect(calls.every((c) => c.source === 'official' || c.source === undefined)).toBe(true);
  });

  it('drops a late local catalog response after switching CLI before switching back', async () => {
    const calls: CatalogCall[] = [];
    let releaseLocal: (() => void) | null = null;
    installBothLogins((in_) => {
      const data = payload(in_.source, in_.backend === 'claude' ? 'Claude Local' : 'Other Local');
      if (!(in_.source === 'local' && in_.backend === 'claude')) return data;
      return new Promise((resolve) => {
        releaseLocal = () => resolve(data);
      });
    }, calls);
    const r = mountPicker({ ...initial, source: 'local', accountId: null });
    await waitFor(() => expect(r.getByTestId('runner-picker-official-acct-work')).toBeTruthy());
    fireEvent.click(r.getByTestId('runner-picker-local'));
    await waitFor(() => expect(calls).toContainEqual({ backend: 'claude', source: 'local' }));
    // 切走 CLI 再切回来：claude 的旧请求晚到，不能覆盖当前（新一次）的目录
    await waitFor(() => expect(r.getByTestId('runner-picker-cli-codex')).toBeTruthy());
    fireEvent.click(r.getByTestId('runner-picker-cli-codex'));
    await drain();
    const late = releaseLocal as unknown as (() => void) | null;
    if (late) late();
    await drain();
    await drain();
    const before = optionTexts(r);
    fireEvent.click(r.getByTestId('runner-picker-cli-claude'));
    await waitFor(() => expect(optionTexts(r)).toContain('Claude Local'));
    expect(before).not.toContain('Claude Local');
  });

  it('asks for the draft source: local and official catalogs stay separate with both logins', async () => {
    const calls: CatalogCall[] = [];
    installBothLogins(
      (in_) =>
        in_.source === 'local'
          ? payload('local', 'Local Only')
          : payload('official', 'Official Only'),
      calls,
    );
    const r = mountPicker();
    await waitFor(() => expect(r.getByTestId('runner-picker-official-acct-work')).toBeTruthy());
    await waitFor(() => expect(r.getByTestId('runner-picker-local')).toBeTruthy());
    fireEvent.click(r.getByTestId('runner-picker-local'));
    await waitFor(() => expect(calls).toContainEqual({ backend: 'claude', source: 'local' }));
    await waitFor(() => expect(optionTexts(r)).toContain('Local Only'));
    // 官方目录不能漏到本机登录下面
    expect(optionTexts(r)).not.toContain('Official Only');

    await waitFor(() => expect(r.getByTestId('runner-picker-official-acct-work')).toBeTruthy());
    fireEvent.click(r.getByTestId('runner-picker-official-acct-work'));
    await waitFor(() => expect(calls).toContainEqual({ backend: 'claude', source: 'official' }));
    await waitFor(() => expect(optionTexts(r)).toContain('Official Only'));
    expect(optionTexts(r)).not.toContain('Local Only');
  });

  it('drops a late local catalog response after switching to the official account', async () => {
    const calls: CatalogCall[] = [];
    let releaseLocal: (() => void) | null = null;
    installBothLogins((in_) => {
      const data =
        in_.source === 'local'
          ? payload('local', 'Local Only')
          : payload('official', 'Official Only');
      if (in_.source !== 'local') return data;
      return new Promise((resolve) => {
        releaseLocal = () => resolve(data);
      });
    }, calls);
    const r = mountPicker();
    await waitFor(() => expect(r.getByTestId('runner-picker-official-acct-work')).toBeTruthy());
    await waitFor(() => expect(r.getByTestId('runner-picker-local')).toBeTruthy());
    fireEvent.click(r.getByTestId('runner-picker-local'));
    await waitFor(() => expect(calls).toContainEqual({ backend: 'claude', source: 'local' }));
    await waitFor(() => expect(r.getByTestId('runner-picker-official-acct-work')).toBeTruthy());
    fireEvent.click(r.getByTestId('runner-picker-official-acct-work'));
    await waitFor(() => expect(optionTexts(r)).toContain('Official Only'));
    await drain();
    expect(releaseLocal).not.toBeNull();
    (releaseLocal as unknown as () => void)();
    await drain();
    await drain();
    expect(optionTexts(r)).not.toContain('Local Only');
    expect(optionTexts(r)).toContain('Official Only');
  });
});
