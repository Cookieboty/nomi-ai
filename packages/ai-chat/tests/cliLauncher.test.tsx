// @vitest-environment happy-dom
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { CliLauncherCard } from '../src/components/ProvidersPage/CliLauncherCard';
import {
  cliLauncherClient,
  launcherManagesLogin,
  type CliLauncherSettings,
} from '../src/services/cliLauncherClient';
import { newTabOptions, newTabSelectValue } from '../src/services/cliSource';

import { installFakeApi, resetFakeApi } from './helpers/fakeApi';

vi.mock('../src/services/api', async () => (await import('./helpers/fakeApi')).fakeApiModule());

beforeEach(() => cliLauncherClient.resetCache());
afterEach(() => {
  cleanup();
  resetFakeApi();
  cliLauncherClient.resetCache();
});

it('uses local sign-in without a custom command and keeps each CLI independent', async () => {
  const settings: Record<string, CliLauncherSettings> = {
    claude: { enabled: true, command: 'reclaude cli', accountSource: 'local' },
    codex: { enabled: false, command: '', accountSource: 'nomi' },
  };
  const invoke = vi.fn(async (name: string, input?: unknown) => {
    if (name === 'cli.launcherGet') return settings;
    if (name === 'cli.launcherSet') {
      const a = input as { kind: string; settings: CliLauncherSettings };
      settings[a.kind] = a.settings;
      return a.settings;
    }
    if (name === 'cli.launcherTest') return { version: '1.0.0' };
    return {};
  });
  installFakeApi(invoke);
  const r = render(<CliLauncherCard kind="codex" />);
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('cli.launcherGet'));
  fireEvent.click(r.getByTestId('cli-account-source-local'));
  fireEvent.click(r.getByTestId('cli-launcher-save'));
  await waitFor(() => expect(settings.codex.accountSource).toBe('local'));
  expect(settings.codex.enabled).toBe(false);
  expect(settings.claude.command).toBe('reclaude cli');
  expect(launcherManagesLogin('codex')).toBe(true);
  expect(launcherManagesLogin('grok')).toBe(false);
  expect(
    newTabSelectValue({ models: { main: null }, newTabAccountId: 'old-account' } as never, 'codex'),
  ).toBe('follow');
  expect(
    newTabOptions({ kind: 'codex', accounts: [], client: undefined, gateway: null })[0]?.label,
  ).not.toContain('默认');
  fireEvent.click(r.getByTestId('cli-launcher-test'));
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith('cli.launcherTest', { kind: 'codex', command: '' }),
  );
});

it('tests a custom command without saving and preserves login when disabling the command', async () => {
  let settings: CliLauncherSettings = { enabled: false, command: '', accountSource: 'local' };
  const invoke = vi.fn(async (name: string, input?: unknown) => {
    if (name === 'cli.launcherGet') return { claude: settings };
    if (name === 'cli.launcherTest') return { version: '2.1.296' };
    if (name === 'cli.launcherSet') {
      settings = (input as { settings: CliLauncherSettings }).settings;
      return settings;
    }
    return {};
  });
  installFakeApi(invoke);
  const r = render(<CliLauncherCard kind="claude" />);
  await waitFor(() =>
    expect((r.getByTestId('cli-account-source-local') as HTMLInputElement).checked).toBe(true),
  );
  fireEvent.click(within(r.getByTestId('cli-launcher-advanced')).getByRole('button'));
  fireEvent.click(r.getByTestId('cli-launcher-enable'));
  fireEvent.change(r.getByTestId('cli-launcher-command'), { target: { value: 'reclaude cli' } });
  fireEvent.click(r.getByTestId('cli-launcher-test'));
  await waitFor(() =>
    expect(r.getByTestId('cli-launcher-result').textContent).toContain('2.1.296'),
  );
  expect(settings.enabled).toBe(false);
  expect(invoke).toHaveBeenCalledWith('cli.launcherTest', {
    kind: 'claude',
    command: 'reclaude cli',
  });
  fireEvent.click(r.getByTestId('cli-launcher-save'));
  await waitFor(() => expect(settings.enabled).toBe(true));
  fireEvent.click(r.getByTestId('cli-launcher-enable'));
  fireEvent.click(r.getByTestId('cli-launcher-save'));
  await waitFor(() => expect(settings.enabled).toBe(false));
  expect(settings.accountSource).toBe('local');
  expect(settings.command).toBe('reclaude cli');
});

it('keeps a failed save editable and displays its error', async () => {
  installFakeApi(async (name: string) => {
    if (name === 'cli.launcherGet')
      return { claude: { enabled: true, command: 'reclaude cli', accountSource: 'local' } };
    if (name === 'cli.launcherSet') throw new Error('Cannot save launch settings');
    return {};
  });
  const r = render(<CliLauncherCard kind="claude" />);
  await waitFor(() =>
    expect((r.getByTestId('cli-launcher-command') as HTMLInputElement).value).toBe('reclaude cli'),
  );
  fireEvent.change(r.getByTestId('cli-launcher-command'), {
    target: { value: 'other-wrapper cli' },
  });
  fireEvent.click(r.getByTestId('cli-launcher-save'));
  await waitFor(() =>
    expect(r.getByRole('alert').textContent).toContain('Cannot save launch settings'),
  );
  expect((r.getByTestId('cli-launcher-command') as HTMLInputElement).value).toBe(
    'other-wrapper cli',
  );
});
