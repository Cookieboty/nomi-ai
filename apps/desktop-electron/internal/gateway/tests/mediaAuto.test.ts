import { describe, expect, it } from 'vitest';

import { autoImageModel, isImageModelId, type AutoImageProvider } from '../src/media';

const relay = (id: string, models: string[], gemini = false): AutoImageProvider => ({
  info: {
    id,
    urls: {
      chat: `https://${id}.example/v1`,
      ...(gemini ? { gemini: `https://${id}.example/v1beta` } : {}),
    },
  },
  models: models.map((m) => ({ id: m })),
});

describe('图片模型自动匹配', () => {
  const amux = relay(
    'amux',
    [
      'openai/gpt-6-astra',
      'google/gemini-3-pro',
      'openai/gpt-image-2',
      'openai/gpt-image-2.5-flare',
      'google/gemini-3-pro-image',
      'anthropic/claude-fable-5',
    ],
    true,
  );

  it('与对话模型同一家族：gpt → gpt-image（取最新），gemini → Gemini 生图', () => {
    expect(autoImageModel('amux/openai/gpt-6-astra', [amux])).toBe(
      'amux/openai/gpt-image-2.5-flare',
    );
    expect(autoImageModel('amux/google/gemini-3-pro', [amux])).toBe(
      'amux/google/gemini-3-pro-image',
    );
  });

  it('没有同家族的（如 Claude）：按 gpt → gemini 顺次', () => {
    expect(autoImageModel('amux/anthropic/claude-fable-5', [amux])).toBe(
      'amux/openai/gpt-image-2.5-flare',
    );
    const onlyGemini = relay('g', ['claude-x', 'gemini-2.5-flash-image'], true);
    expect(autoImageModel('g/claude-x', [onlyGemini])).toBe('g/gemini-2.5-flash-image');
  });

  it('同家族在别的供应商：对话模型所在的供应商优先，没有再找别家', () => {
    const a = relay('a', ['gpt-6-sol']);
    const b = relay('b', ['gpt-image-2']);
    const c = relay('c', ['gpt-image-1']);
    expect(autoImageModel('a/gpt-6-sol', [a, c, b])).toBe('c/gpt-image-1');
    const own = relay('a', ['gpt-6-sol', 'gpt-image-1']);
    expect(autoImageModel('a/gpt-6-sol', [b, own])).toBe('a/gpt-image-1');
  });

  it('没有图片模型 / 端点处理不了：null', () => {
    expect(autoImageModel('amux/openai/gpt-6-astra', [relay('x', ['gpt-6-sol'])])).toBeNull();
    // 只有 Gemini 生图模型、供应商没有 Gemini 也没有 OpenAI 兼容地址
    const bare: AutoImageProvider = {
      info: { id: 'n', urls: {} },
      models: [{ id: 'gpt-image-2' }],
    };
    expect(autoImageModel('n/gpt-6', [bare])).toBeNull();
    expect(autoImageModel(null, [amux])).toBe('amux/openai/gpt-image-2.5-flare');
  });

  it('识别与视图同规则', () => {
    for (const id of [
      'gpt-image-2',
      'dall-e-3',
      'gemini-2.5-flash-image',
      'doubao-seedream-4-0',
      'qwen-image',
    ])
      expect(isImageModelId(id)).toBe(true);
    for (const id of ['gpt-6-astra', 'gemini-3-flash-preview', 'imagine-chat'])
      expect(isImageModelId(id)).toBe(false);
  });
});
