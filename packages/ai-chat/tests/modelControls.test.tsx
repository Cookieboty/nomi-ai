// @vitest-environment happy-dom
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ModelControls } from '../src/components/ModelControls';
import type {
  BackendModelCatalog,
  HarnessTabMeta,
  ReasoningEffort,
} from '../src/services/harnessClient';

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
    if (ch === 'ai:cli-provider:state') return { profiles: [] };
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

  it('浮层默认页：大字档位、「模型名 ›」与滑杆', async () => {
    const { findByTestId, getByTestId } = setup({
      catalog,
      tabOver: { modelOverride: 'gpt-5.6-sol', reasoningEffort: 'high' },
    });
    fireEvent.click(await findByTestId('model-chip'));
    expect(getByTestId('effort-title').textContent).toBe('高');
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
      expect(invoke).toHaveBeenCalledWith('ai:harness:tab-model', 'cx', 'gpt-5.6-sol'),
    );
    expect(getByTestId('effort-slider')).toBeTruthy();
  });

  it('自定义模型 id 输入后提交 tab-model', async () => {
    const { findByTestId, getByTestId, invoke } = setup({ catalog });
    fireEvent.click(await findByTestId('model-chip'));
    fireEvent.click(getByTestId('model-open'));
    fireEvent.click(getByTestId('model-custom-toggle'));
    const input = getByTestId('model-custom-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'gpt-7-codex' } });
    fireEvent.click(getByTestId('model-custom-ok'));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('ai:harness:tab-model', 'cx', 'gpt-7-codex'),
    );
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

  it('未设档位：标题显示默认（带模型默认档位），无「恢复默认」', async () => {
    const { findByTestId, getByTestId, queryByTestId } = setup({
      catalog: claudeCatalog,
      tabOver: { backend: 'claude', modelOverride: 'fable' },
    });
    fireEvent.click(await findByTestId('model-chip'));
    expect(getByTestId('effort-title').textContent).toBe('默认（高）');
    expect(getByTestId('effort-slider').getAttribute('aria-valuenow')).toBeNull();
    expect(queryByTestId('effort-default')).toBeNull();
  });

  it('非推理模型（gpt-4.1）不显示滑杆', async () => {
    const { findByTestId, getByTestId, queryByTestId } = setup({
      catalog,
      tabOver: { modelOverride: 'gpt-4.1' },
    });
    fireEvent.click(await findByTestId('model-chip'));
    expect(getByTestId('effort-title').textContent).toBe('无思考深度');
    expect(queryByTestId('effort-slider')).toBeNull();
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

  it('第三方供应商激活时不渲染（模型由供应商管理）', async () => {
    const current = { ...baseTab };
    const invoke = vi.fn(async (ch: string) => {
      if (ch === 'ai:harness:model-catalog') return catalog;
      if (ch === 'ai:cli-provider:state')
        return {
          profiles: [
            {
              kind: 'codex',
              id: 'p1',
              name: '第三方',
              baseUrl: 'https://x',
              model: 'gpt-5',
              apiFormat: 'responses',
              needsRouting: false,
              hasKey: true,
              keyHint: 'k…',
              active: true,
            },
          ],
        };
      return {};
    });
    (window as unknown as { aiIPC: unknown }).aiIPC = { invoke, on: () => () => undefined };
    const { container } = render(<ModelControls tab={current} />);
    await waitFor(() => expect(container.childElementCount).toBe(0));
    void current;
  });

  it('Claude：按钮显示 CLI 给的默认模型名；不支持思考深度的模型不显示滑杆', async () => {
    const { findByTestId, getByTestId } = setup({
      catalog: claudeCatalog,
      tabOver: { backend: 'claude' },
    });
    // 按钮直接显示 CLI 默认用的模型名，浮层模型行再标「默认」
    expect((await findByTestId('model-chip')).textContent).toContain('Opus 5.5');
    expect((await findByTestId('model-chip')).textContent).not.toContain('默认');
    fireEvent.click(getByTestId('model-chip'));
    expect(getByTestId('model-open').textContent).toContain('默认');
    expect(getByTestId('effort-max')).toBeTruthy();
    cleanup();
    const r = setup({
      catalog: claudeCatalog,
      tabOver: { backend: 'claude', modelOverride: 'claude-haiku-4-5-20251001' },
    });
    fireEvent.click(await r.findByTestId('model-chip'));
    expect(r.getByTestId('effort-title').textContent).toBe('无思考深度');
    expect(r.queryByTestId('effort-slider')).toBeNull();
  });

  it('读不到目录：只有默认与自定义，显示原因；刷新按钮让主进程重读', async () => {
    const { findByTestId, getByTestId, queryByTestId, invoke } = setup({
      catalog: { backend: 'grok', models: [], defaultModel: null, error: 'not authenticated' },
      tabOver: { backend: 'grok' },
    });
    fireEvent.click(await findByTestId('model-chip'));
    expect(queryByTestId('effort-slider')).toBeNull();
    expect(getByTestId('effort-hint').textContent).toContain('没有提供可选档位');
    fireEvent.click(getByTestId('model-open'));
    expect(getByTestId('model-error').textContent).toContain('not authenticated');
    expect(getByTestId('model-default')).toBeTruthy();
    expect(getByTestId('model-custom-toggle')).toBeTruthy();
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
      if (ch === 'ai:cli-provider:state') return { profiles: [] };
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
});
