import { describe, expect, it } from 'vitest';

import {
  codingProviders,
  defaultSourceSwitch,
  newTabPatch,
  newTabOptions,
  newTabSelectValue,
  providerEntryRef,
  scopeCatalogToProvider,
  sessionModelGroups,
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

  it('sessionModelGroups：会话原来的供应商、当前选中的、默认供应商，去重；没聊过返回 null', () => {
    expect(sessionModelGroups({}, 'claude', gateway)).toBeNull();
    expect(
      sessionModelGroups({ lastServedRef: 'deep/ds-v4' }, 'claude', gateway)?.map((g) => [
        g.id,
        g.label,
      ]),
    ).toEqual([
      ['deep', '本会话原来的供应商 · DeepX'],
      ['amux', '默认供应商 · Amux'],
    ]);
    // 已换到默认供应商并聊过：只剩一组
    expect(sessionModelGroups({ lastServedRef: 'amux/gpt-x' }, 'claude', gateway)?.length).toBe(1);
    // 原供应商已不在网关里：当作没聊过
    expect(sessionModelGroups({ lastServedRef: 'gone/x' }, 'claude', gateway)).toBeNull();
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

  it('newTabPatch：没有「本机登录」——官方是跟随默认或指定账号，旧版本存下的 local-<kind> 按跟随默认显示', () => {
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
          loggedIn: true,
          identity: { key: 'work@example.com', email: 'work@example.com' },
          active: true,
          inUse: 0,
          createdAt: 0,
        },
      ],
    };
    // 旧的「默认（本机登录）」值不再有效
    expect(newTabPatch('default', ctx)).toBeNull();
    expect(newTabPatch('follow', ctx)).toEqual({
      newTabSource: 'official',
      newTabAccountId: null,
      models: { main: null },
    });
    expect(newTabPatch('account:account-1', ctx)).toEqual({
      newTabSource: 'official',
      newTabAccountId: 'account-1',
      models: { main: null },
    });
    expect(newTabSelectValue({ models: {}, newTabAccountId: 'local-claude' }, 'claude')).toBe(
      'follow',
    );
    const options = newTabOptions(ctx);
    expect(options.map((o) => o.value)).toEqual([
      'follow',
      'account:account-1',
      'provider:amux',
      'provider:deep',
    ]);
    expect(options[0]!.description).toBe('工作账号');
    expect(options.some((o) => /本机/.test(String(o.label)))).toBe(false);
    // 一个官方账号都没有：「跟随默认账号」写明还没有账号
    expect(newTabOptions({ ...ctx, accounts: [] })[0]!.description).toBe('还没有官方账号');
  });
  it('Gemini / dsh 没有官方账号能力：只有第三方供应商，没有「自己的配置 / 本机登录」', () => {
    expect(newTabSelectValue({ models: {}, newTabAccountId: 'acct-old' }, 'gemini')).toBe('');
    expect(newTabSelectValue({ models: {}, newTabAccountId: null }, 'dsh')).toBe('');
    const none = newTabOptions({ kind: 'gemini', client: undefined, gateway, accounts: [] });
    expect(none.map((o) => o.value)).toEqual(['', 'provider:amux', 'provider:deep']);
    expect(none[0]!.disabled).toBe(true);
    expect(none[0]!.label).toBe('选一个第三方供应商');
    expect(none.some((o) => /自己的配置|本机/.test(String(o.label)))).toBe(false);
    // 分配了第三方模型：下拉停在那个供应商（不管旧的 newTabSource）
    const client = { models: { main: 'deep/ds-v4' }, newTabSource: 'official' as const };
    expect(newTabSelectValue(client, 'gemini')).toBe('provider:deep');
    expect(
      newTabOptions({ kind: 'gemini', client, gateway, accounts: [] }).map((o) => o.value),
    ).toEqual(['provider:amux', 'provider:deep']);
    expect(newTabPatch('follow', { kind: 'gemini', client, gateway, accounts: [] })).toBeNull();
    expect(newTabPatch('provider:amux', { kind: 'gemini', client, gateway, accounts: [] })).toEqual(
      {
        newTabSource: 'thirdParty',
        newTabAccountId: null,
        models: { main: 'amux/gpt-x' },
      },
    );
  });
  it('defaultSourceSwitch：dsh / Gemini 不会被引回「官方 / 自己的配置」', () => {
    const gw = {
      ...gateway,
      clients: { ...gateway.clients, gemini: { models: { main: 'deep/ds-v4' } } },
    } as unknown as GatewayState;
    expect(defaultSourceSwitch({ backend: 'gemini', source: 'thirdParty' }, gw)).toBeNull();
    // 旧标签还停在官方来源：只给第三方一组
    expect(defaultSourceSwitch({ backend: 'gemini', source: 'official' }, gw)?.target).toBe(
      'thirdParty',
    );
    // 没分配模型：也不给「官方」
    expect(defaultSourceSwitch({ backend: 'dsh', source: 'thirdParty' }, gw)).toBeNull();
    const claude = {
      ...gateway,
      clients: { claude: { models: {}, newTabSource: 'official' } },
    } as unknown as GatewayState;
    const sw = defaultSourceSwitch({ backend: 'claude', source: 'thirdParty' }, claude);
    expect(sw?.target).toBe('official');
    expect(sw?.items[0]!.label).toBe('切换到官方账号');
  });
});
