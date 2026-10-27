import { describe, expect, it } from 'vitest';

import { detectImageModel, imageBaseURL, imageBindings, type SharedProvider } from '../src/media';

const sp = (
  id: string,
  over: Partial<SharedProvider> & { models?: SharedProvider['models'] },
): SharedProvider => ({
  id,
  name: id,
  enabled: true,
  hasKey: true,
  urls: {},
  models: [],
  ...over,
});
const m = (id: string, enabled = true) => ({ id, enabled });

describe('图片模型识别（复用第三方供应商）', () => {
  it('按供应商预设 / 地址 + 上游模型名识别 schema 与协议', () => {
    const openrouter = sp('or', { urls: { chat: 'https://openrouter.ai/api/v1' } });
    expect(detectImageModel(openrouter, 'google/gemini-2.5-flash-image-preview')).toEqual({
      modelId: 'gemini-2.5-flash-image',
      protocol: 'openrouter-chat-image',
    });
    expect(detectImageModel(sp('g', { presetId: 'gemini' }), 'gemini-2.5-flash-image')).toEqual({
      modelId: 'gemini-2.5-flash-image',
      protocol: 'gemini',
    });
    expect(
      detectImageModel(sp('d', { presetId: 'doubao' }), 'doubao-seedream-4-0-250828')?.protocol,
    ).toBe('ark-image');
    expect(detectImageModel(sp('f', { presetId: 'fal' }), 'fal-ai/flux-pro/v1.1')).toEqual({
      modelId: 'flux-1.1-pro',
      protocol: 'fal',
    });
    // 通用规则：任何 OpenAI 兼容供应商上的 gpt-image-1
    expect(detectImageModel(sp('x', {}), 'gpt-image-1')?.protocol).toBe('openai-images');
    // 对话模型 / 协议对不上的供应商不识别
    expect(detectImageModel(sp('x', {}), 'gpt-4.1')).toBeNull();
    expect(detectImageModel(sp('x', {}), 'gemini-2.5-flash-image')).toBeNull();
    expect(detectImageModel(sp('x', {}), 'fal-ai/flux-pro/v1.1')).toBeNull();
  });

  it('只看已启用的模型；标记优先，null 排除；同供应商同 schema 只取一个', () => {
    const p = sp('p', {
      urls: { chat: 'https://proxy/v1' },
      models: [m('gpt-image-1'), m('gpt-image-1-mini'), m('img-x'), m('gpt-image-1-old', false)],
    });
    expect(imageBindings([p], []).map((b) => b.upstreamModelName)).toEqual(['gpt-image-1']);
    const marked = imageBindings(
      [p],
      [
        { providerRef: 'p', upstream: 'gpt-image-1', modelId: null },
        { providerRef: 'p', upstream: 'img-x', modelId: 'seedream-4' },
      ],
    );
    expect(marked.map((b) => [b.upstreamModelName, b.modelId, b.presetKey])).toEqual([
      ['gpt-image-1-mini', 'gpt-image-1', 'openai-images'],
      ['img-x', 'seedream-4', 'ark-image'],
    ]);
  });

  it('请求地址：沿用供应商地址；Gemini 原生接口去掉 /openai', () => {
    const g = sp('g', {
      urls: { chat: 'https://generativelanguage.googleapis.com/v1beta/openai/' },
    });
    expect(imageBaseURL(g, 'gemini')).toBe('https://generativelanguage.googleapis.com/v1beta');
    expect(
      imageBaseURL(sp('o', { urls: { responses: 'https://api.openai.com/v1/' } }), 'openai-images'),
    ).toBe('https://api.openai.com/v1');
  });
});
