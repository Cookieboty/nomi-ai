// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AppEntries } from '../src/components/AppEntries';
import { RestartUpdateButton, isUpdateReadyToInstall } from '../src/components/RestartUpdateButton';
import type { UpdateState } from '../src/components/SettingsView/UpdateSettings';

import { installFakeApi, resetFakeApi } from './helpers/fakeApi';

vi.mock('../src/services/api', async () => (await import('./helpers/fakeApi')).fakeApiModule());

const base: UpdateState = {
  status: 'idle',
  currentVersion: '2.0.4',
  autoCheck: true,
};

function mockUpdates(state: UpdateState, install?: () => Promise<UpdateState>) {
  const installFn = install ?? vi.fn(async () => state);
  installFakeApi({
    'updates.get': () => state,
    'updates.check': () => state,
    'updates.download': () => state,
    'updates.install': installFn,
    'updates.setAutoCheck': () => state,
  });
  return installFn;
}

afterEach(() => {
  cleanup();
  resetFakeApi();
});

describe('isUpdateReadyToInstall', () => {
  it('only downloaded is ready', () => {
    expect(isUpdateReadyToInstall('downloaded')).toBe(true);
    expect(isUpdateReadyToInstall('available')).toBe(false);
    expect(isUpdateReadyToInstall('downloading')).toBe(false);
    expect(isUpdateReadyToInstall('idle')).toBe(false);
    expect(isUpdateReadyToInstall(undefined)).toBe(false);
  });
});

describe('RestartUpdateButton', () => {
  it('hidden when no update bridge or not downloaded', async () => {
    const { rerender } = render(<RestartUpdateButton placement="titlebar" />);
    expect(screen.queryByTestId('restart-update-titlebar')).toBeNull();

    mockUpdates({ ...base, status: 'available', availableVersion: '2.0.5' });
    rerender(<RestartUpdateButton placement="titlebar" />);
    // remount to pick up new api + state
    cleanup();
    mockUpdates({ ...base, status: 'available', availableVersion: '2.0.5' });
    render(<RestartUpdateButton placement="titlebar" />);
    await waitFor(() => expect(screen.queryByTestId('restart-update-titlebar')).toBeNull());
  });

  it('title bar: shows the label with the version in its tooltip; click installs', async () => {
    const install = mockUpdates({
      ...base,
      status: 'downloaded',
      availableVersion: '2.0.5',
    });
    render(<RestartUpdateButton placement="titlebar" />);
    const btn = await screen.findByTestId('restart-update-titlebar');
    expect(btn.textContent).toContain('重启更新');
    expect(btn.getAttribute('title')).toBe('重启更新 · v2.0.5');
    fireEvent.click(btn);
    await waitFor(() => expect(install).toHaveBeenCalledTimes(1));
  });

  it('settings-nav: shows only when downloaded', async () => {
    mockUpdates({ ...base, status: 'downloaded', availableVersion: '2.0.5' });
    render(<RestartUpdateButton placement="settings-nav" collapsed={false} />);
    const btn = await screen.findByTestId('restart-update-settings');
    expect(btn.textContent).toContain('重启更新');
  });
});

describe('AppEntries + restart update', () => {
  it('the sidebar entries no longer carry it (it lives in the title bar)', async () => {
    mockUpdates({ ...base, status: 'downloaded', availableVersion: '2.0.5' });
    const r = render(<AppEntries collapsed={false} onSettings={vi.fn()} />);
    expect(r.getByTestId('open-settings')).toBeTruthy();
    await new Promise((res) => setTimeout(res, 0));
    expect(r.queryByTestId('restart-update-titlebar')).toBeNull();
  });
});
