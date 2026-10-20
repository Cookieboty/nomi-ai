// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CliProviderChip, activeProfileOf } from '../src/components/CliProviderChip';
import { EndpointControls, SessionControls } from '../src/components/EndpointControls';
import { HarnessTabsProvider } from '../src/contexts/HarnessTabsContext';
import { setChatMode } from '../src/services/chatPrefs';
import type { CliProviderProfile, CliProviderState } from '../src/services/cliProviderClient';
import type { HarnessTabMeta, HarnessTabsState } from '../src/services/harnessClient';

vi.mock('../src/contexts/AiChatContext', () => ({
  useAiChat: () => ({
    state: { messages: [] },
    actions: { newConversation: async () => undefined },
  }),
}));

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

const prof = (over: Partial<CliProviderProfile>): CliProviderProfile => ({
  id: 'p',
  kind: 'claude',
  name: 'P',
  baseUrl: 'https://x',
  model: 'm',
  apiFormat: 'anthropic_messages',
  needsRouting: false,
  hasKey: true,
  keyHint: '',
  active: false,
  ...over,
});

const cliState = (profiles: CliProviderProfile[]): CliProviderState => ({
  profiles,
  claudeStore: '',
  codexStore: '',
  claudeSettings: '',
  codexConfig: '',
  routing: null,
});

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

function mockIpc(opts: {
  cli: CliProviderState;
  tabs: HarnessTabsState;
  backend?: string;
  accounts?: unknown[];
}) {
  const invoke = vi.fn(async (ch: string, ..._a: unknown[]) => {
    if (ch === 'ai:cli-account:list') return opts.accounts ?? [];
    if (ch === 'ai:cli-account:activate') return {};
    if (ch === 'ai:providers:state') return NOMI_STATE;
    if (ch === 'ai:cli-provider:state') return opts.cli;
    if (ch === 'ai:cli-provider:activate') return { ok: true, backups: [] };
    if (ch === 'ai:cli-provider:deactivate') return { ok: true, backups: [] };
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

describe('activeProfileOf', () => {
  it('only considers the profile list of that kind', () => {
    const s = cliState([prof({ id: 'a', kind: 'claude', active: true })]);
    expect(activeProfileOf(s, 'claude')?.id).toBe('a');
    expect(activeProfileOf(s, 'codex')).toBeNull();
  });
});

describe('CliProviderChip · 官方账号（docs/design/cli-official-accounts.md）', () => {
  it('没有第三方供应商时显示当前官方账号；下拉里选官方账号会全局切换', async () => {
    const invoke = mockIpc({
      cli: { profiles: [] } as unknown as CliProviderState,
      tabs: {
        tabs: [],
        activeTabId: 'main',
        maxConcurrent: 3,
        running: 0,
        queued: 0,
      } as unknown as HarnessTabsState,
      accounts: [
        {
          id: 'a1',
          kind: 'codex',
          label: 'a',
          identity: { key: 'ka', email: 'a@x.com', plan: 'plus' },
          active: true,
          createdAt: 1,
        },
        {
          id: 'a2',
          kind: 'codex',
          label: 'b',
          identity: { key: 'kb', email: 'b@x.com' },
          active: false,
          createdAt: 2,
        },
      ],
    });
    const r = render(<CliProviderChip backend="codex" />);
    await waitFor(() =>
      expect(r.getByTestId('cli-provider-chip').textContent).toContain('官方 · a@x.com'),
    );
    fireEvent.click(r.getByRole('combobox'));
    fireEvent.click(document.querySelector('[data-value="account:a2"]')!);
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('ai:cli-account:activate', 'a2', 'codex'),
    );
  });

  describe('切换后端后不残留上一个后端的账号（#69）', () => {
    const acc = (id: string, kind: string, email: string, active = false) => ({
      id,
      kind,
      label: email,
      identity: { key: id, email },
      active,
      createdAt: 1,
    });
    const LISTS: Record<string, unknown[]> = {
      codex: [acc('cx1', 'codex', 'codex-a@x.com', true), acc('cx2', 'codex', 'codex-b@x.com')],
      claude: [acc('cl1', 'claude', 'claude-a@x.com', true)],
    };
    /** 每次 list 请求都挂起，由测试按任意顺序放行 */
    function mockDeferred() {
      const waiting: Array<{ kind: string; release: () => void }> = [];
      const invoke = vi.fn(async (ch: string, ...a: unknown[]) => {
        if (ch === 'ai:cli-account:list') {
          const kind = String(a[0]);
          return new Promise((res) =>
            waiting.push({ kind, release: () => res(LISTS[kind] ?? []) }),
          );
        }
        if (ch === 'ai:cli-provider:state') return cliState([]);
        return {};
      });
      (window as unknown as { aiIPC: unknown }).aiIPC = { invoke, on: () => () => undefined };
      /** latest：放行该后端最近一次的请求（默认放行最早的） */
      const release = async (kind: string, latest = false) => {
        const mine = waiting.filter((w) => w.kind === kind);
        const w = latest ? mine[mine.length - 1]! : mine[0]!;
        waiting.splice(waiting.indexOf(w), 1);
        await act(async () => w.release());
      };
      return { invoke, release };
    }
    const optionValues = () =>
      Array.from(document.querySelectorAll('[data-value]')).map((x) =>
        x.getAttribute('data-value'),
      );
    const activateCalls = (invoke: ReturnType<typeof vi.fn>) =>
      invoke.mock.calls.filter((c) => c[0] === 'ai:cli-account:activate');

    it('Codex 账号加载后切到 dsh：账号标签与选项立即消失，不会发出 Codex 的切换', async () => {
      const m = mockDeferred();
      const r = render(<CliProviderChip backend="codex" />);
      await m.release('codex');
      await waitFor(() =>
        expect(r.getByTestId('cli-provider-chip').textContent).toContain('codex-a@x.com'),
      );
      r.rerender(<CliProviderChip backend="dsh" />);
      expect(r.getByTestId('cli-provider-chip').textContent).not.toContain('codex-a@x.com');
      fireEvent.click(r.getByRole('combobox'));
      expect(optionValues().some((v) => v?.startsWith('account:'))).toBe(false);
      expect(activateCalls(m.invoke)).toHaveLength(0);
    });

    it('Codex → Claude 且 Claude 列表还没回来：等待期间不显示、不能选 Codex 账号', async () => {
      const m = mockDeferred();
      const r = render(<CliProviderChip backend="codex" />);
      await m.release('codex');
      await waitFor(() =>
        expect(r.getByTestId('cli-provider-chip').textContent).toContain('codex-a@x.com'),
      );
      r.rerender(<CliProviderChip backend="claude" />);
      fireEvent.click(r.getByRole('combobox'));
      expect(optionValues()).not.toContain('account:cx2');
      expect(r.getByTestId('cli-provider-chip').textContent).not.toContain('codex-a@x.com');
      await m.release('claude');
      await waitFor(() =>
        expect(r.getByTestId('cli-provider-chip').textContent).toContain('claude-a@x.com'),
      );
      expect(activateCalls(m.invoke)).toHaveLength(0);
    });

    it('A → B → A 且请求乱序返回：只显示当前后端的账号', async () => {
      const m = mockDeferred();
      const r = render(<CliProviderChip backend="codex" />);
      r.rerender(<CliProviderChip backend="claude" />);
      r.rerender(<CliProviderChip backend="codex" />);
      await m.release('codex', true); // 当前（第二次）的 codex 请求先回来
      await m.release('claude'); // 晚到的 claude 请求：组件已经切回 codex
      await m.release('codex'); // 更晚到的第一次 codex 请求
      await waitFor(() =>
        expect(r.getByTestId('cli-provider-chip').textContent).toContain('codex-a@x.com'),
      );
      fireEvent.click(r.getByRole('combobox'));
      expect(optionValues()).not.toContain('account:cl1');
      fireEvent.click(document.querySelector('[data-value="account:cx2"]')!);
      await waitFor(() => expect(activateCalls(m.invoke)).toHaveLength(1));
      expect(activateCalls(m.invoke)[0]).toEqual(['ai:cli-account:activate', 'cx2', 'codex']);
    });
  });
});

describe('CliProviderChip', () => {
  it('shows CLI default when the backend store has no active profile', async () => {
    // Claude 启用了第三方供应商，Codex 一个都没有 → Codex 按钮必须显示默认配置
    mockIpc({
      cli: cliState([prof({ id: 'c1', kind: 'claude', name: 'MyClaude', active: true })]),
      tabs: { tabs: [], activeTabId: 'main', maxConcurrent: 3, running: 0, queued: 0 },
    });
    const r = render(<CliProviderChip backend="codex" />);
    await waitFor(() => expect(r.getByTestId('cli-provider-chip')).toBeTruthy());
    await waitFor(() =>
      expect(r.getByTestId('cli-provider-chip').getAttribute('data-source')).toBe('cli-default'),
    );
    expect(r.getByTestId('cli-provider-chip').textContent).toContain('CLI 默认 / 已登录');
    expect(r.queryByText('Amux')).toBeNull();
    expect(r.queryByText('MyClaude')).toBeNull();
  });

  it('shows the backend own active profile and model, and activates only its profiles', async () => {
    const invoke = mockIpc({
      cli: cliState([
        prof({ id: 'x1', kind: 'codex', name: 'Local', model: 'qwen', active: true }),
        prof({ id: 'x2', kind: 'codex', name: 'Other', model: 'gpt-y' }),
        prof({ id: 'c1', kind: 'claude', name: 'ClaudeOnly' }),
      ]),
      tabs: { tabs: [], activeTabId: 'main', maxConcurrent: 3, running: 0, queued: 0 },
    });
    const r = render(<CliProviderChip backend="codex" />);
    await waitFor(() =>
      expect(r.getByTestId('cli-provider-chip').getAttribute('data-source')).toBe('own-store'),
    );
    expect(r.getByTestId('cli-model-label').textContent).toBe('qwen');
    fireEvent.click(r.getByRole('combobox'));
    const opts = Array.from(document.querySelectorAll('[role="option"]')).map((o) => o.textContent);
    expect(opts.join('|')).toContain('Other');
    expect(opts.join('|')).not.toContain('ClaudeOnly');
    fireEvent.click(document.querySelector('[data-value="x2"]')!);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('ai:cli-provider:activate', 'x2'));
    fireEvent.click(r.getByRole('combobox'));
    fireEvent.click(document.querySelector('[data-value=""]')!);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('ai:cli-provider:deactivate', 'codex'));
  });
});

describe('each CLI chip shows only its own store', () => {
  it.each([
    ['claude', 'ClaudeP', 'claude-m'],
    ['codex', 'CodexP', 'codex-m'],
    ['dsh', 'DshP', 'dsh-m'],
  ] as const)(
    '%s shows its own active profile + model and nothing else',
    async (kind, name, model) => {
      mockIpc({
        cli: cliState([
          prof({ id: 'c', kind: 'claude', name: 'ClaudeP', model: 'claude-m', active: true }),
          prof({ id: 'x', kind: 'codex', name: 'CodexP', model: 'codex-m', active: true }),
          prof({ id: 'd', kind: 'dsh', name: 'DshP', model: 'dsh-m', active: true }),
        ]),
        tabs: { tabs: [], activeTabId: 'main', maxConcurrent: 3, running: 0, queued: 0 },
      });
      const r = render(<CliProviderChip backend={kind} />);
      await waitFor(() =>
        expect(r.getByTestId('cli-provider-chip').getAttribute('data-source')).toBe('own-store'),
      );
      const text = r.getByTestId('cli-provider-chip').textContent ?? '';
      expect(text).toContain(name);
      expect(r.getByTestId('cli-model-label').textContent).toBe(model);
      for (const other of ['ClaudeP', 'CodexP', 'DshP'].filter((n) => n !== name))
        expect(text).not.toContain(other);
    },
  );

  it('the settings button opens that endpoint provider page', async () => {
    mockIpc({
      cli: cliState([]),
      tabs: {
        tabs: [
          tab({ id: 'main', backend: 'nomi' }),
          tab({ id: 'cx', backend: 'codex', title: 'Codex' }),
        ],
        activeTabId: 'cx',
        maxConcurrent: 3,
        running: 0,
        queued: 0,
      },
    });
    const onManageCli = vi.fn();
    const r = render(
      <HarnessTabsProvider>
        <>
          <EndpointControls />
          <SessionControls onManageNomi={() => undefined} onManageCli={onManageCli} />
        </>
      </HarnessTabsProvider>,
    );
    await waitFor(() => r.getByTestId('open-cli-provider-panel'));
    fireEvent.click(r.getByTestId('open-cli-provider-panel'));
    expect(onManageCli).toHaveBeenCalledWith('codex');
  });
});

describe('EndpointControls', () => {
  const tabsState = (activeBackend: 'main' | 'codex'): HarnessTabsState => ({
    tabs: [
      tab({ id: 'main', backend: 'nomi' }),
      tab({ id: 'cx', backend: 'codex', title: 'Codex' }),
    ],
    activeTabId: activeBackend === 'main' ? 'main' : 'cx',
    maxConcurrent: 3,
    running: 0,
    queued: 0,
  });

  it('Codex tab never renders the Nomi provider switcher (Amux)', async () => {
    mockIpc({ cli: cliState([]), tabs: tabsState('codex') });
    const r = render(
      <HarnessTabsProvider>
        <>
          <EndpointControls />
          <SessionControls onManageNomi={() => undefined} onManageCli={() => undefined} />
        </>
      </HarnessTabsProvider>,
    );
    await waitFor(() => expect(r.getByTestId('cli-provider-chip')).toBeTruthy());
    expect(r.queryByTestId('provider-switcher')).toBeNull();
    expect(r.queryByTestId('model-switch')).toBeNull();
    expect(r.container.textContent).not.toContain('Amux');
  });

  it('Nomi main tab renders the Nomi provider switcher', async () => {
    mockIpc({ cli: cliState([]), tabs: tabsState('main') });
    const r = render(
      <HarnessTabsProvider>
        <>
          <EndpointControls />
          <SessionControls onManageNomi={() => undefined} onManageCli={() => undefined} />
        </>
      </HarnessTabsProvider>,
    );
    await waitFor(() => expect(r.getByTestId('provider-switcher')).toBeTruthy());
    expect(r.queryByTestId('cli-provider-chip')).toBeNull();
  });
});
