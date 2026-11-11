// @vitest-environment happy-dom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ComputerSection } from '../src/components/SettingsView/ComputerSection';

import { installFakeApi, resetFakeApi } from './helpers/fakeApi';

vi.mock('../src/services/api', async () => (await import('./helpers/fakeApi')).fakeApiModule());

const base = {
  platform: 'darwin',
  installed: false,
  path: '',
  version: '',
  latest: '1.3.1',
  updateAvailable: false,
  newerMajor: '',
  supportedMajor: 1,
  unsupported: false,
  npmAvailable: true,
  installing: false,
  permissions: {},
  permissionApp: '',
  wayland: false,
  cliEnabled: false,
  autoApprove: false,
  active: [] as string[],
  visionModel: '',
  visionModels: [] as Array<{ ref: string; label: string; provider: string }>,
  blockedApps: [] as string[],
  redact: false,
  sandbox: '',
  sandboxes: [] as Array<{ name: string; state: string }>,
  sandboxSupported: false,
  stopShortcut: '',
  stopShortcutActive: 'CmdOrCtrl+Shift+.',
  stopShortcutError: '',
  defaultStopShortcut: 'CmdOrCtrl+Shift+.',
};

afterEach(() => {
  cleanup();
  resetFakeApi();
});

describe('设置 → Computer Use', () => {
  it('没装时显示安装按钮；全局目录不可写时提示装到用户目录，点了按用户目录装', async () => {
    let state = { ...base };
    const fake = installFakeApi({
      'computer.state': () => state,
      'computer.install': (input: { scope?: string }) => {
        if (input.scope !== 'user')
          return {
            ok: false,
            version: '',
            path: '',
            log: '',
            needsUserScope: true,
            userPrefix: '/u/.local',
          };
        state = { ...base, installed: true, version: '1.3.1', path: '/u/.local/bin/agent-desktop' };
        return { ok: true, version: '1.3.1', path: state.path, log: '', needsUserScope: false };
      },
    });
    const r = render(<ComputerSection />);
    fireEvent.click(await r.findByTestId('computer-install'));
    const notice = await r.findByTestId('computer-user-scope');
    expect(notice.textContent).toContain('/u/.local');
    fireEvent.click(notice.querySelector('button')!);
    await waitFor(() => expect(r.getByTestId('computer-status').textContent).toContain('1.3.1'));
    expect(fake.calls.filter(([n]) => n === 'computer.install').map(([, i]) => i)).toEqual([
      {},
      { scope: 'user' },
    ]);
    // 装好后不再显示安装按钮，可以检查更新
    expect(r.queryByTestId('computer-install')).toBeNull();
    expect(r.getByTestId('computer-check-update')).toBeTruthy();
  });

  it('检查更新：有新版本时显示「更新到」，新的大版本只提示', async () => {
    const fake = installFakeApi({
      'computer.state': (input: { refresh?: boolean }) => ({
        ...base,
        installed: true,
        version: '1.2.0',
        path: '/bin/agent-desktop',
        updateAvailable: !!input.refresh,
        newerMajor: input.refresh ? '2.0.0' : '',
        permissions: { accessibility: 'denied', screen_recording: 'not_required' },
        permissionApp: 'Ghostty',
      }),
      'computer.openGuide': () => ({ guide: 'started' }),
    });
    const r = render(<ComputerSection />);
    fireEvent.click(await r.findByTestId('computer-check-update'));
    await waitFor(() => expect(r.getByTestId('computer-install').textContent).toContain('1.3.1'));
    expect(r.getByTestId('computer-newer-major').textContent).toContain('2.0.0');
    // 权限要授给启动 agent-desktop 的应用：写明是哪个
    expect(r.getByText(/Ghostty/)).toBeTruthy();
    expect(fake.calls).toContainEqual(['computer.state', { refresh: true }]);
    // 缺辅助功能权限：可以打开授权引导
    fireEvent.click(r.getByTestId('computer-open-guide'));
    await waitFor(() => expect(fake.calls.some(([n]) => n === 'computer.openGuide')).toBe(true));
  });

  it('编程助手开关在「安装与能力」，打码、禁止的应用在「安全与隐私」，都经 updateSettings 保存', async () => {
    let state = { ...base, installed: true, version: '1.3.1' };
    const fake = installFakeApi({
      'computer.state': () => state,
      'computer.updateSettings': (patch: Partial<typeof base>) => (state = { ...state, ...patch }),
    });
    const r = render(<ComputerSection />);
    fireEvent.click(
      (await r.findByTestId('computer-cli-enabled')).querySelector('[role="switch"], input')!,
    );
    await waitFor(() =>
      expect(fake.calls).toContainEqual(['computer.updateSettings', { cliEnabled: true }]),
    );
    fireEvent.click(
      r.getByTestId('computer-auto-approve').querySelector('[role="switch"], input')!,
    );
    await waitFor(() =>
      expect(fake.calls).toContainEqual(['computer.updateSettings', { autoApprove: true }]),
    );
    fireEvent.click(r.getByTestId('settings-computer-page-tab-privacy'));
    fireEvent.click(r.getByTestId('computer-redact').querySelector('[role="switch"], input')!);
    await waitFor(() =>
      expect(fake.calls).toContainEqual(['computer.updateSettings', { redact: true }]),
    );
    fireEvent.change(r.getByTestId('computer-blocked-input'), { target: { value: ' Slack ' } });
    fireEvent.submit(r.getByTestId('computer-blocked-input').closest('form')!);
    await waitFor(() =>
      expect(fake.calls).toContainEqual(['computer.updateSettings', { blockedApps: ['Slack'] }]),
    );
    await waitFor(() =>
      expect(r.getByTestId('computer-blocked-apps').textContent).toContain('Slack'),
    );
  });

  it('紧急停止快捷键：显示当前的，换一个经 updateSettings 保存', async () => {
    let state = { ...base, installed: true, version: '1.3.1' };
    const fake = installFakeApi({
      'computer.state': () => state,
      'computer.updateSettings': (patch: Partial<typeof base>) => (state = { ...state, ...patch }),
    });
    const r = render(<ComputerSection />);
    const row = await r.findByTestId('computer-stop-shortcut');
    const select = row.querySelector('select')!;
    fireEvent.change(select, { target: { value: 'off' } });
    await waitFor(() =>
      expect(fake.calls).toContainEqual(['computer.updateSettings', { stopShortcut: 'off' }]),
    );
  });

  it('有人在操作桌面时显示停止按钮，点了调用 computer.stop', async () => {
    const fake = installFakeApi({
      'computer.state': () => ({
        ...base,
        installed: true,
        version: '1.3.1',
        active: ['Claude Code'],
      }),
      'computer.stop': () => true,
    });
    const r = render(<ComputerSection />);
    expect((await r.findByTestId('computer-active')).textContent).toContain('Claude Code');
    fireEvent.click(r.getByTestId('computer-stop'));
    await waitFor(() => expect(fake.calls.some(([n]) => n === 'computer.stop')).toBe(true));
    await waitFor(() => expect(r.queryByTestId('computer-active')).toBeNull());
  });
});
