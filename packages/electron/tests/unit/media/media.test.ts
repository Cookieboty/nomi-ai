// 需要真实文件系统
jest.unmock('fs');
jest.unmock('path');

import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { AssetLibrary, sha256 } from '../../../src/media/assets';
import { MediaService } from '../../../src/media/MediaService';
import { MediaConfigStore } from '../../../src/media/store';

import { fakeProviders } from './fakeProviders';

const PNG = (seed: number) =>
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from([seed, 1, 2, 3]),
  ]);
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 9, 9]);

const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'media-'));
const logger = { info: jest.fn(), warn: jest.fn() };

describe('AssetLibrary sha256 去重', () => {
  it('同一张图只存一份，来源逐条记录', () => {
    const lib = new AssetLibrary(tmp());
    const a = lib.add({ data: PNG(1), source: 'chat_generated', inLibrary: true });
    const b = lib.add({ data: PNG(1), mime: 'image/png', source: 'studio', inLibrary: false });
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.asset.id).toBe(a.asset.id);
    expect(a.asset.sha256).toBe(sha256(PNG(1)));
    expect(lib.list()).toHaveLength(1);
    expect(lib.view(b.asset).sources).toEqual(['chat_generated', 'studio']);
    // 已在库中的不会被 inLibrary:false 移出
    expect(b.asset.inLibrary).toBe(true);
  });

  it('按文件头嗅探类型，拒绝非图片', () => {
    const lib = new AssetLibrary(tmp());
    expect(
      lib.add({ data: JPG, mime: 'image/png', source: 'manual_add', inLibrary: true }).asset.ext,
    ).toBe('jpg');
    expect(() =>
      lib.add({ data: Buffer.from('hello'), source: 'manual_add', inLibrary: true }),
    ).toThrow();
  });

  it('索引持久化并可重新加载；移出素材库保留文件', () => {
    const root = tmp();
    const lib = new AssetLibrary(root);
    const { asset } = lib.add({
      data: PNG(2),
      source: 'chat_reply',
      inLibrary: true,
      originUrl: 'https://x/y.png',
    });
    lib.setInLibrary(asset.id, false);
    const again = new AssetLibrary(root);
    expect(again.get(asset.id)?.inLibrary).toBe(false);
    expect(again.byOriginUrl('https://x/y.png')?.id).toBe(asset.id);
    expect(readFileSync(again.filePath(asset)).equals(PNG(2))).toBe(true);
    expect(again.list()).toHaveLength(0);
    expect(again.list({ inLibraryOnly: false })).toHaveLength(1);
  });
});

describe('MediaConfigStore（复用第三方供应商）', () => {
  it('图片模型按规则从供应商模型列表识别；没有 Key 的供应商不可用；配置文件不含 Key', () => {
    const root = tmp();
    const src = fakeProviders();
    const s = new MediaConfigStore(root, src);
    expect(s.bindings().map((b) => `${b.providerRef}:${b.modelId}:${b.presetKey}`)).toEqual([
      'openai:gpt-image-1:openai-images',
      'openrouter:gemini-2.5-flash-image:openrouter-chat-image',
      'google:gemini-2.5-flash-image:gemini',
      'volc:seedream-4:ark-image',
      'fal:flux-1.1-pro:fal',
      'fal:seedream-4:fal',
    ]);
    expect(s.prefs().chatDefaultImage).toBeNull();
    expect(() => s.setChatDefault({ modelId: 'gpt-image-1', providerRef: 'openai' })).toThrow();
    src.key('openai', 'sk-secret-1234');
    s.setChatDefault({ modelId: 'gpt-image-1', providerRef: 'openai' });
    expect(s.providers().find((p) => p.id === 'openai')).toEqual({
      id: 'openai',
      name: 'OpenAI',
      presetId: 'openai',
      enabled: true,
      hasKey: true,
    });
    expect(readFileSync(path.join(root, 'config.json'), 'utf8')).not.toContain('sk-secret');
    expect(s.endpoint({ modelId: 'gpt-image-1', providerRef: 'openai' })).toMatchObject({
      baseURL: 'https://api.openai.com/v1',
      apiKey: 'sk-secret-1234',
    });
    // Gemini 原生接口地址从 OpenAI 兼容地址推出
    src.key('google', 'g');
    expect(s.endpoint({ modelId: 'gemini-2.5-flash-image', providerRef: 'google' })?.baseURL).toBe(
      'https://generativelanguage.googleapis.com/v1beta',
    );
  });

  it('入库开关默认：生成图开、上传图关', () => {
    const s = new MediaConfigStore(tmp(), fakeProviders());
    expect(s.prefs().autoAddGenerated).toBe(true);
    expect(s.prefs().autoAddUploads).toBe(false);
  });

  it('默认供应商停用 → 自动切到同模型另一家已启用的供应商', () => {
    const src = fakeProviders();
    const s = new MediaConfigStore(tmp(), src);
    src.key('openrouter', 'k1');
    src.key('google', 'k2');
    s.setChatDefault({ modelId: 'gemini-2.5-flash-image', providerRef: 'openrouter' });
    src.set('openrouter', { enabled: false });
    expect(s.providersChanged()).toEqual([
      {
        target: 'chat',
        kind: 'switched',
        from: { modelId: 'gemini-2.5-flash-image', providerRef: 'openrouter' },
        to: { modelId: 'gemini-2.5-flash-image', providerRef: 'google' },
      },
    ]);
    expect(s.prefs().chatDefaultImage).toEqual({
      modelId: 'gemini-2.5-flash-image',
      providerRef: 'google',
    });
  });

  it('模型在供应商里被停用 / 标为非图片 → 同模型无其他可用供应商时清空，不跨模型兜底', () => {
    const src = fakeProviders();
    const s = new MediaConfigStore(tmp(), src);
    src.key('openai', 'k');
    src.key('google', 'k2'); // 别的模型可用，也不能兜底过去
    s.setChatDefault({ modelId: 'gpt-image-1', providerRef: 'openai' });
    const changes = s.markImage({ providerRef: 'openai', upstream: 'gpt-image-1', modelId: null });
    expect(changes[0]).toMatchObject({ target: 'chat', kind: 'cleared' });
    expect(s.prefs().chatDefaultImage).toBeNull();
    // 清除标记 → 回到自动识别
    s.markImage({ providerRef: 'openai', upstream: 'gpt-image-1' });
    expect(s.isUsable({ modelId: 'gpt-image-1', providerRef: 'openai' })).toBe(true);
    src.set('openai', { models: [{ id: 'gpt-image-1', enabled: false }] });
    expect(s.isUsable({ modelId: 'gpt-image-1', providerRef: 'openai' })).toBe(false);
  });

  it('清除 Key 同样触发校正；损坏的配置文件回落到默认', () => {
    const root = tmp();
    const src = fakeProviders();
    const s = new MediaConfigStore(root, src);
    src.key('volc', 'k');
    s.setChatDefault({ modelId: 'seedream-4', providerRef: 'volc' });
    src.key('fal', 'k');
    src.key('volc', '');
    expect(s.providersChanged()[0]).toMatchObject({ kind: 'switched', to: { providerRef: 'fal' } });
    require('node:fs').writeFileSync(path.join(root, 'config.json'), '{oops');
    expect(new MediaConfigStore(root, src).prefs().chatDefaultImage).toBeNull();
  });

  it('规则没覆盖的供应商（自建中转）：在模型行上手动标记为图片模型，删除供应商后校正', () => {
    const src = fakeProviders();
    src.add(
      {
        id: 'proxy',
        name: 'My Proxy',
        enabled: true,
        hasKey: true,
        urls: { chat: 'https://proxy.example/v1' },
        models: [{ id: 'my-image-model', enabled: true }],
      },
      'k',
    );
    const s = new MediaConfigStore(tmp(), src);
    expect(s.bindings().some((b) => b.providerRef === 'proxy')).toBe(false);
    expect(() =>
      s.markImage({ providerRef: 'proxy', upstream: 'my-image-model', modelId: 'nope' }),
    ).toThrow();
    s.markImage({ providerRef: 'proxy', upstream: 'my-image-model', modelId: 'gpt-image-1' });
    expect(s.binding({ modelId: 'gpt-image-1', providerRef: 'proxy' })).toMatchObject({
      presetKey: 'openai-images',
      upstreamModelName: 'my-image-model',
    });
    s.setChatDefault({ modelId: 'gpt-image-1', providerRef: 'proxy' });
    src.set('proxy', { enabled: false });
    expect(s.providersChanged()[0]).toMatchObject({ kind: 'cleared' });
  });
});

function okJson(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function makeService(over: Partial<ConstructorParameters<typeof MediaService>[0]> = {}) {
  const src = fakeProviders();
  const fetchMock = jest.fn(async (_url: string, _init?: RequestInit) =>
    okJson({ data: [{ b64_json: PNG(7).toString('base64') }] }),
  );
  const events: Array<[string, unknown]> = [];
  const svc = new MediaService({
    root: tmp(),
    logger,
    providers: src,
    fetch: fetchMock as never,
    broadcast: (c, p) => events.push([c, p]),
    ...over,
  });
  /** 在共用供应商配置里填 Key，并像网关广播那样通知生图 */
  const key = (id: string, k: string) => {
    src.key(id, k);
    svc.providersChanged();
  };
  const disable = (id: string) => {
    src.set(id, { enabled: false });
    svc.providersChanged();
  };
  return { svc, fetchMock, events, src, key, disable };
}

describe('MediaService', () => {
  it('未配置：generate_image 工具返回 not_configured，不发任何请求', async () => {
    const { svc, fetchMock } = makeService();
    const tool = svc.tools()[0] as unknown as {
      execute: (i: unknown, c: unknown) => Promise<unknown>;
    };
    const r = (await tool.execute({ prompt: 'a cat' }, {})) as {
      ok: boolean;
      error: { code: string };
    };
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('not_configured');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('对话生图：Key 只放在请求头，结果写入素材库（生成图开关默认开）', async () => {
    const { svc, fetchMock, events, key } = makeService();
    key('openai', 'sk-abc');
    svc.setChatDefault({ modelId: 'gpt-image-1', providerRef: 'openai' });
    const tool = svc.tools()[0] as unknown as {
      execute: (i: unknown, c: unknown) => Promise<unknown>;
    };
    const r = (await tool.execute(
      { prompt: 'a cat', aspect_ratio: '16:9', n: 99 },
      { conversationId: 'c1' },
    )) as {
      ok: boolean;
      data: { images: Array<{ url: string; inLibrary: boolean }>; params: Record<string, unknown> };
    };
    expect(r.ok).toBe(true);
    expect(r.data.images[0].url).toMatch(/^chat-asset:\/\/media\/[a-f0-9]{64}\.png$/);
    expect(r.data.images[0].inLibrary).toBe(true);
    expect(Number(r.data.params.n)).toBeLessThanOrEqual(10); // 被 schema 夹到上限
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/images/generations');
    expect(
      (init!.headers as Record<string, string>).authorization ??
        (init!.headers as Record<string, string>).Authorization,
    ).toBe('Bearer sk-abc');
    expect(svc.listAssets()).toHaveLength(1);
    expect(svc.listAssets()[0].sources).toEqual(['chat_generated']);
    expect(
      events.some(
        ([c, p]) => c === 'ai:media:task' && (p as { status: string }).status === 'succeeded',
      ),
    ).toBe(true);
  });

  it('生成图开关关闭：图片仍可显示，但不进素材库', async () => {
    const { svc, key } = makeService();
    key('openai', 'k');
    svc.setPrefs({ autoAddGenerated: false });
    const task = await svc.generate({
      modelId: 'gpt-image-1',
      providerRef: 'openai',
      prompt: 'x',
      surface: 'studio',
    });
    expect(task.status).toBe('succeeded');
    expect(task.assets[0].inLibrary).toBe(false);
    expect(svc.listAssets()).toHaveLength(0);
    // 工作台记住上次选择
    expect(svc.config.prefs().studioLast).toMatchObject({
      modelId: 'gpt-image-1',
      providerRef: 'openai',
    });
  });

  it('上传图开关：默认关不落盘，打开后入库并记 chat_upload', () => {
    const { svc } = makeService();
    const img = { mime: 'image/png', data: PNG(3).toString('base64') };
    expect(svc.ingestUploads([img], 'c1')).toBe(0);
    expect(svc.assets.list({ inLibraryOnly: false })).toHaveLength(0);
    svc.setPrefs({ autoAddUploads: true });
    expect(svc.ingestUploads([img, img], 'c1')).toBe(2);
    const all = svc.listAssets();
    expect(all).toHaveLength(1); // 同图去重
    expect(all[0].sources).toEqual(['chat_upload']);
  });

  it('右键加入素材库：data URL 入库，lookup 可识别已在库中；重复加入不新增', async () => {
    const { svc } = makeService();
    const src = `data:image/png;base64,${PNG(4).toString('base64')}`;
    expect(await svc.lookup(src)).toBeNull();
    const a = await svc.addFromSrc(src, 'chat_upload', 'c1');
    expect(a.inLibrary).toBe(true);
    expect((await svc.lookup(src))?.id).toBe(a.id);
    expect((await svc.lookup(a.url))?.id).toBe(a.id);
    await svc.addFromSrc(src, 'chat_upload');
    expect(svc.listAssets()).toHaveLength(1);
    svc.setInLibrary(a.id, false);
    expect((await svc.lookup(src))?.inLibrary).toBe(false);
  });

  it('远程图片右键入库：下载一次并记住原始地址', async () => {
    const fetchMock = jest.fn(
      async () => new Response(new Uint8Array(JPG), { headers: { 'content-type': 'image/jpeg' } }),
    );
    const { svc } = makeService({ fetch: fetchMock as never });
    const a = await svc.addFromSrc('https://img.example/a.jpg', 'chat_reply');
    expect(a.ext).toBe('jpg');
    expect((await svc.lookup('https://img.example/a.jpg'))?.id).toBe(a.id);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('仅本地模型开启时拒绝云端生图', async () => {
    const { svc, fetchMock, key } = makeService({ localOnly: () => true });
    key('openai', 'k');
    const task = await svc.generate({
      modelId: 'gpt-image-1',
      providerRef: 'openai',
      prompt: 'x',
      surface: 'studio',
    });
    expect(task.status).toBe('failed');
    expect(task.error?.code).toBe('local_only');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('上游报错：保留错误信息，401 归为 auth', async () => {
    const fetchMock = jest.fn(
      async () => new Response(JSON.stringify({ error: { message: 'bad key' } }), { status: 401 }),
    );
    const { svc, key } = makeService({ fetch: fetchMock as never });
    key('openai', 'k');
    const task = await svc.generate({
      modelId: 'gpt-image-1',
      providerRef: 'openai',
      prompt: 'x',
      surface: 'studio',
    });
    expect(task.error).toEqual({ code: 'auth', message: 'bad key' });
  });

  it('url 结果会被下载后入库（fal）', async () => {
    const fetchMock = jest.fn(async (url: string) =>
      url.startsWith('https://fal.run')
        ? okJson({ images: [{ url: 'https://cdn.fal/x.png' }] })
        : new Response(new Uint8Array(PNG(9)), { headers: { 'content-type': 'image/png' } }),
    );
    const { svc, key } = makeService({ fetch: fetchMock as never });
    key('fal', 'k');
    const task = await svc.generate({
      modelId: 'flux-1.1-pro',
      providerRef: 'fal',
      prompt: 'x',
      surface: 'studio',
    });
    expect(task.status).toBe('succeeded');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('停用默认供应商时广播 notice（渲染层据此 toast）', () => {
    const { svc, events, key, disable } = makeService();
    key('volc', 'k');
    key('fal', 'k');
    svc.setChatDefault({ modelId: 'seedream-4', providerRef: 'volc' });
    disable('volc');
    const notice = events.find(([c]) => c === 'ai:media:notice');
    expect(notice?.[1]).toMatchObject({ kind: 'switched', to: { providerRef: 'fal' } });
  });
  it('素材库批量删除：索引与文件一起删掉，不留孤儿文件', async () => {
    const { svc, events } = makeService();
    const a = await svc.addFromSrc(
      `data:image/png;base64,${PNG(11).toString('base64')}`,
      'manual_add',
    );
    const b = await svc.addFromSrc(
      `data:image/png;base64,${PNG(12).toString('base64')}`,
      'manual_add',
    );
    const fa = svc.assets.filePath(svc.assets.get(a.id)!);
    expect(existsSync(fa)).toBe(true);
    expect(svc.deleteAssets([a.id, 'missing'])).toBe(1);
    expect(existsSync(fa)).toBe(false);
    expect(svc.listAssets().map((x) => x.id)).toEqual([b.id]);
    expect(svc.assets.get(a.id)).toBeUndefined();
    expect(events.some(([c]) => c === 'ai:media:changed')).toBe(true);
  });

  it('素材库批量导出：原图字节写入目标目录，同名不覆盖', async () => {
    const { svc } = makeService();
    const a = await svc.addFromSrc(
      `data:image/png;base64,${PNG(21).toString('base64')}`,
      'manual_add',
    );
    const dir = tmp();
    expect(svc.exportAssets([a.id, 'missing'], dir)).toBe(1);
    expect(svc.exportAssets([a.id], dir)).toBe(1);
    const files = readdirSync(dir).sort();
    expect(files).toHaveLength(2);
    expect(readFileSync(path.join(dir, files[0])).equals(PNG(21))).toBe(true);
  });

  it('会话临时换模型：只影响该会话，不改设置里的默认；新会话仍用默认', async () => {
    const { svc, fetchMock, key } = makeService();
    key('openai', 'k1');
    key('volc', 'k2');
    svc.setChatDefault({ modelId: 'gpt-image-1', providerRef: 'openai' });
    const before = JSON.stringify(svc.state().prefs);
    const r = svc.setSessionChoice('c1', { modelId: 'seedream-4', providerRef: 'volc' });
    expect(r).toEqual({ choice: { modelId: 'seedream-4', providerRef: 'volc' }, override: true });
    expect(JSON.stringify(svc.state().prefs)).toBe(before);
    expect(svc.sessionChoice('c2')).toMatchObject({
      override: false,
      choice: { providerRef: 'openai' },
    });
    const tool = svc.tools()[0] as unknown as {
      execute: (i: unknown, c: unknown) => Promise<{ data: { providerRef: string } }>;
    };
    fetchMock.mockImplementation(async () =>
      okJson({ data: [{ b64_json: PNG(31).toString('base64') }] }),
    );
    expect((await tool.execute({ prompt: 'x' }, { conversationId: 'c1' })).data.providerRef).toBe(
      'volc',
    );
    expect((await tool.execute({ prompt: 'y' }, { conversationId: 'c2' })).data.providerRef).toBe(
      'openai',
    );
    // 清除覆盖后回到默认
    expect(svc.setSessionChoice('c1', null).override).toBe(false);
  });

  it('会话临时换模型：新会话（尚无 id）先记为待定，首次生图时归属该会话；不可用组合被拒', async () => {
    const { svc, key, disable } = makeService();
    key('openai', 'k1');
    key('volc', 'k2');
    svc.setChatDefault({ modelId: 'gpt-image-1', providerRef: 'openai' });
    expect(() =>
      svc.setSessionChoice('c1', { modelId: 'gpt-image-1', providerRef: 'fal' }),
    ).toThrow();
    svc.setSessionChoice(undefined, { modelId: 'seedream-4', providerRef: 'volc' });
    const tool = svc.tools()[0] as unknown as {
      execute: (i: unknown, c: unknown) => Promise<{ data: { providerRef: string } }>;
    };
    expect((await tool.execute({ prompt: 'x' }, { conversationId: 'new1' })).data.providerRef).toBe(
      'volc',
    );
    expect(svc.sessionChoice('new1').override).toBe(true);
    expect(svc.sessionChoice(undefined).override).toBe(false);
    // 覆盖的供应商被停用 → 自动回落到默认
    disable('volc');
    expect(svc.sessionChoice('new1')).toMatchObject({
      override: false,
      choice: { providerRef: 'openai' },
    });
  });
});

describe('MediaService 生成队列', () => {
  /** 可手动放行的 fetch：每次调用挂起，release() 依次返回不同的图 */
  function gatedFetch() {
    const pending: Array<() => void> = [];
    let seed = 20;
    const fetchMock = jest.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((resolve, reject) => {
          const s = seed++;
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
          pending.push(() =>
            resolve(
              _url.includes('generateContent')
                ? okJson({
                    candidates: [
                      {
                        content: {
                          parts: [
                            {
                              inlineData: {
                                mimeType: 'image/png',
                                data: PNG(s).toString('base64'),
                              },
                            },
                          ],
                        },
                      },
                    ],
                  })
                : okJson({ data: [{ b64_json: PNG(s).toString('base64') }] }),
            ),
          );
        }),
    );
    const flush = () => new Promise((r) => setTimeout(r, 0));
    return { fetchMock, pending, flush };
  }
  const req = (prompt: string) =>
    ({ modelId: 'gpt-image-1', providerRef: 'openai', prompt, surface: 'studio' }) as const;

  it('每个供应商最多 2 个并发，其余排队，空出名额后依次开始', async () => {
    const { fetchMock, pending, flush } = gatedFetch();
    const { svc, key } = makeService({ fetch: fetchMock as never });
    key('openai', 'k');
    const tasks = [svc.start(req('a')), svc.start(req('b')), svc.start(req('c'))];
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(svc.inFlight('openai')).toBe(2);
    expect(tasks.map((t) => t.status)).toEqual(['running', 'running', 'queued']);
    pending.shift()!();
    await svc.wait(tasks[0].id);
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(tasks[2].status).toBe('running');
    pending.splice(0).forEach((go) => go());
    await Promise.all(tasks.map((t) => svc.wait(t.id)));
    expect(tasks.map((t) => t.status)).toEqual(['succeeded', 'succeeded', 'succeeded']);
    expect(svc.inFlight('openai')).toBe(0);
  });

  it('不同供应商各自计数，互不占名额', async () => {
    const { fetchMock, flush } = gatedFetch();
    const { svc, key } = makeService({ fetch: fetchMock as never });
    key('openai', 'k');
    key('google', 'g');
    svc.start(req('a'));
    svc.start(req('b'));
    svc.start({ ...req('c'), modelId: 'gemini-2.5-flash-image', providerRef: 'google' });
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('取消排队中的任务：不发请求、标记 canceled；可重试并重新排队', async () => {
    const { fetchMock, pending, flush } = gatedFetch();
    const { svc, key } = makeService({ fetch: fetchMock as never });
    key('openai', 'k');
    svc.start(req('a'));
    svc.start(req('b'));
    const queued = svc.start(req('c'));
    await flush();
    expect(svc.cancel(queued.id)).toBe(true);
    const done = await svc.wait(queued.id);
    expect(done.status).toBe('failed');
    expect(done.error?.code).toBe('canceled');
    expect(svc.cancel(queued.id)).toBe(false);
    pending.splice(0).forEach((go) => go());
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const again = svc.retry(queued.id);
    expect(again.id).not.toBe(queued.id);
    expect(again.prompt).toBe('c');
    await flush();
    pending.splice(0).forEach((go) => go());
    expect((await svc.wait(again.id)).status).toBe('succeeded');
    expect(() => svc.retry(again.id)).toThrow();
  });

  it('取消生成中的任务会中止请求并释放名额', async () => {
    const { fetchMock, flush } = gatedFetch();
    const { svc, key } = makeService({ fetch: fetchMock as never });
    key('openai', 'k');
    const t = svc.start(req('a'));
    await flush();
    svc.cancel(t.id);
    expect((await svc.wait(t.id)).error?.code).toBe('canceled');
    expect(svc.inFlight('openai')).toBe(0);
  });

  it('失败任务重试：沿用原模型、供应商与参数', async () => {
    let calls = 0;
    const fetchMock = jest.fn(async () =>
      ++calls === 1
        ? new Response(JSON.stringify({ error: { message: 'busy' } }), { status: 500 })
        : okJson({ data: [{ b64_json: PNG(3).toString('base64') }] }),
    );
    const { svc, key } = makeService({ fetch: fetchMock as never });
    key('openai', 'k');
    const failed = await svc.generate({ ...req('x'), params: { aspect_ratio: '16:9' } });
    expect(failed.error).toEqual({ code: 'upstream', message: 'busy' });
    const again = await svc.wait(svc.retry(failed.id).id);
    expect(again.status).toBe('succeeded');
    expect(again.params).toEqual(failed.params);
  });

  it('协议一次只出 1 张（Gemini）：n=3 拆成 3 次请求，合并结果并报告进度', async () => {
    const { fetchMock, pending, flush } = gatedFetch();
    // 事件里是同一个任务对象，按当时状态拍快照
    const events: unknown[] = [];
    const { svc, key } = makeService({
      fetch: fetchMock as never,
      broadcast: (c, p) => c === 'ai:media:task' && events.push(structuredClone(p)),
    });
    key('google', 'g');
    const t = svc.start({
      ...req('x'),
      modelId: 'gemini-2.5-flash-image',
      providerRef: 'google',
      params: { n: 3 },
    });
    await flush();
    // 拆出的子请求同样受并发上限约束
    expect(fetchMock).toHaveBeenCalledTimes(2);
    pending.shift()!();
    await flush();
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    pending.splice(0).forEach((go) => go());
    const done = await svc.wait(t.id);
    expect(done.status).toBe('succeeded');
    expect(done.assets).toHaveLength(3);
    expect(done.progress).toEqual({ done: 3, total: 3 });
    expect(events.some((p) => (p as { progress?: { done: number } }).progress?.done === 1)).toBe(
      true,
    );
  });

  it('支持多张的协议不拆分：n 原样一次发出', async () => {
    const { svc, fetchMock, key } = makeService();
    key('openai', 'k');
    await svc.generate({ ...req('x'), params: { n: 4 } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]!.body)).n).toBe(4);
  });
});
