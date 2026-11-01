import { describe, expect, it } from 'vitest';

import {
  IMAGE_ADAPTERS,
  imageAuthHeaders,
  resolveImageEndpoint,
  type ImageGenInput,
  type ImageProviderInfo,
} from '../src/media';

const p = (o: Partial<ImageProviderInfo>): ImageProviderInfo => ({ id: 'x', urls: {}, ...o });
const pick = (prov: ImageProviderInfo, model: string) => {
  const e = resolveImageEndpoint(prov, model);
  return e ? { adapter: e.adapter.id, baseURL: e.baseURL, wire: e.wire, auth: e.auth } : null;
};
const input = (o: Partial<ImageGenInput> = {}): ImageGenInput => ({
  baseURL: 'https://api.example.com/v1/',
  model: 'm',
  prompt: 'a red fox',
  aspect: '1:1',
  ...o,
});

describe('端点规则：供应商 × 模型 → 适配器 + 地址', () => {
  it('中转站（只有 OpenAI 兼容地址）：兜底走 OpenAI Images', () => {
    const relay = p({ urls: { chat: 'https://amux.ai/v1' } });
    expect(pick(relay, 'openai/gpt-image-2')).toEqual({
      adapter: 'openai-images',
      baseURL: 'https://amux.ai/v1',
      wire: 'chat',
      auth: 'bearer',
    });
  });

  it('中转站开了 Gemini 协议：Gemini 生图模型走原生接口，鉴权跟随探测（Bearer）', () => {
    const relay = p({
      urls: { chat: 'https://amux.ai/v1', gemini: 'https://amux.ai/v1beta' },
      auth: { gemini: 'bearer' },
    });
    expect(pick(relay, 'gemini-2.5-flash-image')).toMatchObject({
      adapter: 'gemini',
      baseURL: 'https://amux.ai/v1beta',
      auth: 'bearer',
    });
    // 没有 Gemini 地址就退回 OpenAI Images
    expect(
      pick(p({ urls: { chat: 'https://amux.ai/v1' } }), 'gemini-2.5-flash-image')?.adapter,
    ).toBe('openai-images');
  });

  it('官方 / 专用接口按供应商限定', () => {
    const google = p({
      presetId: 'gemini',
      urls: {
        chat: 'https://generativelanguage.googleapis.com/v1beta/openai',
        gemini: 'https://generativelanguage.googleapis.com/v1beta',
      },
    });
    expect(pick(google, 'models/imagen-4.0-generate-001')).toMatchObject({
      adapter: 'imagen',
      auth: 'x-goog-api-key',
    });
    expect(pick(google, 'gemini-2.5-flash-image')?.adapter).toBe('gemini');
    const ark = p({ urls: { chat: 'https://ark.cn-beijing.volces.com/api/v3' } });
    expect(pick(ark, 'doubao-seedream-4-0-250828')?.adapter).toBe('ark-image');
    const ds = p({ urls: { chat: 'https://dashscope.aliyuncs.com/compatible-mode/v1' } });
    expect(pick(ds, 'wan2.2-t2i-flash')).toMatchObject({
      adapter: 'dashscope-async',
      baseURL: 'https://dashscope.aliyuncs.com',
    });
    expect(
      pick(p({ urls: { chat: 'https://openrouter.ai/api/v1' } }), 'google/gemini-2.5-flash-image')
        ?.adapter,
    ).toBe('openrouter-chat-image');
    expect(
      pick(p({ presetId: 'fal', urls: { chat: 'https://fal.run' } }), 'fal-ai/flux-pro/v1.1'),
    ).toMatchObject({
      adapter: 'fal',
      auth: 'key',
    });
  });

  it('供应商一个地址都没有：没有端点', () => {
    expect(resolveImageEndpoint(p({}), 'gpt-image-2')).toBeNull();
  });

  it('自定义规则表：新增一家只加规则', () => {
    const e = resolveImageEndpoint(p({ urls: { chat: 'https://my.example/v1' } }), 'x', [
      { adapter: 'fal', host: /my\.example$/ },
    ]);
    expect(e?.adapter.id).toBe('fal');
  });
});

describe('适配器：拼请求 / 解析响应', () => {
  it('openai-images', () => {
    const a = IMAGE_ADAPTERS['openai-images']!;
    expect(a.build(input({ aspect: '3:2' }))).toEqual({
      method: 'POST',
      url: 'https://api.example.com/v1/images/generations',
      body: { model: 'm', prompt: 'a red fox', n: 1, size: '1536x1024' },
    });
    expect((a.build(input({ aspect: 'auto' })).body as { size?: string }).size).toBeUndefined();
    expect(a.parse({ data: [{ b64_json: 'AAA', revised_prompt: 'r' }] }, input())).toEqual({
      kind: 'images',
      images: [{ b64: 'AAA' }],
      revisedPrompt: 'r',
    });
    expect(a.parse({ data: [{ url: 'https://cdn/x.png' }] }, input())).toMatchObject({
      images: [{ url: 'https://cdn/x.png' }],
    });
  });

  it('ark-image：像素尺寸、b64、不加水印', () => {
    const r = IMAGE_ADAPTERS['ark-image']!.build(input({ aspect: '1:1' }));
    expect(r.body).toMatchObject({
      size: '2048x2048',
      response_format: 'b64_json',
      watermark: false,
    });
  });

  it('gemini：generateContent，inlineData 取图', () => {
    const a = IMAGE_ADAPTERS.gemini!;
    const r = a.build(input({ model: 'models/gemini-2.5-flash-image', aspect: '16:9' }));
    expect(r.url).toBe('https://api.example.com/v1/models/gemini-2.5-flash-image:generateContent');
    expect(r.body).toMatchObject({ generationConfig: { imageConfig: { aspectRatio: '16:9' } } });
    expect(
      a.parse(
        {
          candidates: [
            {
              content: {
                parts: [{ text: 'hi' }, { inlineData: { mimeType: 'image/png', data: 'BBB' } }],
              },
            },
          ],
        },
        input(),
      ),
    ).toEqual({ kind: 'images', images: [{ b64: 'BBB', mime: 'image/png' }] });
  });

  it('imagen：predict', () => {
    const a = IMAGE_ADAPTERS.imagen!;
    expect(a.build(input({ model: 'imagen-4.0' })).url).toBe(
      'https://api.example.com/v1/models/imagen-4.0:predict',
    );
    expect(a.parse({ predictions: [{ bytesBase64Encoded: 'CCC' }] }, input())).toEqual({
      kind: 'images',
      images: [{ b64: 'CCC' }],
    });
  });

  it('openrouter-chat-image：data URL', () => {
    const a = IMAGE_ADAPTERS['openrouter-chat-image']!;
    expect(a.build(input()).url).toBe('https://api.example.com/v1/chat/completions');
    expect(
      a.parse(
        {
          choices: [{ message: { images: [{ image_url: { url: 'data:image/png;base64,DDD' } }] } }],
        },
        input(),
      ),
    ).toEqual({ kind: 'images', images: [{ b64: 'DDD', mime: 'image/png' }] });
  });

  it('fal：模型路径即地址', () => {
    const r = IMAGE_ADAPTERS.fal!.build(
      input({ baseURL: 'https://fal.run', model: 'fal-ai/flux-pro/v1.1' }),
    );
    expect(r.url).toBe('https://fal.run/fal-ai/flux-pro/v1.1');
    expect(r.body).toMatchObject({ image_size: 'square_hd', sync_mode: true });
  });

  it('dashscope-async：提交 → 轮询 → 成功 / 失败', () => {
    const a = IMAGE_ADAPTERS['dashscope-async']!;
    const i = input({ baseURL: 'https://dashscope.aliyuncs.com' });
    const r = a.build(i);
    expect(r.url).toBe(
      'https://dashscope.aliyuncs.com/api/v1/services/aigc/text2image/image-synthesis',
    );
    expect(r.headers).toEqual({ 'X-DashScope-Async': 'enable' });
    expect(a.parse({ output: { task_id: 't1', task_status: 'PENDING' } }, i)).toEqual({
      kind: 'poll',
      afterMs: 2000,
      next: { method: 'GET', url: 'https://dashscope.aliyuncs.com/api/v1/tasks/t1' },
    });
    expect(
      a.parse({ output: { task_status: 'SUCCEEDED', results: [{ url: 'https://x/y.png' }] } }, i),
    ).toEqual({
      kind: 'images',
      images: [{ url: 'https://x/y.png' }],
    });
    expect(a.parse({ output: { task_status: 'FAILED', message: 'bad prompt' } }, i)).toEqual({
      kind: 'failed',
      message: 'bad prompt',
    });
  });

  it('改图：OpenAI 走 /images/edits（multipart），Gemini / 方舟 / OpenRouter 带参考图；Imagen / fal / 百炼不支持', () => {
    const refs = [{ mime: 'image/png', b64: 'PNG' }];
    const o = IMAGE_ADAPTERS['openai-images']!.build(input({ refs, aspect: '1:1' }));
    expect(o.url).toBe('https://api.example.com/v1/images/edits');
    expect(o.body).toBeUndefined();
    expect(o.multipart).toEqual({
      fields: { model: 'm', prompt: 'a red fox', n: '1', size: '1024x1024' },
      files: [{ field: 'image[]', name: 'image-0.png', mime: 'image/png', b64: 'PNG' }],
    });
    const g = IMAGE_ADAPTERS.gemini!.build(input({ refs }));
    expect((g.body as { contents: Array<{ parts: unknown[] }> }).contents[0]!.parts).toEqual([
      { inline_data: { mime_type: 'image/png', data: 'PNG' } },
      { text: 'a red fox' },
    ]);
    expect(IMAGE_ADAPTERS['ark-image']!.build(input({ refs })).body).toMatchObject({
      image: ['data:image/png;base64,PNG'],
    });
    const or = IMAGE_ADAPTERS['openrouter-chat-image']!.build(input({ refs })).body as {
      messages: Array<{ content: unknown }>;
    };
    expect(or.messages[0]!.content).toEqual([
      { type: 'text', text: 'a red fox' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,PNG' } },
    ]);
    for (const id of ['openai-images', 'gemini', 'ark-image', 'openrouter-chat-image'])
      expect(IMAGE_ADAPTERS[id]!.edit).toBe(true);
    for (const id of ['imagen', 'fal', 'dashscope-async'])
      expect(IMAGE_ADAPTERS[id]!.edit).toBeFalsy();
  });

  it('鉴权头', () => {
    expect(imageAuthHeaders('bearer', 'k')).toEqual({ Authorization: 'Bearer k' });
    expect(imageAuthHeaders('key', 'k')).toEqual({ Authorization: 'Key k' });
    expect(imageAuthHeaders('x-goog-api-key', 'k')).toEqual({ 'x-goog-api-key': 'k' });
    expect(imageAuthHeaders('bearer', undefined)).toEqual({});
  });
});
