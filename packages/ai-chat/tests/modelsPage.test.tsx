// @vitest-environment happy-dom
/**
 * 「模型」页（统一网关）：分配 Nomi 对话的模型、第三方供应商列表、添加第三方供应商的三步流程。
 * 主进程用一个内存里的假 ai:gateway:* 代替。
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ModelsPage } from '../src/components/ModelsPage';
import type {
  DetectResult,
  GatewayState,
  ProviderInput,
  ProviderView,
} from '../src/services/gatewayClient';

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
    detect?: (input: Record<string, unknown>) => DetectResult;
    extra?: Record<string, (...a: unknown[]) => unknown>;
  } = {},
) {
  const state: GatewayState = {
    status: { state: 'running', port: 1, url: 'http://127.0.0.1:1' },
    providers: [],
    clients: { nomi: { models: {} } },
    allowedPrivateHosts: [],
    port: 1,
  };
  const calls: Array<[string, unknown[]]> = [];
  let changed: (() => void) | null = null;
  const invoke = vi.fn(async (ch: string, ...args: unknown[]) => {
    calls.push([ch, args]);
    if (o.extra?.[ch]) return o.extra[ch]!(...args);
    switch (ch) {
      case 'ai:providers:presets':
        return PRESETS;
      case 'ai:providers:state':
        return { providers: [], envProviders: [], overrideId: null };
      case 'ai:gateway:state':
        return structuredClone(state);
      case 'ai:gateway:detect':
        return (
          o.detect ?? ((i) => okDetect(String((i.urls as { chat?: string })?.chat ?? i.url)))
        )(args[0] as Record<string, unknown>);
      case 'ai:gateway:confirm-private-host':
        state.allowedPrivateHosts.push(String(args[0]));
        break;
      case 'ai:gateway:upsert-provider': {
        const i = args[0] as ProviderView & { newKeys?: Array<{ value: string }> };
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
        changed?.();
        return p;
      }
      case 'ai:gateway:clear-learned':
        for (const p of state.providers) if (p.id === args[0]) delete p.learned;
        changed?.();
        break;
      case 'ai:gateway:remove-provider':
        state.providers = state.providers.filter((p) => p.id !== args[0]);
        changed?.();
        break;
      case 'ai:gateway:set-assignment': {
        const client = args[0] as keyof GatewayState['clients'];
        const p = args[1] as {
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
        changed?.();
        break;
      }
      case 'ai:cli-account:list':
        return [];
    }
    return undefined;
  });
  (window as unknown as { aiIPC: unknown }).aiIPC = {
    invoke,
    on: (ch: string, fn: () => void) => {
      if (ch === 'ai:gateway:changed') changed = fn;
      return () => undefined;
    },
  };
  return { state, calls };
}

beforeEach(() => {
  window.confirm = vi.fn(() => true);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete (window as unknown as { aiIPC?: unknown }).aiIPC;
});

const dialog = () => screen.getByTestId('add-provider-dialog');
const detail = () => screen.getByTestId('provider-detail');
const upserts = (m: ReturnType<typeof fakeMain>) =>
  m.calls.filter(([c]) => c === 'ai:gateway:upsert-provider').map(([, a]) => a[0] as ProviderInput);

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
  fireEvent.click(await screen.findByTestId('add-provider'));
  fireEvent.click(await within(dialog()).findByTestId(`preset-${presetId}`));
  if (key)
    fireEvent.change(within(dialog()).getByTestId('add-provider-keys'), { target: { value: key } });
  fireEvent.click(within(dialog()).getByTestId('add-provider-probe'));
}

describe('ModelsPage', () => {
  it('empty state, then add a preset: real detection, keys, models, and the one-click offer', async () => {
    const m = fakeMain();
    render(<ModelsPage />);
    expect(await screen.findByTestId('models-empty')).toBeTruthy();
    await addFlow('deepseek', 'sk-aaaa1111\nsk-bbbb2222');
    const result = await within(dialog()).findByTestId('add-provider-probe-result');
    await waitFor(() => expect(result.querySelectorAll('[data-state="ok"]')).toHaveLength(1));
    // 没探测到的协议只是跳过，探测失败的写明原因
    expect(result.querySelectorAll('[data-state="skip"]')).toHaveLength(2);
    expect(result.querySelector('[data-state="fail"]')!.textContent).toContain('HTTP 404');
    const detect = m.calls.find(([c]) => c === 'ai:gateway:detect')![1][0];
    // 预设写明的各协议地址直接拿去测，不再从 baseURL 推导
    expect(detect).not.toHaveProperty('url');
    expect(detect).toMatchObject({
      urls: { chat: 'https://api.deepseek.com/v1', messages: 'https://api.deepseek.com/anthropic' },
      keys: ['sk-aaaa1111', 'sk-bbbb2222'],
      fallbackModel: 'deepseek-v4-pro',
    });
    // 预设推荐的默认启用，不能对话的模型列出来但不启用
    const checks = within(dialog()).getAllByRole('checkbox') as HTMLInputElement[];
    expect(checks.map((c) => c.checked)).toEqual([true, true, false]);
    fireEvent.click(within(dialog()).getByTestId('add-provider-save'));
    await waitFor(() => expect(screen.queryByTestId('add-provider-dialog')).toBeNull());
    const saved = m.calls.find(([c]) => c === 'ai:gateway:upsert-provider')![1][0];
    expect(saved).toMatchObject({
      name: 'DeepSeek',
      presetId: 'deepseek',
      urls: { chat: 'https://api.deepseek.com/v1' },
      newKeys: [{ value: 'sk-aaaa1111' }, { value: 'sk-bbbb2222' }],
      detected: { chat: { ok: true }, messages: { ok: false, status: 404 } },
      quirks: { reasoningPassback: true },
    });
    // 预设整理的元数据随模型一起存
    expect((saved as { models: unknown[] }).models[0]).toEqual({
      id: 'deepseek-v4-pro',
      enabled: true,
      ctx: 1_000_000,
      maxOutput: 393_216,
      reasoning: true,
      vision: false,
      toolCalling: true,
      metaSource: 'preset',
    });
    const row = await screen.findByTestId('provider-deepseek');
    expect(row.textContent).toContain('2 个 Key');
    expect(row.textContent).toContain('2 个模型');
    // Nomi 对话还没模型：提示一键填好
    fireEvent.click(within(await screen.findByTestId('models-offer')).getByText('一键填好'));
    await waitFor(() => expect(m.state.clients.nomi!.models.main).toBe('deepseek/deepseek-v4-pro'));
    await waitFor(() =>
      expect(screen.getByTestId('assign-chat').closest('div')?.textContent).toContain(
        'DeepSeek / deepseek-v4-pro',
      ),
    );
  });

  it('cannot save when every protocol fails, and shows each reason', async () => {
    fakeMain({
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
    await waitFor(() =>
      expect(within(dialog()).getByTestId('add-provider-probe-result').textContent).toContain(
        'Key 无效或没有权限',
      ),
    );
    expect((within(dialog()).getByTestId('add-provider-save') as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(
      within(dialog()).getByText('所有协议都不可用，不能保存。请检查上面每一条的原因。'),
    ).toBeTruthy();
  });

  it('custom address needs an address; local presets need no key and are confirmed automatically', async () => {
    const m = fakeMain();
    render(<ModelsPage />);
    fireEvent.click(await screen.findByTestId('add-provider'));
    fireEvent.click(await within(dialog()).findByTestId('preset-custom'));
    fireEvent.change(within(dialog()).getByTestId('add-provider-keys'), {
      target: { value: 'sk-1234' },
    });
    const probe = within(dialog()).getByTestId('add-provider-probe') as HTMLButtonElement;
    expect(probe.disabled).toBe(true);
    fireEvent.change(within(dialog()).getByTestId('add-provider-url'), {
      target: { value: 'https://relay.example.com/v1/chat/completions' },
    });
    expect(probe.disabled).toBe(false);
    fireEvent.click(within(dialog()).getByTestId('add-provider-back'));
    fireEvent.click(within(dialog()).getByTestId('preset-ollama'));
    expect(within(dialog()).getByText('本地服务不需要 Key。')).toBeTruthy();
    fireEvent.click(within(dialog()).getByTestId('add-provider-probe'));
    await waitFor(() => expect(m.state.allowedPrivateHosts).toEqual(['localhost:11434']));
    expect(window.confirm).not.toHaveBeenCalled();
  });

  it('a custom private address asks first; declining does not probe', async () => {
    const m = fakeMain();
    vi.mocked(window.confirm).mockReturnValue(false);
    render(<ModelsPage />);
    fireEvent.click(await screen.findByTestId('add-provider'));
    fireEvent.click(await within(dialog()).findByTestId('preset-custom'));
    fireEvent.change(within(dialog()).getByTestId('add-provider-url'), {
      target: { value: 'http://192.168.1.20:8000/v1' },
    });
    fireEvent.change(within(dialog()).getByTestId('add-provider-keys'), {
      target: { value: 'sk-1' },
    });
    fireEvent.click(within(dialog()).getByTestId('add-provider-probe'));
    await waitFor(() => expect(window.confirm).toHaveBeenCalled());
    await waitFor(() => expect(within(dialog()).getByTestId('add-provider-url')).toBeTruthy());
    expect(m.calls.some(([c]) => c === 'ai:gateway:detect')).toBe(false);
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
    expect(within(dlg).queryByTestId('pd-key-k2')).toBeNull();
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
    const detection = m.calls.find(([c]) => c === 'ai:gateway:detect')![1][0];
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
    const det = m.calls.find(([c]) => c === 'ai:gateway:detect')![1][0] as Record<string, unknown>;
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

  it('context limits: badges show the effective value; manual limits save as user-set (§12.7.2)', async () => {
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

    fireEvent.click(within(dlg).getByTestId('pd-advanced-toggle'));
    const ctx = within(dlg).getByTestId('pd-model-ctx-openai/gpt-6-astra') as HTMLInputElement;
    // 自动取值显示在占位里，输入框本身是空的
    expect(ctx.value).toBe('');
    expect(ctx.placeholder).toContain('内置模型目录');
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

  it('long context default per model (§12.7.2): only models with a standard window get the switch', async () => {
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
    fireEvent.click(within(dlg).getByTestId('pd-advanced-toggle'));
    expect(within(dlg).queryByTestId('pd-model-long-openai/gpt-5.2')).toBeNull();
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

  it('fallback chain: add from the picker, reorder and remove', async () => {
    const m = fakeMain();
    m.state.providers = [
      kimi(),
      {
        ...kimi(),
        id: 'ds',
        name: 'DeepSeek',
        models: [
          { id: 'v4', enabled: true },
          { id: 'flash', enabled: true },
        ],
      },
    ];
    render(<ModelsPage />);
    fireEvent.click(await screen.findByTestId('provider-open-kimi'));
    const dlg = detail();
    const add = () => within(dlg).getByTestId('pd-fallback-add');
    fireEvent.change(add(), { target: { value: 'ds/v4' } });
    fireEvent.change(add(), { target: { value: 'ds/flash' } });
    fireEvent.change(add(), { target: { value: 'kimi/kimi-k3-turbo' } });
    // 已在链里的不再出现在选择器里
    expect(Array.from((add() as HTMLSelectElement).options).map((o) => o.value)).not.toContain(
      'ds/v4',
    );
    fireEvent.click(within(dlg).getByTestId('pd-fallback-up-1'));
    fireEvent.click(within(dlg).getByTestId('pd-fallback-remove-2'));
    expect(within(dlg).getByTestId('pd-fallback-0').textContent).toContain('DeepSeek / flash');
    fireEvent.click(within(dlg).getByTestId('provider-detail-save'));
    await waitFor(() => expect(upserts(m)).toHaveLength(1));
    expect(upserts(m)[0]!.fallback).toEqual(['ds/flash', 'ds/v4']);
  });

  it('advanced: URLs (empty turns a protocol off), re-detect, wires, model map, headers, UA', async () => {
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
    expect(within(dlg).queryByTestId('pd-url-chat')).toBeNull();
    fireEvent.click(within(dlg).getByTestId('pd-advanced-toggle'));
    expect(within(dlg).getByTestId('pd-advanced-toggle').getAttribute('aria-expanded')).toBe(
      'true',
    );
    fireEvent.change(within(dlg).getByTestId('pd-url-chat'), { target: { value: '' } });
    fireEvent.change(within(dlg).getByTestId('pd-url-responses'), {
      target: { value: 'https://api.moonshot.cn/v1' },
    });
    // 改了地址：提示重新检测，检测用草稿里的地址（空串表示不测）
    fireEvent.click(within(dlg).getByTestId('pd-redetect'));
    await waitFor(() => expect(within(dlg).queryByTestId('pd-urls-changed')).toBeNull());
    const det = m.calls.find(([c]) => c === 'ai:gateway:detect')![1][0] as Record<string, unknown>;
    expect(det).toMatchObject({
      providerId: 'kimi',
      urls: {
        messages: 'https://api.moonshot.cn/anthropic',
        chat: '',
        responses: 'https://api.moonshot.cn/v1',
        gemini: '',
      },
    });
    fireEvent.click(within(dlg).getByTestId('pd-model-wire-kimi-k3-responses'));
    fireEvent.change(within(dlg).getByTestId('pd-key-wire-k0'), { target: { value: 'messages' } });
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
        'ai:gateway:set-options': (patch) => {
          m.state.strictParams = (patch as { strictParams: boolean }).strictParams;
          return structuredClone(m.state);
        },
      },
    });
    render(<ModelsPage />);
    const sw = await screen.findByTestId('models-strict');
    await waitFor(() => expect((sw as HTMLButtonElement).disabled).toBe(false));
    expect(sw.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(sw);
    await waitFor(() =>
      expect(m.calls).toContainEqual(['ai:gateway:set-options', [{ strictParams: true }]]),
    );
  });

  it('advanced disclosure exposes request body limit and saves via set-options', async () => {
    const m = fakeMain({
      extra: {
        'ai:gateway:set-options': (patch) => {
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
        'ai:gateway:set-options',
        [{ maxRequestBodyBytes: 64 * 1024 * 1024 }],
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
    fireEvent.click(within(dlg).getByTestId('pd-advanced-toggle'));
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
    expect(m.calls.some(([c, a]) => c === 'ai:gateway:clear-learned' && a[0] === 'r')).toBe(true);
  });

  describe('编程助手的第三方模型（§4.1）', () => {
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
      m.calls.filter(([c]) => c === 'ai:gateway:set-assignment').map(([, a]) => a);
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
      render(<ModelsPage />);
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
          'ai:cli-update:inspect': () => [
            inst('claude', '/bin/claude'),
            inst('codex', '/bin/codex'),
            inst('grok', grokPath),
          ],
          'ai:cli-update:busy': () => null,
          'ai:cli-update:preview': (kind) => ({
            kind,
            mode: 'install',
            scope: 'global',
            argv: ['npm', 'install', '-g', 'grok-cli'],
            command: 'npm install -g grok-cli',
            requirements: [],
            blockers: [],
          }),
          'ai:cli-update:run': () => {
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
      fireEvent.click(btn);
      expect((await screen.findByTestId('cli-version-command')).textContent).toBe(
        'npm install -g grok-cli',
      );
      expect(m.calls.some(([c]) => c === 'ai:cli-update:run')).toBe(false);
      fireEvent.click(screen.getByTestId('cli-version-confirm'));
      await waitFor(() =>
        expect(m.calls.find(([c]) => c === 'ai:cli-update:run')?.[1]).toEqual(['grok', 'global']),
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
