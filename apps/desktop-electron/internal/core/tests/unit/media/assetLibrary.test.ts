jest.unmock('fs');
jest.unmock('path');

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { t as tr } from '../../../src/i18n';
import {
  ASSET_IMPORT_MAX_BYTES,
  AssetLibrary,
  assetSourceOf,
} from '../../../src/media/AssetLibrary';

function setup() {
  const chatRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-assets-'));
  const images = path.join(chatRoot, 'images');
  fs.mkdirSync(images, { recursive: true });
  const put = (name: string, t: number) => {
    const p = path.join(images, name);
    fs.writeFileSync(p, 'x');
    fs.utimesSync(p, t / 1000, t / 1000);
  };
  const trashed: string[] = [];
  const revealed: string[] = [];
  let changed = 0;
  const lib = new AssetLibrary({
    chatRoot,
    trashItem: async (p) => {
      trashed.push(path.basename(p));
      fs.unlinkSync(p);
    },
    showItemInFolder: (p) => revealed.push(path.basename(p)),
    onChanged: () => changed++,
  });
  return { lib, put, trashed, revealed, changed: () => changed, images };
}

describe('素材库', () => {
  it('来源看文件名前缀；早期的 gen- 算 Nomi；对话背景等不是生成的图片', () => {
    expect(assetSourceOf('nomi-abc-123.png')).toBe('nomi');
    expect(assetSourceOf('gen-abc-123.png')).toBe('nomi');
    expect(assetSourceOf('grok-5f0e.jpg')).toBe('grok');
    expect(assetSourceOf('codex-1.webp')).toBe('codex');
    expect(assetSourceOf('chat-bg.1234.png')).toBeNull();
    expect(assetSourceOf('panel-bg.jpg')).toBeNull();
    expect(assetSourceOf('nomi-x.txt')).toBeNull();
    expect(assetSourceOf('evil-x.png')).toBeNull();
  });

  it('列出全部生成的图片（新的在前），带上记下的模型 / 提示词', () => {
    const t = setup();
    t.put('grok-a.png', 1_700_000_000_000);
    t.put('nomi-b.png', 1_700_000_100_000);
    t.put('panel-bg.jpg', 1_700_000_200_000);
    t.lib.record('nomi-b.png', {
      model: 'amux/gpt-image-2',
      prompt: 'a red fox',
      conversationId: 'c1',
    });
    expect(t.changed()).toBe(1);
    const items = t.lib.list();
    expect(items.map((x) => [x.file, x.source])).toEqual([
      ['nomi-b.png', 'nomi'],
      ['grok-a.png', 'grok'],
    ]);
    expect(items[0]).toMatchObject({
      url: 'chat-asset://images/nomi-b.png',
      model: 'amux/gpt-image-2',
      prompt: 'a red fox',
      conversationId: 'c1',
      bytes: 1,
    });
    expect(items[1]!.model).toBeUndefined();
  });

  it('删除移到废纸篓，并清掉记下的说明；不接受素材库以外的文件名', async () => {
    const t = setup();
    t.put('nomi-b.png', 1);
    t.put('panel-bg.jpg', 1);
    t.lib.record('nomi-b.png', { model: 'm', prompt: 'p' });
    expect(await t.lib.remove(['nomi-b.png', 'panel-bg.jpg', '../x.png', 'nomi-gone.png'])).toEqual(
      ['nomi-b.png'],
    );
    expect(t.trashed).toEqual(['nomi-b.png']);
    expect(fs.existsSync(path.join(t.images, 'panel-bg.jpg'))).toBe(true);
    expect(t.lib.list()).toEqual([]);
    t.put('nomi-b.png', 1);
    expect(t.lib.list()[0]!.model).toBeUndefined();
  });

  it('在文件夹中显示：只认素材库里存在的文件', () => {
    const t = setup();
    t.put('grok-a.png', 1);
    expect(t.lib.reveal('grok-a.png')).toBe(true);
    expect(t.lib.reveal('panel-bg.jpg')).toBe(false);
    expect(t.lib.reveal('nomi-missing.png')).toBe(false);
    expect(t.revealed).toEqual(['grok-a.png']);
  });

  it('没有图片目录：空列表', () => {
    const lib = new AssetLibrary({ chatRoot: path.join(os.tmpdir(), 'cd-none-' + Date.now()) });
    expect(lib.list()).toEqual([]);
  });

  it('重新生成沿用原图的提示词 / 模型 / 画幅 / 改图来源 / 参考图；没有提示词的不能重新生成', async () => {
    const chatRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-assets-'));
    fs.mkdirSync(path.join(chatRoot, 'images'));
    fs.writeFileSync(path.join(chatRoot, 'images', 'nomi-a.png'), 'x');
    fs.writeFileSync(path.join(chatRoot, 'images', 'grok-g.png'), 'x');
    const reqs: unknown[] = [];
    const lib = new AssetLibrary({
      chatRoot,
      generate: async (req) => {
        reqs.push(req);
        fs.writeFileSync(path.join(chatRoot, 'images', 'nomi-new.png'), 'y');
        return 'nomi-new.png';
      },
    });
    lib.record('nomi-a.png', {
      model: 'amux/gpt-image-2',
      prompt: 'a fox',
      aspect: '3:2',
      references: ['grok-g.png'],
    });
    const next = await lib.regenerate('nomi-a.png');
    expect(next.file).toBe('nomi-new.png');
    expect(reqs[0]).toEqual({
      prompt: 'a fox',
      aspect: '3:2',
      modelRef: 'amux/gpt-image-2',
      references: ['grok-g.png'],
    });
    await expect(lib.regenerate('grok-g.png')).rejects.toThrow();
  });

  it('长提示词原样保存，重新生成发的是全文（#225）', async () => {
    const chatRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-assets-'));
    fs.mkdirSync(path.join(chatRoot, 'images'));
    fs.writeFileSync(path.join(chatRoot, 'images', 'nomi-a.png'), 'x');
    const reqs: Array<{ prompt: string }> = [];
    const lib = new AssetLibrary({
      chatRoot,
      generate: async (req) => {
        reqs.push(req);
        fs.writeFileSync(path.join(chatRoot, 'images', 'nomi-new.png'), 'y');
        return 'nomi-new.png';
      },
    });
    for (const prompt of [
      'p'.repeat(2000),
      'p'.repeat(2000) + 'KEEP',
      'p'.repeat(3996) + 'KEEP',
      '狐'.repeat(1998) + '😀😀', // 代理对在 2000 附近
    ]) {
      lib.record('nomi-a.png', { model: 'amux/gpt-image-2', prompt });
      expect(lib.list().find((x) => x.file === 'nomi-a.png')?.prompt).toBe(prompt);
      await lib.regenerate('nomi-a.png');
      expect(reqs.at(-1)!.prompt).toBe(prompt);
    }
  });

  it('另存为：选了位置就复制一份，取消不动', async () => {
    const chatRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-assets-'));
    fs.mkdirSync(path.join(chatRoot, 'images'));
    fs.writeFileSync(path.join(chatRoot, 'images', 'nomi-a.png'), 'x');
    const dest = path.join(chatRoot, 'out.png');
    let pick: string | null = dest;
    const lib = new AssetLibrary({ chatRoot, saveFile: async () => pick });
    expect(await lib.saveAs('nomi-a.png')).toBe(true);
    expect(fs.readFileSync(dest, 'utf8')).toBe('x');
    pick = null;
    expect(await lib.saveAs('nomi-a.png')).toBe(false);
    expect(await lib.saveAs('panel-bg.jpg')).toBe(false);
  });
});

describe('素材库：保存用户发送的原图', () => {
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2]);
  const WEBP = Buffer.from('RIFF\x00\x00\x00\x00WEBPVP8 ', 'latin1');
  const GIF = Buffer.from('GIF89a\x01\x00', 'latin1');

  it('写进图片目录（来源 user），记下会话，通知视图，列表里能看到', async () => {
    const t = setup();
    const item = await t.lib.importImage({
      mime: 'image/png',
      data: PNG.toString('base64'),
      conversationId: 'c1',
    });
    expect(item.file).toMatch(/^user-[a-z0-9]+-[a-z0-9]+\.png$/);
    expect(item).toMatchObject({
      url: `chat-asset://images/${item.file}`,
      source: 'user',
      bytes: PNG.length,
      conversationId: 'c1',
    });
    expect(fs.readFileSync(path.join(t.images, item.file))).toEqual(PNG);
    expect(t.changed()).toBe(1);
    expect(t.lib.list().map((x) => [x.file, x.source])).toEqual([[item.file, 'user']]);
    expect(assetSourceOf(item.file)).toBe('user');
    if (process.platform !== 'win32')
      expect(fs.statSync(path.join(t.images, item.file)).mode & 0o777).toBe(0o600);
  });

  it('扩展名跟 mime 走：jpeg / webp / gif', async () => {
    const t = setup();
    const j = await t.lib.importImage({ mime: 'image/jpeg', data: JPG.toString('base64') });
    const w = await t.lib.importImage({ mime: 'image/webp', data: WEBP.toString('base64') });
    const g = await t.lib.importImage({ mime: 'image/gif', data: GIF.toString('base64') });
    expect([j.file, w.file, g.file].map((f) => path.extname(f))).toEqual(['.jpg', '.webp', '.gif']);
    expect(j.conversationId).toBeUndefined();
  });

  it('文件头与 mime 不符、超过 20 MB：拒绝，不落盘', async () => {
    const t = setup();
    await expect(
      t.lib.importImage({ mime: 'image/jpeg', data: PNG.toString('base64') }),
    ).rejects.toThrow(tr('electron.image.import-bad-format'));
    await expect(
      t.lib.importImage({ mime: 'image/png', data: Buffer.from('<svg/>').toString('base64') }),
    ).rejects.toThrow();
    const big = Buffer.alloc(ASSET_IMPORT_MAX_BYTES + 1);
    PNG.copy(big);
    await expect(
      t.lib.importImage({ mime: 'image/png', data: big.toString('base64') }),
    ).rejects.toThrow(tr('electron.image.import-too-large', 20));
    expect(fs.readdirSync(t.images)).toEqual([]);
    expect(t.changed()).toBe(0);
  });
});
