// @vitest-environment happy-dom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EndpointControls } from '../src/components/EndpointControls';
import { HarnessTabsProvider } from '../src/contexts/HarnessTabsContext';
import { setChatMode } from '../src/services/chatPrefs';
import type { HarnessTabsState } from '../src/services/harnessClient';
import { openModelMenu } from '../src/services/modelMenu';
import type { ProviderState } from '../src/services/providerClient';
import {
  isNativeThirdPartyModel,
  resolveThinkingLevel,
  type ThinkingProfile,
} from '../src/services/thinkingDepth';

import { installFakeApi, resetFakeApi } from './helpers/fakeApi';

vi.mock('../src/services/api', async () => (await import('./helpers/fakeApi')).fakeApiModule());

/** Nomi 会话：档位存在会话 meta.reasoningEffort（与消息一起保存，切换会话后各自独立） */
const session = vi.hoisted(() => {
  const convo: {
    id: string;
    backend: string;
    reasoningEffort?: string;
    longContext?: { model: string; on: boolean };
  } = {
    id: 'c1',
    backend: 'nomi',
  };
  const updateMeta = vi.fn((id: string, patch: Record<string, unknown>) => {
    if (id === convo.id) Object.assign(convo, patch);
  });
  const store = {
    get: (id: string) => (id === convo.id ? convo : undefined),
    updateMeta,
  };
  const ipcClient = {
    currentConversationId: () => convo.id,
    conversationStore: () => store,
    ensureConversationId: () => convo.id,
  };
  // 稳定引用：每次新建对象会让 useSyncExternalStore 的 snapshot 一直变
  const legacy = {
    state: { messages: [], ipcClient },
    actions: { newConversation: async () => undefined },
    dispatch: () => undefined,
  };
  return { convo, updateMeta, legacy };
});

vi.mock('../src/contexts/AiChatContext', () => ({
  useAiChat: () => session.legacy,
}));

const profile = (levels: string[]): ThinkingProfile => ({
  control: 'effort',
  levels,
  default: levels[1] ?? levels[0] ?? '',
});

describe('resolveThinkingLevel', () => {
  it('uses the second tier when the conversation has not chosen one', () => {
    expect(resolveThinkingLevel(undefined, profile(['low', 'medium', 'high']))).toBe('medium');
    expect(resolveThinkingLevel(undefined, profile(['minimal', 'low', 'medium', 'high']))).toBe(
      'low',
    );
    expect(resolveThinkingLevel(undefined, profile(['off', 'on']))).toBe('on');
  });

  it('keeps a stored tier that this model still offers, and drops one it does not', () => {
    const p = profile(['low', 'medium', 'high']);
    expect(resolveThinkingLevel('high', p)).toBe('high');
    expect(resolveThinkingLevel('xhigh', p)).toBe('medium');
    expect(resolveThinkingLevel(undefined, null)).toBeUndefined();
  });
});

describe('isNativeThirdPartyModel', () => {
  it('识别同协议原生模型以及通过 like 标注的中转别名', () => {
    const state = {
      status: { state: 'running', port: 1, url: 'http://127.0.0.1:1' },
      providers: [
        {
          id: 'relay',
          name: 'Relay',
          enabled: true,
          urls: {},
          keys: [],
          models: [
            { id: 'claude-opus-5-5', enabled: true },
            { id: 'my-opus', enabled: true, like: 'claude-opus-5-5' },
            { id: 'gpt-5', enabled: true },
            { id: 'o3', enabled: true },
            { id: 'kimi-k3', enabled: true },
            { id: 'minimax-m3.1-flash', enabled: true },
            { id: 'my-kimi', enabled: true, like: 'kimi-k3' },
            { id: 'my-minimax', enabled: true, like: 'minimax-m3.1-flash' },
            { id: 'ds-v4', enabled: true },
          ],
          source: 'user',
        },
      ],
      clients: {},
      allowedPrivateHosts: [],
      port: 1,
    } as unknown as Parameters<typeof isNativeThirdPartyModel>[1];

    expect(isNativeThirdPartyModel('claude', state, 'relay/claude-opus-5-5')).toBe(true);
    expect(isNativeThirdPartyModel('claude', state, 'relay/my-opus')).toBe(true);
    expect(isNativeThirdPartyModel('codex', state, 'relay/gpt-5')).toBe(true);
    expect(isNativeThirdPartyModel('codex', state, 'relay/o3')).toBe(true);
    expect(isNativeThirdPartyModel('kimi', state, 'relay/kimi-k3')).toBe(true);
    expect(isNativeThirdPartyModel('kimi', state, 'relay/my-kimi')).toBe(true);
    expect(isNativeThirdPartyModel('minimax', state, 'relay/minimax-m3.1-flash')).toBe(true);
    expect(isNativeThirdPartyModel('minimax', state, 'relay/my-minimax')).toBe(true);
    expect(isNativeThirdPartyModel('claude', state, 'relay/gpt-5')).toBe(false);
    expect(isNativeThirdPartyModel('claude', state, 'relay/kimi-k3')).toBe(false);
    expect(isNativeThirdPartyModel('codex', state, 'relay/claude-opus-5-5')).toBe(false);
    expect(isNativeThirdPartyModel('claude', state, 'relay/ds-v4')).toBe(false);
    expect(isNativeThirdPartyModel('codex', state, 'relay/ds-v4')).toBe(false);
  });
});

const EFFORT = { control: 'effort', levels: ['low', 'medium', 'high'], default: 'medium' };

/** 网关状态：gpt-5 支持思考深度，gpt-4.1 不支持；deep 是第二家供应商（跨供应商切换用） */
const gateway = (main = 'amux/gpt-5', label?: string) => ({
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
          label,
          enabled: true,
          effective: {
            ctx: 1,
            maxOutput: 1,
            source: 'catalog',
            maxOutputSource: 'catalog',
            thinking: EFFORT,
          },
        },
        { id: 'gpt-4.1', enabled: true },
      ],
      source: 'user',
    },
    {
      id: 'deep',
      name: 'DeepX',
      enabled: true,
      urls: { chat: 'https://api.deepx.example/v1' },
      keys: [],
      models: [
        {
          id: 'ds-v4',
          enabled: true,
          effective: {
            ctx: 1,
            maxOutput: 1,
            source: 'catalog',
            maxOutputSource: 'catalog',
            thinking: EFFORT,
          },
        },
      ],
      source: 'user',
    },
  ],
  clients: { nomi: { models: { main } } },
  allowedPrivateHosts: [],
  port: 1,
});

const tabs = {
  tabs: [],
  activeTabId: 'main',
  running: 0,
  queued: 0,
} as unknown as HarnessTabsState;

function setup(
  main?: string,
  options: {
    modelLabel?: string;
    providerState?: Partial<ProviderState>;
    gatewayState?: ReturnType<typeof gateway>;
  } = {},
) {
  const invoke = vi.fn(async (ch: string) => {
    if (ch === 'gateway.state') return options.gatewayState ?? gateway(main, options.modelLabel);
    if (ch === 'providers.state')
      return { providers: [], envProviders: [], routes: {}, ...options.providerState };
    if (ch === 'harness.state') return { backend: 'nomi', cwd: '/w', bins: {} };
    if (ch === 'harness.tabs') return tabs;
    return null;
  });
  installFakeApi(invoke);
  const r = render(
    <HarnessTabsProvider>
      <EndpointControls part="model" />
    </HarnessTabsProvider>,
  );
  const chip = () => r.getByTestId('nomi-model-chip');
  const open = async () => {
    const btn = await waitFor(() => chip());
    fireEvent.click(btn);
    await waitFor(() => expect(r.getByTestId('nomi-model-menu')).toBeTruthy());
    return btn;
  };
  return { ...r, chip, open, invoke };
}

/** 模型页里模型列表的一行（值即 `供应商/模型`；选项 testid 带 nomi-model- 前缀） */
const modelOption = (ref: string) => document.querySelector<HTMLElement>(`[data-value="${ref}"]`)!;

beforeEach(() => {
  setChatMode('dev');
  session.convo.reasoningEffort = undefined;
  session.convo.longContext = undefined;
  session.updateMeta.mockClear();
});
afterEach(() => {
  cleanup();
  resetFakeApi();
});

describe('Nomi model chip', () => {
  it('模型不支持思考深度时只显示模型名，没有独立的思考深度按钮', async () => {
    const r = setup('amux/gpt-4.1');
    await waitFor(() => expect(r.chip().textContent).toBe('gpt-4.1'));
    expect(r.chip().textContent).not.toContain('·');
    expect(r.queryByTestId('nomi-thinking')).toBeNull();
  });

  it('支持思考深度时按钮显示「模型 · 档位」，档位是第二档', async () => {
    const r = setup();
    await waitFor(() => expect(r.chip().textContent).toBe('gpt-5 · 中'));
  });

  it('与 CLI 一样优先显示模型厂商图标，而不是中转供应商品牌', async () => {
    const r = setup();
    await waitFor(() => expect(r.chip().querySelector('[data-brand="openai"]')).toBeTruthy());
    expect(r.chip().querySelector('[data-brand="amux"]')).toBeNull();
  });

  it('模型有显示名时优先使用显示名，档位页也不拼供应商', async () => {
    const r = setup(undefined, { modelLabel: 'GPT Five' });
    await waitFor(() => expect(r.chip().textContent).toBe('GPT Five · 中'));
    await r.open();
    const row = r.getByTestId('nomi-model-open');
    expect(row.textContent).toBe('模型GPT Five');
    expect(row.getAttribute('aria-label')).not.toContain('Amux');
  });

  it('认不出模型厂商时与 CLI 一样回退到供应商品牌，文字仍只有模型名', async () => {
    const r = setup('amux/custom/model');
    await waitFor(() => expect(r.chip().textContent).toBe('custom/model'));
    expect(r.chip().querySelector('[data-brand="amux"]')).toBeTruthy();
  });

  it('环境变量锁定时只显示实际模型名并保持禁用', async () => {
    const r = setup(undefined, {
      providerState: {
        overrideId: 'env',
        effectiveProviderId: 'env',
        effectiveModel: 'deepseek-chat',
      },
    });
    await waitFor(() => expect(r.chip().textContent).toBe('deepseek-chat'));
    expect((r.chip() as HTMLButtonElement).disabled).toBe(true);
  });

  it('浮层单列当前第三方供应商，使用与官方账号相同的行样式', async () => {
    const r = setup();
    await r.open();
    const row = r.getByTestId('nomi-model-provider-open');
    expect(row.textContent).toBe('第三方供应商Amux');
    expect(row.className).toBe(r.getByTestId('nomi-model-open').className);
    expect(r.queryByTestId('account-open')).toBeNull();
    fireEvent.click(row);
    expect(r.getByTestId('provider-amux').getAttribute('aria-selected')).toBe('true');
    expect(r.getByTestId('provider-deep')).toBeTruthy();
    fireEvent.click(r.getByTestId('nomi-model-provider-back'));
    expect(r.getByTestId('nomi-effort-view')).toBeTruthy();
  });

  it('目标供应商有同名模型时直接替换供应商，保留模型与思考档位', async () => {
    const state = gateway();
    const shared = state.providers[0]!.models[0]!;
    state.providers[1]!.models.push({ ...shared, label: 'Another display name' });
    const r = setup(undefined, { gatewayState: state });
    await r.open();
    fireEvent.click(r.getByTestId('nomi-model-provider-open'));
    fireEvent.click(r.getByTestId('provider-deep'));
    await waitFor(() =>
      expect(r.invoke).toHaveBeenCalledWith('gateway.setAssignment', {
        client: 'nomi',
        patch: { models: { main: 'deep/gpt-5' } },
      }),
    );
    expect(r.getByTestId('nomi-effort-view')).toBeTruthy();
    expect(r.getByTestId('nomi-model-provider-open').textContent).toBe('第三方供应商DeepX');
    expect(r.chip().textContent).toBe('Another display name · 中');
    expect(session.updateMeta).not.toHaveBeenCalled();
  });

  it('没有同名模型时打开目标供应商的模型页，选模型前不修改供应商', async () => {
    const r = setup();
    await r.open();
    fireEvent.click(r.getByTestId('nomi-model-provider-open'));
    fireEvent.click(r.getByTestId('provider-deep'));
    expect(r.getByTestId('model-picker-tab-deep').getAttribute('aria-selected')).toBe('true');
    expect(r.getByTestId('model-picker-tab-amux').getAttribute('aria-selected')).toBe('false');
    expect(r.invoke.mock.calls.some(([ch]) => ch === 'gateway.setAssignment')).toBe(false);
    fireEvent.click(modelOption('deep/ds-v4'));
    await waitFor(() =>
      expect(r.invoke).toHaveBeenCalledWith('gateway.setAssignment', {
        client: 'nomi',
        patch: { models: { main: 'deep/ds-v4' } },
      }),
    );
    expect(r.getByTestId('nomi-model-provider-open').textContent).toBe('第三方供应商DeepX');
  });

  it('当前供应商重选不写入，供应商列表支持 Esc 关闭与焦点回收', async () => {
    const r = setup();
    const chip = await r.open();
    fireEvent.click(r.getByTestId('nomi-model-provider-open'));
    fireEvent.click(r.getByTestId('provider-amux'));
    expect(r.getByTestId('nomi-effort-view')).toBeTruthy();
    expect(r.invoke.mock.calls.some(([ch]) => ch === 'gateway.setAssignment')).toBe(false);
    fireEvent.click(r.getByTestId('nomi-model-provider-open'));
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(r.queryByTestId('nomi-model-menu')).toBeNull());
    expect(document.activeElement).toBe(chip);
  });

  it('点开先是档位页：滑杆 + 「模型 ›」行；点模型行进模型页', async () => {
    const r = setup();
    await r.open();
    expect(r.getByTestId('nomi-effort-view')).toBeTruthy();
    const slider = r.getByTestId('effort-slider');
    expect(slider.getAttribute('aria-valuenow')).toBe('1');
    expect(slider.getAttribute('aria-valuetext')).toBe('中');
    expect(r.getByTestId('effort-low')).toBeTruthy();
    expect(r.getByTestId('effort-high')).toBeTruthy();

    fireEvent.click(r.getByTestId('nomi-model-open'));
    expect(r.getByTestId('nomi-model-picker-menu')).toBeTruthy();
    expect(r.queryByTestId('effort-slider')).toBeNull();
  });

  it('模型页可跨供应商切换：选完回到档位页；不支持思考的模型选完直接收起', async () => {
    const r = setup();
    await r.open();
    fireEvent.click(r.getByTestId('nomi-model-open'));
    // 切到另一家供应商的标签，选它的模型：回到档位页
    fireEvent.click(r.getByTestId('model-picker-tab-deep'));
    fireEvent.click(modelOption('deep/ds-v4'));
    await waitFor(() => expect(r.getByTestId('nomi-effort-view')).toBeTruthy());
    expect(r.queryByTestId('nomi-model-picker-menu')).toBeNull();
    expect(r.chip().textContent).toBe('ds-v4 · 中');
    expect(r.chip().querySelector('[data-brand]')).toBeNull();

    // 再进模型页选不支持思考的模型：浮层收起
    fireEvent.click(r.getByTestId('nomi-model-open'));
    fireEvent.click(r.getByTestId('model-picker-tab-amux'));
    fireEvent.click(modelOption('amux/gpt-4.1'));
    await waitFor(() => expect(r.queryByTestId('nomi-model-menu')).toBeNull());
  });

  it('档位写回会话 meta.reasoningEffort，按钮随之更新', async () => {
    const r = setup();
    await r.open();
    fireEvent.keyDown(r.getByTestId('effort-slider'), { key: 'ArrowRight' });
    await waitFor(() =>
      expect(session.updateMeta).toHaveBeenCalledWith('c1', { reasoningEffort: 'high' }),
    );
    expect(r.chip().textContent).toBe('gpt-5 · 高');
  });

  it('Esc 关闭整个浮层，焦点回到按钮', async () => {
    const r = setup();
    const btn = await r.open();
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(r.queryByTestId('nomi-model-menu')).toBeNull());
    expect(document.activeElement).toBe(btn);
  });

  it('/model 打开同一个浮层，停在模型页', async () => {
    const r = setup();
    await waitFor(() => expect(r.chip()).toBeTruthy());
    await waitFor(() => {
      // 打开方法在挂载后的 effect 里登记
      const opened = openModelMenu('nomi');
      expect(opened).toBe(true);
    });
    await waitFor(() => expect(r.getByTestId('nomi-model-picker-menu')).toBeTruthy());
  });

  it('Nomi 模型支持长上下文时：档位页直接提供开关，写入会话 meta.longContext 且不显示于普通模型', async () => {
    const plain = setup();
    await plain.open();
    expect(plain.queryByTestId('nomi-model-long-context')).toBeNull();
    cleanup();

    const stateWithLong = gateway();
    (stateWithLong.providers[0]!.models[0]!.effective as Record<string, unknown>).longContext = {
      standard: 262_144,
      full: 1_048_576,
      on: false,
      price: { size: 262_144, input: 0.14, output: 0.42, tierInput: 0.28, tierOutput: 0.84 },
    };
    const r = setup(undefined, { gatewayState: stateWithLong });
    await r.open();
    const row = r.getByTestId('nomi-model-long-context');
    expect(row.textContent).toContain('262K → 1M');
    expect(row.textContent).toContain('超过 262K 的请求按输入 $0.28/M（标准 $0.14/M）计费');
    const sw = r.getByTestId('nomi-model-long-context-switch');
    expect(sw.getAttribute('aria-checked')).toBe('false');

    fireEvent.click(sw);
    await waitFor(() =>
      expect(session.updateMeta).toHaveBeenCalledWith('c1', {
        longContext: { model: 'amux/gpt-5', on: true },
      }),
    );
    expect(r.getByTestId('nomi-model-chip-long').textContent).toBe('长');
    expect(r.getByTestId('nomi-model-long-context-switch').getAttribute('aria-checked')).toBe(
      'true',
    );

    // 再点关闭：与模型默认(false)相同时清掉覆盖
    fireEvent.click(r.getByTestId('nomi-model-long-context-switch'));
    await waitFor(() =>
      expect(session.updateMeta).toHaveBeenCalledWith('c1', { longContext: undefined }),
    );
    expect(r.queryByTestId('nomi-model-chip-long')).toBeNull();
  });
});
