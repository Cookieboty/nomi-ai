// @vitest-environment happy-dom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PrivacyTab } from '../src/components/DesktopPanel/PrivacyTab';
import type { DesktopState } from '../src/services/desktopClient';

import { installFakeApi, resetFakeApi } from './helpers/fakeApi';

vi.mock('../src/services/api', async () => (await import('./helpers/fakeApi')).fakeApiModule());
vi.mock('../src/components/ConfirmDialog', () => import('./helpers/confirmViaWindow'));

const base: DesktopState = {
  scopes: [],
  policies: {},
  localOnly: false,
  cloudAcked: [],
  tools: [],
  protectedPaths: ['/Users/me/finance'],
  cliEnvAllow: ['NPM_TOKEN'],
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  resetFakeApi();
});

describe('PrivacyTab', () => {
  it('lists protected folders and env names; adding a folder reports the saved path', async () => {
    const fake = installFakeApi({
      'desktop.protectFolder': () => ({ path: '/Users/me/ids', state: base }),
    });
    const onMessage = vi.fn();
    const r = render(<PrivacyTab state={base} onMessage={onMessage} />);
    expect(r.getAllByTestId('desktop-protected-path')).toHaveLength(1);
    expect(r.getAllByTestId('desktop-env-allow')).toHaveLength(1);
    fireEvent.click(r.getByTestId('desktop-protect'));
    await waitFor(() => expect(onMessage).toHaveBeenCalled());
    expect(fake.calls.map(([n]) => n)).toContain('desktop.protectFolder');
    // 装没装词典都行：要么是带路径的「已保护」文案，要么是这条 key（不是报错文案）
    expect(String(onMessage.mock.calls[0]?.[0])).toMatch(
      /\/Users\/me\/ids|ui\.foundation\.protected-folder-added/,
    );
  });

  it('unprotecting asks first; cancelling sends nothing', async () => {
    const fake = installFakeApi({ 'desktop.unprotectPath': () => base });
    (window as unknown as { confirm: unknown }).confirm = vi.fn(() => false);
    const r = render(<PrivacyTab state={base} onMessage={() => undefined} />);
    fireEvent.click(r.getByTestId('desktop-unprotect'));
    await waitFor(() => expect(window.confirm).toHaveBeenCalled());
    expect(fake.calls.map(([n]) => n)).not.toContain('desktop.unprotectPath');

    (window as unknown as { confirm: unknown }).confirm = vi.fn(() => true);
    fireEvent.click(r.getByTestId('desktop-unprotect'));
    await waitFor(() =>
      expect(fake.calls).toContainEqual(['desktop.unprotectPath', { path: '/Users/me/finance' }]),
    );
  });

  it('allowing an env name validates it and confirms before saving the whole list', async () => {
    const fake = installFakeApi({ 'desktop.setCliEnvAllow': () => base });
    (window as unknown as { confirm: unknown }).confirm = vi.fn(() => true);
    const onMessage = vi.fn();
    const r = render(<PrivacyTab state={base} onMessage={onMessage} />);
    const input = r.getByTestId('desktop-env-allow-input');

    fireEvent.change(input, { target: { value: '1BAD-NAME' } });
    fireEvent.click(r.getByTestId('desktop-env-allow-add'));
    await waitFor(() => expect(onMessage).toHaveBeenCalled());
    expect(fake.calls.map(([n]) => n)).not.toContain('desktop.setCliEnvAllow');

    fireEvent.change(input, { target: { value: 'GITHUB_TOKEN' } });
    fireEvent.click(r.getByTestId('desktop-env-allow-add'));
    await waitFor(() =>
      expect(fake.calls).toContainEqual([
        'desktop.setCliEnvAllow',
        { names: ['NPM_TOKEN', 'GITHUB_TOKEN'] },
      ]),
    );
  });

  it('turning the sandbox off asks first; turning it on does not; always-allowed items can be removed', async () => {
    const fake = installFakeApi({
      'desktop.setCliSandbox': () => base,
      'desktop.removeCliSandboxAllow': () => base,
    });
    const state: DesktopState = {
      ...base,
      cliSandbox: true,
      cliSandboxSupported: true,
      cliSandboxAllow: [{ kind: 'folder', value: '/Users/me/.ai-usage' }],
    };
    (window as unknown as { confirm: unknown }).confirm = vi.fn(() => false);
    const r = render(<PrivacyTab state={state} onMessage={() => undefined} />);
    fireEvent.click(r.getByTestId('desktop-cli-sandbox'));
    await waitFor(() => expect(window.confirm).toHaveBeenCalled());
    expect(fake.calls.map(([n]) => n)).not.toContain('desktop.setCliSandbox');

    fireEvent.click(r.getByTestId('desktop-sandbox-allow-remove'));
    await waitFor(() =>
      expect(fake.calls).toContainEqual([
        'desktop.removeCliSandboxAllow',
        { kind: 'folder', value: '/Users/me/.ai-usage' },
      ]),
    );

    cleanup();
    (window as unknown as { confirm: unknown }).confirm = vi.fn(() => true);
    const off = render(
      <PrivacyTab state={{ ...state, cliSandbox: false }} onMessage={() => undefined} />,
    );
    fireEvent.click(off.getByTestId('desktop-cli-sandbox'));
    await waitFor(() =>
      expect(fake.calls).toContainEqual(['desktop.setCliSandbox', { enabled: true }]),
    );
    expect(window.confirm).not.toHaveBeenCalled();
  });

  it('shows the sandbox as unavailable where the platform has none', () => {
    installFakeApi({});
    const r = render(
      <PrivacyTab state={{ ...base, cliSandboxSupported: false }} onMessage={() => undefined} />,
    );
    expect(r.queryByTestId('desktop-cli-sandbox')).toBeNull();
  });
});
