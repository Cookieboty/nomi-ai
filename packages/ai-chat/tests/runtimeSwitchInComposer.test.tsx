// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetConfirmDialogForTest } from '../src/components/ConfirmDialog';
import { EndpointControls } from '../src/components/EndpointControls';
import { ManagedRuntimeDock } from '../src/components/ManagedRuntimeDock';
import { NomiModelSwitch } from '../src/components/NomiModelSwitch';
import { HarnessTabsProvider } from '../src/contexts/HarnessTabsContext';
import { ManagedRuntimeProvider } from '../src/contexts/ManagedRuntimeContext';
import { setChatMode } from '../src/services/chatPrefs';
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
  gateway?: typeof gatewayWithProviders | typeof gatewayWithoutProviders;
  initialManaged?: boolean;
  initialBackend?: string;
  choices?: Array<Record<string, unknown>>;
}) {
  let managed = opts?.initialManaged ?? false;
  let runtimeState = {
    id: 'c1',
    backend: opts?.initialBackend ?? 'claude',
    generation: 1,
    phase: 'idle',
    queued: 0,
    partial: '',
    detail: '',
    approvals: [],
    recovery: 'none',
    model: 'cli-default',
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
      return { supported: true, backends: ['api', 'claude', 'gemini'], detail: '', choices };
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
      runtimeState = {
        ...runtimeState,
        backend: input.backend,
        generation: runtimeState.generation + 1,
      };
      return runtimeState;
    }
    if (name === 'conversations.runtimeSwitch') {
      runtimeState = {
        ...runtimeState,
        backend: input.backend ?? runtimeState.backend,
        generation: runtimeState.generation + 1,
        ...(input.model !== undefined ? { model: input.model } : {}),
        ...(input.permissionMode !== undefined ? { permissionMode: input.permissionMode } : {}),
        ...(input.effort !== undefined
          ? { effort: input.effort === 'default' ? '' : input.effort }
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
  it('stays completely invisible at rest and puts runtime row above effort inside the popover', async () => {
    const fake = setupBackendApi();
    mountComposer();

    await waitFor(() => {
      expect(screen.getByTestId('nomi-model-chip').textContent).toContain('GPT-5');
    });
    expect(screen.queryByTestId('managed-runtime-dock')).toBeNull();

    fireEvent.click(screen.getByTestId('nomi-model-chip'));
    const runtimeRow = await waitFor(() => screen.getByTestId('nomi-model-runtime-open'));
    expect(runtimeRow.textContent).toContain('底座');
    expect(runtimeRow.textContent).toContain('Nomi');

    // 底座行应位于推理强度视图最上方，在滑杆之前
    const effortView = screen.getByTestId('nomi-effort-view');
    expect(effortView.firstElementChild).toBe(runtimeRow);

    // 点开底座页并无确认框直接切换到 Claude Code（空会话）
    fireEvent.click(runtimeRow);
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

    // 切到 Claude Code 后：胶囊展示 Claude Code，绝不露出 CLI Default；左下角权限同步为每次确认
    await waitFor(() => {
      expect(screen.getByTestId('nomi-model-chip').textContent).toContain('Claude Code');
      expect(screen.getByTestId('nomi-model-chip').textContent).not.toContain('CLI Default');
      expect(screen.getByTestId('permission-mode-chip').getAttribute('data-mode')).toBe('manual');
    });
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

  it('supports CLI model/effort changes, effort reset to default, capability matrix details, and hides model row for single-model CLIs', async () => {
    const fake = setupBackendApi({ initialManaged: true, initialBackend: 'claude' });
    mountComposer();

    await waitFor(() => {
      expect(screen.getByTestId('nomi-model-chip').textContent).toContain('Claude Code');
    });

    fireEvent.click(screen.getByTestId('nomi-model-chip'));
    // 切换模型到 Claude Sonnet 4.5
    fireEvent.click(screen.getByTestId('nomi-model-open'));
    fireEvent.click(screen.getByTestId('managed-model-claude-sonnet-4-5'));
    await waitFor(() => {
      expect(fake.inputs('conversations.runtimeSwitch')).toContainEqual(
        expect.objectContaining({ backend: 'claude', model: 'claude-sonnet-4-5' }),
      );
    });
    await waitFor(() => {
      expect(screen.getByTestId('nomi-model-chip').textContent).toContain('Claude Sonnet 4.5');
    });

    // 点开能力说明二级页，可见 7 项能力边界
    fireEvent.click(screen.getByTestId('nomi-model-details-open'));
    expect(screen.getByTestId('managed-cap-computer')).toBeTruthy();
    expect(screen.getByTestId('managed-cap-attachments')).toBeTruthy();
    fireEvent.click(screen.getByTestId('nomi-model-details-back'));

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
    fireEvent.click(chip);
    expect(screen.getByTestId('side-effort-view')).toBeTruthy();
    expect(screen.queryByTestId('side-model-runtime-open')).toBeNull();
  });
});
