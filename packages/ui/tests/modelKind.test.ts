import { describe, expect, it } from 'vitest';

import { isImageModel } from '../src/modelKind';

describe('isImageModel', () => {
  it.each([
    'gpt-image-2',
    'openai/gpt-image-2.5-flare',
    'amux/openai/gpt-image-2.5-sunburst',
    'dall-e-3',
    'imagen-4.0-generate',
    'black-forest-labs/flux-1.1-pro',
    'gemini-2.5-flash-image',
    'qwen-image',
    'hunyuan-image-3',
    'doubao-seedream-4-0',
    'stable-diffusion-xl',
    'midjourney',
  ])('生图模型：%s', (id) => expect(isImageModel(id)).toBe(true));

  it.each([
    'gpt-6-astra',
    'openai/gpt-6.1-sol',
    'anthropic/claude-fable-5',
    'gemini-3-flash-preview',
    'qwen3-vl-plus',
    'glm-5v',
    'imagine-chat', // 只是名字像
    'deepseek-v4',
  ])('对话模型：%s', (id) => expect(isImageModel(id)).toBe(false));
});
