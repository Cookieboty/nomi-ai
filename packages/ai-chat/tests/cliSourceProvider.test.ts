import { describe, expect, it } from 'vitest';

import {
  codingProviders,
  providerEntryRef,
  scopeCatalogToProvider,
} from '../src/services/cliSource';
import type { GatewayState } from '../src/services/gatewayClient';
import type { BackendModelCatalog } from '../src/services/harnessClient';

const provider = (id: string, name: string, models: string[]) => ({
  id,
  name,
  enabled: true,
  urls: {},
  keys: [],
  models: models.map((m) => ({ id: m, enabled: true, toolCalling: true })),
  source: 'user',
  createdAt: 0,
  updatedAt: 0,
});
const gateway = {
  status: { state: 'running' },
  providers: [provider('amux', 'Amux', ['gpt-x', 'kimi-k3']), provider('deep', 'DeepX', ['ds-v4'])],
  clients: { claude: { models: { main: 'amux/kimi-k3' } } },
  allowedPrivateHosts: [],
  port: 1,
} as unknown as GatewayState;

describe('第三方供应商（输入框左下角只切供应商，模型在模型按钮里换）', () => {
  it('codingProviders 按供应商归组', () => {
    expect(codingProviders(gateway).map((p) => [p.id, p.name, p.models.length])).toEqual([
      ['amux', 'Amux', 2],
      ['deep', 'DeepX', 1],
    ]);
  });

  it('providerEntryRef：当前模型 > 「模型」页分配的模型 > 该供应商第一个模型', () => {
    expect(providerEntryRef(gateway, 'amux', 'claude', 'amux/gpt-x')).toBe('amux/gpt-x');
    expect(providerEntryRef(gateway, 'amux', 'claude', 'deep/ds-v4')).toBe('amux/kimi-k3');
    expect(providerEntryRef(gateway, 'deep', 'claude', 'amux/gpt-x')).toBe('deep/ds-v4');
    expect(providerEntryRef(gateway, 'nope', 'claude', null)).toBeNull();
  });

  it('scopeCatalogToProvider：只留当前供应商的模型，去掉名字里的「供应商 / 」', () => {
    const m = (id: string, label: string) => ({ id, label, reasoning: false, efforts: [] });
    const catalog: BackendModelCatalog = {
      backend: 'claude',
      models: [
        m('amux/gpt-x', 'Amux / gpt-x'),
        m('amux/kimi-k3', 'Amux / kimi-k3'),
        m('deep/ds-v4', 'DeepX / ds-v4'),
      ],
      defaultModel: m('amux/kimi-k3', 'Amux / kimi-k3'),
      provider: { id: 'nomi-gateway', name: '第三方模型' },
    };
    const deep = scopeCatalogToProvider(catalog, 'deep/ds-v4', gateway);
    expect(deep.models.map((x) => [x.id, x.label])).toEqual([['deep/ds-v4', 'ds-v4']]);
    // 默认模型不属于这个供应商：不显示成「默认」
    expect(deep.defaultModel).toBeNull();
    expect(deep.provider?.name).toBe('DeepX');
    const amux = scopeCatalogToProvider(catalog, 'amux/gpt-x', gateway);
    expect(amux.models).toHaveLength(2);
    expect(amux.defaultModel?.label).toBe('kimi-k3');
    // 没有当前模型：原样返回
    expect(scopeCatalogToProvider(catalog, null, gateway)).toBe(catalog);
  });
});
