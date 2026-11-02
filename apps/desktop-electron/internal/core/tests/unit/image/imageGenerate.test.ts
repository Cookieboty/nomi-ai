jest.unmock('fs');
jest.unmock('path');

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  createImageTools,
  generateImageAsset,
  imageExt,
  splitImageRef,
  type ImageProviderAccess,
  type ImageToolDeps,
} from '../../../src/image/imageGenerate';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

type Call = { url: string; init?: RequestInit };

function setup(
  over: Partial<ImageToolDeps> = {},
  respond?: (url: string, n: number) => Response,
  provider: Partial<ImageProviderAccess['info']> = {},
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-img-'));
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return respond
      ? respond(url, calls.length)
      : new Response(JSON.stringify({ data: [{ b64_json: PNG.toString('base64') }] }));
  }) as unknown as typeof fetch;
  const access: ImageProviderAccess = {
    info: { id: 'amux', urls: { chat: 'https://api.example.com/v1/' }, ...provider },
    keyFor: (wire) => (wire === 'chat' ? 'sk-chat' : wire === 'gemini' ? 'sk-gem' : undefined),
    headers: { 'X-Extra': '1' },
  };
  const deps: ImageToolDeps = {
    imageRef: () => 'amux/openai/gpt-image-2',
    imageProvider: (id) => (id === 'amux' ? access : null),
    imagesDir: path.join(dir, 'images'),
    fetchImpl,
    sleep: async () => undefined,
    now: () => 1_700_000_000_000,
    ...over,
  };
  const [tool] = createImageTools(deps);
  return { tool: tool!, calls, dir: deps.imagesDir };
}

const headersOf = (c: Call) => c.init!.headers as Record<string, string>;
const bodyOf = (c: Call) => JSON.parse(String(c.init!.body)) as Record<string, unknown>;

describe('image_generate', () => {
  it('没分配图片模型 / 供应商不可用 / 没有端点：不提供给模型', () => {
    expect(setup({ imageRef: () => null }).tool.available!()).toBe(false);
    expect(setup({ imageRef: () => 'gone/gpt-image-2' }).tool.available!()).toBe(false);
    expect(setup({}, undefined, { urls: {} }).tool.available!()).toBe(false);
    expect(setup().tool.available!()).toBe(true);
  });

  it('中转站：经 OpenAI Images 适配器生图，存进 chat/images，只回 chat-asset 地址', async () => {
    const { tool, calls, dir } = setup();
    const out = (await tool.execute({ prompt: 'a red fox', aspect_ratio: '1:1' }, {})) as {
      image: string;
      model: string;
      adapter: string;
    };
    expect(calls[0]!.url).toBe('https://api.example.com/v1/images/generations');
    expect(headersOf(calls[0]!)).toMatchObject({ Authorization: 'Bearer sk-chat', 'X-Extra': '1' });
    expect(bodyOf(calls[0]!)).toEqual({
      model: 'openai/gpt-image-2',
      prompt: 'a red fox',
      n: 1,
      size: '1024x1024',
    });
    expect(out.adapter).toBe('openai-images');
    expect(out.image).toMatch(/^chat-asset:\/\/images\/nomi-[a-z0-9]+-[a-z0-9]+\.png$/);
    expect(JSON.stringify(out)).not.toContain(PNG.toString('base64'));
    const file = path.join(dir, out.image.slice('chat-asset://images/'.length));
    expect(fs.readFileSync(file)).toEqual(PNG);
  });

  it('开了 Gemini 协议的供应商：Gemini 生图模型走原生接口，用 Gemini 协议的 Key', async () => {
    const { tool, calls } = setup(
      { imageRef: () => 'amux/gemini-2.5-flash-image' },
      () =>
        new Response(
          JSON.stringify({
            candidates: [
              { content: { parts: [{ inlineData: { data: PNG.toString('base64') } }] } },
            ],
          }),
        ),
      { urls: { chat: 'https://api.example.com/v1', gemini: 'https://api.example.com/v1beta' } },
    );
    await tool.execute({ prompt: 'x' }, {});
    expect(calls[0]!.url).toBe(
      'https://api.example.com/v1beta/models/gemini-2.5-flash-image:generateContent',
    );
    expect(headersOf(calls[0]!)['x-goog-api-key']).toBe('sk-gem');
  });

  it('异步任务型接口：提交后轮询到完成，再下载结果图', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-img-'));
    const seen: string[] = [];
    const fetchImpl = (async (url: string) => {
      seen.push(url);
      if (url.endsWith('/image-synthesis'))
        return new Response(JSON.stringify({ output: { task_id: 't1', task_status: 'PENDING' } }));
      if (url.endsWith('/tasks/t1') && seen.filter((u) => u.endsWith('/tasks/t1')).length < 2)
        return new Response(JSON.stringify({ output: { task_status: 'RUNNING', task_id: 't1' } }));
      if (url.endsWith('/tasks/t1'))
        return new Response(
          JSON.stringify({
            output: { task_status: 'SUCCEEDED', results: [{ url: 'http://127.0.0.1/a.png' }] },
          }),
        );
      return new Response(PNG);
    }) as unknown as typeof fetch;
    const [ds] = createImageTools({
      imageRef: () => 'ds/wan2.2-t2i-flash',
      imageProvider: () => ({
        info: { id: 'ds', urls: { chat: 'https://dashscope.aliyuncs.com/compatible-mode/v1' } },
        keyFor: () => 'sk-ds',
      }),
      imagesDir: dir,
      fetchImpl,
      sleep: async () => undefined,
    });
    // 结果是内网地址：轮询完成后拒绝下载（防 SSRF）
    await expect(ds!.execute({ prompt: 'x' }, {})).rejects.toThrow();
    expect(seen).toEqual([
      'https://dashscope.aliyuncs.com/api/v1/services/aigc/text2image/image-synthesis',
      'https://dashscope.aliyuncs.com/api/v1/tasks/t1',
      'https://dashscope.aliyuncs.com/api/v1/tasks/t1',
    ]);
  });

  it('对话停止：请求带上 signal，轮询中途中止后不再请求、不落盘', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-img-'));
    const ac = new AbortController();
    const seen: Array<{ url: string; signal?: AbortSignal | null }> = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      seen.push({ url, signal: init?.signal });
      return new Response(JSON.stringify({ output: { task_id: 't1', task_status: 'PENDING' } }));
    }) as unknown as typeof fetch;
    const [ds] = createImageTools({
      imageRef: () => 'ds/wan2.2-t2i-flash',
      imageProvider: () => ({
        info: { id: 'ds', urls: { chat: 'https://dashscope.aliyuncs.com/compatible-mode/v1' } },
        keyFor: () => 'sk-ds',
      }),
      imagesDir: path.join(dir, 'images'),
      fetchImpl,
      // 第一次等待期间用户点了停止
      sleep: async () => ac.abort(),
    });
    await expect(ds!.execute({ prompt: 'x' }, { signal: ac.signal })).rejects.toThrow();
    expect(seen).toHaveLength(1);
    expect(seen[0]!.signal).toBe(ac.signal);
    expect(fs.existsSync(path.join(dir, 'images'))).toBe(false);
  });

  it('指定了模型（重新生成）：原模型不可用就报错，不改用当前图片模型（#224）', async () => {
    const generated: unknown[] = [];
    const { calls, dir } = setup();
    const deps = (current: string): ImageToolDeps => ({
      imageRef: () => current,
      imageProvider: (id) =>
        id === 'amux' || id === 'other'
          ? { info: { id, urls: { chat: `https://${id}.example.com/v1/` } }, keyFor: () => 'k' }
          : null,
      imagesDir: dir,
      fetchImpl: (async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        return new Response(JSON.stringify({ data: [{ b64_json: PNG.toString('base64') }] }));
      }) as unknown as typeof fetch,
      onGenerated: (_f, m) => generated.push(m),
    });
    // 原供应商没了、当前模型可用：报错，不发请求、不记素材
    await expect(
      generateImageAsset(deps('other/openai/gpt-image-2'), {
        prompt: 'a fox',
        modelRef: 'gone/gpt-image-2',
      }),
    ).rejects.toThrow(/regenerate-model-unavailable/);
    expect(calls).toHaveLength(0);
    expect(generated).toHaveLength(0);
    // 原模型还在、当前默认已换：仍用原模型
    const r = await generateImageAsset(deps('other/openai/gpt-image-2'), {
      prompt: 'a fox',
      modelRef: 'amux/openai/gpt-image-2',
    });
    expect(r.provider).toBe('amux');
    expect(calls[0]!.url).toContain('amux.example.com');
    // 没指定模型：照旧用当前图片模型
    const r2 = await generateImageAsset(deps('other/openai/gpt-image-2'), { prompt: 'a fox' });
    expect(r2.provider).toBe('other');
  });

  it('接口报错：带上状态码与上游的错误信息', async () => {
    const { tool } = setup(
      {},
      () => new Response(JSON.stringify({ error: { message: 'quota exceeded' } }), { status: 429 }),
    );
    await expect(tool.execute({ prompt: 'x' }, {})).rejects.toThrow(/429.*quota exceeded/);
  });

  it('改图：原图从素材库读出来，走 /images/edits（multipart），结果记下改自哪张', async () => {
    const generated: Array<[string, unknown]> = [];
    const { tool, calls, dir } = setup({ onGenerated: (f, m) => generated.push([f, m]) });
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'nomi-src.png'), PNG);
    const out = (await tool.execute(
      { prompt: 'make it blue', edit_image: 'chat-asset://images/nomi-src.png' },
      { conversationId: 'c1' },
    )) as { mode: string };
    expect(out.mode).toBe('edit');
    expect(calls[0]!.url).toBe('https://api.example.com/v1/images/edits');
    const form = calls[0]!.init!.body as FormData;
    expect(form.get('prompt')).toBe('make it blue');
    expect((form.getAll('image[]')[0] as Blob).size).toBe(PNG.length);
    expect(generated[0]![1]).toMatchObject({
      prompt: 'make it blue',
      editedFrom: 'nomi-src.png',
      conversationId: 'c1',
    });
  });

  it('参考图生成：最多 4 张参考图，结果记下参考了哪几张', async () => {
    const generated: Array<[string, unknown]> = [];
    const { tool, calls, dir } = setup({ onGenerated: (f, m) => generated.push([f, m]) });
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'nomi-a.png'), PNG);
    fs.writeFileSync(path.join(dir, 'grok-b.jpg'), PNG);
    const out = (await tool.execute(
      {
        prompt: 'same style, a dog',
        reference_images: ['chat-asset://images/nomi-a.png', 'grok-b.jpg'],
      },
      {},
    )) as { mode: string };
    expect(out.mode).toBe('reference');
    expect((calls[0]!.init!.body as FormData).getAll('image[]')).toHaveLength(2);
    expect(generated[0]![1]).toMatchObject({ references: ['nomi-a.png', 'grok-b.jpg'] });
  });

  it('带图：素材库以外的路径拒绝；不支持带图的适配器明确报错', async () => {
    const { tool } = setup();
    await expect(
      tool.execute({ prompt: 'x', edit_image: '../../etc/passwd' }, {}),
    ).rejects.toThrow();
    await expect(
      tool.execute({ prompt: 'x', edit_image: 'nomi-missing.png' }, {}),
    ).rejects.toThrow();
    const ds = setup({ imageRef: () => 'amux/wan2.2-t2i-flash' }, undefined, {
      urls: { chat: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
    });
    fs.mkdirSync(ds.dir, { recursive: true });
    fs.writeFileSync(path.join(ds.dir, 'nomi-a.png'), PNG);
    await expect(ds.tool.execute({ prompt: 'x', edit_image: 'nomi-a.png' }, {})).rejects.toThrow(
      /wan2\.2-t2i-flash/,
    );
  });

  it('辅助函数', () => {
    expect(splitImageRef('amux/openai/gpt-image-2')).toEqual({
      provider: 'amux',
      model: 'openai/gpt-image-2',
    });
    expect(splitImageRef('noslash')).toBeNull();
    expect(imageExt(new Uint8Array([0xff, 0xd8, 0]))).toBe('jpg');
    expect(imageExt(new Uint8Array([0x52, 0x49, 0x46, 0x46]))).toBe('webp');
    expect(imageExt(PNG)).toBe('png');
  });
});
