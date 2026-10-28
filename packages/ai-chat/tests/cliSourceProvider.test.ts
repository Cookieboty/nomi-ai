import { describe, expect, it } from 'vitest';

import {
  codingProviders,
  newTabPatch,
  newTabSelectValue,
  providerEntryRef,
  scopeCatalogToProvider,
  thirdPartyRefOf,
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

  it('thirdPartyRefOf：标签的选择 > 会话上次用的模型（还在网关里时）> 「模型」页分配的模型', () => {
    expect(
      thirdPartyRefOf(
        { modelOverride: 'amux/gpt-x', lastServedRef: 'deep/ds-v4' },
        'claude',
        gateway,
      ),
    ).toBe('amux/gpt-x');
    expect(thirdPartyRefOf({ lastServedRef: 'deep/ds-v4' }, 'claude', gateway)).toBe('deep/ds-v4');
    // 原供应商已删除 / 停用：回到分配的模型
    expect(thirdPartyRefOf({ lastServedRef: 'gone/x' }, 'claude', gateway)).toBe('amux/kimi-k3');
    expect(thirdPartyRefOf({}, 'claude', gateway)).toBe('amux/kimi-k3');
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

  it('newTabPatch：官方来源会清掉第三方主模型，第三方来源同时写入供应商模型', () => {
    const client = {
      models: { main: 'amux/gpt-x' },
      newTabSource: 'thirdParty' as const,
    };
    expect(newTabPatch('follow', { kind: 'claude', client, gateway })).toEqual({
      newTabSource: 'official',
      newTabAccountId: null,
      models: { main: null },
    });
    expect(newTabPatch('provider:deep', { kind: 'claude', client, gateway })).toEqual({
      newTabSource: 'thirdParty',
      newTabAccountId: null,
      models: { main: 'deep/ds-v4' },
    });
  });

  it('newTabPatch：默认使用本机配置，官方可指定账号；选择模型后来源值跟随供应商', () => {
    const client = { models: { main: 'amux/gpt-x' }, newTabSource: 'thirdParty' as const };
    const ctx = {
      kind: 'claude' as const,
      client,
      gateway,
      accounts: [
        {
          id: 'account-1',
          kind: 'claude' as const,
          label: '工作账号',
          local: false,
          loggedIn: true,
          identity: { key: 'work@example.com', email: 'work@example.com' },
          active: false,
          inUse: 0,
          createdAt: 0,
        },
      ],
    };
    expect(newTabPatch('default', ctx)).toEqual({
      newTabSource: 'official',
      newTabAccountId: 'local-claude',
      models: { main: null },
    });
    expect(newTabPatch('account:account-1', ctx)).toEqual({
      newTabSource: 'official',
      newTabAccountId: 'account-1',
      models: { main: null },
    });
    expect(newTabSelectValue({ models: {}, newTabAccountId: 'local-claude' }, 'claude')).toBe(
      'default',
    );
  });
});
