// @vitest-environment happy-dom
import { t } from '@nomi-ai/ui';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetConfirmDialogForTest } from '../src/components/ConfirmDialog';
import { EndpointControls } from '../src/components/EndpointControls';
import { ManagedRuntimeDock } from '../src/components/ManagedRuntimeDock';
import { NomiModelSwitch } from '../src/components/NomiModelSwitch';
import { HarnessTabsProvider } from '../src/contexts/HarnessTabsContext';
import { ManagedRuntimeProvider } from '../src/contexts/ManagedRuntimeContext';
import { clearManagedDefaultRuntime, setChatMode } from '../src/services/chatPrefs';
import type { ChatMessage } from '../src/types/chat';

import { installFakeApi, resetFakeApi } from './helpers/fakeApi';

vi.mock('../src/services/api', async () => (await import('./helpers/fakeApi')).fakeApiModule());

const harness = vi.hoisted(() => {
  const convo = {
    id: 'c1',
    backend: 'nomi',
    projectId: 'p1',
  } as { id: string; backend: string; projectId?: string; reasoningEffort?: string };
  const store = {
    isNomi: (id: string) => id === convo.id,
    get: (id: string) => (id === convo.id ? convo : undefined),
    currentId: () => convo.id,
    defaultNomiProject: () => convo.projectId,
    updateMeta: vi.fn((id: string, patch: Record<string, unknown>) => {
      if (id === convo.id) Object.assign(convo, patch);
    }),
    flush: vi.fn(async () => undefined),
    refreshManaged: vi.fn(async () => undefined),
  };
  const ipcClient = {
    currentConversationId: () => convo.id,
    conversationStore: () => store,
    ensureConversationId: () => convo.id,
  };
  const state = {
    messages: [] as ChatMessage[],
    ipcClient,
  };
  return { convo, store, ipcClient, state };
});

vi.mock('../src/contexts/AiChatContext', () => ({
  useAiChat: () => ({
    state: harness.state,
    actions: { newConversation: async () => undefined },
    dispatch: () => undefined,
  }),
}));

const bridges = {
  computer: { status: 'unsupported' as const, detail: 'No computer use' },
  mcp: { status: 'unsupported' as const, detail: 'No MCP' },
  persona: { status: 'degraded' as const, detail: 'No persona' },
  memory: { status: 'degraded' as const, detail: 'Handoff only' },
  knowledge: { status: 'unsupported' as const, detail: 'No KB' },
  skills: { status: 'degraded' as const, detail: 'No skills' },
  attachments: { status: 'unsupported' as const, detail: 'No attachments' },
};

const gatewayWithProviders = {
  status: { state: 'running', port: 1, url: 'http://127.0.0.1:1' },
  providers: [
    {
      id: 'amux',
      name: 'Amux',
      enabled: true,
      urls: { chat: 'https://gateway.amux.ai/v1' },
      keys: [],
      models: [
        {
          id: 'gpt-5',
          label: 'GPT-5',
          enabled: true,
          effective: {
            ctx: 1,
            maxOutput: 1,
            source: 'catalog',
            maxOutputSource: 'catalog',
            thinking: { control: 'effort', levels: ['low', 'medium', 'high'], default: 'medium' },
          },
        },
      ],
      source: 'user',
    },
  ],
  clients: { nomi: { models: { main: 'amux/gpt-5' } } },
  allowedPrivateHosts: [],
  port: 1,
};

const gatewayWithoutProviders = {
  status: { state: 'running', port: 1, url: 'http://127.0.0.1:1' },
  providers: [],
  clients: { nomi: { models: {} } },
  allowedPrivateHosts: [],
  port: 1,
};

function setupBackendApi(opts?: {
  gateway?: Record<string, unknown>;
  initialManaged?: boolean;
  initialBackend?: string;
  initialSource?: 'local' | 'official' | 'thirdParty';
  initialModel?: string;
  initialAccountId?: string;
  choices?: Array<Record<string, unknown>>;
  cliAccounts?: Array<Record<string, unknown>>;
  catalogResolver?: (input?: {
    backend?: string;
    source?: string;
    refresh?: boolean;
  }) => Record<string, unknown> | undefined;
}) {
  let managed = opts?.initialManaged ?? false;
  type Cfg = { source?: string; model: string; accountId?: string; effort: string };
  const initialB = opts?.initialBackend ?? 'claude';
  const backendConfigs = new Map<string, Cfg>([
    [
      initialB,
      {
        source: opts?.initialSource,
        model: opts?.initialModel ?? 'cli-default',
        accountId: opts?.initialAccountId,
        effort: '',
      },
    ],
  ]);
  let runtimeState: Record<string, unknown> & {
    backend: string;
    generation: number;
    source?: string;
    model?: string;
    accountId?: string;
    permissionMode: string;
    effort: string;
    capabilities: {
      resume: boolean;
      cancel: boolean;
      approval: boolean;
      attachments: boolean;
      permissionModes: string[];
      degraded: string[];
      bridges: typeof bridges;
    };
  } = {
    id: 'c1',
    backend: initialB,
    source: opts?.initialSource,
    generation: 1,
    phase: 'idle',
    queued: 0,
    partial: '',
    detail: '',
    approvals: [],
    recovery: 'none',
    model: opts?.initialModel ?? 'cli-default',
    accountId: opts?.initialAccountId,
    permissionMode: 'ask',
    effort: '',
    capabilities: {
      resume: true,
      cancel: true,
      approval: true,
      attachments: false,
      permissionModes: ['ask'],
      degraded: [],
      bridges,
    },
  };
  const choices = opts?.choices ?? [
    {
      id: 'api',
      available: true,
      status: 'requires-provider',
      detail: '',
      login: 'not-applicable',
      requiresProject: false,
      degraded: [],
      models: [{ id: 'chat-route', label: 'Gateway Default' }],
      permissionModes: ['ask', 'acceptEdits', 'bypass', 'deny'],
      bridges,
    },
    {
      id: 'claude',
      available: true,
      status: 'ready',
      detail: '',
      login: 'unverified',
      requiresProject: true,
      degraded: [],
      models: [
        { id: 'cli-default', label: 'CLI Default' },
        { id: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5' },
      ],
      permissionModes: ['ask'],
      bridges,
    },
    {
      id: 'gemini',
      available: true,
      status: 'ready',
      detail: '',
      login: 'unverified',
      requiresProject: true,
      degraded: [],
      models: [{ id: 'cli-default', label: 'CLI Default' }],
      permissionModes: ['ask'],
      bridges,
    },
    {
      id: 'antigravity',
      available: true,
      status: 'ready',
      detail: '',
      login: 'unverified',
      requiresProject: true,
      degraded: [],
      models: [{ id: 'cli-default', label: 'CLI Default' }],
      permissionModes: ['ask'],
      bridges,
    },
    {
      id: 'codex',
      available: false,
      status: 'missing-executable',
      detail: '',
      login: 'not-advertised',
      requiresProject: true,
      degraded: [],
    },
  ];
  const fake = installFakeApi((name, input) => {
    if (name === 'gateway.state') return opts?.gateway ?? gatewayWithProviders;
    if (name === 'providers.state') return { overrideId: null, effectiveModel: '' };
    if (name === 'cliAccount.list') {
      const kind = input?.kind as string | undefined;
      return (opts?.cliAccounts ?? []).filter((a) => !kind || !a.kind || a.kind === kind);
    }
    if (name === 'harness.modelCatalog') {
      return (
        opts?.catalogResolver?.(
          input as { backend?: string; source?: string; refresh?: boolean } | undefined,
        ) ?? {}
      );
    }
    if (name === 'harness.tabs') {
      return {
        tabs: [{ id: 'main', backend: 'nomi', cwd: '/w', title: '', permissionMode: 'auto' }],
        activeTabId: 'main',
        running: 0,
        queued: 0,
      };
    }
    if (name === 'harness.state') {
      return { backend: 'nomi', cwd: '/w', permissionMode: 'auto', bins: {} };
    }
    if (name === 'project.list') {
      return [
        { id: 'p1', name: 'nomi-ai', primary: '/w', folders: ['/w'], createdAt: 1, updatedAt: 1 },
      ];
    }
    if (name === 'conversations.state') {
      return { conversations: [], managed: managed ? ['c1'] : [] };
    }
    if (name === 'conversations.runtimeCapabilities') {
      return {
        supported: true,
        backends: ['api', 'claude', 'gemini', 'antigravity'],
        detail: '',
        choices,
      };
    }
    if (name === 'conversations.runtimeState') {
      const activeChoice = choices.find((c) => c.id === runtimeState.backend);
      return {
        ...runtimeState,
        capabilities: {
          ...runtimeState.capabilities,
          permissionModes: (activeChoice?.permissionModes as string[] | undefined) ?? ['ask'],
        },
      };
    }
    if (name === 'conversations.runtimeAdopt') {
      managed = true;
      const b = input.backend as string;
      const cfg: Cfg = {
        source: (input.source as string | undefined) ?? 'local',
        model: (input.model as string | undefined) ?? 'cli-default',
        accountId: input.accountId as string | undefined,
        effort: (input.effort as string | undefined) ?? '',
      };
      backendConfigs.set(b, cfg);
      runtimeState = {
        ...runtimeState,
        backend: b,
        ...cfg,
        generation: runtimeState.generation + 1,
      };
      return runtimeState;
    }
    if (name === 'conversations.runtimeSwitch') {
      const nextBackend = (input.backend as string | undefined) ?? runtimeState.backend;
      const baseCfg: Cfg = backendConfigs.get(nextBackend) ?? {
        source: 'local',
        model: 'cli-default',
        accountId: undefined,
        effort: '',
      };
      const prevSource = baseCfg.source;
      const nextSource = input.source !== undefined ? (input.source as string) : prevSource;
      const sourceChanged = input.source !== undefined && input.source !== prevSource;
      let nextModel = sourceChanged ? 'cli-default' : baseCfg.model;
      let nextAccount = sourceChanged ? undefined : baseCfg.accountId;
      let nextEffort = sourceChanged ? '' : baseCfg.effort;
      if (input.model !== undefined) nextModel = input.model as string;
      if (input.accountId !== undefined) {
        nextAccount = input.accountId === 'default' ? undefined : (input.accountId as string);
      }
      if (nextSource === 'official' && !nextAccount) {
        const firstAcc = (opts?.cliAccounts ?? []).find((a) => !a.kind || a.kind === nextBackend);
        if (firstAcc?.id) nextAccount = firstAcc.id as string;
      }
      if (input.effort !== undefined) {
        nextEffort = input.effort === 'default' ? '' : (input.effort as string);
      }
      const nextCfg: Cfg = {
        source: nextSource,
        model: nextModel,
        accountId: nextAccount,
        effort: nextEffort,
      };
      backendConfigs.set(nextBackend, nextCfg);
      runtimeState = {
        ...runtimeState,
        backend: nextBackend,
        ...nextCfg,
        generation: runtimeState.generation + 1,
        ...(input.permissionMode !== undefined
          ? { permissionMode: input.permissionMode as string }
          : {}),
      };
      return runtimeState;
    }
    return {};
  });
  return fake;
}

function mountComposer() {
  return render(
    <HarnessTabsProvider>
      <ManagedRuntimeProvider conversationId="c1" hidden={false}>
        <ManagedRuntimeDock />
        <EndpointControls />
      </ManagedRuntimeProvider>
    </HarnessTabsProvider>,
  );
}

beforeEach(() => {
  clearManagedDefaultRuntime();
  setChatMode('dev');
  harness.convo.projectId = 'p1';
  harness.convo.reasoningEffort = undefined;
  harness.state.messages = [];
});

afterEach(() => {
  cleanup();
  resetConfirmDialogForTest();
  resetFakeApi();
});

describe('Composer runtime switching (scheme 1)', () => {
  it('stays completely invisible at rest and puts runtime row at the bottom inside the popover', async () => {
    const fake = setupBackendApi();
    mountComposer();

    await waitFor(() => {
      const chip = screen.getByTestId('nomi-model-chip');
      expect(chip.textContent).toContain('GPT-5');
      expect(chip.querySelector('[data-testid="endpoint-icon-nomi"]')).toBeTruthy();
      expect(chip.querySelector('[data-testid="nomi-model-chip-sep"]')).toBeTruthy();
      expect(chip.querySelector('[data-brand="openai"]')).toBeTruthy();
    });
    expect(screen.queryByTestId('managed-runtime-dock')).toBeNull();

    fireEvent.click(screen.getByTestId('nomi-model-chip'));
    const runtimeRow = await waitFor(() => screen.getByTestId('nomi-model-runtime-open'));
    expect(runtimeRow.textContent).toContain('底座');
    expect(runtimeRow.textContent).toContain('Nomi');

    // 底座行应位于推理强度视图最下方，在模型行与第三方供应商行之后；模型行展示模型品牌图标而非底座图标
    const effortView = screen.getByTestId('nomi-effort-view');
    const modelRow = screen.getByTestId('nomi-model-open');
    const providerRow = screen.getByTestId('nomi-model-provider-open');
    const children = Array.from(effortView.children);
    expect(effortView.lastElementChild).toBe(runtimeRow);
    expect(children.indexOf(modelRow)).toBeLessThan(children.indexOf(runtimeRow));
    expect(children.indexOf(providerRow)).toBeLessThan(children.indexOf(runtimeRow));
    expect(modelRow.querySelector('[data-testid^="endpoint-icon-"]')).toBeNull();
    expect(modelRow.querySelector('[data-brand="openai"]')).toBeTruthy();

    // 点开底座页并无确认框直接切换到 Claude Code（空会话）
    fireEvent.click(runtimeRow);
    expect(screen.getByTestId('runtime-option-api').textContent).toContain('内置底座');
    const codexOpt = screen.getByTestId('runtime-option-codex');
    expect(codexOpt.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(codexOpt);
    expect(fake.inputs('conversations.runtimeAdopt')).toHaveLength(0);

    fireEvent.click(screen.getByTestId('runtime-option-claude'));
    await waitFor(() => {
      expect(fake.inputs('conversations.runtimeAdopt')).toContainEqual({
        id: 'c1',
        backend: 'claude',
        confirm: true,
      });
    });

    // 切到 Claude Code 本机默认（无具体模型）后：胶囊只展示底座图标且无竖线分隔；左下角权限同步为每次确认
    await waitFor(() => {
      const chip = screen.getByTestId('nomi-model-chip');
      expect(chip.textContent).toContain('Claude Code');
      expect(chip.textContent).not.toContain('CLI Default');
      expect(chip.firstElementChild?.getAttribute('data-testid')).toBe('endpoint-icon-claude');
      expect(chip.querySelector('[data-testid="nomi-model-chip-sep"]')).toBeNull();
      expect(screen.getByTestId('permission-mode-chip').getAttribute('data-mode')).toBe('manual');
    });

    // 浮层内模型行在未选具体模型时不展示底座图标，底座行仍在最下方
    const cliModelRow = await waitFor(() => screen.getByTestId('nomi-model-open'));
    const cliEffortView = screen.getByTestId('nomi-effort-view');
    const cliRuntimeRow = screen.getByTestId('nomi-model-runtime-open');
    expect(cliModelRow.querySelector('[data-testid="endpoint-icon-claude"]')).toBeNull();
    expect(cliModelRow.textContent).toContain(t('ui.providers-schedule.default-model'));
    expect(cliEffortView.lastElementChild).toBe(cliRuntimeRow);
  });

  it('asks for confirmation when switching runtimes on a conversation with existing messages', async () => {
    harness.state.messages = [{ id: 'm1', role: 'user', content: 'hello', timestamp: 1 }];
    const fake = setupBackendApi({ initialManaged: true, initialBackend: 'claude' });
    mountComposer();

    await waitFor(() => {
      expect(screen.getByTestId('nomi-model-chip').textContent).toContain('Claude Code');
    });

    fireEvent.click(screen.getByTestId('nomi-model-chip'));
    fireEvent.click(screen.getByTestId('nomi-model-runtime-open'));
    fireEvent.click(screen.getByTestId('runtime-option-api'));

    // 应弹出 ConfirmDialog（确认按钮 testid 为 confirm-dialog-ok）
    const confirmBtn = await waitFor(() => screen.getByTestId('confirm-dialog-ok'));
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      expect(fake.inputs('conversations.runtimeSwitch')).toContainEqual(
        expect.objectContaining({ id: 'c1', backend: 'api', confirm: true }),
      );
    });
  });

  it('supports CLI model/effort changes, effort reset to default, omits capability matrix details, and hides model row for single-model CLIs', async () => {
    const fake = setupBackendApi({ initialManaged: true, initialBackend: 'claude' });
    mountComposer();

    await waitFor(() => {
      expect(screen.getByTestId('nomi-model-chip').textContent).toContain('Claude Code');
    });

    fireEvent.click(screen.getByTestId('nomi-model-chip'));
    // 已彻底移除能力说明与底座底部登录提示
    expect(screen.queryByTestId('nomi-model-details-open')).toBeNull();
    expect(document.body.textContent).not.toContain('能力说明');
    expect(document.body.textContent).not.toContain('发送时由官方 CLI 使用本机登录');

    // 切换模型到 Claude Sonnet 4.5（同品牌：胶囊去重仅显示 Claude Code 图标，模型行展示 Claude 品牌图标）
    fireEvent.click(screen.getByTestId('nomi-model-open'));
    fireEvent.click(screen.getByTestId('managed-model-claude-sonnet-4-5'));
    await waitFor(() => {
      expect(fake.inputs('conversations.runtimeSwitch')).toContainEqual(
        expect.objectContaining({ backend: 'claude', model: 'claude-sonnet-4-5' }),
      );
    });
    await waitFor(() => {
      const chip = screen.getByTestId('nomi-model-chip');
      expect(chip.textContent).toContain('Claude Sonnet 4.5');
      expect(chip.querySelector('[data-testid="endpoint-icon-claude"]')).toBeTruthy();
      expect(chip.querySelector('[data-testid="nomi-model-chip-sep"]')).toBeNull();
      expect(chip.querySelector('[data-brand="claude"]')).toBeNull();
    });
    const claudeModelRow = screen.getByTestId('nomi-model-open');
    expect(claudeModelRow.querySelector('[data-brand="claude"]')).toBeTruthy();
    expect(claudeModelRow.querySelector('[data-testid="endpoint-icon-claude"]')).toBeNull();

    // 设高强度并恢复默认（传 effort: 'default'）
    const highTick = screen.getByText('高');
    fireEvent.click(highTick);
    await waitFor(() => {
      expect(fake.inputs('conversations.runtimeSwitch')).toContainEqual(
        expect.objectContaining({ backend: 'claude', effort: 'high' }),
      );
    });
    const restoreBtn = await waitFor(() => screen.getByTestId('nomi-effort-default'));
    fireEvent.click(restoreBtn);
    await waitFor(() => {
      expect(fake.inputs('conversations.runtimeSwitch')).toContainEqual(
        expect.objectContaining({ backend: 'claude', effort: 'default' }),
      );
    });

    // 切到仅包含 cli-default 的 Gemini CLI 后，模型行隐藏
    fireEvent.click(screen.getByTestId('nomi-model-runtime-open'));
    fireEvent.click(screen.getByTestId('runtime-option-gemini'));
    await waitFor(() => {
      expect(screen.getByTestId('nomi-model-chip').textContent).toContain('Gemini CLI');
    });
    expect(screen.queryByTestId('nomi-model-open')).toBeNull();
  });

  it('keeps chip interactive without API providers and prompts inline project selection for no-project CLIs', async () => {
    harness.convo.projectId = undefined;
    const fake = setupBackendApi({
      gateway: gatewayWithoutProviders,
      choices: [
        {
          id: 'api',
          available: true,
          status: 'requires-provider',
          detail: '',
          login: 'not-applicable',
          requiresProject: false,
          degraded: [],
        },
        {
          id: 'claude',
          available: false,
          status: 'no-project',
          detail: '',
          login: 'not-advertised',
          requiresProject: true,
          degraded: [],
        },
      ],
    });
    mountComposer();

    const chip = await waitFor(() => screen.getByTestId('nomi-model-chip') as HTMLButtonElement);
    expect(chip.disabled).toBe(false);
    fireEvent.click(chip);

    // 无 API 供应商时直接停在底座列表页
    const claudeOpt = await waitFor(() => screen.getByTestId('runtime-option-claude'));
    expect(claudeOpt.getAttribute('aria-disabled')).toBeNull();
    fireEvent.click(claudeOpt);

    // 内联出现选项目引导
    await waitFor(() => {
      expect(screen.getByTestId('runtime-project-prompt')).toBeTruthy();
    });
    expect(fake.inputs('conversations.runtimeAdopt')).toHaveLength(0);

    // 通过内联 ProjectPicker 选择项目 p1 后自动 adopt 并平滑切回主视图
    fireEvent.click(screen.getByTestId('runtime-project-picker-button'));
    const projectItem = await waitFor(() => screen.getByTestId('project-picker-item'));
    fireEvent.click(projectItem);

    await waitFor(() => {
      expect(fake.inputs('conversations.runtimeAdopt')).toContainEqual({
        id: 'c1',
        backend: 'claude',
        confirm: true,
      });
    });
    await waitFor(() => {
      expect(screen.getByTestId('nomi-effort-view')).toBeTruthy();
      expect(screen.getByTestId('nomi-model-chip').textContent).toContain('Claude Code');
    });
  });

  it('prompts bypass confirmation in managed API mode and passes confirmUnsafe=true', async () => {
    const fake = setupBackendApi({ initialManaged: true, initialBackend: 'api' });
    mountComposer();

    const permChip = await waitFor(() => screen.getByTestId('permission-mode-chip'));
    fireEvent.click(permChip);
    fireEvent.click(await waitFor(() => screen.getByTestId('permission-mode-bypass')));

    const okBtn = await waitFor(() => screen.getByTestId('confirm-dialog-ok'));
    fireEvent.click(okBtn);

    await waitFor(() => {
      expect(fake.inputs('conversations.runtimeSwitch')).toContainEqual(
        expect.objectContaining({
          id: 'c1',
          backend: 'api',
          permissionMode: 'bypass',
          confirmUnsafe: true,
        }),
      );
    });
  });

  it('does not render runtime row in SideChat binding mode', async () => {
    setupBackendApi();
    render(
      <ManagedRuntimeProvider conversationId="c1" hidden={false}>
        <NomiModelSwitch
          binding={{
            model: 'amux/gpt-5',
            onModel: vi.fn(),
            effort: undefined,
            onEffort: vi.fn(),
            menuKey: 'side-1',
            testPrefix: 'side',
          }}
        />
      </ManagedRuntimeProvider>,
    );

    const chip = await waitFor(() => screen.getByTestId('side-model-chip'));
    expect(chip.querySelector('[data-testid="endpoint-icon-nomi"]')).toBeNull();
    expect(chip.querySelector('[data-testid="side-model-chip-sep"]')).toBeNull();
    expect(chip.querySelector('[data-brand="openai"]')).toBeTruthy();
    fireEvent.click(chip);
    expect(screen.getByTestId('side-effort-view')).toBeTruthy();
    expect(screen.queryByTestId('side-model-runtime-open')).toBeNull();
  });

  it('supports tri-state source switching (local / official accounts / thirdParty providers & models) on Claude', async () => {
    const multiGateway = {
      status: { state: 'running', port: 1, url: 'http://127.0.0.1:1' },
      providers: [
        gatewayWithProviders.providers[0],
        {
          id: 'deep',
          name: 'DeepX',
          enabled: true,
          urls: { chat: 'https://deep.example.com/v1' },
          keys: [],
          models: [
            {
              id: 'ds-reasoner',
              label: 'DeepSeek Reasoner',
              enabled: true,
              effective: {
                ctx: 1,
                maxOutput: 1,
                source: 'catalog',
                maxOutputSource: 'catalog',
                thinking: {
                  control: 'effort',
                  levels: ['low', 'medium', 'high'],
                  default: 'medium',
                },
              },
            },
          ],
          source: 'user',
        },
      ],
      clients: {
        nomi: { models: { main: 'amux/gpt-5' } },
        claude: { models: { main: 'amux/gpt-5' } },
      },
      allowedPrivateHosts: [],
      port: 1,
    };
    const fake = setupBackendApi({
      gateway: multiGateway,
      initialManaged: true,
      initialBackend: 'claude',
      initialSource: 'local',
      cliAccounts: [
        {
          id: 'acc-1',
          kind: 'claude',
          label: 'Work',
          active: true,
          loggedIn: true,
          identity: null,
          inUse: 0,
          createdAt: 1,
        },
        {
          id: 'acc-2',
          kind: 'claude',
          label: 'Personal',
          active: false,
          loggedIn: true,
          identity: null,
          inUse: 0,
          createdAt: 2,
        },
      ],
    });
    mountComposer();

    await waitFor(() => {
      expect(screen.getByTestId('nomi-model-chip').textContent).toContain('Claude Code');
    });

    fireEvent.click(screen.getByTestId('nomi-model-chip'));
    await waitFor(() => {
      expect(fake.inputs('cliAccount.list').length).toBeGreaterThan(0);
    });
    expect(screen.getByTestId('managed-source-local')).toBeTruthy();
    expect(screen.getByTestId('managed-source-official')).toBeTruthy();
    expect(screen.getByTestId('managed-source-thirdParty')).toBeTruthy();
    // local 下不显示官方账号行与第三方供应商行，胶囊仅显示底座图标、无竖线分隔；模型行不含底座图标；底座行在最下方
    expect(screen.queryByTestId('account-open')).toBeNull();
    expect(screen.queryByTestId('nomi-model-provider-open')).toBeNull();
    expect(
      screen.getByTestId('nomi-model-chip').firstElementChild?.getAttribute('data-testid'),
    ).toBe('endpoint-icon-claude');
    expect(
      screen.getByTestId('nomi-model-chip').querySelector('[data-testid="nomi-model-chip-sep"]'),
    ).toBeNull();
    expect(
      screen.getByTestId('nomi-model-open').querySelector('[data-testid="endpoint-icon-claude"]'),
    ).toBeNull();
    expect(screen.getByTestId('nomi-effort-view').lastElementChild).toBe(
      screen.getByTestId('nomi-model-runtime-open'),
    );

    // 1. 切换到官方账号并切换多账号
    fireEvent.click(screen.getByTestId('managed-source-official'));
    await waitFor(() => {
      expect(fake.inputs('conversations.runtimeSwitch')).toContainEqual(
        expect.objectContaining({ backend: 'claude', source: 'official', accountId: 'acc-1' }),
      );
    });
    expect(
      screen.getByTestId('nomi-model-chip').firstElementChild?.getAttribute('data-testid'),
    ).toBe('endpoint-icon-claude');
    expect(
      screen.getByTestId('nomi-model-chip').querySelector('[data-testid="nomi-model-chip-sep"]'),
    ).toBeNull();
    expect(
      screen.getByTestId('nomi-model-open').querySelector('[data-testid="endpoint-icon-claude"]'),
    ).toBeNull();
    expect(screen.getByTestId('nomi-effort-view').lastElementChild).toBe(
      screen.getByTestId('nomi-model-runtime-open'),
    );
    const accOpen = await waitFor(() => screen.getByTestId('account-open'));
    fireEvent.click(accOpen);
    fireEvent.click(screen.getByTestId('account-acc-2'));
    await waitFor(() => {
      expect(fake.inputs('conversations.runtimeSwitch')).toContainEqual(
        expect.objectContaining({ backend: 'claude', accountId: 'acc-2' }),
      );
    });
    expect(screen.queryByTestId('nomi-model-provider-open')).toBeNull();

    // 2. 切换到第三方来源：展示第三方供应商行、多供应商 ModelPicker 与网关思考深度；胶囊展示双图标+竖线；模型行展示模型品牌图标而非底座图标
    fireEvent.click(screen.getByTestId('managed-source-thirdParty'));
    await waitFor(() => {
      expect(fake.inputs('conversations.runtimeSwitch')).toContainEqual(
        expect.objectContaining({ backend: 'claude', source: 'thirdParty', model: 'amux/gpt-5' }),
      );
    });
    await waitFor(() => {
      const chip = screen.getByTestId('nomi-model-chip');
      expect(chip.firstElementChild?.getAttribute('data-testid')).toBe('endpoint-icon-claude');
      expect(chip.querySelector('[data-testid="nomi-model-chip-sep"]')).toBeTruthy();
      expect(chip.querySelector('[data-brand="openai"]')).toBeTruthy();
      expect(chip.textContent).toContain('GPT-5');
    });
    const tpModelRow = screen.getByTestId('nomi-model-open');
    expect(tpModelRow.querySelector('[data-testid="endpoint-icon-claude"]')).toBeNull();
    const tpModelIcon = tpModelRow.querySelector('[data-brand="openai"]');
    expect(tpModelIcon).toBeTruthy();
    expect(tpModelIcon?.nextElementSibling?.textContent).toBe('GPT-5');
    expect(screen.queryByTestId('account-open')).toBeNull();
    const provOpen = await waitFor(() => screen.getByTestId('nomi-model-provider-open'));
    expect(screen.getByTestId('nomi-effort-view').lastElementChild).toBe(
      screen.getByTestId('nomi-model-runtime-open'),
    );
    fireEvent.click(provOpen);
    fireEvent.click(screen.getByTestId('provider-deep'));
    fireEvent.click(await waitFor(() => screen.getByTestId('model-deep/ds-reasoner')));
    await waitFor(() => {
      expect(fake.inputs('conversations.runtimeSwitch')).toContainEqual(
        expect.objectContaining({ backend: 'claude', model: 'deep/ds-reasoner' }),
      );
    });
    fireEvent.click(screen.getByText('高'));
    await waitFor(() => {
      expect(fake.inputs('conversations.runtimeSwitch')).toContainEqual(
        expect.objectContaining({ backend: 'claude', effort: 'high' }),
      );
    });

    // 3. 切回 local 后隐藏第三方供应商行与账号行
    fireEvent.click(screen.getByTestId('managed-source-local'));
    await waitFor(() => {
      expect(fake.inputs('conversations.runtimeSwitch')).toContainEqual(
        expect.objectContaining({ backend: 'claude', source: 'local' }),
      );
    });
    await waitFor(() => {
      expect(screen.queryByTestId('nomi-model-provider-open')).toBeNull();
      expect(screen.queryByTestId('account-open')).toBeNull();
    });
  });

  it('supports dual-source (local & thirdParty only) on Gemini and single-source without tabs on Antigravity', async () => {
    const fake = setupBackendApi({
      initialManaged: true,
      initialBackend: 'gemini',
      initialSource: 'local',
    });
    mountComposer();

    await waitFor(() => {
      expect(screen.getByTestId('nomi-model-chip').textContent).toContain('Gemini CLI');
    });

    fireEvent.click(screen.getByTestId('nomi-model-chip'));
    // Gemini 仅有本机和第三方，无官方账号选项；local 下无思考深度时直接隐藏整块（不显示不可用提示）且无单模型行
    expect(screen.getByTestId('managed-source-local')).toBeTruthy();
    expect(screen.queryByTestId('managed-source-official')).toBeNull();
    expect(screen.getByTestId('managed-source-thirdParty')).toBeTruthy();
    expect(screen.queryByTestId('nomi-effort-unavailable')).toBeNull();
    expect(screen.queryByTestId('nomi-effort-hint')).toBeNull();
    expect(screen.queryByTestId('nomi-effort-slider')).toBeNull();
    expect(document.body.textContent).not.toContain('没有文档化的思考深度控制');
    expect(screen.queryByTestId('nomi-model-open')).toBeNull();

    // 切到第三方后出现模型、第三方供应商行与网关思考深度滑杆
    fireEvent.click(screen.getByTestId('managed-source-thirdParty'));
    await waitFor(() => {
      expect(fake.inputs('conversations.runtimeSwitch')).toContainEqual(
        expect.objectContaining({ backend: 'gemini', source: 'thirdParty', model: 'amux/gpt-5' }),
      );
    });
    await waitFor(() => {
      expect(screen.getByTestId('nomi-model-open')).toBeTruthy();
      expect(screen.getByTestId('nomi-model-provider-open')).toBeTruthy();
      expect(screen.getByTestId('nomi-effort-view')).toBeTruthy();
      expect(screen.queryByTestId('nomi-effort-unavailable')).toBeNull();
    });

    // 切换到单态底座 Antigravity 后不渲染来源分段条
    fireEvent.click(screen.getByTestId('nomi-model-runtime-open'));
    fireEvent.click(screen.getByTestId('runtime-option-antigravity'));
    await waitFor(() => {
      expect(screen.getByTestId('nomi-model-chip').textContent).toContain('Antigravity');
    });
    expect(screen.queryByTestId('managed-source-tabs')).toBeNull();
  });

  it('renders catalog error notice and refreshes catalog on click without crashing chip', async () => {
    const fake = setupBackendApi({
      initialManaged: true,
      initialBackend: 'claude',
      initialSource: 'local',
      catalogResolver: (input) => ({
        backend: input?.backend ?? 'claude',
        models: [],
        defaultModel: null,
        error: 'auth expired',
      }),
    });
    mountComposer();

    await waitFor(() => {
      expect(screen.getByTestId('nomi-model-chip').textContent).toContain('Claude Code');
    });

    fireEvent.click(screen.getByTestId('nomi-model-chip'));
    fireEvent.click(await waitFor(() => screen.getByTestId('nomi-model-open')));
    expect(await waitFor(() => screen.getByTestId('model-error'))).toBeTruthy();

    fireEvent.click(screen.getByTestId('model-refresh'));
    await waitFor(() => {
      expect(fake.inputs('harness.modelCatalog')).toContainEqual(
        expect.objectContaining({ backend: 'claude', refresh: true }),
      );
    });
  });

  it('disables local source tab when hasLocalLogin is false and enables it when hasLocalLogin is true', async () => {
    const fake = setupBackendApi({
      initialManaged: true,
      initialBackend: 'gemini',
      initialSource: 'thirdParty',
      initialModel: 'amux/gpt-5',
      choices: [
        {
          id: 'api',
          available: true,
          status: 'requires-provider',
          detail: '',
          login: 'not-applicable',
          requiresProject: false,
          degraded: [],
          models: [{ id: 'chat-route', label: 'Gateway Default' }],
          permissionModes: ['ask'],
        },
        {
          id: 'gemini',
          available: true,
          status: 'ready',
          detail: '',
          login: 'unverified',
          requiresProject: true,
          hasLocalLogin: false,
          degraded: [],
          models: [{ id: 'cli-default', label: 'CLI Default' }],
          permissionModes: ['ask'],
        },
        {
          id: 'claude',
          available: true,
          status: 'ready',
          detail: '',
          login: 'unverified',
          requiresProject: true,
          hasLocalLogin: true,
          degraded: [],
          models: [{ id: 'cli-default', label: 'CLI Default' }],
          permissionModes: ['ask'],
        },
      ],
    });
    mountComposer();

    await waitFor(() => {
      expect(screen.getByTestId('nomi-model-chip').textContent).toContain('GPT-5');
    });

    fireEvent.click(screen.getByTestId('nomi-model-chip'));
    const localTab = await waitFor(
      () => screen.getByTestId('managed-source-local') as HTMLButtonElement,
    );
    expect(localTab.disabled).toBe(true);
    fireEvent.click(localTab);
    expect(fake.inputs('conversations.runtimeSwitch')).toHaveLength(0);

    // 切换到已检测到本机登录的 Claude：本机来源可用
    fireEvent.click(screen.getByTestId('nomi-model-runtime-open'));
    fireEvent.click(screen.getByTestId('runtime-option-claude'));
    const claudeLocalTab = await waitFor(
      () => screen.getByTestId('managed-source-local') as HTMLButtonElement,
    );
    expect(claudeLocalTab.disabled).toBe(false);
  });

  it('renders all 5 permission modes for grok and strips provider prefix from thirdParty catalog label', async () => {
    const fake = setupBackendApi({
      initialManaged: true,
      initialBackend: 'grok',
      initialSource: 'thirdParty',
      initialModel: 'amux/deepseek-v4.1-flash',
      choices: [
        {
          id: 'grok',
          available: true,
          status: 'ready',
          detail: '',
          login: 'unverified',
          requiresProject: true,
          hasLocalLogin: true,
          degraded: [],
          models: [{ id: 'cli-default', label: 'CLI Default' }],
          permissionModes: ['deny', 'ask', 'acceptEdits', 'auto', 'bypass'],
          bridges,
        },
      ],
      catalogResolver: (input) => ({
        backend: input?.backend ?? 'grok',
        models: [
          {
            id: 'amux/deepseek-v4.1-flash',
            label: 'Amux AI / deepseek-v4.1-flash',
          },
        ],
        defaultModel: 'amux/deepseek-v4.1-flash',
      }),
    });
    mountComposer();

    await waitFor(() => {
      const chip = screen.getByTestId('nomi-model-chip');
      const chipText = chip.textContent ?? '';
      expect(chipText).toContain('deepseek-v4.1-flash');
      expect(chipText).not.toContain('Amux AI');
      expect(chip.querySelector('[data-testid="endpoint-icon-grok"]')).toBeTruthy();
      expect(chip.querySelector('[data-testid="nomi-model-chip-sep"]')).toBeTruthy();
      expect(chip.querySelector('[data-brand="deepseek"]')).toBeTruthy();
    });

    fireEvent.click(screen.getByTestId('nomi-model-chip'));
    await waitFor(() => {
      const modelRow = screen.getByTestId('nomi-model-open');
      const rowText = modelRow.textContent ?? '';
      expect(rowText).toContain('deepseek-v4.1-flash');
      expect(rowText).not.toContain('Amux AI');
      expect(modelRow.querySelector('[data-brand="deepseek"]')).toBeTruthy();
      expect(modelRow.querySelector('[data-testid="endpoint-icon-grok"]')).toBeNull();
    });

    fireEvent.click(await waitFor(() => screen.getByTestId('permission-mode-chip')));
    for (const id of [
      'permission-mode-plan',
      'permission-mode-manual',
      'permission-mode-acceptEdits',
      'permission-mode-auto',
      'permission-mode-bypass',
    ]) {
      expect(screen.getByTestId(id)).toBeTruthy();
    }

    fireEvent.click(screen.getByTestId('permission-mode-auto'));
    await waitFor(() => {
      expect(fake.inputs('conversations.runtimeSwitch')).toContainEqual(
        expect.objectContaining({
          id: 'c1',
          backend: 'grok',
          permissionMode: 'auto',
        }),
      );
    });

    fireEvent.click(await waitFor(() => screen.getByTestId('permission-mode-chip')));
    fireEvent.click(await waitFor(() => screen.getByTestId('permission-mode-bypass')));
    fireEvent.click(await waitFor(() => screen.getByTestId('confirm-dialog-ok')));
    await waitFor(() => {
      expect(fake.inputs('conversations.runtimeSwitch')).toContainEqual(
        expect.objectContaining({
          id: 'c1',
          backend: 'grok',
          permissionMode: 'bypass',
          confirmUnsafe: true,
        }),
      );
    });
  });
});
