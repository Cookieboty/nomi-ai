// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

import { buildCliSlots } from '../src/components/Conversation/cliSlots';
import { ErrorCard } from '../src/components/Conversation/Messages';
import { ComposerBar } from '../src/components/MessageInput/ComposerBar';
import { ModelControls } from '../src/components/ModelControls';
import { NewChatMenu } from '../src/components/NewChatMenu';
import { TaskForm } from '../src/components/Tasks/TaskForm';
import { cliLauncherClient } from '../src/services/cliLauncherClient';
import {
  bindNextDelegateConversation,
  consumeNextDelegate,
  setNextDelegate,
  type RunnerPreset,
} from '../src/services/delegateClient';
import type { GatewayState } from '../src/services/gatewayClient';
import type { BackendModelCatalog, HarnessTabMeta } from '../src/services/harnessClient';
import { filterAgents } from '../src/slash/agentComplete';

import { installFakeApi, resetFakeApi, untilIdle } from './helpers/fakeApi';

vi.mock('../src/services/api', async () => (await import('./helpers/fakeApi')).fakeApiModule());
vi.mock('../src/components/ConfirmDialog', () => import('./helpers/confirmViaWindow'));

beforeEach(() => cliLauncherClient.resetCache());
afterEach(() => {
  cliLauncherClient.resetCache();
  bindNextDelegateConversation(null);
  setNextDelegate(null);
  cleanup();
  resetFakeApi();
  vi.restoreAllMocks();
});

const SAMPLE_GATEWAY = {
  status: { state: 'running', port: 6129, url: 'http://127.0.0.1:6129' },
  providers: [
    {
      id: 'deep',
      name: 'DeepSeek',
      presetId: 'deepseek',
      enabled: true,
      urls: { chat: 'https://api.deepseek.com' },
      keys: [],
      models: [{ id: 'deepseek-chat', enabled: true, toolCalling: true }],
      source: 'user',
      createdAt: 0,
      updatedAt: 0,
    },
  ],
  clients: {
    claude: { models: { main: 'deep/deepseek-chat' }, newTabSource: 'official' },
  },
  allowedPrivateHosts: [],
  port: 6129,
} as unknown as GatewayState;

const SAMPLE_PRESETS: RunnerPreset[] = [
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
];

describe('阶段三：日常高频入口联动', () => {
  it('1. NewChatMenu 渲染快捷档位分组，禁用未安装 CLI 的档位，点击触发 onPickPreset', () => {
    const onPick = vi.fn();
    const onPickPreset = vi.fn();
    const r = render(
      <NewChatMenu
        backends={['nomi', 'claude', 'codex']}
        bins={{ claude: '/usr/bin/claude', codex: null }}
        strictBins
        presets={SAMPLE_PRESETS}
        gateway={SAMPLE_GATEWAY}
        onPick={onPick}
        onPickPreset={onPickPreset}
      />,
    );
    expect(r.getByTestId('new-chat-presets')).toBeTruthy();
    expect((r.getByTestId('new-chat-preset-balanced') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(r.getByTestId('new-chat-preset-low'));
    expect(onPickPreset).toHaveBeenCalledWith(SAMPLE_PRESETS[2]);
  });

  it('2. ModelControls 展示三态来源切换栏与快捷切档药丸，点击切换第三方调 harness.tabSource', async () => {
    const tab: HarnessTabMeta = {
      id: 'tab-claude-1',
      title: 'Claude',
      backend: 'claude',
      cwd: '/w',
      cliSessionId: null,
      status: 'idle',
      unread: 0,
      createdAt: 0,
      updatedAt: 0,
      source: 'official',
    };
    const catalog: BackendModelCatalog = {
      backend: 'claude',
      defaultModel: { id: 'default', label: 'Opus 4.6', reasoning: true, efforts: ['low', 'high'] },
      models: [{ id: 'opus', label: 'Opus 4.6', reasoning: true, efforts: ['low', 'high'] }],
    };
    const fake = installFakeApi({
      'harness.modelCatalog': () => catalog,
      'gateway.state': () => SAMPLE_GATEWAY,
      'cli.launcherGet': () => ({
        claude: { enabled: false, command: '', accountSource: 'nomi', hasLocalLogin: true },
      }),
      'delegate.settings': () => ({
        enabled: true,
        defaults: {},
        installed: ['claude'],
        presets: SAMPLE_PRESETS,
        routes: {},
      }),
      'harness.tabSource': () => ({
        ...tab,
        source: 'thirdParty',
        modelOverride: 'deep/deepseek-chat',
      }),
      'cliAccount.list': () => [
        {
          id: 'acct-1',
          kind: 'claude',
          label: 'Work Pro',
          loggedIn: true,
          identity: null,
          active: true,
          inUse: 0,
          createdAt: 0,
        },
      ],
    });

    const r = render(<ModelControls tab={tab} />);
    fireEvent.click(await r.findByTestId('model-chip'));
    await r.findByTestId('model-source-tabs');
    expect(r.getByTestId('model-source-local')).toBeTruthy();
    expect(r.getByTestId('model-source-official').getAttribute('aria-pressed')).toBe('true');
    const thirdBtn = r.getByTestId('model-source-thirdParty') as HTMLButtonElement;
    expect(thirdBtn.disabled).toBe(false);

    await r.findByTestId('model-preset-pills');
    const lowPill = r.getByTestId('model-preset-pill-low');
    expect(lowPill).toBeTruthy();
    expect(lowPill.textContent).toBe('轻量省钱');
    expect(lowPill.getAttribute('aria-pressed')).toBe('false');
    expect(r.getByTestId('model-preset-pill-high').textContent).toBe('高级攻坚');

    fireEvent.click(thirdBtn);
    await waitFor(() =>
      expect(fake.calls).toContainEqual([
        'harness.tabSource',
        { id: 'tab-claude-1', source: 'thirdParty', model: 'deep/deepseek-chat' },
      ]),
    );
  });

  it('2b. ModelControls 无本机登录且无已登录官方账号时，不展示本机与官方来源选项', async () => {
    const tab: HarnessTabMeta = {
      id: 'tab-claude-tp',
      title: 'Claude',
      backend: 'claude',
      cwd: '/w',
      cliSessionId: null,
      status: 'idle',
      unread: 0,
      createdAt: 0,
      updatedAt: 0,
      source: 'thirdParty',
      modelOverride: 'deep/deepseek-chat',
    };
    const catalog: BackendModelCatalog = {
      backend: 'claude',
      defaultModel: null,
      models: [
        {
          id: 'deep/deepseek-chat',
          label: 'DeepSeek / deepseek-chat',
          reasoning: false,
          efforts: [],
        },
      ],
    };
    installFakeApi({
      'harness.modelCatalog': () => catalog,
      'gateway.state': () => SAMPLE_GATEWAY,
      'cli.launcherGet': () => ({
        claude: { enabled: false, command: '', accountSource: 'nomi', hasLocalLogin: false },
      }),
      'delegate.settings': () => ({
        enabled: true,
        defaults: {},
        installed: ['claude'],
        presets: SAMPLE_PRESETS,
        routes: {},
      }),
      'cliAccount.list': () => [],
    });

    const r = render(<ModelControls tab={tab} />);
    fireEvent.click(await r.findByTestId('model-chip'));
    await untilIdle();
    expect(r.queryByTestId('model-source-local')).toBeNull();
    expect(r.queryByTestId('model-source-official')).toBeNull();
    expect(r.queryByTestId('model-source-tabs')).toBeNull();
    expect(r.getByTestId('model-preset-pill-low')).toBeTruthy();
    expect(r.queryByTestId('model-preset-pill-high')).toBeNull();
  });

  it('3. /agent 补全置顶预设且 ComposerBar 胶囊显示完整摘要并钉住 presetId', async () => {
    const fake = installFakeApi({
      'delegate.pin': () => 'preset:low',
    });
    const opts = filterAgents(['claude'], 'l', SAMPLE_PRESETS, SAMPLE_GATEWAY);
    expect(opts[0]).toMatchObject({ kind: 'preset', id: 'low', cli: 'claude', installed: true });

    bindNextDelegateConversation('conv-s3');
    const summaryLabel = 'Claude Code · DeepSeek / deepseek-chat (轻量省钱)';
    setNextDelegate('preset:low', { cli: 'claude', label: summaryLabel });

    const r = render(
      <ComposerBar
        commands={[]}
        menuOpen={false}
        onMenuOpenChange={vi.fn()}
        fileInputRef={{ current: null }}
        onFiles={() => false}
        onDelegate={vi.fn()}
        kbMode={false}
        kbAvailable={false}
        toggleKb={vi.fn()}
        nextDelegate="preset:low"
        onClearDelegate={() => setNextDelegate(null)}
        compact
        modelControl={<span />}
        cv={{ v: { available: false } } as never}
        disabled={false}
        canStop={false}
        onSend={vi.fn()}
        sendDisabled={false}
        queueActive={false}
        busy={false}
      />,
    );
    expect(r.getByTestId('next-delegate-chip').textContent).toContain(summaryLabel);

    const consumed = await consumeNextDelegate('turn-stage3');
    expect(consumed).toBe('preset:low');
    expect(fake.calls).toContainEqual(['delegate.pin', { presetId: 'low', turnId: 'turn-stage3' }]);
  });

  it('4. TaskForm 定时任务支持路由预设执行方式，提交携带 presetId', async () => {
    window.confirm = vi.fn(() => true);
    const fake = installFakeApi({
      'harness.state': () => ({ bins: { claude: '/bin/claude' } }),
      'harness.recentCwds': () => ['/repo'],
      'ext.mcpList': () => ({ servers: [], env: [], presets: [], ready: true }),
      'delegate.settings': () => ({
        enabled: true,
        defaults: {},
        installed: ['claude'],
        presets: SAMPLE_PRESETS,
        routes: { scheduled: { kind: 'preset', presetId: 'low' } },
      }),
      'tasks.create': () => ({ id: 't-new-1' }),
    });

    render(<TaskForm onClose={vi.fn()} onCreated={vi.fn()} />);
    await untilIdle();
    fireEvent.change(screen.getByTestId('task-form-title'), { target: { value: '自动巡检' } });
    fireEvent.change(screen.getByTestId('task-form-goal'), { target: { value: '跑单测' } });
    fireEvent.change(screen.getByTestId('task-form-who'), { target: { value: 'cli' } });

    const modeSelect = (await screen.findByTestId('task-form-cli-mode')) as HTMLSelectElement;
    expect(modeSelect.value).toBe('scheduled');

    fireEvent.click(screen.getByTestId('task-form-cwd-button'));
    await untilIdle();
    fireEvent.click(screen.getByTestId('workspace-recent-item'));
    await untilIdle();

    fireEvent.click(screen.getByTestId('task-form-submit'));
    await waitFor(() => expect(fake.calls.some(([n]) => n === 'tasks.create')).toBe(true));
    const created = fake.inputs('tasks.create')[0] as { executor: Record<string, unknown> };
    // 档位模式只存 presetId：执行参数由内核在触发时按当前档位解析，不能再带保存当时的 cli / 来源 / 账号 / 模型
    expect(created.executor).toMatchObject({
      kind: 'cli',
      cwd: '/repo',
      isolation: 'worktree',
      presetId: 'low',
    });
    for (const k of ['cli', 'source', 'accountId', 'model', 'reasoningEffort'])
      expect(created.executor).not.toHaveProperty(k);
  });

  it('5. agents 429 额度耗尽错误展示一键降级按钮，点击切至第三方轻量模型并重发', async () => {
    window.confirm = vi.fn(() => true);
    const tab: HarnessTabMeta = {
      id: 'tab-quota-1',
      title: 'Claude',
      backend: 'claude',
      cwd: '/w',
      cliSessionId: 'sess-1',
      status: 'error',
      unread: 0,
      createdAt: 0,
      updatedAt: 0,
      source: 'official',
    };
    const fake = installFakeApi({
      'gateway.state': () => SAMPLE_GATEWAY,
      'delegate.settings': () => ({
        enabled: true,
        defaults: {},
        installed: ['claude'],
        presets: SAMPLE_PRESETS,
        routes: {},
      }),
      'harness.tabSource': () => ({
        ...tab,
        source: 'thirdParty',
        modelOverride: 'deep/deepseek-chat',
      }),
      'harness.tabEffort': () => ({
        ...tab,
        source: 'thirdParty',
        modelOverride: 'deep/deepseek-chat',
        reasoningEffort: 'low',
      }),
    });

    const retry = vi.fn();
    const errText = 'HTTP 429 rate_limit_error: quota exceeded';
    const slots = buildCliSlots({ tab, cwd: '/w' });
    const msg = { id: 'm-err', role: 'assistant' as const, text: '', error: errText, at: 1 };

    const r = render(
      <ErrorCard message={errText} onRetry={retry} extra={slots.errorActions?.(msg, { retry })} />,
    );
    await untilIdle();
    const fallbackBtn = within(r.container).getByTestId('cli-quota-fallback');
    expect(fallbackBtn.textContent).toContain('轻量省钱');

    fireEvent.click(fallbackBtn);
    await waitFor(() =>
      expect(fake.calls).toContainEqual([
        'harness.tabSource',
        { id: 'tab-quota-1', source: 'thirdParty', model: 'deep/deepseek-chat' },
      ]),
    );
    await waitFor(() => expect(retry).toHaveBeenCalledTimes(1));
  });
});
