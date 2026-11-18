// @vitest-environment happy-dom
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { ModelControls } from '../src/components/ModelControls';
import { CliLauncherCard } from '../src/components/ProvidersPage/CliLauncherCard';
import {
  cliLauncherClient,
  launcherManagesLogin,
  type CliLauncherSettings,
} from '../src/services/cliLauncherClient';
import { newTabOptions, newTabSelectValue } from '../src/services/cliSource';
import type { HarnessTabMeta } from '../src/services/harnessClient';

import { installFakeApi, resetFakeApi } from './helpers/fakeApi';

vi.mock('../src/services/api', async () => (await import('./helpers/fakeApi')).fakeApiModule());

beforeEach(() => cliLauncherClient.resetCache());
afterEach(() => {
  cleanup();
  resetFakeApi();
  cliLauncherClient.resetCache();
});

it('coexists local sign-in without a custom command and keeps each CLI independent', async () => {
  const settings: Record<string, CliLauncherSettings> = {
    claude: { enabled: true, command: 'reclaude cli', accountSource: 'local' },
    codex: { enabled: false, command: '', accountSource: 'local' },
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
  await waitFor(() => expect(launcherManagesLogin('codex')).toBe(true));
  expect(settings.codex.enabled).toBe(false);
  expect(settings.claude.command).toBe('reclaude cli');
  expect(launcherManagesLogin('grok')).toBe(false);
  expect(
    newTabSelectValue({ models: { main: null }, newTabSource: 'local' } as never, 'codex'),
  ).toBe('local');
  expect(
    newTabSelectValue(
      { models: { main: null }, newTabSource: 'official', newTabAccountId: null } as never,
      'codex',
    ),
  ).toBe('follow');
  expect(
    newTabOptions({
      kind: 'codex',
      accounts: [],
      localAvailable: true,
      client: undefined,
      gateway: null,
    })[0]?.label,
  ).toContain('本机登录');
  expect(
    newTabOptions({
      kind: 'codex',
      accounts: [],
      localAvailable: false,
      client: undefined,
      gateway: null,
    }).some((o) => o.value === 'local' || o.value === 'follow'),
  ).toBe(false);
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
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('cli.launcherGet'));
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

it('updates ModelControls sourceSwitch reactively when launcher config loads as local', async () => {
  let resolveGet!: (v: Record<string, CliLauncherSettings>) => void;
  const tab: HarnessTabMeta = {
    id: 'cx',
    title: 'Chat',
    backend: 'codex',
    cwd: '/w',
    cliSessionId: null,
    status: 'idle',
    unread: 0,
    createdAt: 0,
    updatedAt: 0,
    source: 'thirdParty',
    modelOverride: 'a/gpt-5',
  };
  installFakeApi(async (name: string) => {
    if (name === 'cli.launcherGet')
      return await new Promise<Record<string, CliLauncherSettings>>((resolve) => {
        resolveGet = resolve;
      });
    if (name === 'gateway.state')
      return {
        providers: [
          {
            id: 'a',
            name: 'A',
            enabled: true,
            source: 'user',
            urls: { chat: 'https://example.com' },
            keys: [],
            models: [{ id: 'gpt-5', enabled: true, toolCalling: true }],
          },
        ],
        clients: { codex: { models: { main: 'a/gpt-5' } } },
        status: { state: 'running', port: 1, url: 'http://127.0.0.1:1' },
        allowedPrivateHosts: [],
        port: 1,
      };
    if (name === 'cliAccount.list')
      return [
        {
          id: 'acct-1',
          kind: 'codex',
          label: 'Work',
          loggedIn: true,
          identity: null,
          active: true,
          inUse: 0,
          createdAt: 0,
        },
      ];
    if (name === 'harness.modelCatalog')
      return {
        backend: 'codex',
        provider: { id: 'gateway', name: 'Third-party models' },
        defaultModel: { id: 'a/gpt-5', label: 'A / gpt-5', reasoning: false, efforts: [] },
        models: [{ id: 'a/gpt-5', label: 'A / gpt-5', reasoning: false, efforts: [] }],
      };
    return {};
  });

  const r = render(<ModelControls tab={tab} />);
  fireEvent.click(await r.findByTestId('model-chip'));
  await waitFor(() => expect(r.getByTestId('model-menu').textContent).toContain('切换到官方账号'));

  resolveGet({
    codex: { enabled: false, command: '', accountSource: 'local', hasLocalLogin: true },
  });
  await waitFor(() => expect(r.getByTestId('model-menu').textContent).toContain('沿用本机登录'));
});
