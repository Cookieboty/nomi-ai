import { describe, expect, it } from 'vitest';

import {
  endpointURL,
  fullUrlFetch,
  mapModel,
  migrateStoreData,
  modelsRequestHeaders,
  modelsURL,
  parseModelList,
  plaintextCipher,
  ProviderStore,
  sdkBaseURL,
  searchPresets,
} from '../src/providers';

describe('protocol URL building', () => {
  it('appends the protocol path unless full URL is on', () => {
    expect(endpointURL('openai-chat', 'https://a.com/v1/')).toBe(
      'https://a.com/v1/chat/completions',
    );
    expect(endpointURL('openai-responses', 'https://a.com/v1')).toBe('https://a.com/v1/responses');
    expect(endpointURL('anthropic', 'https://a.com')).toBe('https://a.com/v1/messages');
    expect(endpointURL('anthropic', 'https://a.com/v1')).toBe('https://a.com/v1/messages');
    expect(endpointURL('openai-chat', 'https://a.com/x/chat', true)).toBe('https://a.com/x/chat');
  });

  it('sdk base strips the protocol suffix in full-URL mode', () => {
    expect(sdkBaseURL('openai-chat', 'https://a.com/v1/chat/completions', true)).toBe(
      'https://a.com/v1',
    );
    expect(sdkBaseURL('anthropic', 'https://a.com/api/v1/messages', true)).toBe(
      'https://a.com/api/v1',
    );
    expect(sdkBaseURL('anthropic', 'https://a.com/api')).toBe('https://a.com/api/v1');
  });

  it('full-URL fetch rewrites only the SDK endpoint', async () => {
    const seen: string[] = [];
    const f = fullUrlFetch('openai-responses', 'https://a.com/gw?key=1', true, (async (
      u: string,
    ) => {
      seen.push(String(u));
      return new Response('{}');
    }) as unknown as typeof fetch)!;
    await f('https://a.com/gw/responses');
    await f('https://a.com/other');
    expect(seen).toEqual(['https://a.com/gw?key=1', 'https://a.com/other']);
    expect(fullUrlFetch('openai-chat', 'https://a.com/v1/chat/completions', true)).toBeUndefined();
    expect(fullUrlFetch('openai-chat', 'https://a.com/v1', false)).toBeUndefined();
  });

  it('models URL + headers per style', () => {
    expect(modelsURL('openai-chat', 'https://a.com/v1')).toBe('https://a.com/v1/models');
    expect(modelsURL('openai-responses', 'https://a.com/v1/responses', true)).toBe(
      'https://a.com/v1/models',
    );
    expect(modelsURL('anthropic', 'https://api.anthropic.com')).toBe(
      'https://api.anthropic.com/v1/models',
    );
    expect(modelsURL('openai-chat', 'https://a.com/weird/endpoint', true)).toBe(
      'https://a.com/v1/models',
    );
    expect(modelsRequestHeaders('anthropic', 'sk')).toMatchObject({
      'x-api-key': 'sk',
      'anthropic-version': '2023-06-01',
    });
    expect(modelsRequestHeaders('openai-chat', 'sk')).toMatchObject({ authorization: 'Bearer sk' });
    expect(modelsRequestHeaders('openai-chat', undefined).authorization).toBeUndefined();
  });
});

describe('model list parsing', () => {
  it('OpenAI style', () => {
    expect(
      parseModelList({
        object: 'list',
        data: [{ id: 'gpt-b', owned_by: 'x' }, { id: 'gpt-a' }, { id: 'gpt-a' }],
      }),
    ).toEqual([{ id: 'gpt-a' }, { id: 'gpt-b', ownedBy: 'x' }]);
  });
  it('Anthropic style', () => {
    expect(
      parseModelList({
        data: [{ type: 'model', id: 'claude-x', display_name: 'Claude X' }],
        has_more: false,
      }),
    ).toEqual([{ id: 'claude-x', name: 'Claude X' }]);
  });
  it('Ollama / bare arrays / garbage', () => {
    expect(
      parseModelList({ models: [{ name: 'llama3' }, { model: 'qwen' }] }).map((m) => m.id),
    ).toEqual(['llama3', 'qwen']);
    expect(parseModelList(['a', 'b']).map((m) => m.id)).toEqual(['a', 'b']);
    expect(parseModelList({ nope: 1 })).toEqual([]);
    expect(parseModelList(null)).toEqual([]);
  });
});

describe('model mapping', () => {
  it('exact beats wildcard; no mapping keeps the name', () => {
    const m = [
      { from: '*', to: 'fallback' },
      { from: 'fast', to: 'gpt-mini' },
    ];
    expect(mapModel('fast', m)).toBe('gpt-mini');
    expect(mapModel('other', m)).toBe('fallback');
    expect(mapModel('x', undefined)).toBe('x');
  });
});

describe('preset search', () => {
  it('matches name, keywords and URL', () => {
    expect(searchPresets('智谱').map((p) => p.id)).toContain('zhipu');
    expect(searchPresets('claude').map((p) => p.id)).toContain('anthropic');
    expect(searchPresets('openrouter.ai').map((p) => p.id)).toEqual(['openrouter']);
    expect(searchPresets('gateway.amux').map((p) => p.id)).toEqual(['amux']);
    expect(searchPresets('').length).toBeGreaterThan(10);
  });
});

describe('store migration v1 → v2', () => {
  const v1 = {
    version: 1,
    providers: [
      {
        id: 'p-claude-1',
        presetId: 'claude',
        name: 'C',
        backend: 'anthropic',
        baseURL: 'https://api.anthropic.com/v1',
        defaultModel: 'claude-x',
        enabled: true,
        keys: [],
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: 'p-gemini-1',
        presetId: 'gemini',
        name: 'G',
        backend: 'google',
        baseURL: 'https://generativelanguage.googleapis.com/v1beta',
        defaultModel: 'gemini-2.5-flash',
        enabled: true,
        keys: [],
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: 'p-deepseek-1',
        presetId: 'deepseek',
        name: 'D',
        backend: 'openai-compatible',
        baseURL: 'https://api.deepseek.com/v1',
        defaultModel: 'deepseek-chat',
        enabled: true,
        keys: [],
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    activeProviderId: 'p-deepseek-1',
    routes: {
      chat: { providerId: 'p-claude-1', model: 'claude-y' },
      summary: { providerId: 'p-gemini-1' },
    },
    usage: {},
  };

  it('maps backends to protocols, Gemini to its OpenAI endpoint, chat route into active', () => {
    const { data, migrated } = migrateStoreData(JSON.parse(JSON.stringify(v1)));
    expect(migrated).toBe(true);
    expect(data.version).toBe(2);
    const [c, g, d] = data.providers;
    expect(c).toMatchObject({
      protocol: 'anthropic',
      presetId: 'anthropic',
      fullUrl: false,
      defaultModel: 'claude-y',
    });
    expect(c!.models).toEqual(['claude-y', 'claude-x']);
    expect(g).toMatchObject({
      protocol: 'openai-chat',
      baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
    });
    expect(d).toMatchObject({ protocol: 'openai-chat', models: ['deepseek-chat'] });
    expect('backend' in c!).toBe(false);
    expect(data.activeProviderId).toBe('p-claude-1');
    expect(data.routes).toEqual({ summary: { providerId: 'p-gemini-1' } });
  });

  it('v2 data passes through untouched', () => {
    const once = migrateStoreData(JSON.parse(JSON.stringify(v1))).data;
    const again = migrateStoreData(JSON.parse(JSON.stringify(once)));
    expect(again.migrated).toBe(false);
    expect(again.data).toEqual(once);
  });
});

describe('store: switching', () => {
  it('setActive overrides a stale chat route and can pick a model', () => {
    const store = new ProviderStore({ cipher: plaintextCipher });
    const a = store.upsert({ presetId: 'custom', baseURL: 'http://a/v1', defaultModel: 'a1' });
    const b = store.upsert({ presetId: 'custom', baseURL: 'http://b/v1', defaultModel: 'b1' });
    store.setRoute('chat', { providerId: a.id, model: 'a-pinned' });
    store.setActive(b.id, 'b2');
    expect(store.route('chat')).toBeUndefined();
    expect(store.activeProviderId()).toBe(b.id);
    const vb = store.list().find((p) => p.id === b.id)!;
    expect(vb.defaultModel).toBe('b2');
    expect(vb.models).toEqual(['b1', 'b2']);
  });
});

describe('preset verification metadata', () => {
  it('every vendor / platform preset links its official docs and is verified', async () => {
    const { PROVIDER_PRESETS, PRESETS_CHECKED_AT } = await import('../src/providers');
    expect(PRESETS_CHECKED_AT).toBe('2026-10-11');
    for (const p of PROVIDER_PRESETS.filter((x) => x.category !== 'custom')) {
      expect(p.docsUrl, p.id).toMatch(/^https:\/\//);
      expect(p.verified, p.id).toBe(true);
      expect(p.icon, p.id).toBeTruthy();
    }
  });

  it('amux preset matches official docs (gateway, OpenAI Chat, /v1/models)', async () => {
    const { findPreset } = await import('../src/providers');
    const p = findPreset('amux')!;
    expect(p).toMatchObject({
      category: 'platform',
      protocol: 'openai-chat',
      baseURL: 'https://gateway.amux.ai/v1',
      modelsEndpoint: true,
      requiresApiKey: true,
      checkedAt: '2026-10-12',
    });
    expect(modelsURL('openai-chat', p.baseURL)).toBe('https://gateway.amux.ai/v1/models');
    expect(endpointURL('openai-chat', p.baseURL)).toBe(
      'https://gateway.amux.ai/v1/chat/completions',
    );
  });

  it('no preset ships a defaultModel — user must fetch and pick', async () => {
    const { PROVIDER_PRESETS } = await import('../src/providers');
    for (const p of PROVIDER_PRESETS) {
      expect(p.defaultModel, p.id).toBe('');
      expect(p.models, p.id).toEqual([]);
    }
  });

  it('gateway extension (§8.4): per-wire URLs, model metadata and quirks for the first vendors', async () => {
    const { PROVIDER_PRESETS, GATEWAY_PRESETS_CHECKED_AT } = await import('../src/providers');
    const by = (id: string) => PROVIDER_PRESETS.find((p) => p.id === id)!;
    // 首批要写明 Anthropic 入口的厂商
    for (const id of [
      'deepseek',
      'zhipu',
      'zhipu-coding',
      'kimi',
      'qwen',
      'qwen-coding',
      'minimax',
    ]) {
      const p = by(id);
      expect(p.urls?.messages, id).toMatch(/^https:\/\/[^/]+.*[^/]$/);
      expect(p.urls?.chat, id).toBeTruthy();
      expect(p.checkedAt, id).toBe(GATEWAY_PRESETS_CHECKED_AT);
      expect(p.modelMeta?.length, id).toBeGreaterThan(0);
      for (const m of p.modelMeta!) {
        expect(m.ctx, `${id}/${m.id}`).toBeGreaterThan(0);
        expect(typeof m.toolCalling, `${id}/${m.id}`).toBe('boolean');
      }
    }
    // 地址不带接口路径（拼接由网关做）
    for (const p of PROVIDER_PRESETS)
      for (const u of Object.values(p.urls ?? {}))
        expect(u, p.id).not.toMatch(/\/(chat\/completions|responses|messages)$/);
    expect(by('xai').urls?.messages).toBeUndefined(); // 已弃用
    expect(by('minimax').urls?.responses).toBeUndefined(); // 文档没有
    expect(by('qwen-coding').urls?.responses).toBeUndefined();
    expect(by('zhipu-coding').codingPlan).toBe(true);
    expect(by('deepseek').quirks?.reasoningPassback).toBe(true);
    expect(by('kimi').quirks?.dropParams).toContain('temperature');
  });
});
