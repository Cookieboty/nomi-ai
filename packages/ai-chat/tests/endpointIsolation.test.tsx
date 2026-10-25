// @vitest-environment happy-dom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CliDefaultSource } from '../src/components/CliDefaultSource';
import { EndpointControls, SessionControls } from '../src/components/EndpointControls';
import { HarnessTabsProvider } from '../src/contexts/HarnessTabsContext';
import { setChatMode } from '../src/services/chatPrefs';
import type { HarnessTabMeta, HarnessTabsState } from '../src/services/harnessClient';

vi.mock('../src/contexts/AiChatContext', () => ({
  useAiChat: () => ({
    state: { messages: [] },
    actions: { newConversation: async () => undefined },
  }),
}));

const GATEWAY_STATE = {
  status: { state: 'running', port: 1, url: 'http://127.0.0.1:1' },
  providers: [
    {
      id: 'amux',
      name: 'Amux',
      enabled: true,
      urls: { chat: 'https://gateway.amux.ai/v1' },
      keys: [],
      models: [
        { id: 'gpt-x', enabled: true },
        { id: 'embed-x', enabled: true, toolCalling: false },
        { id: 'kimi-k3', enabled: true, toolCalling: true },
      ],
      source: 'user',
      createdAt: 0,
      updatedAt: 0,
    },
    {
      id: 'deep',
      name: 'DeepX',
      enabled: true,
      urls: { chat: 'https://api.deepx.example/v1' },
      keys: [],
      models: [{ id: 'ds-v4', enabled: true, toolCalling: true }],
      source: 'user',
      createdAt: 0,
      updatedAt: 0,
    },
  ],
  clients: {
    nomi: { models: { main: 'amux/gpt-x' } },
    codex: { models: { main: 'amux/kimi-k3' } },
  },
  allowedPrivateHosts: [],
  port: 1,
};

const NOMI_STATE = {
  providers: [
    {
      id: 'amux',
      presetId: 'amux',
      name: 'Amux',
      protocol: 'openai-chat',
      baseURL: 'https://gateway.amux.ai/v1',
      fullUrl: false,
      defaultModel: 'gpt-x',
      models: ['gpt-x'],
      enabled: true,
      active: true,
      keys: [{ id: 'k', masked: 'sk••', encryption: 'none', createdAt: 0 }],
      usage: { requests: 0, errors: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      source: 'store',
    },
  ],
  envProviders: [],
  activeProviderId: 'amux',
  effectiveProviderId: 'amux',
  effectiveModel: 'gpt-x',
  routes: {},
  roles: [],
  encryption: 'none',
};

const tab = (over: Partial<HarnessTabMeta>): HarnessTabMeta => ({
  id: 'x',
  title: 'X',
  backend: 'codex',
  cwd: '/w',
  cliSessionId: null,
  status: 'idle',
  unread: 0,
  createdAt: 0,
  updatedAt: 0,
  ...over,
});

function mockIpc(opts: { tabs: HarnessTabsState; backend?: string; accounts?: unknown[] }) {
  const invoke = vi.fn(async (ch: string, ..._a: unknown[]) => {
    if (ch === 'ai:cli-account:list') return opts.accounts ?? [];
    if (ch === 'ai:cli-account:activate') return {};
    if (ch === 'ai:providers:state') return NOMI_STATE;
    if (ch === 'ai:gateway:state') return GATEWAY_STATE;
    if (ch === 'ai:harness:tab-source') return tab({ id: String(_a[0]), source: _a[1] as never });
    if (ch === 'ai:harness:tabs') return opts.tabs;
    if (ch === 'ai:harness:state')
      return {
        backend: opts.backend ?? 'nomi',
        cwd: '/w',
        bins: { claude: '/c', codex: '/x', dsh: '/d' },
      };
    if (ch === 'ai:harness:tab-messages') return [];
    return opts.tabs;
  });
  (window as unknown as { aiIPC: unknown }).aiIPC = { invoke, on: () => () => undefined };
  return invoke;
}

beforeEach(() => setChatMode('dev'));
afterEach(() => {
  cleanup();
  delete (window as { aiIPC?: unknown }).aiIPC;
  localStorage.clear();
});

const EMPTY_TABS = {
  tabs: [],
  activeTabId: 'main',
  running: 0,
  queued: 0,
} as unknown as HarnessTabsState;
describe('CliDefaultSource · 侧栏信息卡「新标签默认」', () => {
  it('信息卡「新标签默认」：选供应商写 newTabSource + 该供应商的主模型（与「模型」页同一份设置）', async () => {
    const invoke = mockIpc({ tabs: EMPTY_TABS });
    const r = render(<CliDefaultSource backend="codex" />);
    await waitFor(() => r.getByTestId('cli-default-source'));
    fireEvent.click(r.getByRole('combobox'));
    fireEvent.click(document.querySelector('[data-value="provider:deep"]')!);
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('ai:gateway:set-assignment', 'codex', {
        newTabSource: 'thirdParty',
        newTabAccountId: null,
        models: { main: 'deep/ds-v4' },
      }),
    );
  });
});

describe('EndpointControls', () => {
  const tabsState = (activeBackend: 'main' | 'codex'): HarnessTabsState => ({
    tabs: [
      tab({ id: 'main', backend: 'nomi' }),
      tab({ id: 'cx', backend: 'codex', title: 'Codex' }),
    ],
    activeTabId: activeBackend === 'main' ? 'main' : 'cx',
    running: 0,
    queued: 0,
  });

  it('Codex tab renders neither a provider menu nor the Nomi provider switcher (Amux)', async () => {
    mockIpc({ tabs: tabsState('codex') });
    const r = render(
      <HarnessTabsProvider>
        <>
          <EndpointControls />
          <SessionControls />
        </>
      </HarnessTabsProvider>,
    );
    await waitFor(() => expect(r.getByTestId('permission-mode-chip')).toBeTruthy());
    // 供应商在侧栏信息卡的「新标签默认」里设，输入框下方不再有来源菜单
    expect(r.queryByTestId('cli-source-menu')).toBeNull();
    expect(r.queryByTestId('nomi-model-switch')).toBeNull();
  });

  it('Nomi main tab renders the Nomi provider switcher', async () => {
    mockIpc({ tabs: tabsState('main') });
    const r = render(
      <HarnessTabsProvider>
        <>
          <EndpointControls />
          <SessionControls />
        </>
      </HarnessTabsProvider>,
    );
    await waitFor(() => expect(r.getByTestId('nomi-model-switch')).toBeTruthy());
    expect(r.getByTestId('nomi-model-switch').textContent).toContain('Amux / gpt-x');
    expect(r.queryByTestId('cli-source-menu')).toBeNull();
  });
});
