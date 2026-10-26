import { describe, expect, it } from 'vitest';

import {
  buildRequest,
  openaiSizeFor,
  parseResponse,
  pixelSizeFor,
  providersForModel,
  reconcileChoice,
  usableModels,
  type ProviderAvailability,
  type ProviderBinding,
} from '../src/media';

const bind = (providerRef: string, modelId: string, enabled = true): ProviderBinding => ({
  providerRef,
  modelId,
  enabled,
  presetKey: 'openai-images',
  upstreamModelName: modelId,
});
const prov = (id: string, enabled = true, hasKey = true): ProviderAvailability => ({
  id,
  enabled,
  hasKey,
});

describe('供应商绑定与自动切换', () => {
  const bindings = [
    bind('openai', 'gpt-image-1'),
    bind('openrouter', 'gpt-image-1'),
    bind('fal', 'flux'),
  ];

  it('只列启用 + 有 Key 的组合', () => {
    const ps = [prov('openai'), prov('openrouter', true, false), prov('fal', false)];
    expect(providersForModel('gpt-image-1', bindings, ps)).toEqual(['openai']);
    expect(usableModels(bindings, ps)).toEqual(['gpt-image-1']);
  });

  it('当前供应商可用：不变', () => {
    const r = reconcileChoice({ modelId: 'gpt-image-1', providerRef: 'openai' }, bindings, [
      prov('openai'),
      prov('openrouter'),
    ]);
    expect(r.kind).toBe('unchanged');
  });

  it('当前供应商停用：切到同模型另一家', () => {
    const r = reconcileChoice({ modelId: 'gpt-image-1', providerRef: 'openai' }, bindings, [
      prov('openai', false),
      prov('openrouter'),
      prov('fal'),
    ]);
    expect(r).toEqual({
      kind: 'switched',
      choice: { modelId: 'gpt-image-1', providerRef: 'openrouter' },
      from: { modelId: 'gpt-image-1', providerRef: 'openai' },
    });
  });

  it('绑定被停用也会触发切换；同模型无可用 → 清空（不跨模型兜底）', () => {
    const r = reconcileChoice(
      { modelId: 'gpt-image-1', providerRef: 'openai' },
      [
        bind('openai', 'gpt-image-1', false),
        bind('openrouter', 'gpt-image-1'),
        bind('fal', 'flux'),
      ],
      [prov('openai'), prov('openrouter', true, false), prov('fal')],
    );
    expect(r).toEqual({ kind: 'cleared', from: { modelId: 'gpt-image-1', providerRef: 'openai' } });
  });

  it('未配置保持未配置', () => {
    expect(reconcileChoice(null, bindings, [prov('openai')])).toEqual({
      kind: 'unchanged',
      choice: null,
    });
  });
});

describe('协议适配（纯函数，无网络）', () => {
  const base = { baseURL: 'https://x.test/v1/', apiKey: 'sk-1', prompt: '猫' };

  it('openai-images：size 由比例合成；带参考图走 edits multipart', () => {
    expect(openaiSizeFor('3:2')).toBe('1536x1024');
    expect(openaiSizeFor('2:3')).toBe('1024x1536');
    expect(openaiSizeFor('auto')).toBe('auto');
    const r = buildRequest({
      ...base,
      protocol: 'openai-images',
      upstreamModel: 'gpt-image-1',
      params: { aspect_ratio: '1:1', n: 2, output_format: 'png', output_compression: 80 },
    });
    expect(r.url).toBe('https://x.test/v1/images/generations');
    expect(r.headers.authorization).toBe('Bearer sk-1');
    expect(r.body).toEqual({
      kind: 'json',
      json: { model: 'gpt-image-1', prompt: '猫', size: '1024x1024', n: 2, output_format: 'png' },
    });
    const e = buildRequest({
      ...base,
      protocol: 'openai-images',
      upstreamModel: 'gpt-image-1',
      params: {},
      refs: [{ mime: 'image/png', data: 'AAA' }],
    });
    expect(e.url).toMatch(/images\/edits$/);
    expect(e.body.kind).toBe('multipart');
  });

  it('gemini：key 走 x-goog-api-key，比例进 imageConfig', () => {
    const r = buildRequest({
      ...base,
      baseURL: 'https://g.test/v1beta',
      protocol: 'gemini',
      upstreamModel: 'gemini-2.5-flash-image',
      params: { aspect_ratio: '16:9' },
    });
    expect(r.url).toBe('https://g.test/v1beta/models/gemini-2.5-flash-image:generateContent');
    expect(r.headers['x-goog-api-key']).toBe('sk-1');
    expect(JSON.stringify(r.body)).toContain('"aspectRatio":"16:9"');
    expect(
      parseResponse('gemini', {
        candidates: [
          {
            content: {
              parts: [{ text: 'hi' }, { inlineData: { mimeType: 'image/png', data: 'QQ==' } }],
            },
          },
        ],
      }),
    ).toEqual([{ b64: 'QQ==', mime: 'image/png' }]);
  });

  it('ark-image：像素尺寸按分辨率 + 比例合成，组图走 sequential', () => {
    expect(pixelSizeFor('2K', '1:1')).toBe('2048x2048');
    expect(pixelSizeFor('1K', '16:9')).toBe('1344x768');
    const r = buildRequest({
      ...base,
      protocol: 'ark-image',
      upstreamModel: 'doubao-seedream',
      params: { resolution: '2K', aspect_ratio: '1:1', n: 3 },
    });
    expect(r.body).toMatchObject({
      kind: 'json',
      json: {
        sequential_image_generation: 'auto',
        sequential_image_generation_options: { max_images: 3 },
      },
    });
    expect(
      parseResponse('ark-image', { data: [{ b64_json: 'Zg==' }, { url: 'https://u' }] }),
    ).toEqual([{ b64: 'Zg==' }, { url: 'https://u' }]);
  });

  it('openrouter / fal 解析', () => {
    expect(
      parseResponse('openrouter-chat-image', {
        choices: [{ message: { images: [{ image_url: { url: 'data:image/png;base64,QUJD' } }] } }],
      }),
    ).toEqual([{ mime: 'image/png', b64: 'QUJD' }]);
    const r = buildRequest({
      ...base,
      baseURL: 'https://fal.run',
      protocol: 'fal',
      upstreamModel: 'fal-ai/flux-pro/v1.1',
      params: { aspect_ratio: '9:16' },
    });
    expect(r.url).toBe('https://fal.run/fal-ai/flux-pro/v1.1');
    expect(r.headers.authorization).toBe('Key sk-1');
    expect(
      parseResponse('fal', { images: [{ url: 'https://img', content_type: 'image/jpeg' }] }),
    ).toEqual([{ url: 'https://img', mime: 'image/jpeg' }]);
  });
});
