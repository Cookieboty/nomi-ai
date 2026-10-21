import { gatewayMenuEntries, providerMenuEntries } from '../../../src/core/TrayManager';

const usage = { requests: 0, errors: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 };

describe('providerMenuEntries', () => {
  it('lists enabled stored providers then env providers, checking the effective one', () => {
    const entries = providerMenuEntries({
      providers: [
        {
          id: 'p-a',
          presetId: 'openai',
          name: 'Work OpenAI',
          protocol: 'openai-chat',
          fullUrl: false,
          models: [],
          baseURL: 'https://api.openai.com/v1',
          defaultModel: 'gpt-4o-mini',
          enabled: true,
          active: true,
          keys: [{ id: 'k1', masked: 'sk-…1234', encryption: 'safeStorage', createdAt: 0 }],
          usage,
          source: 'store',
        },
        {
          id: 'p-b',
          presetId: 'zhipu',
          name: 'Disabled',
          protocol: 'openai-chat',
          fullUrl: false,
          models: [],
          baseURL: 'https://x/v1',
          defaultModel: 'm',
          enabled: false,
          active: false,
          keys: [],
          usage,
          source: 'store',
        },
      ],
      envProviders: [
        {
          id: 'deepseek',
          name: 'DeepSeek（环境变量）',
          protocol: 'openai-chat',
          hasKey: false,
          keyless: false,
          active: false,
          usage,
          source: 'env',
        },
      ],
      activeProviderId: 'p-a',
      effectiveProviderId: 'p-a',
      routes: {},
      roles: ['chat', 'agent-tools', 'summary'],
      encryption: 'safeStorage',
    });
    expect(entries).toEqual([
      { id: 'p-a', label: 'Work OpenAI · gpt-4o-mini', checked: true, enabled: true },
      { id: 'deepseek', label: 'DeepSeek（环境变量）（无 key）', checked: false, enabled: false },
    ]);
  });
});

describe('gatewayMenuEntries', () => {
  const prov = (
    id: string,
    models: Array<{ id: string; enabled: boolean; toolCalling?: boolean }>,
    enabled = true,
  ) => ({ id, name: id.toUpperCase(), enabled, models, keys: [], urls: {} }) as never;
  it("one entry per enabled provider; the main's provider is checked with its current model", () => {
    const entries = gatewayMenuEntries({
      providers: [
        prov('ds', [
          { id: 'flash', enabled: true },
          { id: 'pro', enabled: true },
        ]),
        prov('kimi', [
          { id: 'embed', enabled: true, toolCalling: false },
          { id: 'k3', enabled: true },
        ]),
        prov('off', [{ id: 'x', enabled: true }], false),
        prov('empty', [{ id: 'y', enabled: false }]),
      ],
      clients: { nomi: { models: { main: 'ds/pro' } } },
    });
    expect(entries).toEqual([
      { id: 'ds', label: 'DS · pro', checked: true, enabled: true, ref: 'ds/pro' },
      { id: 'kimi', label: 'KIMI · k3', checked: false, enabled: true, ref: 'kimi/k3' },
    ]);
  });
});
