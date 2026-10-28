// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ModelControls } from '../src/components/ModelControls';
import type {
  BackendModelCatalog,
  HarnessTabMeta,
  ReasoningEffort,
} from '../src/services/harnessClient';
import { openModelMenu } from '../src/services/modelMenu';

import type { CodingApiMockState } from './helpers/codingApi';

// D3 客户端走契约（services/api）；测试仍用旧通道形状的 window.aiIPC 假桥，经 helpers/codingApi 转发
const codingApi = vi.hoisted(() => ({}) as CodingApiMockState);
vi.mock('../src/services/api', async () =>
  (await import('./helpers/codingApi')).createCodingApiMock(codingApi),
);

// D2 的过程经契约替身转发到下面的旧桥假实现（见 helpers/shellApi）
vi.mock('../src/services/api', () => import('./helpers/shellApi'));

/** 形状与主进程从 CLI 读到的目录一致（Codex：config 未指定默认模型时 defaultModel = null） */
const codexLevels: ReasoningEffort[] = ['low', 'medium', 'high', 'xhigh'];
const catalog: BackendModelCatalog = {
  backend: 'codex',
  defaultModel: null,
  models: [
    { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', reasoning: true, efforts: codexLevels },
    {
      id: 'gpt-6-pro',
      label: 'GPT-6 Pro',
      reasoning: true,
      efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
      defaultEffort: 'medium',
    },
    { id: 'gpt-4.1', label: 'GPT-4.1', reasoning: false, efforts: [] },
  ],
};

const claudeLevels: ReasoningEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const claudeCatalog: BackendModelCatalog = {
  backend: 'claude',
  defaultModel: { id: 'default', label: 'Opus 5.5', reasoning: true, efforts: claudeLevels },
  models: [
    { id: 'opus', label: 'Opus 5.5', reasoning: true, efforts: claudeLevels },
    {
      id: 'fable',
      label: 'Fable 5.1',
      reasoning: true,
      efforts: claudeLevels,
      defaultEffort: 'high',
    },
    {
      id: 'claude-opus-4-6',
      label: 'Opus 4.6',
      reasoning: true,
      efforts: ['low', 'medium', 'high', 'max'],
    },
    { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5', reasoning: false, efforts: [] },
  ],
};

const baseTab: HarnessTabMeta = {
  id: 'cx',
  title: 'X',
  backend: 'codex',
  cwd: '/w',
  cliSessionId: null,
  status: 'idle',
  unread: 0,
  createdAt: 0,
  updatedAt: 0,
  permissionMode: 'default',
  modelOverride: null,
  reasoningEffort: null,
};

function setup(opts: { catalog: BackendModelCatalog | null; tabOver?: Partial<HarnessTabMeta> }) {
  let current = { ...baseTab, ...opts.tabOver };
  const invoke = vi.fn(async (ch: string, ...a: unknown[]) => {
    if (ch === 'ai:harness:model-catalog') return opts.catalog;
    if (ch === 'ai:harness:tab-model') {
      const model = String(a[1] ?? '');
      current = { ...current, modelOverride: model || null };
      if (!model) current.reasoningEffort = null;
      if (model === 'gpt-4.1') current.reasoningEffort = null;
      return { ...current };
    }
    if (ch === 'ai:harness:tab-effort') {
      const e = a[1] as ReasoningEffort | null;
      current = { ...current, reasoningEffort: e };
      return { ...current };
    }
    return {};
  });
  (window as unknown as { aiIPC: unknown }).aiIPC = { invoke, on: () => () => undefined };

  const rerender = render(<ModelControls tab={current} />);
  return {
    invoke,
    current: () => current,
    ...rerender,
    rerenderWith: () => rerender.rerender(<ModelControls tab={current} />),
  };
}

beforeEach(() => {
  document.body.innerHTML = '';
});
afterEach(cleanup);

describe('ModelControls', () => {
  it('无模型目录的后端不渲染任何按钮', () => {
    const { container } = setup({ catalog: null });
    expect(container.childElementCount).toBe(0);
  });

  it('默认状态只有一个按钮，显示「默认模型」', async () => {
    const { findByTestId, queryByTestId } = setup({ catalog });
    const chip = await findByTestId('model-chip');
    expect(chip.textContent).toContain('默认模型');
    expect(queryByTestId('effort-chip')).toBeNull();
  });

  it('按钮合并显示「模型 · 档位」', async () => {
    const { findByTestId } = setup({
      catalog,
      tabOver: { modelOverride: 'gpt-5.6-sol', reasoningEffort: 'high' },
    });
    expect((await findByTestId('model-chip')).textContent).toContain('GPT-5.6 Sol · 高');
  });

  it('浮层默认页：思考深度滑杆与模型入口', async () => {
    const { findByTestId, getByTestId, queryByTestId } = setup({
      catalog,
      tabOver: { modelOverride: 'gpt-5.6-sol', reasoningEffort: 'high' },
    });
    fireEvent.click(await findByTestId('model-chip'));
    expect(queryByTestId('effort-title')).toBeNull();
    expect(queryByTestId('effort-hint')).toBeNull();
    expect(getByTestId('model-open').textContent).toContain('GPT-5.6 Sol');
    const slider = getByTestId('effort-slider');
    expect(slider.getAttribute('role')).toBe('slider');
    expect(slider.getAttribute('aria-valuetext')).toBe('高');
    expect(slider.getAttribute('aria-valuenow')).toBe('2');
  });

  it('点「模型名 ›」进入模型页，选模型后回到滑杆页（浮层不关）', async () => {
    const { findByTestId, getByTestId, queryByTestId, invoke } = setup({ catalog });
    fireEvent.click(await findByTestId('model-chip'));
    fireEvent.click(getByTestId('model-open'));
    const menu = getByTestId('model-menu');
    expect(within(menu).getByText('GPT-5.6 Sol')).toBeTruthy();
    expect(within(menu).getByText('GPT-4.1')).toBeTruthy();
    expect(queryByTestId('effort-slider')).toBeNull();
    fireEvent.click(getByTestId('model-gpt-5.6-sol'));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('ai:harness:tab-model', 'cx', 'gpt-5.6-sol', {
        expectSource: 'official',
      }),
    );
    expect(getByTestId('effort-slider')).toBeTruthy();
  });

  it('/model 打开同一个浮层：直接到模型列表（不插卡片）', async () => {
    const { findByTestId, queryByTestId } = setup({ catalog });
    await findByTestId('model-chip');
    expect(queryByTestId('model-menu')).toBeNull();
    let opened = false;
    act(() => {
      opened = openModelMenu('cx');
    });
    expect(opened).toBe(true);
    expect(await findByTestId('model-menu')).toBeTruthy();
    expect(await findByTestId('model-gpt-6-pro')).toBeTruthy();
    expect(openModelMenu('other-tab')).toBe(false);
  });

  it('只能从目录里选模型：没有「自定义模型 id」入口；当前模型不在目录里时照样显示出来', async () => {
    const { findByTestId, getByTestId, queryByTestId } = setup({
      catalog,
      tabOver: { modelOverride: 'gpt-7-codex' },
    });
    fireEvent.click(await findByTestId('model-chip'));
    fireEvent.click(getByTestId('model-open'));
    expect(queryByTestId('model-custom-toggle')).toBeNull();
    expect(queryByTestId('model-custom-input')).toBeNull();
    expect(getByTestId('model-current-custom').textContent).toContain('gpt-7-codex');
  });

  it('键盘 ← → 调档发起 tab-effort；「恢复默认」发 null', async () => {
    const { findByTestId, getByTestId, invoke } = setup({
      catalog,
      tabOver: { modelOverride: 'gpt-5.6-sol', reasoningEffort: 'medium' },
    });
    fireEvent.click(await findByTestId('model-chip'));
    const slider = getByTestId('effort-slider');
    fireEvent.keyDown(slider, { key: 'ArrowRight' });
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('ai:harness:tab-effort', 'cx', 'high'));
    fireEvent.keyDown(slider, { key: 'Home' });
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('ai:harness:tab-effort', 'cx', 'low'));
    fireEvent.click(getByTestId('effort-default'));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('ai:harness:tab-effort', 'cx', null));
  });

  it('未设档位：滑杆定位到 CLI 返回的默认档位，仍无「恢复默认」', async () => {
    const { findByTestId, getByTestId, queryByTestId } = setup({
      catalog: claudeCatalog,
      tabOver: { backend: 'claude', modelOverride: 'fable' },
    });
    fireEvent.click(await findByTestId('model-chip'));
    expect(queryByTestId('effort-title')).toBeNull();
    expect(queryByTestId('effort-hint')).toBeNull();
    expect(getByTestId('effort-slider').getAttribute('aria-valuenow')).toBe('2');
    expect(getByTestId('effort-slider').getAttribute('aria-valuetext')).toBe('高');
    expect(queryByTestId('effort-default')).toBeNull();
  });

  it('未设档位：底部模型按钮同时显示 CLI 默认思考档位', async () => {
    const { findByTestId } = setup({
      catalog: claudeCatalog,
      tabOver: { backend: 'claude', modelOverride: 'fable' },
    });
    expect((await findByTestId('model-chip')).textContent).toContain('Fable 5.1 · 高');
  });

  it('未设档位且 CLI 没给默认档位：说明由 CLI 按模型决定，不留一个空滑杆', async () => {
    const { findByTestId, getByTestId, queryByTestId, rerender } = setup({
      catalog: claudeCatalog,
      tabOver: { backend: 'claude' },
    });
    fireEvent.click(await findByTestId('model-chip'));
    expect(getByTestId('effort-default-unknown').textContent).toBe(
      '默认：由 Claude Code 按模型决定',
    );
    expect(getByTestId('effort-slider').getAttribute('aria-valuetext')).toBe('默认');
    expect(queryByTestId('effort-default')).toBeNull();

    // 知道默认档位（Fable 5.1）或已选了档位时不显示这句说明
    rerender(<ModelControls tab={{ ...baseTab, backend: 'claude', modelOverride: 'fable' }} />);
    expect(queryByTestId('effort-default-unknown')).toBeNull();
    rerender(<ModelControls tab={{ ...baseTab, backend: 'claude', reasoningEffort: 'low' }} />);
    expect(queryByTestId('effort-default-unknown')).toBeNull();
    expect(getByTestId('effort-default')).toBeTruthy();
  });

  it('非推理模型（gpt-4.1）不显示滑杆，并说明当前模型无思考深度', async () => {
    const { findByTestId, getByTestId, queryByTestId } = setup({
      catalog,
      tabOver: { modelOverride: 'gpt-4.1' },
    });
    fireEvent.click(await findByTestId('model-chip'));
    expect(queryByTestId('effort-title')).toBeNull();
    expect(queryByTestId('effort-slider')).toBeNull();
    expect(getByTestId('effort-unavailable')).toBeTruthy();
    expect(getByTestId('effort-hint').textContent).toContain('当前模型无思考深度');
  });

  it('未知自定义模型仍显示滑杆，并在模型页标为当前', async () => {
    const { findByTestId, getByTestId } = setup({ catalog, tabOver: { modelOverride: 'gpt-9-x' } });
    fireEvent.click(await findByTestId('model-chip'));
    expect(getByTestId('effort-slider')).toBeTruthy();
    fireEvent.click(getByTestId('model-open'));
    expect(getByTestId('model-current-custom').getAttribute('aria-selected')).toBe('true');
  });

  it('没选模型且 CLI 没给默认模型：滑杆用目录并集（含 ultra）', async () => {
    const { findByTestId, queryByTestId, getByTestId } = setup({ catalog });
    fireEvent.click(await findByTestId('model-chip'));
    expect(getByTestId('effort-ultra')).toBeTruthy();
    expect(getByTestId('effort-low')).toBeTruthy();
    expect(queryByTestId('effort-minimal')).toBeNull();
  });

  it('Claude：按模型取档位（Opus 4.6 无 xhigh），End 跳到最高', async () => {
    const { findByTestId, getByTestId, queryByTestId, invoke } = setup({
      catalog: claudeCatalog,
      tabOver: { backend: 'claude', modelOverride: 'claude-opus-4-6' },
    });
    fireEvent.click(await findByTestId('model-chip'));
    expect(queryByTestId('effort-minimal')).toBeNull();
    expect(queryByTestId('effort-xhigh')).toBeNull();
    fireEvent.keyDown(getByTestId('effort-slider'), { key: 'End' });
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('ai:harness:tab-effort', 'cx', 'max'));
  });

  it('第三方来源的标签：按 source=thirdParty 要网关的模型，直接打开模型列表、没有思考深度和自定义 id', async () => {
    let current: HarnessTabMeta = { ...baseTab, source: 'thirdParty' };
    const gatewayCatalog: BackendModelCatalog = {
      backend: 'codex',
      provider: { id: 'gateway', name: '第三方模型' },
      defaultModel: { id: 'ds/v4', label: 'DeepSeek / v4', reasoning: false, efforts: [] },
      models: [
        { id: 'ds/v4', label: 'DeepSeek / v4', reasoning: false, efforts: [] },
        { id: 'kimi/k3', label: 'Kimi / k3', reasoning: false, efforts: [] },
      ],
    };
    const invoke = vi.fn(async (ch: string, ...a: unknown[]) => {
      if (ch === 'ai:harness:model-catalog') return gatewayCatalog;
      if (ch === 'ai:harness:tab-model') {
        current = { ...current, modelOverride: String(a[1] ?? '') || null };
        return { ...current };
      }
      return {};
    });
    (window as unknown as { aiIPC: unknown }).aiIPC = { invoke, on: () => () => undefined };
    const r = render(<ModelControls tab={current} />);
    const chip = await r.findByTestId('model-chip');
    expect(invoke).toHaveBeenCalledWith('ai:harness:model-catalog', 'codex', {
      source: 'thirdParty',
    });
    expect(chip.textContent).toContain('DeepSeek / v4');
    fireEvent.click(chip);
    const menu = await r.findByTestId('model-menu');
    expect(within(menu).getByTestId('model-provider').textContent).toContain('第三方模型');
    expect(within(menu).queryByTestId('effort-view')).toBeNull();
    expect(within(menu).queryByTestId('effort-slider')).toBeNull();
    expect(within(menu).queryByText('无思考深度')).toBeNull();
    expect(within(menu).queryByTestId('model-custom-toggle')).toBeNull();
    fireEvent.click(within(menu).getByTestId('model-kimi/k3'));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('ai:harness:tab-model', 'cx', 'kimi/k3', {
        expectSource: 'thirdParty',
      }),
    );
    await waitFor(() => expect(r.queryByTestId('model-menu')).toBeNull());
    fireEvent.click(r.getByTestId('model-chip'));
    fireEvent.click(within(await r.findByTestId('model-menu')).getByTestId('model-refresh'));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('ai:harness:model-catalog', 'codex', {
        refresh: true,
        source: 'thirdParty',
      }),
    );
  });

  it('长上下文（§12.7.2）：分档计价的第三方模型在模型页有「标准 / 长上下文」一组，价格写清楚', async () => {
    const ref = 'amux/openai/gpt-6.1-sol';
    const gatewayState = {
      status: { state: 'running', port: 1, url: 'http://127.0.0.1:1' },
      providers: [
        {
          id: 'amux',
          name: 'Amux',
          enabled: true,
          urls: {},
          keys: [],
          models: [
            {
              id: 'openai/gpt-6.1-sol',
              enabled: true,
              effective: {
                ctx: 272_000,
                maxOutput: 128_000,
                source: 'catalog',
                maxOutputSource: 'catalog',
                longContext: {
                  standard: 272_000,
                  full: 922_000,
                  on: false,
                  price: { size: 272_000, input: 2, output: 10, tierInput: 4, tierOutput: 15 },
                },
              },
            },
          ],
        },
      ],
      clients: { codex: { models: {} } },
      allowedPrivateHosts: [],
      port: 1,
    };
    let current: HarnessTabMeta = { ...baseTab, source: 'thirdParty', modelOverride: ref };
    const invoke = vi.fn(async (ch: string, ...a: unknown[]) => {
      if (ch === 'ai:gateway:state') return gatewayState;
      if (ch === 'ai:harness:model-catalog')
        return {
          backend: 'codex',
          provider: { id: 'amux', name: 'Amux' },
          defaultModel: null,
          models: [{ id: ref, label: 'GPT-6.1 Sol', reasoning: true, efforts: [] }],
        };
      if (ch === 'ai:harness:tab-long-context') {
        const on = a[1] as boolean | null;
        current = { ...current, longContext: on === null ? null : { model: ref, on } };
        return { ...current };
      }
      return {};
    });
    (window as unknown as { aiIPC: unknown }).aiIPC = { invoke, on: () => () => undefined };
    const r = render(<ModelControls tab={current} />);
    // 应用里网关状态早已缓存；测试里先等它到达再开菜单
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('ai:gateway:state'));
    await act(async () => {});
    fireEvent.click(await r.findByTestId('model-chip'));
    const group = await r.findByTestId('long-context-group');
    // 抹零显示：922,000 → 922K
    expect(within(group).getByTestId('long-context-standard').textContent).toContain('272K');
    expect(within(group).getByTestId('long-context-long').textContent).toContain('922K');
    expect(within(group).getByTestId('long-context-standard').getAttribute('aria-checked')).toBe(
      'true',
    );
    expect(group.textContent).toContain('超过 272K 的请求按输入 $4/M（标准 $2/M）计费');
    fireEvent.click(within(group).getByTestId('long-context-long'));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('ai:harness:tab-long-context', 'cx', true),
    );
    // 开启后按钮带「长」标记；切回标准时与模型默认相同 → 存 null（跟随默认）
    r.rerender(<ModelControls tab={current} />);
    expect((await r.findByTestId('model-chip-long')).textContent).toBe('长');
    // 选上下文不关菜单（与选模型不同），可以接着切回
    fireEvent.click(
      within(await r.findByTestId('long-context-group')).getByTestId('long-context-standard'),
    );
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('ai:harness:tab-long-context', 'cx', null),
    );
  });

  it('模型多于 8 个时模型页有搜索：按 id / 名称过滤，回车选第一个，Esc 先清空搜索词', async () => {
    const models = Array.from({ length: 12 }, (_, i) => ({
      id: `anthropic/claude-${i}`,
      label: i === 7 ? 'Claude Opus' : undefined,
      reasoning: false,
      efforts: [],
    }));
    models.push({ id: 'openai/gpt-6', label: undefined, reasoning: false, efforts: [] });
    const catalog: BackendModelCatalog = {
      backend: 'codex',
      provider: { id: 'amux', name: 'Amux' },
      defaultModel: null,
      models,
    };
    const invoke = vi.fn(async (ch: string) => (ch === 'ai:harness:model-catalog' ? catalog : {}));
    (window as unknown as { aiIPC: unknown }).aiIPC = { invoke, on: () => () => undefined };
    const r = render(<ModelControls tab={{ ...baseTab, source: 'thirdParty' }} />);
    fireEvent.click(await r.findByTestId('model-chip'));
    const menu = await r.findByTestId('model-menu');
    const search = within(menu).getByTestId('model-search');
    fireEvent.change(search, { target: { value: 'opus' } });
    expect(within(menu).getByTestId('model-anthropic/claude-7')).toBeTruthy();
    expect(within(menu).queryByTestId('model-openai/gpt-6')).toBeNull();
    expect(within(menu).queryByTestId('model-default')).toBeNull();
    fireEvent.change(search, { target: { value: 'nothing-here' } });
    expect(within(menu).getByTestId('model-search-empty')).toBeTruthy();
    fireEvent.keyDown(search, { key: 'Escape' });
    expect((search as HTMLInputElement).value).toBe('');
    expect(r.queryByTestId('model-menu')).not.toBeNull();
    fireEvent.change(search, { target: { value: 'GPT' } });
    fireEvent.keyDown(search, { key: 'Enter' });
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('ai:harness:tab-model', 'cx', 'openai/gpt-6', {
        expectSource: 'thirdParty',
      }),
    );
  });

  it('模型不多时没有搜索框', async () => {
    const catalog: BackendModelCatalog = {
      backend: 'codex',
      provider: { id: 'amux', name: 'Amux' },
      defaultModel: null,
      models: [{ id: 'a/b', reasoning: false, efforts: [] }],
    };
    const invoke = vi.fn(async (ch: string) => (ch === 'ai:harness:model-catalog' ? catalog : {}));
    (window as unknown as { aiIPC: unknown }).aiIPC = { invoke, on: () => () => undefined };
    const r = render(<ModelControls tab={{ ...baseTab, source: 'thirdParty' }} />);
    fireEvent.click(await r.findByTestId('model-chip'));
    await r.findByTestId('model-menu');
    expect(r.queryByTestId('model-search')).toBeNull();
  });

  it('来源从官方切到第三方：重新按第三方要目录；官方仍不带 source', async () => {
    const invoke = vi.fn(async (ch: string) => {
      if (ch === 'ai:harness:model-catalog') return catalog;
      return {};
    });
    (window as unknown as { aiIPC: unknown }).aiIPC = { invoke, on: () => () => undefined };
    const r = render(<ModelControls tab={baseTab} />);
    await r.findByTestId('model-chip');
    expect(invoke).toHaveBeenCalledWith('ai:harness:model-catalog', 'codex', {});
    r.rerender(<ModelControls tab={{ ...baseTab, source: 'thirdParty' }} />);
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('ai:harness:model-catalog', 'codex', {
        source: 'thirdParty',
      }),
    );
  });

  it('Claude：按钮显示 CLI 给的默认模型名；不支持思考深度的模型不显示滑杆', async () => {
    const { findByTestId, getByTestId } = setup({
      catalog: claudeCatalog,
      tabOver: { backend: 'claude' },
    });
    // 按钮直接显示 CLI 默认用的模型名，浮层只显示当前模型值
    expect((await findByTestId('model-chip')).textContent).toContain('Opus 5.5');
    expect((await findByTestId('model-chip')).textContent).not.toContain('默认');
    fireEvent.click(getByTestId('model-chip'));
    expect(getByTestId('model-open').textContent).toContain('Opus 5.5');
    expect(getByTestId('model-open').textContent).not.toContain('默认');
    expect(getByTestId('effort-max')).toBeTruthy();
    cleanup();
    const r = setup({
      catalog: claudeCatalog,
      tabOver: { backend: 'claude', modelOverride: 'claude-haiku-4-5-20251001' },
    });
    fireEvent.click(await r.findByTestId('model-chip'));
    expect(r.queryByTestId('effort-title')).toBeNull();
    expect(r.queryByTestId('effort-slider')).toBeNull();
    expect(r.getByTestId('effort-unavailable')).toBeTruthy();
    expect(r.getByTestId('effort-hint').textContent).toContain('当前模型无思考深度');
  });

  it('读不到目录：只有默认，显示原因；刷新按钮让主进程重读', async () => {
    const { findByTestId, getByTestId, queryByTestId, invoke } = setup({
      catalog: { backend: 'grok', models: [], defaultModel: null, error: 'not authenticated' },
      tabOver: { backend: 'grok' },
    });
    fireEvent.click(await findByTestId('model-chip'));
    expect(queryByTestId('effort-slider')).toBeNull();
    expect(queryByTestId('effort-title')).toBeNull();
    expect(getByTestId('effort-hint').textContent).toContain('当前模型无思考深度');
    fireEvent.click(getByTestId('model-open'));
    expect(getByTestId('model-error').textContent).toContain('not authenticated');
    expect(getByTestId('model-default')).toBeTruthy();
    expect(queryByTestId('model-custom-toggle')).toBeNull();
    fireEvent.click(getByTestId('model-refresh'));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('ai:harness:model-catalog', 'grok', { refresh: true }),
    );
  });

  it('CLI 读目录较慢时先显示不可点的占位按钮，读完换成真正的按钮', async () => {
    let resolve: (c: BackendModelCatalog) => void = () => undefined;
    const pending = new Promise<BackendModelCatalog>((r) => (resolve = r));
    const invoke = vi.fn(async (ch: string) => {
      if (ch === 'ai:harness:model-catalog') return pending;
      return {};
    });
    (window as unknown as { aiIPC: unknown }).aiIPC = { invoke, on: () => () => undefined };
    const r = render(<ModelControls tab={{ ...baseTab, backend: 'claude' }} />);
    const loading = await r.findByTestId('model-chip-loading');
    expect((loading as HTMLButtonElement).disabled).toBe(true);
    resolve(claudeCatalog);
    expect((await r.findByTestId('model-chip')).textContent).toContain('Opus 5.5');
    expect(r.queryByTestId('model-chip-loading')).toBeNull();
  });
  it('Gemini：无文档化思考深度控制，浮层禁用档位并说明原因', async () => {
    const geminiCatalog: BackendModelCatalog = {
      backend: 'gemini',
      defaultModel: {
        id: 'gemini-2.5-pro',
        label: 'Gemini 2.5 Pro',
        reasoning: true,
        efforts: ['low', 'high'],
      },
      models: [
        {
          id: 'gemini-2.5-pro',
          label: 'Gemini 2.5 Pro',
          reasoning: true,
          efforts: ['low', 'high'],
        },
      ],
    };
    const { findByTestId, getByTestId, queryByTestId } = setup({
      catalog: geminiCatalog,
      tabOver: { backend: 'gemini', modelOverride: 'gemini-2.5-pro' },
    });
    fireEvent.click(await findByTestId('model-chip'));
    expect(queryByTestId('effort-slider')).toBeNull();
    expect(getByTestId('effort-unavailable')).toBeTruthy();
    expect(getByTestId('effort-hint').textContent).toMatch(/Gemini.*思考深度|不会假装/);
    fireEvent.click(getByTestId('model-open'));
    expect(getByTestId('effort-hint').textContent).toMatch(/Gemini.*思考深度|不会假装/);
  });

  it('dsh：无文档化思考深度控制，浮层禁用档位并说明原因', async () => {
    const dshCatalog: BackendModelCatalog = {
      backend: 'dsh',
      defaultModel: {
        id: 'deepseek-v4',
        label: 'DeepSeek V4',
        reasoning: true,
        efforts: ['medium'],
      },
      models: [{ id: 'deepseek-v4', label: 'DeepSeek V4', reasoning: true, efforts: ['medium'] }],
    };
    const { findByTestId, getByTestId, queryByTestId } = setup({
      catalog: dshCatalog,
      tabOver: { backend: 'dsh', modelOverride: 'deepseek-v4' },
    });
    fireEvent.click(await findByTestId('model-chip'));
    expect(queryByTestId('effort-slider')).toBeNull();
    expect(getByTestId('effort-unavailable')).toBeTruthy();
    expect(getByTestId('effort-hint').textContent).toMatch(/dsh.*思考深度|不会假装/);
  });
});

// 放在文件最后：网关状态是模块级共享缓存，前面不依赖网关状态的用例不受这里设的默认供应商影响
describe('ModelControls（会话的供应商分组）', () => {
  describe('聊过的第三方会话：原来的供应商与默认供应商', () => {
    const prov = (id: string, name: string, models: string[]) => ({
      id,
      name,
      enabled: true,
      urls: {},
      keys: [],
      models: models.map((m) => ({ id: m, enabled: true, toolCalling: true })),
    });
    const gatewayState = {
      status: { state: 'running', port: 1, url: 'http://127.0.0.1:1' },
      providers: [prov('old', 'OldCo', ['glm-a', 'glm-b']), prov('neu', 'NewCo', ['ds-x'])],
      clients: { codex: { models: { main: 'neu/ds-x' } } },
      allowedPrivateHosts: [],
      port: 1,
    };
    const gwCatalog: BackendModelCatalog = {
      backend: 'codex',
      provider: { id: 'gateway', name: '第三方模型' },
      defaultModel: { id: 'neu/ds-x', label: 'NewCo / ds-x', reasoning: false, efforts: [] },
      models: [
        { id: 'old/glm-a', label: 'OldCo / glm-a', reasoning: false, efforts: [] },
        { id: 'old/glm-b', label: 'OldCo / glm-b', reasoning: false, efforts: [] },
        { id: 'neu/ds-x', label: 'NewCo / ds-x', reasoning: false, efforts: [] },
      ],
    };
    const open = async (
      tab: HarnessTabMeta,
      gw: object = gatewayState,
      cat: BackendModelCatalog = gwCatalog,
    ) => {
      const invoke = vi.fn(async (ch: string, ...a: unknown[]) => {
        if (ch === 'ai:gateway:state') return gw;
        if (ch === 'ai:harness:model-catalog') return cat;
        if (ch === 'ai:harness:tab-model') return { ...tab, modelOverride: String(a[1]) };
        return {};
      });
      (window as unknown as { aiIPC: unknown }).aiIPC = { invoke, on: () => () => undefined };
      const r = render(<ModelControls tab={tab} />);
      await waitFor(() => expect(invoke).toHaveBeenCalledWith('ai:gateway:state'));
      await act(async () => {});
      return { r, invoke };
    };

    it('两家不同：两组都列出全部模型，勾在会话上次用的模型上，没有「默认模型」一行', async () => {
      const tab = { ...baseTab, source: 'thirdParty' as const, lastServedRef: 'old/glm-b' };
      const { r, invoke } = await open(tab);
      const chip = await r.findByTestId('model-chip');
      expect(chip.textContent).toContain('OldCo / glm-b');
      fireEvent.click(chip);
      const menu = await r.findByTestId('model-menu');
      expect(within(menu).getByTestId('model-group-old').textContent).toBe(
        '本会话原来的供应商 · OldCo',
      );
      expect(within(menu).getByTestId('model-group-neu').textContent).toBe('默认供应商 · NewCo');
      expect(within(menu).getByTestId('model-old/glm-a')).toBeTruthy();
      expect(within(menu).getByTestId('model-old/glm-b').getAttribute('aria-selected')).toBe(
        'true',
      );
      expect(within(menu).queryByTestId('model-default')).toBeNull();
      fireEvent.click(within(menu).getByTestId('model-neu/ds-x'));
      await waitFor(() =>
        expect(invoke).toHaveBeenCalledWith('ai:harness:tab-model', 'cx', 'neu/ds-x', {
          expectSource: 'thirdParty',
        }),
      );
    });

    it('换到默认供应商并聊过一轮后只剩一组；没聊过的会话照旧只列默认供应商', async () => {
      const { r } = await open({
        ...baseTab,
        source: 'thirdParty',
        lastServedRef: 'neu/ds-x',
      });
      fireEvent.click(await r.findByTestId('model-chip'));
      const menu = await r.findByTestId('model-menu');
      expect(within(menu).queryByTestId('model-group-neu')).toBeNull();
      expect(within(menu).queryByTestId('model-old/glm-a')).toBeNull();
      expect(within(menu).getByTestId('model-neu/ds-x').getAttribute('aria-selected')).toBe('true');
      cleanup();
      const fresh = await open({ ...baseTab, source: 'thirdParty' });
      fireEvent.click(await fresh.r.findByTestId('model-chip'));
      const m2 = await fresh.r.findByTestId('model-menu');
      expect(within(m2).getByTestId('model-default')).toBeTruthy();
      expect(within(m2).queryByTestId('model-old/glm-a')).toBeNull();
    });
    it('默认是官方账号：第三方会话的模型列表最后有「切换到官方账号」，选中即切换来源', async () => {
      const { r, invoke } = await open({
        ...baseTab,
        source: 'thirdParty',
        lastServedRef: 'old/glm-b',
      });
      fireEvent.click(await r.findByTestId('model-chip'));
      const menu = await r.findByTestId('model-menu');
      expect(within(menu).getByTestId('model-group-switch').textContent).toBe('默认 · 官方账号');
      fireEvent.click(within(menu).getByTestId('model-switch-official'));
      await waitFor(() =>
        expect(invoke).toHaveBeenCalledWith('ai:harness:tab-source', 'cx', 'official'),
      );
    });

    it('默认是第三方供应商：官方标签的模型页附上默认供应商的全部模型，选中即切到第三方', async () => {
      const gw = {
        ...gatewayState,
        clients: { codex: { newTabSource: 'thirdParty', models: { main: 'neu/ds-x' } } },
      };
      const { r, invoke } = await open({ ...baseTab, source: 'official' }, gw, catalog);
      fireEvent.click(await r.findByTestId('model-chip'));
      fireEvent.click(await r.findByTestId('model-open'));
      const menu = await r.findByTestId('model-menu');
      expect(within(menu).getByTestId('model-group-switch').textContent).toBe('默认供应商 · NewCo');
      expect(within(menu).queryByTestId('model-switch-old/glm-a')).toBeNull();
      fireEvent.click(within(menu).getByTestId('model-switch-neu/ds-x'));
      await waitFor(() =>
        expect(invoke).toHaveBeenCalledWith(
          'ai:harness:tab-source',
          'cx',
          'thirdParty',
          'neu/ds-x',
        ),
      );
    });
  });
});
