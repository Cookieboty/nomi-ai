// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CliSourceMenu } from '../src/components/CliSourceMenu';
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

const noop = () => undefined;
const EMPTY_TABS = {
  tabs: [],
  activeTabId: 'main',
  maxConcurrent: 3,
  running: 0,
  queued: 0,
} as unknown as HarnessTabsState;
const optionValues = () =>
  Array.from(document.querySelectorAll('[data-value]')).map((x) => x.getAttribute('data-value'));
const menu = (
  backend: 'claude' | 'codex' | 'dsh',
  t?: HarnessTabMeta | null,
  hasMessages = false,
) => (
  <CliSourceMenu backend={backend} tab={t ?? null} hasMessages={hasMessages} onOpenModels={noop} />
);

describe('CliSourceMenu · 官方账号（docs/design/cli-official-accounts.md）', () => {
  it('显示当前官方账号；下拉里选别的官方账号会全局切换', async () => {
    const invoke = mockIpc({
      tabs: EMPTY_TABS,
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
    const r = render(menu('codex', tab({ id: 'cx' })));
    await waitFor(() =>
      expect(r.getByTestId('cli-source-menu').textContent).toContain('官方 · a@x.com'),
    );
    expect(r.getByTestId('cli-source-menu').getAttribute('data-source')).toBe('official');
    fireEvent.click(r.getByRole('combobox'));
    fireEvent.click(document.querySelector('[data-value="account:a2"]')!);
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('ai:cli-account:activate', 'a2', 'codex'),
    );
    // 已经是官方来源：不切换标签来源
    expect(invoke.mock.calls.some((c) => c[0] === 'ai:harness:tab-source')).toBe(false);
  });

  it('dsh 没有官方账号：官方一项是「dsh 自带配置」，不读账号列表', async () => {
    const invoke = mockIpc({ tabs: EMPTY_TABS });
    const r = render(menu('dsh', tab({ id: 'd', backend: 'dsh' })));
    await waitFor(() =>
      expect(r.getByTestId('cli-source-menu').textContent).toContain('dsh 自带配置'),
    );
    expect(invoke.mock.calls.some((c) => c[0] === 'ai:cli-account:list')).toBe(false);
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
    const activateCalls = (invoke: ReturnType<typeof vi.fn>) =>
      invoke.mock.calls.filter((c) => c[0] === 'ai:cli-account:activate');

    it('Codex 账号加载后切到 dsh：账号标签与选项立即消失，不会发出 Codex 的切换', async () => {
      const m = mockDeferred();
      const r = render(menu('codex'));
      await m.release('codex');
      await waitFor(() =>
        expect(r.getByTestId('cli-source-menu').textContent).toContain('codex-a@x.com'),
      );
      r.rerender(menu('dsh'));
      expect(r.getByTestId('cli-source-menu').textContent).not.toContain('codex-a@x.com');
      fireEvent.click(r.getByRole('combobox'));
      expect(optionValues().some((v) => v?.startsWith('account:'))).toBe(false);
      expect(activateCalls(m.invoke)).toHaveLength(0);
    });

    it('Codex → Claude 且 Claude 列表还没回来：等待期间不显示、不能选 Codex 账号', async () => {
      const m = mockDeferred();
      const r = render(menu('codex'));
      await m.release('codex');
      await waitFor(() =>
        expect(r.getByTestId('cli-source-menu').textContent).toContain('codex-a@x.com'),
      );
      r.rerender(menu('claude'));
      fireEvent.click(r.getByRole('combobox'));
      expect(optionValues()).not.toContain('account:cx2');
      expect(r.getByTestId('cli-source-menu').textContent).not.toContain('codex-a@x.com');
      await m.release('claude');
      await waitFor(() =>
        expect(r.getByTestId('cli-source-menu').textContent).toContain('claude-a@x.com'),
      );
      expect(activateCalls(m.invoke)).toHaveLength(0);
    });

    it('A → B → A 且请求乱序返回：只显示当前后端的账号', async () => {
      const m = mockDeferred();
      const r = render(menu('codex'));
      r.rerender(menu('claude'));
      r.rerender(menu('codex'));
      await m.release('codex', true); // 当前（第二次）的 codex 请求先回来
      await m.release('claude'); // 晚到的 claude 请求：组件已经切回 codex
      await m.release('codex'); // 更晚到的第一次 codex 请求
      await waitFor(() =>
        expect(r.getByTestId('cli-source-menu').textContent).toContain('codex-a@x.com'),
      );
      fireEvent.click(r.getByRole('combobox'));
      expect(optionValues()).not.toContain('account:cl1');
      fireEvent.click(document.querySelector('[data-value="account:cx2"]')!);
      await waitFor(() => expect(activateCalls(m.invoke)).toHaveLength(1));
      expect(activateCalls(m.invoke)[0]).toEqual(['ai:cli-account:activate', 'cx2', 'codex']);
    });
  });
});

describe('CliSourceMenu · 第三方（docs/design/unified-gateway.md §4.3）', () => {
  afterEach(() => {
    delete (window as { confirm?: unknown }).confirm;
  });

  it('第三方分组只列能给编程助手用的网关模型；选中即 tab-source(标签, thirdParty, ref)', async () => {
    const invoke = mockIpc({ tabs: EMPTY_TABS });
    const r = render(menu('codex', tab({ id: 'cx' })));
    fireEvent.click(r.getByRole('combobox'));
    await waitFor(() => expect(optionValues()).toContain('amux/gpt-x'));
    // 不支持工具调用的模型不出现
    expect(optionValues()).not.toContain('amux/embed-x');
    fireEvent.click(document.querySelector('[data-value="amux/kimi-k3"]')!);
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        'ai:harness:tab-source',
        'cx',
        'thirdParty',
        'amux/kimi-k3',
      ),
    );
  });

  it('第三方标签显示「供应商 / 模型」；没选模型时用这个 CLI 分配的默认模型', async () => {
    mockIpc({ tabs: EMPTY_TABS });
    const r = render(menu('codex', tab({ id: 'cx', source: 'thirdParty', modelOverride: null })));
    await waitFor(() =>
      expect(r.getByTestId('cli-source-menu').textContent).toContain('Amux / kimi-k3'),
    );
    expect(r.getByTestId('cli-source-menu').getAttribute('data-source')).toBe('thirdParty');
    r.rerender(menu('codex', tab({ id: 'cx', source: 'thirdParty', modelOverride: 'amux/gpt-x' })));
    expect(r.getByTestId('cli-source-menu').textContent).toContain('Amux / gpt-x');
  });

  it('第三方 → 官方且已有对话：先确认；取消不切换，确认后 tab-source(标签, official)', async () => {
    const invoke = mockIpc({ tabs: EMPTY_TABS });
    const confirm = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
    window.confirm = confirm;
    const r = render(menu('codex', tab({ id: 'cx', source: 'thirdParty' }), true));
    fireEvent.click(r.getByRole('combobox'));
    fireEvent.click(document.querySelector('[data-value="official"]')!);
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    expect(confirm.mock.calls[0]![0]).toContain('第三方的推理内容不能发给官方接口');
    expect(invoke.mock.calls.some((c) => c[0] === 'ai:harness:tab-source')).toBe(false);
    fireEvent.click(r.getByRole('combobox'));
    fireEvent.click(document.querySelector('[data-value="official"]')!);
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('ai:harness:tab-source', 'cx', 'official'),
    );
  });

  it('空标签第三方 → 官方：不确认，直接切换', async () => {
    const invoke = mockIpc({ tabs: EMPTY_TABS });
    const confirm = vi.fn(() => true);
    window.confirm = confirm;
    const r = render(menu('codex', tab({ id: 'cx', source: 'thirdParty' }), false));
    fireEvent.click(r.getByRole('combobox'));
    fireEvent.click(document.querySelector('[data-value="official"]')!);
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('ai:harness:tab-source', 'cx', 'official'),
    );
    expect(confirm).not.toHaveBeenCalled();
  });

  it('「打开模型设置」调 onOpenModels，不切换来源', async () => {
    const invoke = mockIpc({ tabs: EMPTY_TABS });
    const onOpenModels = vi.fn();
    const r = render(
      <CliSourceMenu
        backend="claude"
        tab={tab({ id: 'c', backend: 'claude' })}
        hasMessages={false}
        onOpenModels={onOpenModels}
      />,
    );
    fireEvent.click(r.getByRole('combobox'));
    fireEvent.click(document.querySelector('[data-value="__open-models"]')!);
    expect(onOpenModels).toHaveBeenCalledTimes(1);
    expect(invoke.mock.calls.some((c) => c[0] === 'ai:harness:tab-source')).toBe(false);
  });

  it('SessionControls：CLI 标签的「打开模型设置」走 onOpenModels', async () => {
    mockIpc({
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
    const onOpenModels = vi.fn();
    const r = render(
      <HarnessTabsProvider>
        <SessionControls onManageNomi={noop} onOpenModels={onOpenModels} />
      </HarnessTabsProvider>,
    );
    await waitFor(() => r.getByTestId('cli-source-menu'));
    fireEvent.click(r.getByRole('combobox'));
    fireEvent.click(document.querySelector('[data-value="__open-models"]')!);
    expect(onOpenModels).toHaveBeenCalledTimes(1);
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
    mockIpc({ tabs: tabsState('codex') });
    const r = render(
      <HarnessTabsProvider>
        <>
          <EndpointControls />
          <SessionControls onManageNomi={() => undefined} onOpenModels={() => undefined} />
        </>
      </HarnessTabsProvider>,
    );
    await waitFor(() => expect(r.getByTestId('cli-source-menu')).toBeTruthy());
    expect(r.queryByTestId('nomi-model-switch')).toBeNull();
    // 标签用官方来源：不显示 Nomi 对话的模型分配
    expect(r.getByTestId('cli-source-menu').getAttribute('data-source')).toBe('official');
    expect(
      r.getByTestId('cli-source-menu').querySelector('[role="combobox"]')!.textContent,
    ).not.toContain('Amux');
  });

  it('Nomi main tab renders the Nomi provider switcher', async () => {
    mockIpc({ tabs: tabsState('main') });
    const r = render(
      <HarnessTabsProvider>
        <>
          <EndpointControls />
          <SessionControls onManageNomi={() => undefined} onOpenModels={() => undefined} />
        </>
      </HarnessTabsProvider>,
    );
    await waitFor(() => expect(r.getByTestId('nomi-model-switch')).toBeTruthy());
    expect(r.getByTestId('nomi-model-switch').textContent).toContain('Amux / gpt-x');
    expect(r.queryByTestId('cli-source-menu')).toBeNull();
  });
});
