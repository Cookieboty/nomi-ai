// @vitest-environment happy-dom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AiSettingsSection } from '../src/components/AiSettingsSection';
import { RoutingTab } from '../src/components/AiSettingsSection/RoutingTab';
import { ModelsPage } from '../src/components/ModelsPage';
import { resetAutoRefreshedAccounts } from '../src/hooks/useCliAccounts';
import { resetAccountLabelCache } from '../src/services/cliAccountClient';
import type { GatewayState } from '../src/services/gatewayClient';

import { installFakeApi, resetFakeApi, untilIdle } from './helpers/fakeApi';

vi.mock('../src/services/api', async () => (await import('./helpers/fakeApi')).fakeApiModule());

beforeEach(() => {
  resetAccountLabelCache();
  resetAutoRefreshedAccounts();
});
afterEach(() => {
  resetAccountLabelCache();
  resetAutoRefreshedAccounts();
  cleanup();
  resetFakeApi();
});

function sampleGateway(): GatewayState {
  return {
    status: { state: 'running', port: 6129, url: 'http://127.0.0.1:6129' },
    providers: [
      {
        id: 'deep',
        name: 'DeepSeek',
        presetId: 'deepseek',
        enabled: true,
        urls: { chat: 'https://api.deepseek.com' },
        keys: [{ label: 'k1', masked: 'sk-***1', enabled: true, decryptable: true }],
        models: [
          { id: 'deepseek-chat', enabled: true, toolCalling: true },
          {
            id: 'deepseek-reasoner',
            enabled: true,
            toolCalling: true,
            effective: {
              thinking: {
                control: 'effort',
                levels: ['low', 'medium', 'high', 'xhigh'],
                default: 'medium',
              },
            },
          },
        ],
        source: 'user',
        createdAt: 0,
        updatedAt: 0,
      },
    ],
    clients: {
      nomi: { models: { main: 'deep/deepseek-chat' } },
      claude: { models: { main: 'deep/deepseek-chat' }, newTabSource: 'official' },
      codex: { models: {}, newTabSource: 'official' },
      dsh: { models: {}, newTabSource: 'thirdParty' },
      grok: { models: {}, newTabSource: 'official' },
      gemini: { models: {}, newTabSource: 'thirdParty' },
      kimi: { models: {}, newTabSource: 'official' },
      minimax: { models: {}, newTabSource: 'official' },
    },
    allowedPrivateHosts: [],
    port: 6129,
  } as unknown as GatewayState;
}

function sampleDelegateSettings() {
  return {
    enabled: true,
    defaults: {},
    defaultProfileId: 'default',
    installed: ['claude', 'codex', 'gemini'],
    localAvailable: { claude: true, codex: false },
    autoComplexity: true,
    presets: [
      {
        id: 'high',
        label: '高级攻坚',
        cli: 'claude',
        source: 'official',
        accountId: null,
        model: null,
        reasoningEffort: 'high',
        costTier: 'high',
      },
      {
        id: 'balanced',
        label: '均衡主力',
        cli: 'codex',
        source: 'official',
        accountId: null,
        model: null,
        reasoningEffort: 'medium',
        costTier: 'medium',
      },
      {
        id: 'low',
        label: '轻量省钱',
        cli: 'claude',
        source: 'thirdParty',
        accountId: null,
        model: 'deep/deepseek-chat',
        reasoningEffort: 'low',
        costTier: 'low',
      },
    ],
    routes: {
      complex: { kind: 'preset', presetId: 'high' },
      coding: { kind: 'preset', presetId: 'balanced' },
      review: { kind: 'preset', presetId: 'balanced' },
      research: { kind: 'preset', presetId: 'balanced' },
      simple: { kind: 'preset', presetId: 'low' },
      scheduled: { kind: 'preset', presetId: 'low' },
    },
    pinned: null,
  };
}

describe('AiSettingsSection RoutingTab & RunnerModelPicker & ModelsPage', () => {
  it('renders presets, edits via RunnerModelPicker with third-party & Gemini lock, and updates routes/autoComplexity', async () => {
    const gw = sampleGateway();
    let ds = sampleDelegateSettings();
    const fake = installFakeApi({
      'gateway.state': () => gw,
      'delegate.settings': () => ds,
      'delegate.setSettings': (input: { settings: typeof ds }) => {
        ds = { ...ds, ...input.settings };
        return true;
      },
      'cliAccount.list': (in_: { kind?: string }) =>
        in_?.kind === 'claude'
          ? [
              {
                id: 'acct-work',
                kind: 'claude',
                label: 'Work Pro',
                loggedIn: true,
                identity: { key: 'work@example.com', email: 'work@example.com', plan: 'Pro' },
                active: true,
                inUse: 0,
                createdAt: 0,
              },
            ]
          : in_?.kind === 'grok'
            ? [
                {
                  id: 'acct-grok-default',
                  kind: 'grok',
                  label: '官方账号',
                  loggedIn: true,
                  identity: null,
                  active: true,
                  inUse: 0,
                  createdAt: 0,
                },
              ]
            : [],
      'usage.state': () => ({ pricing: { builtin: [] } }),
      'cliUpdate.status': () => [],
      'harness.state': () => ({ bins: { claude: '/usr/bin/claude' }, tabs: [], activeId: 'nomi' }),
      'harness.modelCatalog': (in_: { backend: string }) =>
        in_.backend === 'claude'
          ? {
              backend: 'claude',
              defaultModel: {
                id: 'default',
                label: 'Sonnet 4.6',
                reasoning: true,
                efforts: ['low', 'medium', 'high'],
              },
              models: [
                {
                  id: 'claude-opus-4-6',
                  label: 'Opus 4.6',
                  reasoning: true,
                  efforts: ['low', 'medium', 'high', 'max'],
                  defaultEffort: 'medium',
                },
                {
                  id: 'claude-sonnet-4-6',
                  label: 'Sonnet 4.6',
                  reasoning: true,
                  efforts: ['low', 'medium', 'high'],
                },
                {
                  id: 'claude-3-5-haiku',
                  label: 'Haiku 3.5',
                  reasoning: false,
                  efforts: [],
                },
              ],
            }
          : null,
    });

    const r = render(<RoutingTab onOpenProviders={() => undefined} />);
    await untilIdle();
    await r.findByTestId('routing-preset-high');
    // 内置三档优先按前端 i18n 文案渲染（而非后端 raw label）
    expect(r.getByTestId('routing-preset-high').textContent).toContain('高级攻坚');
    expect(r.getByTestId('routing-preset-balanced').textContent).toContain('日常均衡');
    expect(r.getByTestId('routing-preset-low').textContent).toContain('轻量省钱');
    // 包含 prd 需求文档与单测路由行，Nomi 更多用途有可见按钮文案
    expect(r.getByTestId('routing-target-prd')).toBeTruthy();
    expect(r.getByTestId('routing-nomi-more').textContent).toContain('更多用途');

    // 打开编辑高阶预设：直接平铺展示官方账号且自动选中默认账号，验证官方模型思考深度随模型动态变化
    fireEvent.click(r.getByTestId('routing-preset-edit-high'));
    await r.findByTestId('runner-model-picker');
    expect(r.queryByTestId('runner-picker-official-default')).toBeNull();
    await waitFor(() =>
      expect(r.getByTestId('runner-picker-official-acct-work').getAttribute('data-selected')).toBe(
        'true',
      ),
    );
    const officialSelect = await waitFor(
      () => r.getByTestId('runner-picker-official-model') as HTMLSelectElement,
    );
    expect(officialSelect.tagName).toBe('SELECT');
    expect(officialSelect.options.length).toBe(4);
    // 切换为支持 max 档的 Opus 4.6，出现 max 档位按钮
    fireEvent.change(officialSelect, { target: { value: 'claude-opus-4-6' } });
    expect(r.getByTestId('runner-picker-effort-max')).toBeTruthy();
    // 切换为不支持思考深度的 Haiku 3.5，提示无思考深度且隐藏档位按钮
    fireEvent.change(officialSelect, { target: { value: 'claude-3-5-haiku' } });
    expect(r.getByTestId('runner-picker-effort-unavailable')).toBeTruthy();
    expect(r.queryByTestId('runner-picker-effort-group')).toBeNull();
    fireEvent.click(r.getByTestId('runner-picker-cancel'));

    // 打开编辑低成本预设（初始为非推理 deepseek-chat）：内嵌展示无思考深度提示；切换到 deepseek-reasoner 动态出现档位
    fireEvent.click(r.getByTestId('routing-preset-edit-low'));
    await r.findByTestId('runner-model-picker');
    expect(r.getByTestId('runner-picker-local')).toBeTruthy();
    expect(r.queryByTestId('runner-picker-official-default')).toBeNull();
    await waitFor(() => expect(r.getByTestId('runner-picker-official-acct-work')).toBeTruthy());
    expect(r.getByTestId('runner-picker-tp-picker-menu')).toBeTruthy();
    expect(r.getByTestId('runner-picker-effort-unavailable')).toBeTruthy();
    expect(r.queryByTestId('runner-picker-effort-low')).toBeNull();

    // 切换到既无本机登录也无官方账号的 codex：隐藏本机/官方账号选项，自动落到第三方
    fireEvent.click(r.getByTestId('runner-picker-cli-codex'));
    await waitFor(() => {
      expect(r.queryByTestId('runner-picker-local')).toBeNull();
      expect(r.queryByTestId('runner-picker-official-default')).toBeNull();
    });

    // 切换到账号名为「官方账号」的 grok：不出现「跟随默认账号」，也不出现「官方账号 · 官方账号」重复文案
    fireEvent.click(r.getByTestId('runner-picker-cli-grok'));
    const grokAccBtn = await waitFor(() =>
      r.getByTestId('runner-picker-official-acct-grok-default'),
    );
    expect(r.queryByTestId('runner-picker-official-default')).toBeNull();
    expect(grokAccBtn.textContent).toBe('官方账号');

    // 切换到只支持第三方的 gemini：隐藏本机/官方账号选项
    fireEvent.click(r.getByTestId('runner-picker-cli-gemini'));
    expect(r.queryByTestId('runner-picker-local')).toBeNull();
    expect(r.queryByTestId('runner-picker-official-default')).toBeNull();

    // 切回 claude，先选支持 4 档思考深度的 deepseek-reasoner，再测试切回不支持的 deepseek-chat 后不会残留旧档位，最终切回 deepseek-reasoner 选 low 保存
    fireEvent.click(r.getByTestId('runner-picker-cli-claude'));
    fireEvent.click(await r.findByTestId('runner-picker-tp-deep/deepseek-reasoner'));
    await waitFor(() => expect(r.getByTestId('runner-picker-effort-xhigh')).toBeTruthy());
    fireEvent.click(r.getByTestId('runner-picker-effort-low'));
    // 若切回不支持思考深度的模型，档位栏变为无思考深度提示
    fireEvent.click(r.getByTestId('runner-picker-tp-deep/deepseek-chat'));
    expect(r.getByTestId('runner-picker-effort-unavailable')).toBeTruthy();
    // 再次选 deepseek-reasoner + low 并保存
    fireEvent.click(r.getByTestId('runner-picker-tp-deep/deepseek-reasoner'));
    fireEvent.click(r.getByTestId('runner-picker-effort-low'));
    fireEvent.click(r.getByTestId('runner-picker-confirm'));

    await waitFor(() => {
      const saves = fake.inputs('delegate.setSettings') as Array<{
        settings: ReturnType<typeof sampleDelegateSettings>;
      }>;
      expect(saves.length).toBeGreaterThan(0);
      const updatedLow = saves.at(-1)!.settings.presets.find((p) => p.id === 'low');
      expect(updatedLow).toMatchObject({
        cli: 'claude',
        source: 'thirdParty',
        model: 'deep/deepseek-reasoner',
        reasoningEffort: 'low',
      });
    });

    // 再打开 low 预设切回无思考深度的 deepseek-chat 并保存：验证提交时已清洗 reasoningEffort 为 null
    fireEvent.click(r.getByTestId('routing-preset-edit-low'));
    await r.findByTestId('runner-model-picker');
    fireEvent.click(await r.findByTestId('runner-picker-tp-deep/deepseek-chat'));
    expect(r.getByTestId('runner-picker-effort-unavailable')).toBeTruthy();
    fireEvent.click(r.getByTestId('runner-picker-confirm'));
    await waitFor(() => {
      const saves = fake.inputs('delegate.setSettings') as Array<{
        settings: ReturnType<typeof sampleDelegateSettings>;
      }>;
      const updatedLow = saves.at(-1)!.settings.presets.find((p) => p.id === 'low');
      expect(updatedLow?.model).toBe('deep/deepseek-chat');
      expect(updatedLow?.reasoningEffort ?? null).toBeNull();
    });

    // 关闭弹窗后切换自动复杂度开关与审查任务路由
    fireEvent.click(r.getByTestId('routing-auto-complexity'));
    await waitFor(() => {
      const saves = fake.inputs('delegate.setSettings') as Array<{
        settings: ReturnType<typeof sampleDelegateSettings>;
      }>;
      expect(saves.at(-1)!.settings.autoComplexity).toBe(false);
    });

    fireEvent.change(r.getByTestId('routing-target-review'), {
      target: { value: 'preset:high' },
    });
    await waitFor(() => {
      const saves = fake.inputs('delegate.setSettings') as Array<{
        settings: ReturnType<typeof sampleDelegateSettings>;
      }>;
      expect(saves.at(-1)!.settings.routes.review).toEqual({ kind: 'preset', presetId: 'high' });
    });
  });

  it('ModelsPage with hideAssignments renders providers without models-assign grid', async () => {
    const gw = sampleGateway();
    installFakeApi({
      'gateway.state': () => gw,
      'cliUpdate.status': () => [],
      'harness.state': () => ({ bins: {}, tabs: [], activeId: 'nomi' }),
    });

    const r = render(<ModelsPage hideAssignments />);
    await untilIdle();
    await r.findByTestId('provider-deep');
    expect(r.queryByTestId('models-assign')).toBeNull();
  });

  it('三方模型标签只渲染供应商列表，本地模型标签只渲染本地面板', async () => {
    const gw = sampleGateway();
    installFakeApi({
      'gateway.state': () => gw,
      'cliUpdate.status': () => [],
      'harness.state': () => ({ bins: {}, tabs: [], activeId: 'nomi' }),
      'local.state': () => ({
        ramGb: 32,
        recommended: 'qwen2.5-7b',
        models: [],
        runtime: {
          tag: 'b4700',
          license: 'MIT',
          licenseUrl: '',
          sourceUrl: '',
          supported: true,
          bytes: 0,
          installed: true,
        },
        server: { status: 'stopped', log: [] },
        settings: { autoStart: false, ollamaUrl: 'http://127.0.0.1:11434' },
        offline: false,
      }),
      'local.ollamaList': () => [],
    });

    const favorites = render(
      <AiSettingsSection
        tab="providers"
        onTab={() => undefined}
        onClose={() => undefined}
        go={() => undefined}
      />,
    );
    await untilIdle();
    await favorites.findByTestId('provider-deep');
    expect(favorites.getByTestId('ai-providers-tab')).toBeTruthy();
    expect(favorites.queryByTestId('ai-local-tab')).toBeNull();
    expect(favorites.queryByTestId('local-panel')).toBeNull();
    cleanup();

    const local = render(
      <AiSettingsSection
        tab="local"
        onTab={() => undefined}
        onClose={() => undefined}
        go={() => undefined}
      />,
    );
    expect(local.getByTestId('settings-ai-page').getAttribute('data-tab')).toBe('local');
    await local.findByTestId('local-models');
    expect(local.getByTestId('ai-local-tab')).toBeTruthy();
    expect(local.queryByTestId('ai-providers-tab')).toBeNull();
    expect(local.queryByTestId('provider-deep')).toBeNull();
  });

  it('presets show missing CLI / invalid third-party model warning badges and picker jumps to providers when empty', async () => {
    const emptyGw = {
      status: { state: 'running', port: 6129, url: 'http://127.0.0.1:6129' },
      providers: [],
      clients: {},
      allowedPrivateHosts: [],
      port: 6129,
    };
    const ds = {
      ...sampleDelegateSettings(),
      installed: ['claude'],
      presets: [
        {
          id: 'balanced',
          label: 'x',
          cli: 'codex',
          source: 'official',
          accountId: null,
          model: null,
          reasoningEffort: 'medium',
          costTier: 'medium',
        },
        {
          id: 'low',
          label: 'y',
          cli: 'claude',
          source: 'thirdParty',
          accountId: null,
          model: 'missing/model',
          reasoningEffort: 'low',
          costTier: 'low',
        },
      ],
    };
    installFakeApi({
      'gateway.state': () => emptyGw,
      'delegate.settings': () => ds,
      'cliAccount.list': () => [],
      'usage.state': () => ({ pricing: { builtin: [] } }),
      'harness.modelCatalog': () => null,
    });
    const onOpenProviders = vi.fn();
    const r = render(<RoutingTab onOpenProviders={onOpenProviders} />);
    await r.findByTestId('routing-preset-balanced');
    expect(r.getByTestId('routing-preset-warn-balanced').textContent).toBe('助手未安装');
    expect(r.getByTestId('routing-preset-warn-low').textContent).toBe('需配置第三方模型');

    fireEvent.click(r.getByTestId('routing-preset-edit-low'));
    const addBtn = await r.findByTestId('runner-picker-add-provider');
    fireEvent.click(addBtn);
    expect(onOpenProviders).toHaveBeenCalledTimes(1);
  });

  it('auto-refreshes official accounts missing identity when opening RunnerModelPicker and displays username', async () => {
    const gw = sampleGateway();
    let ds = {
      ...sampleDelegateSettings(),
      installed: ['claude', 'grok'],
      localAvailable: { claude: false, grok: false },
    };
    const initialGrok = {
      id: 'g1',
      kind: 'grok',
      label: '官方账号',
      loggedIn: true,
      identity: { key: 'k1' },
      active: true,
      inUse: 0,
      createdAt: 0,
    };
    const refreshedGrok = {
      id: 'g1',
      kind: 'grok',
      label: 'Alice Wang',
      loggedIn: true,
      identity: {
        key: 'alice@x.ai',
        name: 'Alice Wang',
        email: 'alice@x.ai',
        plan: 'SuperGrok',
      },
      active: true,
      inUse: 0,
      createdAt: 0,
    };
    let refreshed = false;
    const fake = installFakeApi({
      'gateway.state': () => gw,
      'delegate.settings': () => ds,
      'delegate.setSettings': (input: { settings: typeof ds }) => {
        ds = { ...ds, ...input.settings };
        return true;
      },
      'cliAccount.list': (in_?: { kind?: string }) => {
        if (!in_?.kind) return [refreshed ? refreshedGrok : initialGrok];
        if (in_.kind === 'grok') return [refreshed ? refreshedGrok : initialGrok];
        return [];
      },
      'cliAccount.refresh': (in_: { kind: string }) => {
        if (in_.kind === 'grok') {
          refreshed = true;
          return [refreshedGrok];
        }
        return [];
      },
      'usage.state': () => ({ pricing: { builtin: [] } }),
      'cliUpdate.status': () => [],
      'harness.state': () => ({ bins: { grok: '/usr/bin/grok' }, tabs: [], activeId: 'nomi' }),
      'harness.modelCatalog': () => null,
    });

    const r = render(<RoutingTab onOpenProviders={() => undefined} />);
    await untilIdle();
    fireEvent.click(await r.findByTestId('routing-preset-edit-high'));
    await r.findByTestId('runner-model-picker');

    fireEvent.click(r.getByTestId('runner-picker-cli-grok'));
    await waitFor(() => expect(fake.inputs('cliAccount.refresh')).toContainEqual({ kind: 'grok' }));
    const grokBtn = await waitFor(() => r.getByTestId('runner-picker-official-g1'));
    await waitFor(() => expect(grokBtn.textContent).toContain('Alice Wang'));
    expect(grokBtn.textContent).toContain('SuperGrok · alice@x.ai');

    fireEvent.click(grokBtn);
    fireEvent.click(r.getByTestId('runner-picker-confirm'));

    await waitFor(() =>
      expect(r.getByTestId('routing-preset-high').textContent).toContain('官方账号 · Alice Wang'),
    );
    expect(r.getByTestId('routing-target-complex').textContent).toContain(
      'Grok · 官方账号 · Alice Wang',
    );
  });

  it('无已安装 CLI 时展示默认后台承接卡片，且切至未配主模型的 Codex 自动选 GPT 同族次顶级三方模型', async () => {
    const gw = {
      ...sampleGateway(),
      providers: [
        {
          id: 'amux',
          name: 'Amux AI',
          presetId: 'custom',
          enabled: true,
          urls: { chat: 'https://api.example.com' },
          keys: [{ label: 'k1', masked: 'sk-***1', enabled: true, decryptable: true }],
          models: [
            { id: 'claude-opus-4-6', enabled: true, toolCalling: true },
            { id: 'gpt-6-astra', enabled: true, toolCalling: true },
            { id: 'gpt-6.1-sol', enabled: true, toolCalling: true },
            { id: 'gpt-6.1-terra', enabled: true, toolCalling: true },
            { id: 'deepseek-v4.1-flash', enabled: true, toolCalling: true },
          ],
          source: 'user',
          createdAt: 0,
          updatedAt: 0,
        },
      ],
      clients: {
        nomi: { models: { main: 'amux/deepseek-v4.1-flash' } },
        claude: { models: {}, newTabSource: 'thirdParty' },
        codex: { models: {}, newTabSource: 'thirdParty' },
      },
    } as unknown as GatewayState;
    const ds = {
      enabled: true,
      defaults: {},
      installed: [],
      presets: [],
      routes: {},
      pinned: null,
    };
    installFakeApi({
      'gateway.state': () => gw,
      'delegate.settings': () => ds,
      'cliAccount.list': () => [],
      'cli.launcherGet': () => ({}),
      'usage.state': () => ({ pricing: { builtin: [] } }),
      'harness.modelCatalog': () => null,
    });

    const r = render(<RoutingTab onOpenProviders={() => undefined} />);
    const defaultCard = await r.findByTestId('routing-preset-nomi-default');
    expect(defaultCard.textContent).toContain('默认后台承接');
    expect((r.getByTestId('routing-target-complex') as HTMLSelectElement).value).toBe(
      '__default_nomi__',
    );

    // 打开新增预设弹窗并切换至 codex：在无主模型时自动优先选中 GPT 次顶级 amux/gpt-6.1-sol
    fireEvent.click(r.getByTestId('routing-preset-add'));
    await r.findByTestId('runner-model-picker');
    fireEvent.click(r.getByTestId('runner-picker-cli-codex'));
    const selectedBar = await waitFor(() => r.getByTestId('runner-picker-tp-selected'));
    expect(selectedBar.textContent).toContain('gpt-6.1-sol');
  });
});
