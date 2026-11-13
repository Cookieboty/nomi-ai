// @vitest-environment happy-dom
/**
 * 「模型」页（统一网关）：分配 Nomi 对话的模型、第三方供应商列表、添加第三方供应商的三步流程。
 * 主进程用一个内存里的假 ai:gateway:* 代替。
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ModelsPage } from '../src/components/ModelsPage';
import { NewTabSourceRow } from '../src/components/ProvidersPage/NewTabSourceRow';
import type {
  DetectResult,
  GatewayState,
  ProviderInput,
  ProviderView,
} from '../src/services/gatewayClient';

import { installFakeApi, untilIdle, resetFakeApi } from './helpers/fakeApi';

vi.mock('../src/services/api', async () => (await import('./helpers/fakeApi')).fakeApiModule());

vi.mock('../src/components/ConfirmDialog', () => import('./helpers/confirmViaWindow'));

const PRESETS = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    category: 'vendor',
    protocol: 'openai-chat',
    baseURL: 'https://api.deepseek.com/v1',
    defaultModel: '',
    models: [],
    requiresApiKey: true,
    urls: {
      chat: 'https://api.deepseek.com/v1',
      messages: 'https://api.deepseek.com/anthropic',
    },
    modelMeta: [
      {
        id: 'deepseek-v4-pro',
        ctx: 1_000_000,
        maxOutput: 393_216,
        reasoning: true,
        vision: false,
        toolCalling: true,
      },
      { id: 'deepseek-v4-flash', ctx: 1_000_000, reasoning: true, vision: true, toolCalling: true },
    ],
    quirks: { reasoningPassback: true },
  },
  {
    id: 'ollama',
    name: 'Ollama（本地）',
    category: 'platform',
    protocol: 'openai-chat',
    baseURL: 'http://localhost:11434/v1',
    defaultModel: '',
    models: [],
    requiresApiKey: false,
  },
];

const okDetect = (url: string): DetectResult => ({
  wires: {
    chat: { wire: 'chat', url, ok: true, ms: 10 },
    messages: { wire: 'messages', url: `${url}/anthropic`, ok: false, status: 404, ms: 10 },
  },
  byKey: {},
  models: ['deepseek-v4-pro', 'deepseek-v4-flash', 'text-embedding-v4'],
  urls: { chat: url },
});

function fakeMain(
  o: {
    detect?: (input: Record<string, unknown>) => DetectResult | Promise<DetectResult>;
    /** upsertProvider 推完 gateway.changed 之后、返回之前等它（模拟内核的变更事件先于调用结果到达） */
    beforeUpsertReturns?: () => Promise<void>;

    extra?: Record<string, (i: any) => unknown>;
  } = {},
) {
  const state: GatewayState = {
    status: { state: 'running', port: 1, url: 'http://127.0.0.1:1' },
    providers: [],
    clients: { nomi: { models: {} } },
    allowedPrivateHosts: [],
    port: 1,
  };
  const calls: Array<[string, unknown]> = [];
  const invoke = vi.fn(async (ch: string, input?: unknown) => {
    calls.push([ch, input]);
    const args = (input ?? {}) as Record<string, unknown>;
    if (o.extra?.[ch]) return o.extra[ch]!(input);
    switch (ch) {
      case 'providers.presets':
        return PRESETS;
      case 'providers.state':
        return { providers: [], envProviders: [], overrideId: null };
      case 'gateway.state':
        return structuredClone(state);
      case 'gateway.detect':
        return (
          o.detect ?? ((i) => okDetect(String((i.urls as { chat?: string })?.chat ?? i.url)))
        )(args);
      case 'gateway.confirmPrivateHost':
        state.allowedPrivateHosts.push(String(args.hostPort));
        break;
      case 'gateway.upsertProvider': {
        const i = args as unknown as ProviderView & { newKeys?: Array<{ value: string }> };
        const id = i.id ?? i.presetId ?? i.name.toLowerCase();
        const prev = state.providers.find((p) => p.id === id);
        const p: ProviderView = {
          id,
          name: i.name,
          presetId: i.presetId,
          enabled: true,
          urls: i.urls,
          keys:
            prev?.keys ??
            (i.newKeys ?? []).map((k, n) => ({
              id: `k${n}`,
              masked: `${k.value.slice(0, 3)}…${k.value.slice(-4)}`,
              enabled: true,
              decryptable: true,
            })),
          models: i.models ?? prev?.models ?? [],
          source: 'user',
          detected: i.detected,
          createdAt: 0,
          updatedAt: 0,
        };
        state.providers = [...state.providers.filter((x) => x.id !== id), p];
        changed();
        await o.beforeUpsertReturns?.();
        return p;
      }
      case 'gateway.clearLearned':
        for (const p of state.providers) if (p.id === args.providerId) delete p.learned;
        changed();
        break;
      case 'gateway.removeProvider':
        state.providers = state.providers.filter((p) => p.id !== args.id);
        changed();
        break;
      case 'gateway.setProviderEnabled':
        for (const p of state.providers) if (p.id === args.id) p.enabled = args.enabled as boolean;
        changed();
        break;
      case 'gateway.reorderProviders': {
        const ids = args.ids as string[];
        const at = (id: string) => (ids.includes(id) ? ids.indexOf(id) : ids.length);
        state.providers = [...state.providers].sort((a, b) => at(a.id) - at(b.id));
        changed();
        break;
      }
      case 'gateway.setAssignment': {
        const client = args.client as keyof GatewayState['clients'];
        const p = args.patch as {
          models?: Record<string, string | null>;
          newTabSource?: 'official' | 'thirdParty';
          newTabAccountId?: string | null;
        };
        const prev = state.clients[client] ?? { models: {} };
        const next = { ...prev.models, ...p.models } as Record<string, unknown>;
        for (const k of Object.keys(next)) if (next[k] == null) delete next[k];
        const accountPatch = Object.prototype.hasOwnProperty.call(p, 'newTabAccountId')
          ? { newTabAccountId: p.newTabAccountId }
          : {};
        state.clients[client] = {
          ...prev,
          models: next,
          ...(p.newTabSource ? { newTabSource: p.newTabSource } : {}),
          ...accountPatch,
        };
        changed();
        break;
      }
      case 'cliAccount.list':
        return [];
    }
    return undefined;
  });
  const fake = installFakeApi(invoke);
  // 网关状态变了：推 gateway.changed（不等送达，界面再拉 gateway.state）
  const changed = () => fake.publish('gateway.changed', null);
  return { state, calls };
}

beforeEach(() => {
  window.confirm = vi.fn(() => true);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  resetFakeApi();
});

const detail = () => screen.getByTestId('provider-detail');
const upserts = (m: ReturnType<typeof fakeMain>) =>
  m.calls.filter(([c]) => c === 'gateway.upsertProvider').map(([, a]) => a as ProviderInput);

const kimi = (o: Partial<ProviderView> = {}): ProviderView => ({
  id: 'kimi',
  name: 'Kimi',
  enabled: true,
  urls: { messages: 'https://api.moonshot.cn/anthropic' },
  keys: [{ id: 'k0', masked: 'sk-…a702', enabled: true, decryptable: true }],
  models: [
    { id: 'kimi-k3', enabled: true },
    { id: 'kimi-k3-turbo', enabled: true },
  ],
  source: 'user',
  createdAt: 0,
  updatedAt: 0,
  ...o,
});

async function addFlow(presetId: string, key?: string) {
  // 预设要等 gateway 状态与 presets 两段异步依次返回才渲染；慢 CI（macOS）上会超过默认 1s
  fireEvent.click(await screen.findByTestId(`models-preset-${presetId}`, {}, { timeout: 5000 }));
  if (key) fireEvent.change(screen.getByTestId('models-provider-key'), { target: { value: key } });
  fireEvent.click(screen.getByTestId('models-provider-save'));
}

describe('ModelsPage', () => {
  it('no provider: the inline form is open and model assignment is greyed out', async () => {
    fakeMain();
    render(<ModelsPage />);
    expect(await screen.findByTestId('models-empty')).toBeTruthy();
    expect(await screen.findByTestId('models-provider-picker')).toBeTruthy();
    // 没有供应商时不弹对话框，也没有「取消」
    expect(screen.queryByTestId('models-provider-cancel')).toBeNull();
    const assign = screen.getByTestId('models-assign');
    expect(assign.getAttribute('data-state')).toBe('disabled');
    expect(assign.getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByTestId('models-assign-off').textContent).toContain('先配置好第三方供应商');
    expect(screen.queryByTestId('models-offer')).toBeNull();
  });

  it('add a preset inline: real detection, keys, models; then pick the chat model below', async () => {
    const m = fakeMain();
    render(<ModelsPage />);
    await addFlow('deepseek', 'sk-aaaa1111 sk-bbbb2222');
    await screen.findByTestId('provider-deepseek');
    const detect = m.calls.find(([c]) => c === 'gateway.detect')![1];
    // 预设写明的各协议地址直接拿去测，不再从 baseURL 推导
    expect(detect).not.toHaveProperty('url');
    expect(detect).toMatchObject({
      urls: { chat: 'https://api.deepseek.com/v1', messages: 'https://api.deepseek.com/anthropic' },
      keys: ['sk-aaaa1111', 'sk-bbbb2222'],
      fallbackModel: 'deepseek-v4-pro',
    });
    const saved = m.calls.find(([c]) => c === 'gateway.upsertProvider')![1];
    expect(saved).toMatchObject({
      name: 'DeepSeek',
      presetId: 'deepseek',
      urls: { chat: 'https://api.deepseek.com/v1' },
      newKeys: [{ value: 'sk-aaaa1111' }, { value: 'sk-bbbb2222' }],
      detected: { chat: { ok: true }, messages: { ok: false, status: 404 } },
      quirks: { reasoningPassback: true },
    });
    // 预设推荐的默认启用，不能对话的模型存下但不启用；预设整理的元数据随模型一起存
    const models = (saved as { models: Array<{ id: string; enabled: boolean }> }).models;
    expect(models.map((x) => x.enabled)).toEqual([true, true, false]);
    expect(models[0]).toEqual({
      id: 'deepseek-v4-pro',
      enabled: true,
      ctx: 1_000_000,
      maxOutput: 393_216,
      reasoning: true,
      vision: false,
      toolCalling: true,
      metaSource: 'preset',
    });
    const row = screen.getByTestId('provider-deepseek');
    expect(row.textContent).toContain('2 个 Key');
    expect(row.textContent).toContain('2 个模型');
    // 保存后表单收起，模型分配可用，推荐模型已默认填为 Nomi 对话的模型
    await waitFor(() => expect(screen.queryByTestId('models-provider-picker')).toBeNull());
    await waitFor(() => expect(m.state.clients.nomi!.models.main).toBe('deepseek/deepseek-v4-pro'));
    expect(screen.getByTestId('models-assign').getAttribute('data-state')).toBe('ready');
    // 不再在分配上方列出这家的全部模型（与下面的「Nomi 对话」重复）
    expect(screen.queryByTestId('models-fresh')).toBeNull();
    // 用户在「Nomi 对话」里可以改
    fireEvent.change(screen.getByTestId('assign-chat'), {
      target: { value: 'deepseek/deepseek-v4-flash' },
    });
    await waitFor(() =>
      expect(m.state.clients.nomi!.models.main).toBe('deepseek/deepseek-v4-flash'),
    );
    await waitFor(() =>
      expect(screen.getByTestId('assign-chat').closest('div')?.textContent).toContain(
        'DeepSeek / deepseek-v4-flash',
      ),
    );
  });

  it('with providers already set up, 添加 opens the form in a dialog; with none it stays inline', async () => {
    const m = fakeMain();
    m.state.providers = [kimi({ models: [{ id: 'kimi-k3', enabled: true }] })];
    render(<ModelsPage />);
    const add = await screen.findByTestId('add-provider');
    expect(screen.queryByTestId('models-provider-picker')).toBeNull();
    fireEvent.click(add);
    const dialog = await screen.findByTestId('models-add-provider-dialog');
    expect(within(dialog).getByTestId('models-provider-picker')).toBeTruthy();
    fireEvent.click(within(dialog).getByTestId('models-preset-custom'));
    fireEvent.click(within(dialog).getByTestId('models-provider-cancel'));
    await waitFor(() => expect(screen.queryByTestId('models-add-provider-dialog')).toBeNull());
  });

  it('image generation: lists only image models (even disabled ones) and saves clients.nomi.models.image', async () => {
    const m = fakeMain();
    m.state.providers = [
      kimi({
        models: [
          { id: 'kimi-k3', enabled: true },
          { id: 'gpt-image-2', enabled: false },
        ],
      }),
    ];
    m.state.clients.nomi = { models: { main: 'kimi/kimi-k3' } };
    render(<ModelsPage />);
    // Nomi 卡片：主模型在卡片上，工具调用 / 摘要 / 图片生成点箭头展开
    expect(screen.queryByTestId('assign-image')).toBeNull();
    fireEvent.click(await screen.findByTestId('nomi-more'));
    const image = (await screen.findByTestId('assign-image')) as HTMLSelectElement;
    const values = (el: HTMLSelectElement) => [...el.options].map((o) => o.value);
    expect(values(image)).toEqual(['unset', 'kimi/gpt-image-2']);
    // 对话的模型里没有生图模型
    expect(values(screen.getByTestId('assign-chat') as HTMLSelectElement)).not.toContain(
      'kimi/gpt-image-2',
    );
    fireEvent.change(image, { target: { value: 'kimi/gpt-image-2' } });
    await waitFor(() => expect(m.state.clients.nomi!.models.image).toBe('kimi/gpt-image-2'));
    fireEvent.change(screen.getByTestId('assign-image'), { target: { value: 'unset' } });
    await waitFor(() => expect(m.state.clients.nomi!.models.image).toBeUndefined());
  });

  it('first provider: the chat model is filled in even when the change event arrives before the save returns', async () => {
    // 内联表单在有了供应商后卸载；保存结果晚到时也要给 Nomi 对话填上推荐模型
    const m = fakeMain({
      beforeUpsertReturns: () =>
        waitFor(() => expect(screen.queryByTestId('models-provider-picker')).toBeNull()),
    });
    render(<ModelsPage />);
    await addFlow('deepseek', 'sk-aaaa1111');
    await waitFor(() => expect(m.state.clients.nomi!.models.main).toBe('deepseek/deepseek-v4-pro'));
  });

  it('adding another provider keeps the chat model already chosen', async () => {
    const m = fakeMain();
    m.state.providers = [kimi()];
    m.state.clients.nomi = { models: { main: 'kimi/kimi-k3' } };
    render(<ModelsPage />);
    expect(screen.queryByTestId('models-provider-picker')).toBeNull();
    fireEvent.click(await screen.findByTestId('add-provider'));
    expect(await screen.findByTestId('models-provider-picker')).toBeTruthy();
    // 有供应商时可以取消
    fireEvent.click(screen.getByTestId('models-provider-cancel'));
    await waitFor(() => expect(screen.queryByTestId('models-provider-picker')).toBeNull());
    fireEvent.click(screen.getByTestId('add-provider'));
    await addFlow('deepseek', 'sk-aaaa1111');
    await waitFor(() => expect(screen.getByTestId('provider-deepseek')).toBeTruthy());
    expect(m.state.clients.nomi!.models.main).toBe('kimi/kimi-k3');
  });

  it('cannot save when every protocol fails, and shows each reason', async () => {
    const m = fakeMain({
      detect: () => ({
        wires: {
          chat: {
            wire: 'chat',
            url: 'https://x/v1',
            ok: false,
            error: 'Key 无效或没有权限（鉴权失败）',
            ms: 5,
          },
        },
        byKey: {},
        models: [],
        urls: {},
      }),
    });
    render(<ModelsPage />);
    await addFlow('deepseek', 'sk-bad');
    const err = await screen.findByTestId('models-provider-error');
    expect(err.textContent).toContain('所有协议都不可用，不能保存');
    expect(err.textContent).toContain('Key 无效或没有权限');
    expect(upserts(m)).toHaveLength(0);
    expect(screen.getByTestId('models-provider-form')).toBeTruthy();
  });

  it('custom address: optional test model is sent as fallbackModel and saved when /models is empty (#161)', async () => {
    const m = fakeMain({
      detect: (i) => ({
        wires: {
          chat: {
            wire: 'chat',
            url: String(i.url),
            ok: true,
            model: String(i.fallbackModel ?? ''),
            ms: 5,
          },
        },
        byKey: {},
        models: [],
        urls: { chat: String(i.url) },
      }),
    });
    render(<ModelsPage />);
    fireEvent.click(await screen.findByTestId('models-preset-custom'));
    fireEvent.change(screen.getByTestId('models-provider-url'), {
      target: { value: 'https://relay.example.com/v1' },
    });
    fireEvent.change(screen.getByTestId('models-provider-key'), { target: { value: 'sk-xyz' } });
    fireEvent.change(screen.getByTestId('models-provider-name'), {
      target: { value: ' My Relay ' },
    });
    expect(screen.getByTestId('models-provider-test-model')).toBeTruthy();
    fireEvent.change(screen.getByTestId('models-provider-test-model'), {
      target: { value: 'my-synth-model' },
    });
    fireEvent.click(screen.getByTestId('models-provider-save'));
    await waitFor(() => expect(upserts(m)).toHaveLength(1));
    const detect = m.calls.find(([c]) => c === 'gateway.detect')![1] as Record<string, unknown>;
    expect(detect.fallbackModel).toBe('my-synth-model');
    expect(upserts(m)[0]!.models.map((x) => x.id)).toContain('my-synth-model');
    expect(upserts(m)[0]!.name).toBe('My Relay');
  });

  it('custom address with empty /models and no test model shows an actionable error (#161)', async () => {
    const m = fakeMain({
      detect: () => ({
        wires: {
          chat: { wire: 'chat', url: 'https://relay.example.com/v1', ok: true, ms: 5 },
        },
        byKey: {},
        models: [],
        urls: { chat: 'https://relay.example.com/v1' },
      }),
    });
    render(<ModelsPage />);
    fireEvent.click(await screen.findByTestId('models-preset-custom'));
    fireEvent.change(screen.getByTestId('models-provider-url'), {
      target: { value: 'https://relay.example.com/v1' },
    });
    fireEvent.change(screen.getByTestId('models-provider-key'), { target: { value: 'sk-1' } });
    fireEvent.click(screen.getByTestId('models-provider-save'));
    const err = await screen.findByTestId('models-provider-error');
    expect(err.textContent).toMatch(/测试用模型|test model/i);
    expect(upserts(m)).toHaveLength(0);
    expect(screen.getByTestId('models-provider-test-model')).toBeTruthy();
  });

  it('cancelling while detect is in flight does not upsert (#162)', async () => {
    let resolveDetect!: (v: DetectResult) => void;
    const m = fakeMain({
      detect: () =>
        new Promise<DetectResult>((r) => {
          resolveDetect = r;
        }),
    });
    m.state.providers = [kimi()];
    render(<ModelsPage />);
    fireEvent.click(await screen.findByTestId('add-provider'));
    fireEvent.click(await screen.findByTestId('models-preset-deepseek'));
    fireEvent.change(screen.getByTestId('models-provider-key'), { target: { value: 'sk-aaaa' } });
    fireEvent.click(screen.getByTestId('models-provider-save'));
    await waitFor(() => expect(m.calls.some(([c]) => c === 'gateway.detect')).toBe(true));
    fireEvent.click(screen.getByTestId('models-provider-cancel'));
    resolveDetect(okDetect('https://api.deepseek.com'));
    await new Promise((x) => setTimeout(x, 80));
    expect(upserts(m)).toHaveLength(0);
    expect(m.state.providers.map((p) => p.id)).toEqual(['kimi']);
  });

  it('custom address needs an address; local presets need no key and are confirmed automatically', async () => {
    const m = fakeMain();
    render(<ModelsPage />);
    // custom chip is always mounted; wait for async presets (ollama) before switching
    await screen.findByTestId('models-preset-ollama', {}, { timeout: 5000 });
    fireEvent.click(screen.getByTestId('models-preset-custom'));
    fireEvent.change(screen.getByTestId('models-provider-key'), { target: { value: 'sk-1234' } });
    const save = screen.getByTestId('models-provider-save') as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(screen.getByTestId('models-provider-url'), {
      target: { value: 'https://relay.example.com/v1/chat/completions' },
    });
    expect(save.disabled).toBe(false);
    // 两步：先回到分组列表再选别的
    fireEvent.click(screen.getByTestId('models-provider-back'));
    fireEvent.click(screen.getByTestId('models-preset-ollama'));
    expect(screen.getByText('本地服务不需要 Key。')).toBeTruthy();
    fireEvent.click(screen.getByTestId('models-provider-save'));
    await waitFor(() => expect(m.state.allowedPrivateHosts).toEqual(['localhost:11434']));
    expect(window.confirm).not.toHaveBeenCalled();
  });

  it('a custom private address asks first; declining does not probe', async () => {
    const m = fakeMain();
    vi.mocked(window.confirm).mockReturnValue(false);
    render(<ModelsPage />);
    fireEvent.click(await screen.findByTestId('models-preset-custom'));
    fireEvent.change(screen.getByTestId('models-provider-url'), {
      target: { value: 'http://192.168.1.20:8000/v1' },
    });
    fireEvent.change(screen.getByTestId('models-provider-key'), { target: { value: 'sk-1' } });
    fireEvent.click(screen.getByTestId('models-provider-save'));
    await waitFor(() => expect(window.confirm).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByTestId('models-provider-url')).toBeTruthy());
    expect(m.calls.some(([c]) => c === 'gateway.detect')).toBe(false);
    expect(m.state.allowedPrivateHosts).toEqual([]);
  });

  it('toggling a model is saved from the detail dialog; removing a provider asks first', async () => {
    const m = fakeMain();
    m.state.providers = [kimi()];
    render(<ModelsPage />);
    fireEvent.click(await screen.findByTestId('provider-open-kimi'));
    const dlg = detail();
    expect(within(dlg).getByDisplayValue('Kimi')).toBeTruthy();
    const save = within(dlg).getByTestId('provider-detail-save') as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.click(
      within(within(dlg).getByTestId('pd-model-kimi-k3-turbo')).getByRole('checkbox'),
    );
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    await waitFor(() =>
      expect(m.state.providers[0]!.models.map((x) => x.enabled)).toEqual([true, false]),
    );
    await waitFor(() => expect(screen.queryByTestId('provider-detail')).toBeNull());
    fireEvent.click(screen.getByTestId('provider-open-kimi'));
    fireEvent.click(within(detail()).getByTestId('provider-detail-remove'));
    expect(window.confirm).toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByTestId('provider-kimi')).toBeNull());
  });

  it('cancel and Esc discard the draft', async () => {
    const m = fakeMain();
    m.state.providers = [kimi()];
    render(<ModelsPage />);
    fireEvent.click(await screen.findByTestId('provider-open-kimi'));
    fireEvent.change(within(detail()).getByTestId('provider-detail-name'), {
      target: { value: 'Moonshot' },
    });
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('provider-detail')).toBeNull());
    fireEvent.click(screen.getByTestId('provider-open-kimi'));
    expect(within(detail()).getByDisplayValue('Kimi')).toBeTruthy();
    fireEvent.change(within(detail()).getByTestId('provider-detail-name'), {
      target: { value: 'Moonshot' },
    });
    fireEvent.click(within(detail()).getByTestId('provider-detail-cancel'));
    await waitFor(() => expect(screen.queryByTestId('provider-detail')).toBeNull());
    expect(upserts(m)).toHaveLength(0);
  });

  it('keys: reorder, rename, disable, delete (confirmed) and add several produce one upsert', async () => {
    const m = fakeMain();
    m.state.providers = [
      kimi({
        keys: [
          { id: 'k0', masked: 'sk-…0000', enabled: true, decryptable: true },
          {
            id: 'k1',
            masked: 'sk-…1111',
            enabled: true,
            decryptable: true,
            lastError: '401 Key 无效',
          },
          { id: 'k2', name: '旧的', masked: 'sk-…2222', enabled: true, decryptable: true },
        ],
      }),
    ];
    render(<ModelsPage />);
    fireEvent.click(await screen.findByTestId('provider-open-kimi'));
    const dlg = detail();
    expect(within(dlg).getByTestId('pd-key-error-k1').textContent).toBe('401 Key 无效');
    // k1 上移成为主 Key
    fireEvent.click(within(dlg).getByTestId('pd-key-up-k1'));
    // 焦点留在被移动 Key 的按钮上（到顶后上移不可用，落到下移）
    expect(document.activeElement).toBe(within(dlg).getByTestId('pd-key-down-k1'));
    fireEvent.change(within(dlg).getByLabelText('主 Key 的名称'), { target: { value: '公司' } });
    fireEvent.click(within(within(dlg).getByTestId('pd-key-k0')).getByRole('switch'));
    // 删除要确认；拒绝时不删
    vi.mocked(window.confirm).mockReturnValueOnce(false);
    fireEvent.click(within(dlg).getByTestId('pd-key-delete-k2'));
    expect(within(dlg).queryByTestId('pd-key-k2')).toBeTruthy();
    fireEvent.click(within(dlg).getByTestId('pd-key-delete-k2'));
    await waitFor(() => expect(within(dlg).queryByTestId('pd-key-k2')).toBeNull());
    fireEvent.click(within(dlg).getByTestId('pd-keys-open'));
    fireEvent.change(within(dlg).getByTestId('pd-keys-input'), {
      target: { value: 'sk-new-aaaa1111\n\n  sk-new-bbbb2222 \nsk-new-aaaa1111' },
    });
    fireEvent.click(within(dlg).getByTestId('pd-keys-add'));
    expect(within(dlg).getAllByTestId('pd-new-key')).toHaveLength(2);
    // 新 Key 与已保存 Key 共用顺序，可以在保存前成为主 Key。
    const fresh = within(dlg).getAllByTestId('pd-new-key')[0]!;
    fireEvent.click(within(fresh).getByRole('button', { name: /上移/ }));
    fireEvent.click(within(fresh).getByRole('button', { name: /上移/ }));
    expect(dlg.querySelector('[data-testid="pd-new-key"]')).toBe(fresh);
    // 检测同时包含草稿中仍启用的已保存 Key 和新 Key。
    fireEvent.click(within(dlg).getByTestId('pd-models-refresh'));
    await within(dlg).findByTestId('pd-detect-notice');
    const detection = m.calls.find(([c]) => c === 'gateway.detect')![1];
    expect(detection).toMatchObject({
      savedKeyIds: ['k1'],
      keys: ['sk-new-aaaa1111', 'sk-new-bbbb2222'],
    });
    fireEvent.click(within(dlg).getByTestId('provider-detail-save'));
    await waitFor(() => expect(upserts(m)).toHaveLength(1));
    const payload = upserts(m)[0]!;
    expect(payload.keys).toEqual([
      { id: 'k1', enabled: true, name: '公司' },
      { id: 'k0', enabled: false },
    ]);
    expect(payload.newKeys).toEqual([
      { value: 'sk-new-aaaa1111', position: 0, enabled: true },
      { value: 'sk-new-bbbb2222', position: 3, enabled: true },
    ]);
  });

  it('keys: a key typed but not added is saved with the provider', async () => {
    const m = fakeMain();
    m.state.providers = [kimi()];
    render(<ModelsPage />);
    fireEvent.click(await screen.findByTestId('provider-open-kimi'));
    const dlg = detail();
    const save = within(dlg).getByTestId('provider-detail-save') as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.click(within(dlg).getByTestId('pd-keys-open'));
    fireEvent.change(within(dlg).getByTestId('pd-keys-input'), {
      target: { value: 'sk-typed-cccc3333' },
    });
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    await waitFor(() => expect(upserts(m)).toHaveLength(1));
    expect(upserts(m)[0]!.newKeys).toEqual([
      { value: 'sk-typed-cccc3333', position: kimi().keys.length, enabled: true },
    ]);
  });

  it('keys: replace a saved key in place; a key pasted into the name is offered as a replacement', async () => {
    const m = fakeMain();
    m.state.providers = [
      kimi({
        keys: [
          { id: 'k0', masked: 'sk-…0000', enabled: true, decryptable: true },
          {
            id: 'k1',
            name: 'sk-pasted_Into_Name_1234567890',
            masked: 'sk-…1111',
            enabled: true,
            decryptable: true,
          },
        ],
      }),
    ];
    render(<ModelsPage />);
    fireEvent.click(await screen.findByTestId('provider-open-kimi'));
    const dlg = detail();
    fireEvent.click(within(dlg).getByTestId('pd-key-replace-k0'));
    fireEvent.change(within(dlg).getByTestId('pd-key-replace-input-k0'), {
      target: { value: '  sk-fresh-0000aaaa ' },
    });
    fireEvent.click(within(dlg).getByTestId('pd-key-name-to-replace-k1'));
    expect(within(dlg).queryByTestId('pd-key-name-hint-k1')).toBeNull();
    expect((within(dlg).getByTestId('pd-key-replace-input-k1') as HTMLInputElement).value).toBe(
      'sk-pasted_Into_Name_1234567890',
    );
    fireEvent.click(within(dlg).getByTestId('provider-detail-save'));
    await waitFor(() => expect(upserts(m)).toHaveLength(1));
    const payload = upserts(m)[0]!;
    expect(payload.keys).toEqual([]);
    expect(payload.newKeys).toEqual([
      { value: 'sk-fresh-0000aaaa', position: 0, enabled: true },
      { value: 'sk-pasted_Into_Name_1234567890', position: 1, enabled: true },
    ]);
  });

  it('keys: a note is edited in the key settings, shown on the card, saved only when changed', async () => {
    const m = fakeMain();
    m.state.providers = [
      kimi({
        keys: [
          { id: 'k0', masked: 'sk-…0000', enabled: true, decryptable: true, note: '公司账号' },
          { id: 'k1', masked: 'sk-…1111', enabled: true, decryptable: true },
        ],
      }),
    ];
    render(<ModelsPage />);
    fireEvent.click(await screen.findByTestId('provider-open-kimi'));
    const dlg = detail();
    expect(within(dlg).getByTestId('pd-key-note-text-k0').textContent).toBe('公司账号');
    expect(within(dlg).queryByTestId('pd-key-note-text-k1')).toBeNull();
    fireEvent.click(within(dlg).getByTestId('pd-key-settings-k1'));
    fireEvent.change(within(dlg).getByTestId('pd-key-note-k1'), {
      target: { value: '  个人账号，月底到期 ' },
    });
    fireEvent.click(within(dlg).getByTestId('provider-detail-save'));
    await waitFor(() => expect(upserts(m)).toHaveLength(1));
    const keys = upserts(m)[0]!.keys!;
    // 没改的不带 note；改了的去掉首尾空白
    expect(keys[0]).not.toHaveProperty('note');
    expect(keys[1]).toMatchObject({ id: 'k1', note: '个人账号，月底到期' });
  });

  it('keys: clearing a note sends an empty string; replacing a key keeps its note', async () => {
    const m = fakeMain();
    m.state.providers = [
      kimi({
        keys: [
          { id: 'k0', masked: 'sk-…0000', enabled: true, decryptable: true, note: '旧账号' },
          { id: 'k1', masked: 'sk-…1111', enabled: true, decryptable: true, note: '备用' },
        ],
      }),
    ];
    render(<ModelsPage />);
    fireEvent.click(await screen.findByTestId('provider-open-kimi'));
    const dlg = detail();
    fireEvent.click(within(dlg).getByTestId('pd-key-settings-k0'));
    fireEvent.change(within(dlg).getByTestId('pd-key-note-k0'), { target: { value: '' } });
    fireEvent.click(within(dlg).getByTestId('pd-key-replace-k1'));
    fireEvent.change(within(dlg).getByTestId('pd-key-replace-input-k1'), {
      target: { value: 'sk-fresh-1111bbbb' },
    });
    fireEvent.click(within(dlg).getByTestId('provider-detail-save'));
    await waitFor(() => expect(upserts(m)).toHaveLength(1));
    const payload = upserts(m)[0]!;
    expect(payload.keys).toEqual([expect.objectContaining({ id: 'k0', note: '' })]);
    expect(payload.newKeys).toEqual([
      expect.objectContaining({ value: 'sk-fresh-1111bbbb', position: 1, note: '备用' }),
    ]);
  });

  it('re-detect keeps edits made while it runs (#257)', async () => {
    let release!: (r: DetectResult) => void;
    const m = fakeMain({ detect: () => new Promise<DetectResult>((res) => (release = res)) });
    m.state.providers = [
      kimi({
        models: [
          { id: 'kimi-k3', enabled: true },
          { id: 'kimi-k3-turbo', enabled: false },
        ],
      }),
    ];
    render(<ModelsPage />);
    fireEvent.click(await screen.findByTestId('provider-open-kimi'));
    const dlg = detail();
    fireEvent.click(within(dlg).getByTestId('pd-models-refresh'));
    await waitFor(() => expect(m.calls.some(([c]) => c === 'gateway.detect')).toBe(true));
    // 检测还没返回：改名称、打开一个模型
    fireEvent.change(within(dlg).getByTestId('provider-detail-name'), {
      target: { value: 'Kimi 改名' },
    });
    fireEvent.click(
      within(within(dlg).getByTestId('pd-model-kimi-k3-turbo')).getByRole('checkbox'),
    );
    release({
      wires: {
        messages: { wire: 'messages', url: 'https://api.moonshot.cn/anthropic', ok: true, ms: 3 },
      },
      byKey: {},
      models: ['kimi-k3', 'kimi-k3-turbo', 'kimi-new'],
      urls: {},
    });
    await within(dlg).findByTestId('pd-detect-notice');
    // 改动都还在，新发现的模型照常合并进来（默认不启用）
    expect(within(dlg).getByDisplayValue('Kimi 改名')).toBeTruthy();
    expect(
      (
        within(within(dlg).getByTestId('pd-model-kimi-k3-turbo')).getByRole(
          'checkbox',
        ) as HTMLInputElement
      ).checked,
    ).toBe(true);
    expect(within(dlg).getByTestId('pd-model-kimi-new')).toBeTruthy();
    fireEvent.click(within(dlg).getByTestId('provider-detail-save'));
    await waitFor(() => expect(upserts(m)).toHaveLength(1));
    const payload = upserts(m)[0]!;
    expect(payload.name).toBe('Kimi 改名');
    expect(payload.models.map((x) => [x.id, x.enabled])).toEqual([
      ['kimi-k3', true],
      ['kimi-k3-turbo', true],
      ['kimi-new', false],
    ]);
  });

  it('a re-detect that returns after the address changed does not apply to the new address (#257)', async () => {
    let release!: (r: DetectResult) => void;
    const m = fakeMain({ detect: () => new Promise<DetectResult>((res) => (release = res)) });
    m.state.providers = [kimi()];
    render(<ModelsPage />);
    fireEvent.click(await screen.findByTestId('provider-open-kimi'));
    const dlg = detail();
    fireEvent.click(within(dlg).getByTestId('pd-models-refresh'));
    await waitFor(() => expect(m.calls.some(([c]) => c === 'gateway.detect')).toBe(true));
    fireEvent.click(within(dlg).getByTestId('pd-advanced-toggle'));
    fireEvent.change(within(dlg).getByTestId('pd-url-messages'), {
      target: { value: 'https://relay.example.com/anthropic' },
    });
    release({
      wires: {
        messages: { wire: 'messages', url: 'https://api.moonshot.cn/anthropic', ok: true, ms: 3 },
      },
      byKey: {},
      models: ['kimi-k3', 'kimi-old-endpoint-only'],
      urls: {},
    });
    await untilIdle();
    // 旧地址的结果没有套到新地址上：不出新模型、不提示检测结果，改过的地址仍提示重新检测
    expect(within(dlg).queryByTestId('pd-model-kimi-old-endpoint-only')).toBeNull();
    expect(within(dlg).queryByTestId('pd-detect-notice')).toBeNull();
    expect(within(dlg).getByDisplayValue('https://relay.example.com/anthropic')).toBeTruthy();
    expect(within(dlg).getByTestId('pd-urls-changed')).toBeTruthy();
  });

  it('models: add an id by hand; 刷新 merges newly listed models as disabled', async () => {
    const m = fakeMain({
      detect: () => ({
        wires: {
          messages: { wire: 'messages', url: 'https://api.moonshot.cn/anthropic', ok: true, ms: 3 },
        },
        byKey: {},
        models: ['kimi-k3', 'kimi-k3-vision', 'kimi-embedding'],
        urls: {},
      }),
    });
    m.state.providers = [
      kimi({
        models: [
          { id: 'kimi-k3', enabled: true, reasoning: true, ctx: 256_000, metaSource: 'preset' },
          { id: 'kimi-k3-turbo', enabled: false },
        ],
      }),
    ];
    render(<ModelsPage />);
    fireEvent.click(await screen.findByTestId('provider-open-kimi'));
    const dlg = detail();
    // 能力标签
    const k3 = within(dlg).getByTestId('pd-model-kimi-k3');
    expect(k3.textContent).toContain('推理');
    expect(k3.textContent).toContain('256K');
    fireEvent.change(within(dlg).getByTestId('pd-model-input'), { target: { value: 'kimi-x' } });
    fireEvent.keyDown(within(dlg).getByTestId('pd-model-input'), { key: 'Enter' });
    fireEvent.click(within(dlg).getByTestId('pd-models-refresh'));
    await within(dlg).findByTestId('pd-detect-notice');
    const det = m.calls.find(([c]) => c === 'gateway.detect')![1] as Record<string, unknown>;
    expect(det.providerId).toBe('kimi');
    expect(det).not.toHaveProperty('keys');
    fireEvent.click(within(dlg).getByTestId('provider-detail-save'));
    await waitFor(() => expect(upserts(m)).toHaveLength(1));
    const payload = upserts(m)[0]!;
    expect(payload.models).toEqual([
      { id: 'kimi-k3', enabled: true, reasoning: true, ctx: 256_000, metaSource: 'preset' },
      { id: 'kimi-k3-turbo', enabled: false },
      { id: 'kimi-x', enabled: true },
      { id: 'kimi-k3-vision', enabled: false },
      { id: 'kimi-embedding', enabled: false, toolCalling: false },
    ]);
    expect(payload.detected).toMatchObject({ messages: { ok: true } });
  });

  it('models: search and status filter narrow the list; enable / disable all act on what is shown', async () => {
    const m = fakeMain();
    m.state.providers = [
      kimi({
        models: [
          { id: 'kimi-k3', enabled: true },
          { id: 'kimi-k3-turbo', enabled: false },
          { id: 'moonshot-v1', enabled: false },
        ],
      }),
    ];
    render(<ModelsPage />);
    fireEvent.click(await screen.findByTestId('provider-open-kimi'));
    const dlg = detail();
    expect(within(dlg).getByTestId('pd-models-count').textContent).toContain('1');
    fireEvent.change(within(dlg).getByTestId('pd-model-search'), { target: { value: 'K3' } });
    expect(within(dlg).queryByTestId('pd-model-moonshot-v1')).toBeNull();
    expect(within(dlg).getByTestId('pd-model-kimi-k3-turbo')).toBeTruthy();
    // 只启用筛出来的两个，moonshot-v1 不动
    fireEvent.click(within(dlg).getByTestId('pd-models-enable-shown'));
    fireEvent.change(within(dlg).getByTestId('pd-model-search'), { target: { value: '' } });
    fireEvent.change(within(dlg).getByTestId('pd-model-filter'), { target: { value: 'off' } });
    expect(within(dlg).getByTestId('pd-model-moonshot-v1')).toBeTruthy();
    expect(within(dlg).queryByTestId('pd-model-kimi-k3')).toBeNull();
    fireEvent.change(within(dlg).getByTestId('pd-model-search'), { target: { value: 'nope' } });
    expect(within(dlg).getByText('没有匹配的模型')).toBeTruthy();
    fireEvent.click(within(dlg).getByTestId('provider-detail-save'));
    await waitFor(() => expect(upserts(m)).toHaveLength(1));
    expect(upserts(m)[0]!.models.map((x) => [x.id, x.enabled])).toEqual([
      ['kimi-k3', true],
      ['kimi-k3-turbo', true],
      ['moonshot-v1', false],
    ]);
  });

  it('context limits: badges show the effective value; manual limits save as user-set', async () => {
    const m = fakeMain({
      detect: () => ({
        wires: { chat: { wire: 'chat', url: 'https://relay/v1', ok: true, ms: 3 } },
        byKey: {},
        models: ['openai/gpt-6-astra', 'acme/new-model'],
        limits: { 'acme/new-model': { ctx: 262_144, maxOutput: 16_384 } },
        urls: {},
      }),
    });
    m.state.providers = [
      kimi({
        models: [
          {
            id: 'openai/gpt-6-astra',
            enabled: true,
            metaSource: 'user',
            effective: {
              ctx: 1_050_000,
              maxOutput: 128_000,
              reasoning: true,
              source: 'catalog',
              maxOutputSource: 'catalog',
            },
          },
          {
            id: 'acme/mystery',
            enabled: true,
            effective: {
              ctx: 128_000,
              maxOutput: 32_000,
              source: 'default',
              maxOutputSource: 'default',
            },
          },
        ],
      }),
    ];
    render(<ModelsPage />);
    fireEvent.click(await screen.findByTestId('provider-open-kimi'));
    const dlg = detail();
    const astra = within(dlg).getByTestId('pd-model-openai/gpt-6-astra');
    // 抹零显示：1,050,000 → 1M，不四舍五入成 1.1M
    expect(astra.textContent).toContain('1M');
    expect(astra.textContent).not.toContain('1.1M');
    expect(astra.textContent).toContain('推理');
    expect(within(dlg).getByTestId('pd-model-acme/mystery').textContent).toContain('参数未知');

    // 默认在右侧打开第一个启用的模型
    const ctx = within(dlg).getByTestId('pd-model-ctx-openai/gpt-6-astra') as HTMLInputElement;
    // 自动取值显示在占位里，输入框本身是空的
    expect(ctx.value).toBe('');
    expect(ctx.placeholder).toContain('内置模型目录');
    // 点另一个模型：右侧换成它的设置
    fireEvent.click(within(dlg).getByTestId('pd-model-open-acme/mystery'));
    expect(within(dlg).queryByTestId('pd-model-ctx-openai/gpt-6-astra')).toBeNull();
    fireEvent.change(within(dlg).getByTestId('pd-model-ctx-acme/mystery'), {
      target: { value: '400000' },
    });

    fireEvent.click(within(dlg).getByTestId('pd-models-refresh'));
    await within(dlg).findByTestId('pd-detect-notice');
    fireEvent.click(within(dlg).getByTestId('provider-detail-save'));
    await waitFor(() => expect(upserts(m)).toHaveLength(1));
    expect(upserts(m)[0]!.models).toEqual([
      { id: 'openai/gpt-6-astra', enabled: true, metaSource: 'user' },
      { id: 'acme/mystery', enabled: true, ctx: 400_000, maxOutput: undefined, metaSource: 'user' },
      // 模型列表接口返回的上限随新模型一起存下
      {
        id: 'acme/new-model',
        enabled: false,
        ctx: 262_144,
        maxOutput: 16_384,
        metaSource: 'listed',
      },
    ]);
  });

  it('long context default per model: only models with a standard window get the switch', async () => {
    const m = fakeMain();
    m.state.providers = [
      kimi({
        models: [
          {
            id: 'openai/gpt-6.1-sol',
            enabled: true,
            effective: {
              ctx: 272_000,
              maxOutput: 128_000,
              source: 'catalog',
              maxOutputSource: 'catalog',
              longContext: { standard: 272_000, full: 922_000, on: false },
            },
          },
          {
            id: 'openai/gpt-5.2',
            enabled: true,
            effective: {
              ctx: 272_000,
              maxOutput: 128_000,
              source: 'catalog',
              maxOutputSource: 'catalog',
            },
          },
        ],
      }),
    ];
    render(<ModelsPage />);
    fireEvent.click(await screen.findByTestId('provider-open-kimi'));
    const dlg = detail();
    fireEvent.click(within(dlg).getByTestId('pd-model-open-openai/gpt-5.2'));
    expect(within(dlg).queryByTestId('pd-model-long-openai/gpt-5.2')).toBeNull();
    fireEvent.click(within(dlg).getByTestId('pd-model-open-openai/gpt-6.1-sol'));
    const sw = within(dlg).getByTestId('pd-model-long-openai/gpt-6.1-sol');
    expect(sw.closest('div')?.textContent).toContain('标准 272K · 长上下文 922K');
    fireEvent.click(sw);
    fireEvent.click(within(dlg).getByTestId('provider-detail-save'));
    await waitFor(() => expect(upserts(m)).toHaveLength(1));
    expect(upserts(m)[0]!.models![0]).toEqual({
      id: 'openai/gpt-6.1-sol',
      enabled: true,
      longContext: true,
    });
  });

  it('Base URL: Enter detects, the detected per-API addresses are saved', async () => {
    const m = fakeMain({
      detect: () => ({
        wires: { chat: { wire: 'chat', ok: true }, messages: { wire: 'messages', ok: true } },
        byKey: {},
        models: [],
        urls: { chat: 'https://new.example/v1', messages: 'https://new.example' },
      }),
    });
    m.state.providers = [kimi({ urls: { chat: 'https://api.moonshot.cn/v1' } })];
    render(<ModelsPage />);
    fireEvent.click(await screen.findByTestId('provider-open-kimi'));
    const dlg = detail();
    const base = within(dlg).getByTestId('pd-base-url') as HTMLInputElement;
    expect(base.value).toBe('https://api.moonshot.cn/v1');
    fireEvent.change(base, { target: { value: 'https://new.example/v1' } });
    fireEvent.keyDown(base, { key: 'Enter' });
    await waitFor(() =>
      expect(within(dlg).getByTestId('pd-wire-messages').hasAttribute('data-ok')).toBe(true),
    );
    const det = m.calls.find(([c]) => c === 'gateway.detect')![1] as Record<string, unknown>;
    expect(det).toMatchObject({ providerId: 'kimi', url: 'https://new.example/v1' });
    expect(det).not.toHaveProperty('urls');
    fireEvent.click(within(dlg).getByTestId('provider-detail-save'));
    await waitFor(() => expect(upserts(m)).toHaveLength(1));
    expect(upserts(m)[0]!.urls).toEqual({
      messages: 'https://new.example',
      chat: 'https://new.example/v1',
    });
    // 填的 Base URL 原样存下（下次打开原样显示，不换成推出来的某个协议地址）
    expect(upserts(m)[0]!.baseUrl).toBe('https://new.example/v1');
  });

  it('saving per-API addresses that changed detects them first, so the list shows the right APIs', async () => {
    const m = fakeMain({
      detect: () => ({
        wires: {
          chat: { wire: 'chat', ok: true, status: 200 },
          responses: { wire: 'responses', ok: true, status: 200 },
        },
        byKey: {},
        models: [],
        urls: { chat: 'https://api.moonshot.cn/v1', responses: 'https://api.moonshot.cn/v1' },
      }),
    });
    m.state.providers = [
      kimi({
        urls: { chat: 'https://api.moonshot.cn/v1' },
        detected: { chat: { ok: true, at: 1 }, responses: { ok: false, at: 1, status: 503 } },
      }),
    ];
    render(<ModelsPage />);
    fireEvent.click(await screen.findByTestId('provider-open-kimi'));
    const dlg = detail();
    fireEvent.click(within(dlg).getByTestId('pd-advanced-toggle'));
    fireEvent.change(within(dlg).getByTestId('pd-url-add'), { target: { value: 'responses' } });
    fireEvent.change(within(dlg).getByTestId('pd-url-responses'), {
      target: { value: 'https://api.moonshot.cn/v1' },
    });
    fireEvent.click(within(dlg).getByTestId('provider-detail-save'));
    await waitFor(() => expect(upserts(m)).toHaveLength(1));
    const det = m.calls.find(([c]) => c === 'gateway.detect')![1] as Record<string, unknown>;
    expect(det).toMatchObject({ urls: { responses: 'https://api.moonshot.cn/v1' } });
    expect(upserts(m)[0]!.detected).toMatchObject({ responses: { ok: true } });
  });

  it('a saved Base URL is shown as typed, not rebuilt from the per-API addresses', async () => {
    const m = fakeMain();
    m.state.providers = [
      kimi({
        baseUrl: 'https://api.xytoken.example',
        urls: { chat: 'https://api.xytoken.example/v1', messages: 'https://api.xytoken.example' },
      }),
    ];
    render(<ModelsPage />);
    fireEvent.click(await screen.findByTestId('provider-open-kimi'));
    expect((within(detail()).getByTestId('pd-base-url') as HTMLInputElement).value).toBe(
      'https://api.xytoken.example',
    );
  });

  it('replacing a key: Enter in the new-value field saves right away', async () => {
    const m = fakeMain();
    m.state.providers = [kimi()];
    render(<ModelsPage />);
    fireEvent.click(await screen.findByTestId('provider-open-kimi'));
    const dlg = detail();
    fireEvent.click(within(dlg).getByTestId('pd-key-replace-k0'));
    const input = within(dlg).getByTestId('pd-key-replace-input-k0');
    fireEvent.change(input, { target: { value: 'sk-new-value-0000000000' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(upserts(m)).toHaveLength(1));
    // 保存后弹窗还开着，可以接着改
    expect(screen.getByTestId('provider-detail')).toBeTruthy();
    expect(upserts(m)[0]!.newKeys).toEqual([
      expect.objectContaining({ value: 'sk-new-value-0000000000', position: 0 }),
    ]);
  });

  it('model settings on the right: treat as a known model, standard window, upstream name, remove', async () => {
    const m = fakeMain({
      extra: {
        'gateway.catalogModels': () => [
          { id: 'claude-opus-4-8', family: 'claude-opus', context: 1_000_000 },
        ],
      },
    });
    m.state.providers = [
      kimi({
        models: [
          { id: 'Aerith-opus-5.5', enabled: true },
          { id: 'spare', enabled: true },
        ],
      }),
    ];
    render(<ModelsPage />);
    fireEvent.click(await screen.findByTestId('provider-open-kimi'));
    const dlg = detail();
    const like = within(dlg).getByTestId('pd-model-like-Aerith-opus-5.5');
    await waitFor(() => expect(like.querySelectorAll('option').length).toBeGreaterThan(1));
    // 与其它模型下拉同一个 ModelPicker：值是「来源/模型」
    fireEvent.change(like, { target: { value: 'known/claude-opus-4-8' } });
    fireEvent.change(within(dlg).getByTestId('pd-model-standard-Aerith-opus-5.5'), {
      target: { value: '200000' },
    });
    fireEvent.change(within(dlg).getByTestId('pd-model-upstream-Aerith-opus-5.5'), {
      target: { value: 'opus-real' },
    });
    // 列表行上显示按哪个模型处理
    expect(within(dlg).getByTestId('pd-model-Aerith-opus-5.5').textContent).toContain(
      'claude-opus-4-8',
    );
    fireEvent.click(within(dlg).getByTestId('pd-model-open-spare'));
    fireEvent.click(within(dlg).getByTestId('pd-model-remove-spare'));
    fireEvent.click(within(dlg).getByTestId('provider-detail-save'));
    await waitFor(() => expect(upserts(m)).toHaveLength(1));
    const payload = upserts(m)[0]!;
    expect(payload.models).toEqual([
      { id: 'Aerith-opus-5.5', enabled: true, like: 'claude-opus-4-8', ctxStandard: 200_000 },
    ]);
    expect(payload.modelMap).toEqual([{ from: 'Aerith-opus-5.5', to: 'opus-real' }]);
  });

  it('provider order: drag a row onto another, or Alt+arrows on the grip; env providers are not sortable', async () => {
    const m = fakeMain();
    m.state.providers = [
      kimi(),
      { ...kimi(), id: 'ds', name: 'DeepSeek' },
      { ...kimi(), id: 'env-x', name: 'Env', source: 'env' },
    ];
    render(<ModelsPage />);
    await screen.findByTestId('provider-open-kimi');
    expect(screen.getByTestId('providers-order-hint')).toBeTruthy();
    expect(screen.queryByTestId('provider-grip-env-x')).toBeNull();
    const dt = { setData: () => undefined, effectAllowed: '', dropEffect: '' };
    fireEvent.dragStart(screen.getByTestId('provider-kimi'), { dataTransfer: dt });
    fireEvent.dragOver(screen.getByTestId('provider-ds'), { dataTransfer: dt });
    fireEvent.drop(screen.getByTestId('provider-ds'), { dataTransfer: dt });
    await waitFor(() =>
      expect(m.calls.filter(([c]) => c === 'gateway.reorderProviders').at(-1)?.[1]).toEqual({
        ids: ['ds', 'kimi'],
      }),
    );
    // 键盘：手柄上 Alt+↑ 把 kimi 移回第一位
    await waitFor(() =>
      expect(screen.getByTestId('provider-grip-kimi').getAttribute('aria-label')).toContain('2'),
    );
    fireEvent.keyDown(screen.getByTestId('provider-grip-kimi'), { key: 'ArrowUp', altKey: true });
    await waitFor(() =>
      expect(m.calls.filter(([c]) => c === 'gateway.reorderProviders').at(-1)?.[1]).toEqual({
        ids: ['kimi', 'ds'],
      }),
    );
  });

  it('the list has an enable switch per provider (not for env providers) instead of a ⋯ button', async () => {
    const m = fakeMain();
    m.state.providers = [kimi(), { ...kimi(), id: 'env-x', name: 'Env', source: 'env' }];
    render(<ModelsPage />);
    const sw = await screen.findByTestId('provider-enabled-kimi');
    expect(screen.queryByTestId('provider-enabled-env-x')).toBeNull();
    expect(screen.queryByRole('button', { name: /编辑「|查看「/ })).toBeNull();
    fireEvent.click(sw);
    await waitFor(() =>
      expect(m.calls.find(([c]) => c === 'gateway.setProviderEnabled')?.[1]).toEqual({
        id: 'kimi',
        enabled: false,
      }),
    );
    await waitFor(() =>
      expect(screen.getByTestId('provider-kimi').hasAttribute('data-off')).toBe(true),
    );
  });

  it('the provider dialog no longer has a per-provider fallback chain', async () => {
    const m = fakeMain();
    m.state.providers = [kimi()];
    render(<ModelsPage />);
    fireEvent.click(await screen.findByTestId('provider-open-kimi'));
    const dlg = detail();
    expect(within(dlg).queryByTestId('pd-fallback-add')).toBeNull();
    fireEvent.change(within(dlg).getByTestId('provider-detail-name'), {
      target: { value: 'Kimi 2' },
    });
    fireEvent.click(within(dlg).getByTestId('provider-detail-save'));
    await waitFor(() => expect(upserts(m)).toHaveLength(1));
    expect(upserts(m)[0]).not.toHaveProperty('fallback');
  });

  it('URLs (removing turns a protocol off), re-detect, wires, model map, headers, UA', async () => {
    const m = fakeMain({
      detect: () => ({ wires: {}, byKey: {}, models: [], urls: {} }),
    });
    m.state.providers = [
      kimi({
        urls: { messages: 'https://api.moonshot.cn/anthropic', chat: 'https://api.moonshot.cn/v1' },
        headers: { 'X-Old': '1' },
        modelMap: [{ from: 'a', to: 'b' }],
      }),
    ];
    render(<ModelsPage />);
    fireEvent.click(await screen.findByTestId('provider-open-kimi'));
    const dlg = detail();
    // 平时只改 Base URL；逐协议地址在「更多设置」里（只列填了的，其余在「添加协议地址」里）
    expect(within(dlg).queryByTestId('pd-url-chat')).toBeNull();
    fireEvent.click(within(dlg).getByTestId('pd-advanced-toggle'));
    expect(within(dlg).getByTestId('pd-url-chat')).toBeTruthy();
    expect(within(dlg).queryByTestId('pd-url-responses')).toBeNull();
    fireEvent.click(within(dlg).getByTestId('pd-url-remove-chat'));
    expect(within(dlg).queryByTestId('pd-url-chat')).toBeNull();
    fireEvent.change(within(dlg).getByTestId('pd-url-add'), { target: { value: 'responses' } });
    fireEvent.change(within(dlg).getByTestId('pd-url-responses'), {
      target: { value: 'https://api.moonshot.cn/v1' },
    });
    // 改了地址：提示重新检测，检测用草稿里的地址（空串表示不测）
    fireEvent.click(within(dlg).getByTestId('pd-redetect'));
    await waitFor(() => expect(within(dlg).queryByTestId('pd-urls-changed')).toBeNull());
    const det = m.calls.find(([c]) => c === 'gateway.detect')![1] as Record<string, unknown>;
    expect(det).toMatchObject({
      providerId: 'kimi',
      urls: {
        messages: 'https://api.moonshot.cn/anthropic',
        chat: '',
        responses: 'https://api.moonshot.cn/v1',
        gemini: '',
      },
    });
    // 模型的限定协议在右侧这个模型的设置里；Key 的在它自己的「设置」里
    fireEvent.click(within(dlg).getByTestId('pd-model-wire-kimi-k3-responses'));
    fireEvent.click(within(dlg).getByTestId('pd-key-settings-k0'));
    fireEvent.change(within(dlg).getByTestId('pd-key-wire-k0'), { target: { value: 'messages' } });
    // 列表里没有的模型名的映射、请求头、User-Agent 也在「更多设置」里
    fireEvent.change(within(dlg).getByTestId('pd-map-b-0'), { target: { value: 'kimi-k3' } });
    fireEvent.click(within(dlg).getByTestId('pd-map-add'));
    fireEvent.change(within(dlg).getByTestId('pd-map-a-1'), { target: { value: 'half-filled' } });
    fireEvent.click(within(dlg).getByTestId('pd-header-add'));
    fireEvent.change(within(dlg).getByTestId('pd-header-a-1'), { target: { value: 'X-Team' } });
    fireEvent.change(within(dlg).getByTestId('pd-header-b-1'), { target: { value: 'nomi' } });
    fireEvent.change(within(dlg).getByTestId('pd-user-agent'), { target: { value: 'nomi/1.1' } });
    fireEvent.click(within(dlg).getByTestId('provider-detail-save'));
    await waitFor(() => expect(upserts(m)).toHaveLength(1));
    const payload = upserts(m)[0]!;
    expect(payload.urls).toEqual({
      messages: 'https://api.moonshot.cn/anthropic',
      responses: 'https://api.moonshot.cn/v1',
      chat: '',
    });
    expect(payload.models![0]).toEqual({ id: 'kimi-k3', enabled: true, wires: ['responses'] });
    expect(payload.keys).toEqual([{ id: 'k0', enabled: true, wire: 'messages' }]);
    // 没填完整的映射行不保存
    expect(payload.modelMap).toEqual([{ from: 'a', to: 'kimi-k3' }]);
    expect(payload.headers).toEqual({ 'X-Old': '1', 'X-Team': 'nomi' });
    expect(payload.userAgent).toBe('nomi/1.1');
  });

  it('strict mode is off by default and the switch saves the gateway option', async () => {
    const m = fakeMain({
      extra: {
        'gateway.setOptions': (patch) => {
          m.state.strictParams = (patch as { strictParams: boolean }).strictParams;
          return structuredClone(m.state);
        },
      },
    });
    render(<ModelsPage />);
    // 严格模式在页底「高级」里
    expect(screen.queryByTestId('models-strict')).toBeNull();
    fireEvent.click(await screen.findByTestId('models-advanced-toggle'));
    const sw = await screen.findByTestId('models-strict');
    await waitFor(() => expect((sw as HTMLButtonElement).disabled).toBe(false));
    expect(sw.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(sw);
    await waitFor(() =>
      expect(m.calls).toContainEqual(['gateway.setOptions', { strictParams: true }]),
    );
  });

  it('context tier defaults to the model window and saves a hard cap', async () => {
    const m = fakeMain({
      extra: {
        'gateway.setOptions': (patch) => {
          const p = patch as { contextTier?: number };
          if (typeof p.contextTier === 'number') m.state.contextTier = p.contextTier || undefined;
          return structuredClone(m.state);
        },
      },
    });
    render(<ModelsPage />);
    fireEvent.click(await screen.findByTestId('models-advanced-toggle'));
    const sel = await screen.findByTestId('models-context-tier');
    expect((sel as HTMLSelectElement).value).toBe('0');
    fireEvent.change(sel, { target: { value: '262144' } });
    await waitFor(() =>
      expect(m.calls).toContainEqual(['gateway.setOptions', { contextTier: 262144 }]),
    );
  });

  it('advanced disclosure exposes request body limit and saves via set-options', async () => {
    const m = fakeMain({
      extra: {
        'gateway.setOptions': (patch) => {
          const p = patch as { maxRequestBodyBytes?: number };
          if (typeof p.maxRequestBodyBytes === 'number') {
            m.state.maxRequestBodyBytes = p.maxRequestBodyBytes;
          }
          return structuredClone(m.state);
        },
      },
    });
    m.state.maxRequestBodyBytes = 32 * 1024 * 1024;
    render(<ModelsPage />);
    expect(screen.queryByTestId('models-advanced')).toBeNull();
    fireEvent.click(await screen.findByTestId('models-advanced-toggle'));
    const input = await screen.findByTestId('models-body-limit');
    expect((input as HTMLInputElement).value).toBe('32');
    fireEvent.change(input, { target: { value: '64' } });
    await waitFor(() =>
      expect(m.calls).toContainEqual([
        'gateway.setOptions',
        { maxRequestBodyBytes: 64 * 1024 * 1024 },
      ]),
    );
  });

  it('per-key limits: only changed limits are sent; blank clears a saved limit', async () => {
    const m = fakeMain();
    m.state.providers = [
      kimi({
        keys: [
          { id: 'k0', masked: 'sk-…aaaa', enabled: true, decryptable: true, rpm: 60 },
          { id: 'k1', masked: 'sk-…bbbb', enabled: true, decryptable: true },
        ],
      }),
    ];
    render(<ModelsPage />);
    fireEvent.click(await screen.findByTestId('provider-open-kimi'));
    const dlg = detail();
    // 限流在每个 Key 自己的「设置」里
    fireEvent.click(within(dlg).getByTestId('pd-key-settings-k0'));
    fireEvent.click(within(dlg).getByTestId('pd-key-settings-k1'));
    expect((within(dlg).getByTestId('pd-key-rpm-k0') as HTMLInputElement).value).toBe('60');
    fireEvent.change(within(dlg).getByTestId('pd-key-rpm-k0'), { target: { value: '' } });
    fireEvent.change(within(dlg).getByTestId('pd-key-conc-k1'), { target: { value: '2' } });
    fireEvent.click(within(dlg).getByTestId('provider-detail-save'));
    await waitFor(() => expect(upserts(m)).toHaveLength(1));
    expect(upserts(m)[0]!.keys).toEqual([
      { id: 'k0', enabled: true, rpm: null },
      { id: 'k1', enabled: true, maxConcurrency: 2 },
    ]);
  });

  it('environment-variable providers are read-only', async () => {
    const m = fakeMain();
    m.state.providers = [
      kimi({
        id: 'env-deepseek',
        name: 'DeepSeek',
        source: 'env',
        keys: [
          {
            id: 'e0',
            masked: 'sk-…beef',
            enabled: true,
            decryptable: true,
            lastError: '429 限流',
          },
        ],
      }),
    ];
    render(<ModelsPage />);
    const row = await screen.findByTestId('provider-env-deepseek');
    expect(row.textContent).toContain('环境变量');
    fireEvent.click(within(row).getByTestId('provider-open-env-deepseek'));
    const dlg = detail();
    expect(within(dlg).getByTestId('provider-detail-readonly')).toBeTruthy();
    expect(within(dlg).getByText('环境变量')).toBeTruthy();
    expect(within(dlg).getByText('sk-…beef')).toBeTruthy();
    expect(within(dlg).getByText('429 限流')).toBeTruthy();
    expect(within(dlg).queryByTestId('provider-detail-save')).toBeNull();
    expect(within(dlg).queryByTestId('provider-detail-remove')).toBeNull();
    expect(within(dlg).queryByTestId('pd-keys-input')).toBeNull();
    expect(within(dlg).queryByTestId('provider-detail-name')).toBeNull();
    for (const c of within(dlg).getAllByRole('checkbox') as HTMLInputElement[])
      expect(c.disabled).toBe(true);
    fireEvent.click(within(dlg).getByTestId('provider-detail-cancel'));
    await waitFor(() => expect(screen.queryByTestId('provider-detail')).toBeNull());
    expect(upserts(m)).toHaveLength(0);
  });

  it('shows what was learned at runtime (高级) and clears it', async () => {
    const m = fakeMain();
    m.state.providers = [
      {
        id: 'r',
        name: 'Relay',
        enabled: true,
        urls: { chat: 'https://r/v1', responses: 'https://r/v1' },
        keys: [],
        models: [{ id: 'glm-5', enabled: true }],
        source: 'user',
        learned: {
          wireDown: { responses: { at: 1, reason: '3 次接口不存在' } },
          modelWire: { 'glm-5': ['chat'] },
          droppedParams: { chat: ['service_tier'] },
        },
        createdAt: 0,
        updatedAt: 0,
      },
    ];
    render(<ModelsPage />);
    fireEvent.click(await screen.findByTestId('provider-open-r'));
    fireEvent.click(within(detail()).getByTestId('pd-advanced-toggle'));
    const box = within(detail()).getByTestId('provider-learned');
    expect(box.textContent).toContain('Responses 暂时不可用：3 次接口不存在');
    expect(box.textContent).toContain('glm-5 只走 Chat');
    expect(box.textContent).toContain('Chat 不发送字段：service_tier');
    fireEvent.click(within(box).getByTestId('provider-learned-clear'));
    await waitFor(() =>
      expect(within(detail()).getByTestId('provider-learned').textContent).toContain(
        '还没有自动学到的状态',
      ),
    );
    expect(
      m.calls.some(
        ([c, a]) =>
          c === 'gateway.clearLearned' && (a as { providerId: string }).providerId === 'r',
      ),
    ).toBe(true);
  });

  describe('编程助手的第三方模型', () => {
    const seed = (m: ReturnType<typeof fakeMain>) => {
      m.state.providers = [
        {
          id: 'ds',
          name: 'DeepSeek',
          enabled: true,
          urls: { chat: 'https://api.deepseek.com/v1' },
          keys: [],
          models: [
            { id: 'v4', enabled: true, toolCalling: true },
            { id: 'flash', enabled: true, toolCalling: true },
            { id: 'embed', enabled: true, toolCalling: false },
          ],
          source: 'user',
          createdAt: 0,
          updatedAt: 0,
        },
      ];
    };
    const assignments = (m: ReturnType<typeof fakeMain>) =>
      m.calls
        .filter(([c]) => c === 'gateway.setAssignment')
        .map(([, a]) => [(a as { client: string }).client, (a as { patch: unknown }).patch]);
    const pick = (testId: string, value: string) =>
      fireEvent.change(screen.getByTestId(testId), { target: { value } });

    it('每个 CLI 一行；主模型写 set-assignment，「未设置」写 null，不在这里装 CLI 或显示账号', async () => {
      const m = fakeMain();
      seed(m);
      render(<ModelsPage />);
      for (const k of ['claude', 'codex', 'gemini', 'grok', 'dsh'])
        expect(await screen.findByTestId(`cli-row-${k}`)).toBeTruthy();
      expect(screen.getByTestId('models-cli').textContent).not.toContain('安装');
      // 编程助手只能选支持工具调用的模型
      const opts = Array.from(
        (screen.getByTestId('cli-main-codex') as HTMLSelectElement).options,
      ).map((o) => o.value);
      expect(opts).toContain('ds/v4');
      expect(opts).not.toContain('ds/embed');
      await waitFor(() =>
        expect((screen.getByTestId('cli-main-codex') as HTMLSelectElement).disabled).toBe(false),
      );
      pick('cli-main-codex', 'ds/v4');
      await waitFor(() =>
        expect(assignments(m)).toContainEqual([
          'codex',
          {
            models: { main: 'ds/v4' },
            newTabSource: 'thirdParty',
            newTabAccountId: null,
          },
        ]),
      );
      await waitFor(() => expect(m.state.clients.codex?.models.main).toBe('ds/v4'));
      pick('cli-main-codex', 'unset');
      await waitFor(() =>
        expect(assignments(m)).toContainEqual([
          'codex',
          { models: { main: null }, newTabSource: 'official' },
        ]),
      );
    });

    it('新标签默认用：默认（本机登录）/ 官方账号（跟随默认或指定账号）/ 第三方供应商三组；选供应商带上模型，清主模型退回官方', async () => {
      const m = fakeMain();
      seed(m);
      // 「新会话默认用」在「编程助手」页各助手的详情里；主模型仍在「模型」页
      render(
        <>
          <ModelsPage />
          <NewTabSourceRow kind="grok" />
        </>,
      );
      expect(within(screen.getByTestId('models-cli')).queryByTestId('cli-source-grok')).toBeNull();
      const src = (await screen.findByTestId('cli-source-grok')) as HTMLSelectElement;
      const values = () => Array.from(src.options).map((o) => o.value);
      // 默认 = 本机登录；官方账号组有「跟随默认」；第三方组是具体供应商（不是一个笼统开关）
      expect(values()).toContain('default');
      expect(values()).toContain('follow');
      expect(values()).toContain('provider:ds');
      // 初始没有账号偏好时选中「跟随默认账号」
      await waitFor(() => expect(src.value).toBe('follow'));
      // 默认：本机 grok 自己的登录目录（local-grok）
      pick('cli-source-grok', 'default');
      await waitFor(() =>
        expect(assignments(m)).toContainEqual([
          'grok',
          { newTabSource: 'official', newTabAccountId: 'local-grok' },
        ]),
      );
      // 第三方供应商：自动带上该供应商第一个可用模型
      pick('cli-source-grok', 'provider:ds');
      await waitFor(() =>
        expect(assignments(m)).toContainEqual([
          'grok',
          { newTabSource: 'thirdParty', newTabAccountId: null, models: { main: 'ds/v4' } },
        ]),
      );
      await waitFor(() => expect(m.state.clients.grok?.newTabSource).toBe('thirdParty'));
      // 清掉主模型：没有可用第三方模型，回退到官方（跟随默认账号）
      pick('cli-main-grok', 'unset');
      await waitFor(() =>
        expect(assignments(m)).toContainEqual([
          'grok',
          { models: { main: null }, newTabSource: 'official' },
        ]),
      );
    });

    it('没安装的 CLI 变灰并显示「安装」：确认框里是主进程给出的命令，确认后执行安装', async () => {
      const inst = (kind: string, path: string | null) => ({
        kind,
        path,
        version: path ? '1.0.0' : null,
        latest: '1.0.0',
        installMethod: 'npm',
        updateAvailable: false,
        updateSupported: true,
        installSupported: true,
      });
      let grokPath: string | null = null;
      const m = fakeMain({
        extra: {
          'cliUpdate.inspect': () => [
            inst('claude', '/bin/claude'),
            inst('codex', '/bin/codex'),
            inst('grok', grokPath),
          ],
          'cliUpdate.busy': () => null,
          'cliUpdate.preview': ({ kind }) => ({
            kind,
            mode: 'install',
            scope: 'global',
            argv: ['npm', 'install', '-g', 'grok-cli'],
            command: 'npm install -g grok-cli',
            requirements: [],
            blockers: [],
          }),
          'cliUpdate.run': () => {
            grokPath = '/bin/grok';
            return { ok: true, log: '', version: '1.0.0' };
          },
        },
      });
      seed(m);
      render(<ModelsPage />);
      const btn = await screen.findByTestId('cli-install-grok');
      const row = screen.getByTestId('cli-row-grok');
      expect(row.textContent).toContain('未安装');
      expect(within(row).queryByTestId('cli-main-grok')).toBeNull();
      // 装了的和主进程没报告的（gemini、dsh）照常显示选择器
      expect(screen.queryByTestId('cli-install-claude')).toBeNull();
      expect(screen.getByTestId('cli-main-gemini')).toBeTruthy();
      // 前置检查通过：点了直接装，不弹确认框
      fireEvent.click(btn);
      await waitFor(() =>
        expect(m.calls.find(([c]) => c === 'cliUpdate.run')?.[1]).toEqual({
          kind: 'grok',
          scope: 'global',
        }),
      );
      // 装好后重新检查，行恢复成选择器
      expect(await screen.findByTestId('cli-main-grok')).toBeTruthy();
      expect(screen.queryByTestId('cli-install-grok')).toBeNull();
    });

    it('Claude Code：一行只有主模型；展开各档（Haiku 档并入旧「小模型」）和子代理', async () => {
      const m = fakeMain();
      seed(m);
      m.state.clients.claude = {
        models: { main: 'ds/v4', small: 'ds/v4', tiers: { opus: 'ds/v4' } },
      };
      render(<ModelsPage />);
      await waitFor(() =>
        expect((screen.getByTestId('cli-main-claude') as HTMLSelectElement).disabled).toBe(false),
      );
      expect(screen.queryByTestId('cli-small-claude')).toBeNull();
      expect(screen.queryByTestId('cli-tier-haiku')).toBeNull();
      fireEvent.click(screen.getByTestId('cli-tiers-toggle'));
      expect(screen.getByTestId('cli-tiers-toggle').getAttribute('aria-expanded')).toBe('true');
      // 旧配置的「小模型」显示在 Haiku 档；改 Haiku 档时清掉旧字段
      expect((screen.getByTestId('cli-tier-haiku') as HTMLSelectElement).value).toBe('ds/v4');
      pick('cli-tier-haiku', 'ds/flash');
      await waitFor(() =>
        expect(assignments(m)).toContainEqual([
          'claude',
          { models: { tiers: { opus: 'ds/v4', haiku: 'ds/flash' }, small: null } },
        ]),
      );
      // 等新的网关状态回来再改下一档（各档整体写回，不丢已设的档）
      await waitFor(() =>
        expect((screen.getByTestId('cli-tier-haiku') as HTMLSelectElement).value).toBe('ds/flash'),
      );
      pick('cli-tier-opus', 'follow');
      await waitFor(() =>
        expect(assignments(m)).toContainEqual([
          'claude',
          { models: { tiers: { opus: null, haiku: 'ds/flash' } } },
        ]),
      );
      pick('cli-subagent', 'ds/flash');
      await waitFor(() =>
        expect(assignments(m)).toContainEqual(['claude', { models: { subagent: 'ds/flash' } }]),
      );
      // 辅助模型（标题、摘要等）：没设时跟随主模型
      expect((screen.getByTestId('cli-helper-claude') as HTMLSelectElement).value).toBe('follow');
      pick('cli-helper-claude', 'ds/flash');
      await waitFor(() =>
        expect(assignments(m)).toContainEqual(['claude', { models: { summary: 'ds/flash' } }]),
      );
    });

    it('其它编程助手：「更多」里只有辅助模型，可清回跟随主模型', async () => {
      const m = fakeMain();
      seed(m);
      m.state.clients.codex = { models: { main: 'ds/v4', summary: 'ds/flash' } };
      render(<ModelsPage />);
      fireEvent.click(await screen.findByTestId('cli-more-codex'));
      expect(screen.getByTestId('cli-more-codex').getAttribute('aria-expanded')).toBe('true');
      expect(screen.queryByTestId('cli-tier-haiku')).toBeNull();
      expect(screen.queryByTestId('cli-subagent')).toBeNull();
      await waitFor(() =>
        expect((screen.getByTestId('cli-helper-codex') as HTMLSelectElement).value).toBe(
          'ds/flash',
        ),
      );
      pick('cli-helper-codex', 'follow');
      await waitFor(() =>
        expect(assignments(m)).toContainEqual(['codex', { models: { summary: null } }]),
      );
    });
  });
});
