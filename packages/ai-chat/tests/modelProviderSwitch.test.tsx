// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ModelControls } from '../src/components/ModelControls';
import { thirdPartyProviderSource } from '../src/components/ModelControls/providerSource';
import type { BackendModelCatalog, HarnessTabMeta } from '../src/services/harnessClient';

import { installFakeApi, resetFakeApi } from './helpers/fakeApi';

vi.mock('../src/services/api', async () => (await import('./helpers/fakeApi')).fakeApiModule());

afterEach(() => {
  cleanup();
  resetFakeApi();
});

function setup(reasoning = true, error?: string) {
  let tab: HarnessTabMeta = {
    id: 'cx',
    title: 'Chat',
    backend: 'codex',
    cwd: '/w',
    cliSessionId: null,
    status: 'idle',
    unread: 0,
    createdAt: 0,
    updatedAt: 0,
    source: 'thirdParty',
    modelOverride: 'a/gpt-5',
    reasoningEffort: 'high',
  };
  const model = (id: string, enabled = true, toolCalling = true) => ({
    id,
    enabled,
    toolCalling,
    ...(reasoning
      ? {
          effective: {
            ctx: 1000,
            maxOutput: 100,
            source: 'catalog',
            maxOutputSource: 'catalog',
            thinking: { control: 'effort', levels: ['low', 'medium', 'high'], default: 'medium' },
          },
        }
      : {}),
  });
  const provider = (id: string, models: ReturnType<typeof model>[], enabled = true) => ({
    id,
    name: id.toUpperCase(),
    enabled,
    source: 'user',
    urls: { chat: 'https://example.com' },
    keys: [],
    models,
  });
  const providers = [
    provider('a', [model('gpt-5')]),
    provider('b', [model('gpt-5'), model('gpt-4.1')]),
    provider('c', [model('custom/model')]),
    provider('disabled', [model('gpt-5')], false),
    provider('disabled-model', [model('gpt-5', false)]),
    provider('no-tools', [model('gpt-5', true, false)]),
  ];
  const catalog: BackendModelCatalog = {
    backend: 'codex',
    provider: { id: 'gateway', name: 'Third-party models' },
    defaultModel: { id: 'a/gpt-5', label: 'A / gpt-5', reasoning: false, efforts: [] },
    models: providers.flatMap((p) =>
      p.models.map((m) => ({
        id: `${p.id}/${m.id}`,
        label: `${p.name} / ${m.id}`,
        reasoning: false,
        efforts: [],
      })),
    ),
  };
  const invoke = vi.fn(async (ch: string, input?: Record<string, unknown>) => {
    if (ch === 'gateway.state')
      return {
        providers,
        clients: { codex: { models: { main: 'a/gpt-5' } } },
        status: { state: 'running', port: 1, url: 'http://127.0.0.1:1' },
        allowedPrivateHosts: [],
        port: 1,
      };
    if (ch === 'harness.modelCatalog') return catalog;
    if (ch === 'harness.tabModel') {
      if (error) throw new Error(error);
      tab = { ...tab, modelOverride: String(input?.model) };
      return tab;
    }
    return {};
  });
  installFakeApi(invoke);
  const r = render(<ModelControls tab={tab} />);
  const openProviders = async () => {
    await act(async () => {});
    fireEvent.click(await r.findByTestId('model-chip'));
    fireEvent.click(await r.findByTestId('model-provider-open'));
  };
  return { ...r, invoke, openProviders, update: () => r.rerender(<ModelControls tab={tab} />) };
}

describe('第三方供应商选择', () => {
  it('CLI 显示独立供应商行，不展示官方账号或已停用 / 无工具能力的供应商', async () => {
    const r = setup();
    await r.openProviders();
    expect(r.getByTestId('model-chip').textContent).toBe('gpt-5 · 高');
    expect(r.getByTestId('provider-a').getAttribute('aria-selected')).toBe('true');
    expect(r.getByTestId('provider-b')).toBeTruthy();
    expect(r.queryByTestId('account-open')).toBeNull();
    expect(r.queryByTestId('provider-disabled')).toBeNull();
    expect(r.queryByTestId('provider-disabled-model')).toBeNull();
    expect(r.queryByTestId('provider-no-tools')).toBeNull();
  });

  it('CLI 选择同名模型供应商时只改标签模型，不改思考档位 / 来源 / 官方账号', async () => {
    const r = setup();
    await r.openProviders();
    fireEvent.click(r.getByTestId('provider-b'));
    await waitFor(() =>
      expect(r.invoke).toHaveBeenCalledWith('harness.tabModel', {
        id: 'cx',
        model: 'b/gpt-5',
        expectSource: 'thirdParty',
      }),
    );
    r.update();
    expect(r.getByTestId('model-provider-open').textContent).toBe('第三方供应商B');
    expect(r.getByTestId('model-chip').textContent).toBe('gpt-5 · 高');
    expect(
      r.invoke.mock.calls.some(([ch]) =>
        ['harness.tabEffort', 'harness.tabSource', 'harness.tabAccount'].includes(ch),
      ),
    ).toBe(false);
  });

  it('CLI 无同名模型时定位目标供应商，取消不发生替换', async () => {
    const r = setup();
    await r.openProviders();
    fireEvent.click(r.getByTestId('provider-c'));
    expect(r.getByTestId('model-picker-tab-c').getAttribute('aria-selected')).toBe('true');
    expect(r.getByTestId('model-c/custom/model')).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(r.invoke.mock.calls.some(([ch]) => ch === 'harness.tabModel')).toBe(false);
    await waitFor(() => expect(r.queryByTestId('model-menu')).toBeNull());
  });

  it('不支持思考深度的模型也可直接切供应商', async () => {
    const r = setup(false);
    await r.openProviders();
    fireEvent.click(r.getByTestId('provider-b'));
    await waitFor(() =>
      expect(r.invoke).toHaveBeenCalledWith('harness.tabModel', {
        id: 'cx',
        model: 'b/gpt-5',
        expectSource: 'thirdParty',
      }),
    );
    expect(r.queryByTestId('model-menu')).toBeNull();
  });

  it('写入失败沿用原供应商并显示错误', async () => {
    const r = setup(true, 'Provider switch failed');
    await r.openProviders();
    fireEvent.click(r.getByTestId('provider-b'));
    await waitFor(() =>
      expect(r.getByTestId('model-chip-note').textContent).toBe('Provider switch failed'),
    );
    expect(r.getByTestId('model-provider-open').textContent).toBe('第三方供应商A');
  });

  it('供应商比较使用完整模型 id，不按显示名或最后一段误匹配', () => {
    const onPick = vi.fn(() => 'effort' as const);
    const source = thirdPartyProviderSource(
      [
        { id: 'a', name: 'A', models: [{ id: 'vendor/model', label: 'Same name' }] },
        { id: 'b', name: 'B', models: [{ id: 'model', label: 'Same name' }] },
      ],
      'a/vendor/model',
      onPick,
    )!;
    expect(source.onChange('b')).toBe('model');
    expect(source.onChange('a')).toBe('effort');
    expect(onPick).not.toHaveBeenCalled();
    expect(thirdPartyProviderSource([], null, onPick)).toBeNull();
  });
});
