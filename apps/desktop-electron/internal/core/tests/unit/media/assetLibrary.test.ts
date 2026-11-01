jest.unmock('fs');
jest.unmock('path');

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { AssetLibrary, assetSourceOf } from '../../../src/media/AssetLibrary';

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
