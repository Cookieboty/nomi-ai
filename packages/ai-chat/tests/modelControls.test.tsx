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

const catalog: BackendModelCatalog = {
  backend: 'codex',
  efforts: ['minimal', 'low', 'medium', 'high', 'xhigh'],
  models: [
    { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', reasoning: true },
    { id: 'gpt-5.3-codex', label: 'GPT-5.3 Codex', reasoning: true },
    { id: 'gpt-4.1', label: 'GPT-4.1', reasoning: false },
  ],
};

const claudeCatalog: BackendModelCatalog = {
  backend: 'claude',
  efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  models: [
    { id: 'fable', label: 'Fable', reasoning: true },
    { id: 'sonnet', label: 'Sonnet', reasoning: true },
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
  it('无模型目录的后端不渲染任何芯片', () => {
    const { container } = setup({ catalog: null });
    expect(container.childElementCount).toBe(0);
  });

  it('默认状态显示「默认模型」「思考默认」两枚芯片', async () => {
    const { findByTestId } = setup({ catalog });
    const model = await findByTestId('model-chip');
    expect(model.textContent).toContain('默认模型');
    const effort = await findByTestId('effort-chip');
    expect(effort.textContent).toContain('思考默认');
  });

  it('模型菜单含默认项、目录模型与自定义入口；选择后发起 tab-model', async () => {
    const { findByTestId, getByTestId, invoke } = setup({ catalog });
    fireEvent.click(await findByTestId('model-chip'));
    const menu = await findByTestId('model-menu');
    expect(within(menu).getByText('GPT-5.6 Sol')).toBeTruthy();
    expect(within(menu).getByText('GPT-4.1')).toBeTruthy();
    fireEvent.click(getByTestId('model-gpt-5.6-sol'));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('ai:harness:tab-model', 'cx', 'gpt-5.6-sol'),
    );
  });

  it('自定义模型 id 输入后提交 tab-model', async () => {
    const { findByTestId, getByTestId, invoke } = setup({ catalog });
    fireEvent.click(await findByTestId('model-chip'));
    fireEvent.click(getByTestId('model-custom-toggle'));
    const input = getByTestId('model-custom-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'gpt-7-codex' } });
    fireEvent.click(getByTestId('model-custom-ok'));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('ai:harness:tab-model', 'cx', 'gpt-7-codex'),
    );
  });

  it('选择档位发起 tab-effort；默认项发 null 清除', async () => {
    const { findByTestId, getByTestId, invoke } = setup({
      catalog,
      tabOver: { modelOverride: 'gpt-5.6-sol', reasoningEffort: 'medium' },
    });
    const chip = await findByTestId('effort-chip');
    expect(chip.textContent).toContain('中');
    fireEvent.click(chip);
    fireEvent.click(getByTestId('effort-high'));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('ai:harness:tab-effort', 'cx', 'high'));

    fireEvent.click(await findByTestId('effort-chip'));
    fireEvent.click(getByTestId('effort-default'));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('ai:harness:tab-effort', 'cx', null));
  });

  it('非推理模型（gpt-4.1）隐藏思考深度芯片', async () => {
    const { findByTestId, queryByTestId } = setup({
      catalog,
      tabOver: { modelOverride: 'gpt-4.1' },
    });
    expect(await findByTestId('model-chip')).toBeTruthy();
    await waitFor(() => expect(queryByTestId('effort-chip')).toBeNull());
  });

  it('未知自定义模型默认仍显示思考芯片（主进程兜底校验）', async () => {
    const { findByTestId } = setup({ catalog, tabOver: { modelOverride: 'gpt-9-x' } });
    expect(await findByTestId('effort-chip')).toBeTruthy();
  });

  it('档位菜单只渲染后端目录的档位集（codex 无 max）', async () => {
    const { findByTestId, queryByTestId, getByTestId } = setup({ catalog });
    fireEvent.click(await findByTestId('effort-chip'));
    expect(getByTestId('effort-minimal')).toBeTruthy();
    expect(getByTestId('effort-xhigh')).toBeTruthy();
    expect(queryByTestId('effort-max')).toBeNull();
  });

  it('Claude 后端：模型目录渲染别名；档位无 minimal 但有 max', async () => {
    const { findByTestId, getByTestId, queryByTestId, invoke } = setup({
      catalog: claudeCatalog,
      tabOver: { backend: 'claude' },
    });
    fireEvent.click(await findByTestId('model-chip'));
    const menu = await findByTestId('model-menu');
    expect(within(menu).getByText('Sonnet')).toBeTruthy();
    fireEvent.click(getByTestId('model-sonnet'));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('ai:harness:tab-model', 'cx', 'sonnet'),
    );

    fireEvent.click(await findByTestId('effort-chip'));
    expect(queryByTestId('effort-minimal')).toBeNull();
    fireEvent.click(getByTestId('effort-max'));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('ai:harness:tab-effort', 'cx', 'max'));
  });

  it('第三方供应商档案激活时不渲染（模型由档案管理）', async () => {
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
});
