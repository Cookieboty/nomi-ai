// 需要真实文件系统
jest.unmock('fs');
jest.unmock('path');

import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { AssetLibrary, sha256 } from '../../../src/media/assets';
import { MediaService } from '../../../src/media/MediaService';
import { MediaConfigStore, type SecretCodec } from '../../../src/media/store';

const PNG = (seed: number) =>
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from([seed, 1, 2, 3]),
  ]);
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 9, 9]);

const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'media-'));
const codec: SecretCodec = {
  encrypt: (v) => `enc:${Buffer.from(v).toString('base64')}`,
  decrypt: (v) => (v ? Buffer.from(v.slice(4), 'base64').toString() : ''),
};
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

describe('MediaConfigStore', () => {
  it('预设供应商与绑定首启即有，Key 加密落盘、对外只给 hasKey', () => {
    const root = tmp();
    const s = new MediaConfigStore(root, codec);
    expect(s.providers().map((p) => p.id)).toEqual(
      expect.arrayContaining(['openai', 'openrouter', 'google', 'volc', 'fal']),
    );
    expect(s.prefs().chatDefaultImage).toBeNull();
    s.upsertProvider({ id: 'openai', apiKey: 'sk-secret-1234' });
    const raw = readFileSync(path.join(root, 'config.json'), 'utf8');
    expect(raw).not.toContain('sk-secret-1234');
    const v = s.providers().find((p) => p.id === 'openai')!;
    expect(v).toMatchObject({ hasKey: true, keyHint: '1234' });
    expect(v).not.toHaveProperty('apiKeyEnc');
    expect(s.apiKey('openai')).toBe('sk-secret-1234');
  });

  it('入库开关默认：生成图开、上传图关', () => {
    const s = new MediaConfigStore(tmp(), codec);
    expect(s.prefs().autoAddGenerated).toBe(true);
    expect(s.prefs().autoAddUploads).toBe(false);
  });

  it('不能把对话默认设为没有 Key 的组合', () => {
    const s = new MediaConfigStore(tmp(), codec);
    expect(() => s.setChatDefault({ modelId: 'gpt-image-1', providerRef: 'openai' })).toThrow();
  });

  it('默认供应商停用 → 自动切到同模型另一家已启用的供应商', () => {
    const s = new MediaConfigStore(tmp(), codec);
    s.upsertProvider({ id: 'openrouter', apiKey: 'k1' });
    s.upsertProvider({ id: 'google', apiKey: 'k2' });
    s.setChatDefault({ modelId: 'gemini-2.5-flash-image', providerRef: 'openrouter' });
    const { changes } = s.upsertProvider({ id: 'openrouter', enabled: false });
    expect(changes).toEqual([
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

  it('同模型没有其他可用供应商 → 清空为未配置，不跨模型兜底', () => {
    const s = new MediaConfigStore(tmp(), codec);
    s.upsertProvider({ id: 'openai', apiKey: 'k' });
    s.upsertProvider({ id: 'google', apiKey: 'k2' }); // 别的模型可用，也不能兜底过去
    s.setChatDefault({ modelId: 'gpt-image-1', providerRef: 'openai' });
    const changes = s.upsertBinding({
      providerRef: 'openai',
      modelId: 'gpt-image-1',
      enabled: false,
    });
    expect(changes[0]).toMatchObject({ target: 'chat', kind: 'cleared' });
    expect(s.prefs().chatDefaultImage).toBeNull();
  });

  it('清除 Key 同样触发校正；损坏的配置文件回落到默认', () => {
    const root = tmp();
    const s = new MediaConfigStore(root, codec);
    s.upsertProvider({ id: 'volc', apiKey: 'k' });
    s.setChatDefault({ modelId: 'seedream-4', providerRef: 'volc' });
    s.upsertProvider({ id: 'fal', apiKey: 'k' });
    const { changes } = s.upsertProvider({ id: 'volc', apiKey: null });
    expect(changes[0]).toMatchObject({ kind: 'switched', to: { providerRef: 'fal' } });
    require('node:fs').writeFileSync(path.join(root, 'config.json'), '{oops');
    expect(new MediaConfigStore(root, codec).prefs().chatDefaultImage).toBeNull();
  });

  it('自定义供应商：新增绑定需要协议与上游模型名，删除后校正', () => {
    const s = new MediaConfigStore(tmp(), codec);
    const { provider } = s.upsertProvider({
      name: 'My Proxy',
      baseURL: 'https://proxy.example/v1',
      apiKey: 'k',
    });
    expect(provider.custom).toBe(true);
    expect(() => s.upsertBinding({ providerRef: provider.id, modelId: 'gpt-image-1' })).toThrow();
    s.upsertBinding({
      providerRef: provider.id,
      modelId: 'gpt-image-1',
      presetKey: 'openai-images',
      upstreamModelName: 'gpt-image-1',
    });
    s.setChatDefault({ modelId: 'gpt-image-1', providerRef: provider.id });
    const changes = s.removeProvider(provider.id);
    expect(changes[0]).toMatchObject({ kind: 'cleared' });
    expect(() => s.removeProvider('openai')).toThrow();
  });
});

function okJson(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function makeService(over: Partial<ConstructorParameters<typeof MediaService>[0]> = {}) {
  const fetchMock = jest.fn(async (_url: string, _init?: RequestInit) =>
    okJson({ data: [{ b64_json: PNG(7).toString('base64') }] }),
  );
  const events: Array<[string, unknown]> = [];
  const svc = new MediaService({
    root: tmp(),
    logger,
    codec,
    fetch: fetchMock as never,
    broadcast: (c, p) => events.push([c, p]),
    ...over,
  });
  return { svc, fetchMock, events };
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
    const { svc, fetchMock, events } = makeService();
    svc.upsertProvider({ id: 'openai', apiKey: 'sk-abc' });
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
    const { svc } = makeService();
    svc.upsertProvider({ id: 'openai', apiKey: 'k' });
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
    const { svc, fetchMock } = makeService({ localOnly: () => true });
    svc.upsertProvider({ id: 'openai', apiKey: 'k' });
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
    const { svc } = makeService({ fetch: fetchMock as never });
    svc.upsertProvider({ id: 'openai', apiKey: 'k' });
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
    const { svc } = makeService({ fetch: fetchMock as never });
    svc.upsertProvider({ id: 'fal', apiKey: 'k' });
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
    const { svc, events } = makeService();
    svc.upsertProvider({ id: 'volc', apiKey: 'k' });
    svc.upsertProvider({ id: 'fal', apiKey: 'k' });
    svc.setChatDefault({ modelId: 'seedream-4', providerRef: 'volc' });
    svc.upsertProvider({ id: 'volc', enabled: false });
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
    const { svc, fetchMock } = makeService();
    svc.upsertProvider({ id: 'openai', apiKey: 'k1' });
    svc.upsertProvider({ id: 'volc', apiKey: 'k2' });
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
    const { svc } = makeService();
    svc.upsertProvider({ id: 'openai', apiKey: 'k1' });
    svc.upsertProvider({ id: 'volc', apiKey: 'k2' });
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
    svc.upsertProvider({ id: 'volc', enabled: false });
    expect(svc.sessionChoice('new1')).toMatchObject({
      override: false,
      choice: { providerRef: 'openai' },
    });
  });
});
