// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AppEntries } from '../src/components/AppEntries';
import { RestartUpdateButton, isUpdateReadyToInstall } from '../src/components/RestartUpdateButton';
import type { UpdateState } from '../src/components/SettingsView/UpdateSettings';

const base: UpdateState = {
  status: 'idle',
  currentVersion: '2.0.4',
  autoCheck: true,
};

function mockUpdates(state: UpdateState, install?: () => Promise<UpdateState>) {
  const installFn = install ?? vi.fn(async () => state);
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    updates: {
      get: async () => state,
      check: async () => state,
      download: async () => state,
      install: installFn,
      setAutoCheck: async () => state,
      onChanged: () => () => undefined,
    },
  };
  return installFn;
}

afterEach(() => {
  cleanup();
  delete (window as { electronAPI?: unknown }).electronAPI;
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
    const { rerender } = render(<RestartUpdateButton placement="sidebar" collapsed={false} />);
    expect(screen.queryByTestId('restart-update-sidebar')).toBeNull();

    mockUpdates({ ...base, status: 'available', availableVersion: '2.0.5' });
    rerender(<RestartUpdateButton placement="sidebar" collapsed={false} />);
    // remount to pick up new api + state
    cleanup();
    mockUpdates({ ...base, status: 'available', availableVersion: '2.0.5' });
    render(<RestartUpdateButton placement="sidebar" collapsed={false} />);
    await waitFor(() => expect(screen.queryByTestId('restart-update-sidebar')).toBeNull());
  });

  it('sidebar: shows label when expanded, icon-only when collapsed; click installs', async () => {
    const install = mockUpdates({
      ...base,
      status: 'downloaded',
      availableVersion: '2.0.5',
    });
    const r = render(<RestartUpdateButton placement="sidebar" collapsed={false} />);
    const btn = await screen.findByTestId('restart-update-sidebar');
    expect(btn.textContent).toContain('重启更新');
    fireEvent.click(btn);
    await waitFor(() => expect(install).toHaveBeenCalledTimes(1));

    r.rerender(<RestartUpdateButton placement="sidebar" collapsed />);
    expect(screen.getByTestId('restart-update-sidebar').textContent).toBe('');
    expect(screen.getByTestId('restart-update-sidebar').getAttribute('aria-label')).toBe(
      '重启更新',
    );
  });

  it('settings-nav: shows only when downloaded', async () => {
    mockUpdates({ ...base, status: 'downloaded', availableVersion: '2.0.5' });
    render(<RestartUpdateButton placement="settings-nav" collapsed={false} />);
    const btn = await screen.findByTestId('restart-update-settings');
    expect(btn.textContent).toContain('重启更新');
  });
});

describe('AppEntries + restart update', () => {
  it('renders restart next to settings only when downloaded', async () => {
    const h = {
      onHub: vi.fn(),
      onExt: vi.fn(),
      onSettings: vi.fn(),
    };
    mockUpdates({ ...base, status: 'not-available' });
    const r = render(<AppEntries collapsed={false} {...h} />);
    await waitFor(() => expect(r.queryByTestId('restart-update-sidebar')).toBeNull());
    expect(r.getByTestId('open-settings')).toBeTruthy();

    cleanup();
    mockUpdates({ ...base, status: 'downloaded', availableVersion: '2.0.5' });
    render(<AppEntries collapsed={false} {...h} />);
    expect(await screen.findByTestId('restart-update-sidebar')).toBeTruthy();
  });
});
