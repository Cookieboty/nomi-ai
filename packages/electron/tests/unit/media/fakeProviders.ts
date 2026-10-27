/** 测试用的「第三方供应商」来源：模拟网关供应商配置（生图复用它，不再有独立供应商 / Key） */
import type { SharedProvider } from '@nomi-ai/gateway/media';

import type { ProviderSource } from '../../../src/media/store';

const BASE: SharedProvider[] = [
  {
    id: 'openai',
    name: 'OpenAI',
    presetId: 'openai',
    urls: { chat: 'https://api.openai.com/v1', responses: 'https://api.openai.com/v1' },
    models: ['gpt-4.1', 'gpt-image-1'],
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    presetId: 'openrouter',
    urls: { chat: 'https://openrouter.ai/api/v1' },
    models: ['google/gemini-2.5-flash-image-preview', 'anthropic/claude-sonnet-4'],
  },
  {
    id: 'google',
    name: 'Gemini',
    presetId: 'gemini',
    urls: { chat: 'https://generativelanguage.googleapis.com/v1beta/openai' },
    models: ['gemini-2.5-flash', 'gemini-2.5-flash-image'],
  },
  {
    id: 'volc',
    name: '豆包',
    presetId: 'doubao',
    urls: { chat: 'https://ark.cn-beijing.volces.com/api/v3' },
    models: ['doubao-seedream-4-0-250828'],
  },
  {
    id: 'fal',
    name: 'fal.ai',
    presetId: 'fal',
    urls: { chat: 'https://fal.run' },
    models: ['fal-ai/flux-pro/v1.1', 'fal-ai/bytedance/seedream/v4/text-to-image'],
  },
].map((p) => ({
  ...p,
  enabled: true,
  hasKey: false,
  models: p.models.map((id) => ({ id, enabled: true })),
}));

export interface FakeProviders extends ProviderSource {
  /** 填 Key（空串 = 清除） */
  key(id: string, key: string): void;
  set(id: string, patch: Partial<SharedProvider>): void;
  add(p: SharedProvider, key?: string): void;
}

export function fakeProviders(): FakeProviders {
  const list: SharedProvider[] = structuredClone(BASE);
  const keys = new Map<string, string>();
  const find = (id: string) => {
    const p = list.find((x) => x.id === id);
    if (!p) throw new Error(`no provider ${id}`);
    return p;
  };
  return {
    list: () => list.map((p) => ({ ...p, hasKey: !!keys.get(p.id) })),
    apiKey: (id) => keys.get(id) ?? '',
    key: (id, key) => void (find(id), keys.set(id, key)),
    set: (id, patch) => void Object.assign(find(id), patch),
    add: (p, key) => {
      list.push(p);
      if (key) keys.set(p.id, key);
    },
  };
}
